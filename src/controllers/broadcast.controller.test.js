// Run: node --test src/controllers/broadcast.controller.test.js
// sendBroadcast tells the worker whether it debited the wallet (job.billed),
// so failed sends are refunded only when billing was on. A template Meta has
// paused or disabled can't be used: createBroadcast refuses it, and
// sendBroadcast refuses a draft whose template was paused/disabled after the
// draft was made (nothing queued or debited). Supabase and the services are
// stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

let templateRow;
const draft = { id: 'bc', business_id: 'b', template_id: 't', status: 'draft', template_variables: [] };
// The broadcasts row, stateful so the atomic claim in sendBroadcast is real:
// an update with .eq('status', 'draft') only matches while the row is a draft,
// and matching + changing happen in one step, like the single UPDATE in Postgres.
let broadcastState = { ...draft };
const inserted = [];
const supabase = {
  from: (table) => {
    const filters = [];
    let patch = null;
    const run = () => {
      if (table !== 'broadcasts') return { data: templateRow, error: null };
      if (!filters.every(([c, v]) => broadcastState[c] === v)) return { data: null, error: null };
      if (patch) { Object.assign(broadcastState, patch); patch = null; }
      return { data: { ...broadcastState }, error: null };
    };
    const q = {
      select: () => q,
      eq: (c, v) => { filters.push([c, v]); return q; },
      insert: (row) => { inserted.push(row); return q; },
      update: (p) => { patch = p; return q; },
      single: async () => (inserted.length && !patch ? { data: { id: 'new', ...inserted[inserted.length - 1] }, error: null } : run()),
      maybeSingle: async () => run(),
      then: (resolve) => resolve(run())
    };
    return q;
  }
};
const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const queued = [];
const debits = [];
const refunds = [];
let audience = [{ id: 'c1', whatsapp_number: '911', name: 'A' }];
let failQueue = () => false; // (job, callNumber) => true makes that addToBroadcastQueue reject
let debitError = null;
let queueCalls = 0;
stub('../config/supabase', supabase);
let billing = true;
stub('../config/env', { get WALLET_BILLING_ENABLED() { return billing; }, MAX_BROADCAST_RECIPIENTS: 1000 });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/business.service', { getBusinessById: async () => ({ isWhatsappConnected: true, phoneNumberId: 'p', accessToken: 'x' }) });
stub('../services/wallet.service', {
  debitWallet: async (...a) => { if (debitError) throw debitError; debits.push(a); },
  refundToWallet: async (...a) => { refunds.push(a); },
  getOrCreateWallet: async () => ({ balance_paise: 5 })
});
let rateLookups = 0;
stub('../services/rateCard.service', { getRateForMessage: async () => { rateLookups += 1; return 80; } });
stub('../queues/broadcast.queue', {
  addToBroadcastQueue: async (job) => {
    const n = queueCalls++;
    if (failQueue(job, n)) throw new Error('redis down');
    queued.push(job);
  }
});
// The category rule is the real one (requiresMarketingOptIn); the queries are stubbed.
const { requiresMarketingOptIn } = require('../services/broadcastAudience.service');
const resolveCalls = []; // { options } per resolveAudience call
const categoryLookups = [];
stub('../services/broadcastAudience.service', {
  normalizeAudience: () => ({ filter: 'all_customers', params: {} }),
  resolveAudience: async (businessId, filter, params, options) => { resolveCalls.push({ options }); return audience; },
  businessGroupIds: async () => [],
  requiresMarketingOptIn,
  templateCategory: async (businessId, templateId) => { categoryLookups.push({ businessId, templateId }); return templateRow ? templateRow.category : null; }
});
stub('../services/broadcastProgress.service', { getBroadcastStats: async (b, i, row) => ({ tracked: false, total: row.total_recipients || 0, queued: null, sent: row.sent_count || 0, delivered: null, read: null, failed: row.failed_count || 0 }), notifyBroadcastProgress: () => {} });
const { createBroadcast, sendBroadcast, getBroadcastRecipientsPreview } = require('./broadcast.controller');

const call = async (handler, req) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ user: { businessId: 'b' }, params: {}, body: {}, ...req }, res, (err) => { throw err; });
  return res;
};
const tpl = (status) => ({ id: 't', business_id: 'b', name: 'promo', status, category: 'MARKETING', language: 'en_US', body_text: 'Hi', header_type: 'NONE' });

test.beforeEach(() => {
  inserted.length = 0; queued.length = 0; debits.length = 0; refunds.length = 0; billing = true;
  resolveCalls.length = 0; categoryLookups.length = 0; rateLookups = 0;
  broadcastState = { ...draft }; audience = [{ id: 'c1', whatsapp_number: '911', name: 'A' }];
  failQueue = () => false; debitError = null; queueCalls = 0;
});

