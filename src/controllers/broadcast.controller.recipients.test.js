// Run: node --test src/controllers/broadcast.controller.recipients.test.js
// Delivery tracking in the broadcast controller: sendBroadcast makes one 'queued'
// broadcast_recipients row per recipient BEFORE queueing, and takes them back when
// the claim is released; GET /:id carries the delivery stats; GET /:id/recipients
// (the route is owner / superadmin only) lists who got it and why each failure
// failed. Supabase and the services are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

const draft = { id: 'bc', business_id: 'b', template_id: 't', status: 'draft', template_variables: [] };
let broadcastState; let recRows; let recQueries; let events; let upsertError; let templateRow;

const supabase = {
  from: (table) => {
    const filters = []; let op = 'select'; let patch = null; let upsertRows = null; let range = null; let selectCols = null;
    const match = (r) => filters.every((f) => f(r));
    const run = () => {
      if (table === 'broadcast_recipients') {
        if (op === 'upsert') {
          events.push(['upsert', upsertRows.length]);
          if (upsertError) return { error: upsertError };
          upsertRows.forEach((u) => { if (!recRows.some((r) => r.broadcast_id === u.broadcast_id && r.whatsapp_number === u.whatsapp_number)) recRows.push({ status: 'queued', ...u }); });
          return { error: null };
        }
        if (op === 'delete') { events.push(['delete']); recRows = recRows.filter((r) => !match(r)); return { error: null }; }
        const all = recRows.filter(match);
        recQueries.push({ selectCols, filtered: all.length });
        const page = range ? all.slice(range[0], range[1] + 1) : all;
        return { data: page, error: null, count: all.length };
      }
      if (table === 'broadcasts') {
        if (!filters.every((f) => f(broadcastState))) return { data: null, error: null };
        if (patch) { Object.assign(broadcastState, patch); patch = null; }
        return { data: { ...broadcastState }, error: null };
      }
      return { data: templateRow, error: null };
    };
    const q = {
      select: (cols) => { selectCols = cols; return q; },
      eq: (c, v) => { filters.push((r) => r[c] === v); return q; },
      in: (c, vs) => { filters.push((r) => vs.includes(r[c])); return q; },
      not: (c, o, v) => { filters.push((r) => (o === 'is' && v === null ? r[c] !== null && r[c] !== undefined : true)); return q; },
      order: () => q,
      range: (a, b) => { range = [a, b]; return q; },
      upsert: (rows) => { op = 'upsert'; upsertRows = rows; return q; },
      delete: () => { op = 'delete'; return q; },
      update: (p) => { patch = p; return q; },
      insert: () => q,
      single: async () => run(),
      maybeSingle: async () => run(),
      then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject)
    };
    return q;
  },
  rpc: async () => ({ data: null, error: null })
};
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
let stats; let failQueue; let queued;
stub('../config/supabase', supabase);
stub('../config/env', { WALLET_BILLING_ENABLED: false, MAX_BROADCAST_RECIPIENTS: 5000 });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/business.service', { getBusinessById: async () => ({ isWhatsappConnected: true, phoneNumberId: 'p', accessToken: 'x' }) });
stub('../services/wallet.service', { debitWallet: async () => {}, refundToWallet: async () => {}, getOrCreateWallet: async () => ({ balance_paise: 5 }) });
stub('../services/rateCard.service', { getRateForMessage: async () => 0 });
stub('../queues/broadcast.queue', {
  addToBroadcastQueue: async (job) => {
    events.push(['queue', recRows.length]); // rows that exist when the job is queued
    if (failQueue(job)) throw new Error('redis down');
    queued.push(job);
  }
});
let audience;
const { requiresMarketingOptIn } = require('../services/broadcastAudience.service');
stub('../services/broadcastAudience.service', {
  normalizeAudience: () => ({ filter: 'all_customers', params: {} }),
  resolveAudience: async () => audience,
  businessGroupIds: async () => [],
  requiresMarketingOptIn,
  templateCategory: async () => 'MARKETING'
});
stub('../services/broadcastProgress.service', { getBroadcastStats: async (b, i, row) => { stats.push([b, i, row.id]); return { tracked: true, total: 3, queued: 1, sent: 2, delivered: 1, read: 0, failed: 0 }; }, notifyBroadcastProgress: () => {} });

const { sendBroadcast, getBroadcast, getBroadcastRecipients } = require('./broadcast.controller');

const call = async (handler, req) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ user: { businessId: 'b' }, params: {}, body: {}, query: {}, ...req }, res, (err) => { throw err; });
  return res;
};
const customers = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, whatsapp_number: `91${String(i).padStart(4, '0')}`, name: `N${i}` }));
const tpl = { id: 't', business_id: 'b', name: 'promo', status: 'approved', category: 'MARKETING', language: 'en', body_text: 'Hi', header_type: 'NONE' };

test.beforeEach(() => {
  broadcastState = { ...draft }; recRows = []; recQueries = []; events = []; queued = []; stats = []; upsertError = null;
  failQueue = () => false; templateRow = tpl; audience = customers(3);
});

test('send: one queued row per recipient exists BEFORE any job is queued', async () => {
  audience = customers(120); // 3 jobs of 50/50/20
  const res = await call(sendBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 200);
  assert.equal(recRows.length, 120);
  assert.deepEqual(recRows[0], { status: 'queued', broadcast_id: 'bc', business_id: 'b', customer_id: 'c0', whatsapp_number: '910000' });
  const firstQueue = events.find((e) => e[0] === 'queue');
  assert.equal(firstQueue[1], 120);
  assert.equal(queued.length, 3);
});

test('send: recipient rows go in chunks of 500', async () => {
  audience = customers(1200);
  await call(sendBroadcast, { params: { id: 'bc' } });
  assert.deepEqual(events.filter((e) => e[0] === 'upsert').map((e) => e[1]), [500, 500, 200]);
});

