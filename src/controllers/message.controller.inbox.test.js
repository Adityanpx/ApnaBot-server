// Run: node --test src/controllers/message.controller.inbox.test.js
// The inbox (GET /api/messages) is ordered by customers.last_activity_at and
// includes anyone with activity; dashboard sends stamp last_activity_at but never
// last_message_at (the 24h window).
const test = require('node:test');
const assert = require('node:assert/strict');

let db; let queued;

const from = (table) => {
  const filters = []; let sort = null; let window = null; let head = false; let wantCount = false; let op = 'select'; let payload = null; let single = false;
  const rows = () => (db[table] = db[table] || []);
  const run = () => {
    if (op === 'insert') {
      const row = { id: `${table}-${rows().length + 1}`, created_at: new Date().toISOString(), ...payload };
      rows().push(row);
      return { data: row, error: null, count: null };
    }
    if (op === 'update') {
      const hit = rows().filter(r => filters.every(f => f(r)));
      hit.forEach(r => Object.assign(r, payload));
      return { data: hit, error: null, count: null };
    }
    let list = rows().filter(r => filters.every(f => f(r)));
    if (sort) {
      const { col, ascending, nullsFirst } = sort;
      list = [...list].sort((a, b) => {
        const av = a[col]; const bv = b[col];
        if (av === bv) return 0;
        if (av === null || av === undefined) return nullsFirst ? -1 : 1;
        if (bv === null || bv === undefined) return nullsFirst ? 1 : -1;
        return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
      });
    }
    const count = list.length;
    if (window) list = list.slice(window[0], window[1] + 1);
    return { data: head ? null : list, error: null, count: wantCount ? count : null };
  };
  const q = {
    select: (_cols, opts) => { if (opts && opts.count) wantCount = true; if (opts && opts.head) head = true; return q; },
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    not: (c, op2, v) => { assert.equal(op2, 'is'); filters.push(r => (r[c] === undefined ? null : r[c]) !== v); return q; },
    order: (col, o = {}) => { if (!sort) sort = { col, ascending: o.ascending !== false, nullsFirst: !!o.nullsFirst }; return q; },
    range: (a, b) => { window = [a, b]; return q; },
    limit: () => q,
    insert: (p) => { op = 'insert'; payload = p; return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    single: () => { single = true; return Promise.resolve(run()); },
    maybeSingle: async () => { const r = run(); return { data: (r.data || [])[0] || null, error: r.error }; },
    then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject)
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/supabase', { from });
stub('../utils/logger', { info() {}, warn() {}, error() {} });
stub('../services/business.service', { getBusinessById: async () => ({ isWhatsappConnected: true, phoneNumberId: 'pn1', accessToken: 'enc' }) });
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async (job) => { queued.push(job); } });
stub('./customer.controller', { withWindowExpiresAt: (c) => c });
stub('../services/payment.service', {});
const controller = require('./message.controller');

const BIZ = 'b1';
const cust = (id, lastMessageAt, lastActivityAt, extra = {}) => ({ id, business_id: BIZ, whatsapp_number: `91${id}`, name: id, last_message_at: lastMessageAt, last_activity_at: lastActivityAt, bot_paused_until: null, pipeline_stage: 'new', ...extra });