test('create: paused / disabled templates are refused', async () => {
  for (const status of ['paused', 'disabled']) {
    templateRow = tpl(status);
    const res = await call(createBroadcast, { body: { name: 'Diwali', templateId: 't' } });
    assert.equal(res.statusCode, 400, status);
    assert.match(res.body.message, /Only approved templates/);
  }
  assert.equal(inserted.length, 0);
});

test('send: a draft whose template was since paused / disabled is refused, nothing queued or debited', async () => {
  for (const status of ['paused', 'disabled']) {
    templateRow = tpl(status);
    const res = await call(sendBroadcast, { params: { id: 'bc' } });
    assert.equal(res.statusCode, 400, status);
    assert.match(res.body.message, /no longer approved/);
  }
  assert.equal(queued.length + debits.length, 0);
});

test('send: approved template goes through and the job says it was billed', async () => {
  templateRow = tpl('approved');
  const res = await call(sendBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 200);
  assert.equal(debits.length, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].billed, true);
});

test('send with billing off: no debit, and the job says it was not billed', async () => {
  billing = false;
  templateRow = tpl('approved');
  const res = await call(sendBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 200);
  assert.equal(debits.length, 0);
  assert.equal(queued[0].billed, false);
});

const BLOCKED = ['needs_header_media', 'unsupported_named_params', 'unsupported_component'];

test('create: an approved template ApnaBot can\'t send yet (send_support not ok) is refused', async () => {
  for (const send_support of BLOCKED) {
    templateRow = { ...tpl('approved'), send_support };
    const res = await call(createBroadcast, { body: { name: 'Diwali', templateId: 't' } });
    assert.equal(res.statusCode, 400, send_support);
    assert.match(res.body.message, /can't be used for a broadcast yet/);
  }
  assert.equal(inserted.length, 0);
});

test('send: a draft whose template is not send_support ok is refused, nothing queued or debited', async () => {
  for (const send_support of BLOCKED) {
    templateRow = { ...tpl('approved'), send_support };
    const res = await call(sendBroadcast, { params: { id: 'bc' } });
    assert.equal(res.statusCode, 400, send_support);
    assert.match(res.body.message, /can't be sent yet/);
  }
  assert.equal(queued.length + debits.length, 0);
});

test('approved + send_support ok goes through (create and send)', async () => {
  templateRow = { ...tpl('approved'), send_support: 'ok' };
  assert.equal((await call(createBroadcast, { body: { name: 'Diwali', templateId: 't' } })).statusCode, 201);
  assert.equal((await call(sendBroadcast, { params: { id: 'bc' } })).statusCode, 200);
});

test('a deleted (soft) template is not approved: refused', async () => {
  templateRow = { ...tpl('deleted'), send_support: 'ok' };
  assert.equal((await call(createBroadcast, { body: { name: 'Diwali', templateId: 't' } })).statusCode, 400);
  assert.equal((await call(sendBroadcast, { params: { id: 'bc' } })).statusCode, 400);
});

// ── Atomic claim (a draft can only be sent once) ──

test('send: two concurrent sends → exactly one debit and one enqueue; the other gets 409', async () => {
  templateRow = tpl('approved');
  const [a, b] = await Promise.all([
    call(sendBroadcast, { params: { id: 'bc' } }),
    call(sendBroadcast, { params: { id: 'bc' } })
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  assert.match([a, b].find(r => r.statusCode === 409).body.message, /already being sent/);
  assert.equal(debits.length, 1);
  assert.equal(queued.length, 1);
  assert.equal(refunds.length, 0);
  assert.equal(broadcastState.status, 'sending');
});

test('send: a broadcast no longer a draft is not claimed, debited or queued', async () => {
  templateRow = tpl('approved');
  broadcastState.status = 'sending';
  const res = await call(sendBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 400);
  assert.equal(debits.length + queued.length, 0);
});

test('send: the claim is scoped to this business', async () => {
  templateRow = tpl('approved');
  const res = await call(sendBroadcast, { params: { id: 'bc' }, user: { businessId: 'other' } });
  assert.equal(res.statusCode, 404);
  assert.equal(broadcastState.status, 'draft');
});

test('send: insufficient wallet balance → claim released, nothing queued, no refund', async () => {
  templateRow = tpl('approved');
  debitError = new Error('Insufficient wallet balance');
  const res = await call(sendBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Insufficient wallet balance/);
  assert.equal(broadcastState.status, 'draft');
  assert.equal(queued.length + refunds.length, 0);
  // and the owner can send again once topped up
  debitError = null;
  assert.equal((await call(sendBroadcast, { params: { id: 'bc' } })).statusCode, 200);
});

test('send: an unexpected debit error → claim released (draft again), error passed on, nothing to refund', async () => {
  templateRow = tpl('approved');
  debitError = new Error('db down');
  await assert.rejects(call(sendBroadcast, { params: { id: 'bc' } }), /db down/);
  assert.equal(broadcastState.status, 'draft');
  assert.equal(queued.length + refunds.length, 0);
});

test('send: nothing could be queued → full refund, back to draft, 500', async () => {
  templateRow = tpl('approved');
  failQueue = () => true;
  const res = await call(sendBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 500);
  assert.equal(debits.length, 1);
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0][1], 80); // 1 recipient × 80 paise, the amount debited
  assert.equal(broadcastState.status, 'draft');
  assert.equal(broadcastState.total_recipients, 0);
});

test('send: some batches queued, some not → not released (no double send); refund and total cover only the lost ones', async () => {
  templateRow = tpl('approved');
  audience = Array.from({ length: 120 }, (_, i) => ({ id: `c${i}`, whatsapp_number: `91${i}`, name: 'A' })); // 50 + 50 + 20
  failQueue = (job, n) => n === 2; // the 20-recipient batch
  const res = await call(sendBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 200);
  assert.equal(queued.length, 2);
  assert.equal(debits[0][1], 120 * 80);
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0][1], 20 * 80);
  assert.equal(broadcastState.status, 'sending');
  assert.equal(broadcastState.total_recipients, 100);
});

