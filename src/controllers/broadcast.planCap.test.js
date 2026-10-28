// Run: node --test src/controllers/broadcast.planCap.test.js
// The plan's broadcast_recipient_limit on sendBroadcast and audience-summary: Basic 100 / Pro 500 /
// Business -1 (env cap), min(plan, env), and no subscription = env cap only.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const draft = { id: 'bc', business_id: 'b', template_id: 't', status: 'draft', template_variables: [] };
let broadcastState;
const template = { id: 't', business_id: 'b', name: 'promo', status: 'approved', send_support: 'ok', category: 'MARKETING', language: 'en_US', body_text: 'Hi', header_type: 'NONE' };
stub('../config/supabase', {
  from: (table) => {
    const filters = [];
    let patch = null;
    const run = () => {
      if (table !== 'broadcasts') return { data: template, error: null };
      if (!filters.every(([c, v]) => broadcastState[c] === v)) return { data: null, error: null };
      if (patch) { Object.assign(broadcastState, patch); patch = null; }
      return { data: { ...broadcastState }, error: null };
    };
    const q = {
      select: () => q, eq: (c, v) => { filters.push([c, v]); return q; }, update: (p) => { patch = p; return q; },
      single: async () => run(), maybeSingle: async () => run(), then: (resolve) => resolve(run())
    };
    return q;
  }
});
stub('../config/env', { WALLET_BILLING_ENABLED: false, MAX_BROADCAST_RECIPIENTS: 2000 });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/business.service', { getBusinessById: async () => ({ isWhatsappConnected: true, phoneNumberId: 'p', accessToken: 'x' }) });
stub('../services/wallet.service', { debitWallet: async () => {}, refundToWallet: async () => {}, getOrCreateWallet: async () => ({ balance_paise: 5 }) });
stub('../services/rateCard.service', { getRateForMessage: async () => 0 });
const queued = [];
stub('../queues/broadcast.queue', { addToBroadcastQueue: async (job) => { queued.push(job); } });
let audience = [];
let summary = { selected: 0, willReceive: 0, skipped: {} };
stub('../services/broadcastAudience.service', {
  normalizeAudience: () => ({ filter: 'all_customers', params: {} }),
  resolveAudience: async () => audience,
  audienceSummary: async () => summary,
  businessGroupIds: async () => [],
  businessCustomerIds: async () => [],
  audienceSkipped: async () => ({ items: [], total: 0 }),
  SKIP_REASONS: [],
  requiresMarketingOptIn: () => true,
  templateCategory: async () => 'MARKETING'
});
stub('../services/broadcastProgress.service', { getBroadcastStats: async () => ({}), notifyBroadcastProgress: () => {} });
let subResult;
stub('../services/currentSubscription.service', { getCurrentSubscriptionRow: async () => subResult });
const { sendBroadcast, getAudienceSummary } = require('./broadcast.controller');

const call = async (handler, body = {}) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ user: { businessId: 'b' }, params: { id: 'bc' }, body }, res, (err) => { throw err; });
  return res;
};
const withPlan = (limit, display_name) => { subResult = { data: { plan: { display_name, broadcast_recipient_limit: limit } }, error: null }; };
const people = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, whatsapp_number: `91${i}`, name: 'A' }));

test.beforeEach(() => { broadcastState = { ...draft }; queued.length = 0; subResult = { data: null, error: null }; });

test('send: Basic (100) - 100 recipients go, 101 is a 403 PLAN_BROADCAST_LIMIT and nothing is claimed or queued', async () => {
  withPlan(100, 'Basic');
  audience = people(100);
  assert.equal((await call(sendBroadcast)).statusCode, 200);
  assert.ok(queued.length > 0);

  broadcastState = { ...draft }; queued.length = 0; audience = people(101);
  const res = await call(sendBroadcast);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.message, 'This plan sends a broadcast to up to 100 customers. Upgrade for more.');
  assert.deepEqual(res.body.errors, { code: 'PLAN_BROADCAST_LIMIT', limit: 100, plan: 'Basic' });
  assert.equal(broadcastState.status, 'draft', 'the draft is untouched');
  assert.equal(queued.length, 0);
});

test('send: Pro (500) refuses 501', async () => {
  withPlan(500, 'Pro');
  audience = people(501);
  const res = await call(sendBroadcast);
  assert.deepEqual([res.statusCode, res.body.errors.limit], [403, 500]);
  audience = people(500);
  assert.equal((await call(sendBroadcast)).statusCode, 200);
});

test('send: Business (-1) is held only by the env cap (2000, the old 400 message)', async () => {
  withPlan(-1, 'Business');
  audience = people(1500);
  assert.equal((await call(sendBroadcast)).statusCode, 200);
  broadcastState = { ...draft }; audience = people(2001);
  const res = await call(sendBroadcast);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /exceeds the current limit of 2000\. Contact support/);
  assert.equal(res.body.errors, null);
});

test('send: no active subscription = env cap only, so a live account loses nothing on deploy', async () => {
  audience = people(250);
  assert.equal((await call(sendBroadcast)).statusCode, 200);
});

test('audience-summary: cap and overCap follow the plan', async () => {
  summary = { selected: 150, willReceive: 120, skipped: {} };
  withPlan(100, 'Basic');
  let res = await call(getAudienceSummary);
  assert.deepEqual([res.body.data.cap, res.body.data.overCap], [100, true]);
  summary = { selected: 100, willReceive: 100, skipped: {} };
  assert.equal((await call(getAudienceSummary)).body.data.overCap, false);
  withPlan(500, 'Pro');
  summary = { selected: 150, willReceive: 120, skipped: {} };
  res = await call(getAudienceSummary);
  assert.deepEqual([res.body.data.cap, res.body.data.overCap], [500, false]);
  withPlan(-1, 'Business');
  assert.equal((await call(getAudienceSummary)).body.data.cap, 2000);
  subResult = { data: null, error: null };
  assert.equal((await call(getAudienceSummary)).body.data.cap, 2000);
});