const res = () => { const r = { code: null, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const conversations = async (query = {}) => {
  const r = res();
  await controller.getConversations({ query, user: { businessId: BIZ } }, r, (e) => { throw e; });
  return r.body.data.conversations;
};

test.beforeEach(() => { db = { customers: [], messages: [] }; queued = []; });

// ---- inbox --------------------------------------------------------------

test('inbox: ordered by last_activity_at newest first; customers without activity are not in it', async () => {
  db.customers = [
    cust('a', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
    cust('b', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z'),
    cust('c', null, null), // imported contact, never any activity
    cust('d', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')
  ];
  assert.deepEqual((await conversations()).map(c => c._id), ['b', 'd', 'a']);
});

test('inbox: an owner-first chat (echo: last_activity_at set, last_message_at null) is included and ordered by activity', async () => {
  db.customers = [
    cust('a', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
    cust('owner_first', null, '2026-10-05T00:00:00Z')
  ];
  assert.deepEqual((await conversations()).map(c => c._id), ['owner_first', 'a']);
});

test('inbox: a customer the owner replied to from the phone moves up past newer inbound-only chats', async () => {
  db.customers = [
    cust('old_but_replied', '2026-09-01T00:00:00Z', '2026-10-06T00:00:00Z'),
    cust('newer_inbound', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')
  ];
  assert.deepEqual((await conversations()).map(c => c._id), ['old_but_replied', 'newer_inbound']);
});

test('inbox: with last_activity_at backfilled from last_message_at the list is the one the old ordering gave (same customers, same order, same shape)', async () => {
  const stamps = ['2026-10-04T00:00:00Z', '2026-10-01T00:00:00Z', null, '2026-10-03T00:00:00Z', '2026-10-02T00:00:00Z'];
  db.customers = stamps.map((s, i) => cust(`x${i}`, s, s));
  db.messages = [{ id: 'm1', customer_id: 'x0', direction: 'inbound', content: 'hello', created_at: '2026-10-04T00:00:00Z', is_read: false }];

  const oldOrder = [...db.customers].filter(c => c.last_message_at !== null)
    .sort((p, q) => (p.last_message_at < q.last_message_at ? 1 : -1)).map(c => c.id);
  const list = await conversations();
  assert.deepEqual(list.map(c => c._id), oldOrder);

  assert.deepEqual(Object.keys(list[0]).sort(), ['_id', 'botPausedUntil', 'customer', 'customerNumber', 'lastDirection', 'lastMessage', 'lastMessageAt', 'unreadCount']);
  assert.equal(list[0].lastMessage, 'hello');
  assert.equal(list[0].unreadCount, 1);
  assert.equal(list[1].lastMessage, null);
  assert.equal(list[1].lastMessageAt, '2026-10-03T00:00:00Z');
});

test('inbox: pagination counts only conversations', async () => {
  db.customers = [cust('a', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'), cust('b', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z'), cust('c', null, null)];
  const first = await conversations({ page: 1, limit: 1 });
  const second = await conversations({ page: 2, limit: 1 });
  assert.deepEqual([first.map(c => c._id), second.map(c => c._id)], [['b'], ['a']]);
});

// ---- dashboard send -----------------------------------------------------

const send = async (customerRow) => {
  db.customers = [customerRow];
  const r = res();
  await controller.sendMessage({ body: { customerNumber: customerRow.whatsapp_number, message: 'On my way' }, user: { businessId: BIZ } }, r, (e) => { throw e; });
  return r;
};
const recent = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

test('dashboard send: stamps last_activity_at, pauses the bot, leaves last_message_at (the 24h window) alone', async () => {
  const before = Date.now();
  const lastMessageAt = recent();
  const r = await send(cust('a', lastMessageAt, '2026-10-01T00:00:00Z'));
  assert.equal(r.code, 201);
  const c = db.customers[0];
  assert.ok(new Date(c.last_activity_at).getTime() >= before);
  assert.equal(c.last_message_at, lastMessageAt);
  assert.ok(new Date(c.bot_paused_until).getTime() > before + 23 * 3600 * 1000);
  assert.equal(c.pipeline_stage, 'contacted');
});

test('dashboard send: an indefinite pause is kept, last_activity_at is still stamped', async () => {
  const sentinel = '9999-12-31T00:00:00.000Z';
  const lastMessageAt = recent();
  await send(cust('a', lastMessageAt, '2026-10-01T00:00:00Z', { bot_paused_until: sentinel }));
  const c = db.customers[0];
  assert.equal(c.bot_paused_until, sentinel);
  assert.equal(c.last_message_at, lastMessageAt);
  assert.notEqual(c.last_activity_at, '2026-10-01T00:00:00Z');
});

test('dashboard send: still refused outside the 24h window, and then stamps nothing', async () => {
  const r = await send(cust('a', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'));
  assert.equal(r.code, 400);
  assert.equal(db.customers[0].last_activity_at, '2026-09-01T00:00:00Z');
  assert.equal(queued.length, 0);
});