test('send with billing off: a queue failure releases the claim and refunds nothing', async () => {
  billing = false;
  templateRow = tpl('approved');
  failQueue = () => true;
  const res = await call(sendBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 500);
  assert.equal(refunds.length, 0);
  assert.equal(broadcastState.status, 'draft');
});

// ── UTILITY templates: the stored category decides who is reachable ──

test('send: resolveAudience gets the STORED template category (UTILITY / MARKETING), whatever the request says', async () => {
  for (const category of ['UTILITY', 'MARKETING']) {
    resolveCalls.length = 0;
    broadcastState = { ...draft };
    templateRow = { ...tpl('approved'), category };
    const res = await call(sendBroadcast, { params: { id: 'bc' }, body: { category: category === 'UTILITY' ? 'MARKETING' : 'UTILITY' } });
    assert.equal(res.statusCode, 200, category);
    assert.equal(resolveCalls.length, 1);
    assert.deepEqual(resolveCalls[0].options, { category });
  }
});

test('send: nobody to send to → a 400 that says "opted-in" for MARKETING but not for UTILITY', async () => {
  audience = [];
  for (const [filter, optedInWord] of [['all_customers', 'opted-in'], ['coaching_requests', 'opted-in'], ['groups', 'opted-in'], ['customers', 'not opted in'], ['segment', 'opted-in']]) {
    broadcastState = { ...draft, audience_filter: filter };
    templateRow = { ...tpl('approved'), category: 'MARKETING' };
    const marketing = await call(sendBroadcast, { params: { id: 'bc' } });
    assert.equal(marketing.statusCode, 400, filter);
    assert.ok(marketing.body.message.includes(optedInWord), `${filter}: ${marketing.body.message}`);

    broadcastState = { ...draft, audience_filter: filter };
    templateRow = { ...tpl('approved'), category: 'UTILITY' };
    const utility = await call(sendBroadcast, { params: { id: 'bc' } });
    assert.equal(utility.statusCode, 400, filter);
    assert.ok(!/opted[- ]in|not opted in/i.test(utility.body.message), `${filter}: ${utility.body.message}`);
    assert.ok(/opted out/.test(utility.body.message) || filter !== 'customers', `${filter}: ${utility.body.message}`);
  }
  assert.equal(queued.length + debits.length, 0); // nothing queued or debited
});

test('preview: the audience is resolved with the stored template category; no usable template → strict', async () => {
  templateRow = { ...tpl('approved'), category: 'UTILITY' };
  resolveCalls.length = 0;
  const res = await call(getBroadcastRecipientsPreview, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.totalCount, 1);
  assert.deepEqual(resolveCalls[0].options, { category: 'UTILITY' });
  assert.deepEqual(categoryLookups, [{ businessId: 'b', templateId: 't' }]);

  // template deleted / not found: templateCategory gives null → the marketing rule
  templateRow = null;
  resolveCalls.length = 0;
  await call(getBroadcastRecipientsPreview, { params: { id: 'bc' } });
  assert.deepEqual(resolveCalls[0].options, { category: null });
});

test('send: the rate card is read only when wallet billing is on', async () => {
  templateRow = tpl('approved');
  billing = false;
  let res = await call(sendBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 200);
  assert.equal(rateLookups, 0);
  assert.equal(debits.length, 0);
  assert.equal(queued[0].ratePerMessage, 0);

  queued.length = 0; broadcastState = { ...draft }; billing = true;
  res = await call(sendBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 200);
  assert.equal(rateLookups, 1);
  assert.equal(queued[0].ratePerMessage, 80);
});