test('send: a failure making the rows is logged and the send still goes out', async () => {
  upsertError = { message: 'db down' };
  const res = await call(sendBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 200);
  assert.equal(queued.length, 1);
  assert.equal(recRows.length, 0);
});

test('send: nothing reached the queue -> the draft is released and its rows removed (a re-send starts clean)', async () => {
  failQueue = () => true;
  const res = await call(sendBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 500);
  assert.equal(broadcastState.status, 'draft');
  assert.equal(recRows.length, 0);
});

test('send: some jobs could not be queued -> only those recipients lose their rows', async () => {
  audience = customers(120);
  let n = 0;
  failQueue = () => n++ === 2; // the 20-recipient job
  const res = await call(sendBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 200);
  assert.equal(recRows.length, 100);
  assert.ok(!recRows.some((r) => Number(r.whatsapp_number.slice(2)) >= 100));
  assert.equal(broadcastState.total_recipients, 100);
});

test('GET /:id adds delivery stats and leaves the counters as they are', async () => {
  broadcastState = { ...draft, status: 'sending', sent_count: 2, failed_count: 0, total_recipients: 3 };
  const res = await call(getBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.sentCount, 2);
  assert.equal(res.body.data.failedCount, 0);
  assert.deepEqual(res.body.data.stats, { tracked: true, total: 3, queued: 1, sent: 2, delivered: 1, read: 0, failed: 0 });
  assert.deepEqual(stats[0], ['b', 'bc', 'bc']);
});

test('GET /:id for another business\'s broadcast is a 404 and computes no stats', async () => {
  broadcastState = { ...draft, business_id: 'other' };
  const res = await call(getBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 404);
  assert.equal(stats.length, 0);
});

const rec = (n, extra = {}) => ({ id: `r${n}`, broadcast_id: 'bc', business_id: 'b', customer_id: `c${n}`, whatsapp_number: `91${n}`, status: 'queued', sent_at: null, delivered_at: null, read_at: null, failed_at: null, error_code: null, error_title: null, error_details: null, customers: { name: `Name ${n}` }, ...extra });
const seed = () => {
  recRows = [
    rec(1, { status: 'read', sent_at: 't', delivered_at: 't', read_at: 't' }),
    rec(2, { status: 'delivered', sent_at: 't', delivered_at: 't' }),
    rec(3, { status: 'failed', failed_at: 't', error_code: 131026, error_title: 'Message undeliverable', error_details: 'd' }),
    rec(4, { status: 'failed', sent_at: 't', failed_at: 't', error_code: 131049, error_title: 'x' }),
    rec(5, { status: 'failed', failed_at: 't', error_title: 'recipient has no name on file' }),
    rec(6),
    rec(7, { status: 'sent', sent_at: 't' }),
    { ...rec(8, { business_id: 'other' }) }
  ];
};
const ids = (res) => res.body.data.recipients.map((r) => r.id);

test('recipients: lists this broadcast\'s recipients with name, times and a failure only where one failed', async () => {
  seed();
  const res = await call(getBroadcastRecipients, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(ids(res), ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']); // not the other business's row
  const [r1, , r3, , r5] = res.body.data.recipients;
  assert.equal(r1.name, 'Name 1');
  assert.equal(r1.whatsappNumber, '911');
  assert.equal(r1.failure, null);
  assert.equal(r1.customers, undefined);
  assert.equal(r3.failure.code, 131026);
  assert.match(r3.failure.reason, /not be on WhatsApp/);
  assert.equal(r5.failure.kind, 'local');
  assert.equal(r5.failure.reason, 'Not sent: recipient has no name on file');
  assert.deepEqual(res.body.data.pagination.total, 7);
});

test('recipients: the status filters mean what the stats mean', async () => {
  seed();
  const by = async (status) => ids(await call(getBroadcastRecipients, { params: { id: 'bc' }, query: { status } }));
  assert.deepEqual(await by('queued'), ['r6']);
  assert.deepEqual(await by('sent'), ['r1', 'r2', 'r4', 'r7']); // accepted by Meta, even r4 which failed later
  assert.deepEqual(await by('delivered'), ['r1', 'r2']); // includes read
  assert.deepEqual(await by('read'), ['r1']);
  assert.deepEqual(await by('failed'), ['r3', 'r4', 'r5']);
});

test('recipients: paging', async () => {
  seed();
  const res = await call(getBroadcastRecipients, { params: { id: 'bc' }, query: { page: '2', limit: '3' } });
  assert.deepEqual(ids(res), ['r4', 'r5', 'r6']);
  assert.deepEqual([res.body.data.pagination.page, res.body.data.pagination.limit, res.body.data.pagination.totalPages], [2, 3, 3]);
});

test('recipients: bad input is a 400 and an unknown broadcast a 404', async () => {
  seed();
  for (const query of [{ status: 'bogus' }, { page: '0' }, { page: 'x' }, { limit: '0' }, { limit: '101' }, { limit: '1.5' }]) {
    const res = await call(getBroadcastRecipients, { params: { id: 'bc' }, query });
    assert.equal(res.statusCode, 400, JSON.stringify(query));
  }
  assert.equal((await call(getBroadcastRecipients, { params: { id: 'nope' } })).statusCode, 404);
  broadcastState = { ...draft, business_id: 'other' };
  assert.equal((await call(getBroadcastRecipients, { params: { id: 'bc' } })).statusCode, 404);
});

test('recipients: a broadcast sent before tracking has an empty list', async () => {
  const res = await call(getBroadcastRecipients, { params: { id: 'bc' } });
  assert.deepEqual(res.body.data.recipients, []);
  assert.equal(res.body.data.pagination.total, 0);
});
