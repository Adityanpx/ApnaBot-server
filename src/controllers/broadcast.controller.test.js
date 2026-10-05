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
const inserted = [];
const supabase = {
  from: (table) => {
    const q = {
      select: () => q,
      eq: () => q,
      insert: (row) => { inserted.push(row); return q; },
      update: () => q,
      single: async () => ({ data: { id: 'new', ...inserted[inserted.length - 1] }, error: null }),
      maybeSingle: async () => ({ data: table === 'broadcasts' ? draft : templateRow, error: null })
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
stub('../config/supabase', supabase);
let billing = true;
stub('../config/env', { get WALLET_BILLING_ENABLED() { return billing; }, MAX_BROADCAST_RECIPIENTS: 1000 });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/business.service', { getBusinessById: async () => ({ isWhatsappConnected: true, phoneNumberId: 'p', accessToken: 'x' }) });
stub('../services/wallet.service', { debitWallet: async (...a) => { debits.push(a); } });
stub('../services/rateCard.service', { getRateForMessage: async () => 80 });
stub('../queues/broadcast.queue', { addToBroadcastQueue: async (job) => { queued.push(job); } });
stub('../services/broadcastAudience.service', {
  normalizeAudience: () => ({ filter: 'all_customers', params: {} }),
  resolveAudience: async () => [{ id: 'c1', whatsapp_number: '911', name: 'A' }],
  businessGroupIds: async () => []
});
const { createBroadcast, sendBroadcast } = require('./broadcast.controller');

const call = async (handler, req) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ user: { businessId: 'b' }, params: {}, body: {}, ...req }, res, (err) => { throw err; });
  return res;
};
const tpl = (status) => ({ id: 't', business_id: 'b', name: 'promo', status, category: 'MARKETING', language: 'en_US', body_text: 'Hi', header_type: 'NONE' });

test.beforeEach(() => { inserted.length = 0; queued.length = 0; debits.length = 0; billing = true; });

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
