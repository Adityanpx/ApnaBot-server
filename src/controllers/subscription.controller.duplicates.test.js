// Run: node --test src/controllers/subscription.controller.duplicates.test.js
// Billing page + cancel-auto-renew survive two live rows; autopay create
// refuses a downgrade while a higher paid plan is running.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase, stub } = require('../testUtils/fakeSupabase');

let fake;
const created = [];
const cancelled = [];
stub('razorpay', function Razorpay() { return {}; }, __filename);
stub('../config/env', { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 's' }, __filename);
stub('../config/supabase', { from: (t) => fake.from(t) }, __filename);
stub('../utils/logger', { info: () => {}, error: () => {}, warn: () => {} }, __filename);
stub('../config/redis', { get: async () => null, set: async () => {}, del: async () => {} }, __filename);
stub('../services/usage.service', { getUsageForBusiness: async () => ({ used: 1 }) }, __filename);
stub('../services/subscription.service', {
  createAutopaySubscriptionRow: async (b, p, o) => { created.push({ b, p, o }); return { id: 'row1' }; }
}, __filename);
stub('../services/razorpaySubscriptions.service', {
  getOrCreateRazorpayPlan: async () => 'plan_rzp',
  createRazorpaySubscription: async () => ({ id: 'sub_new', short_url: 'https://rzp.io/x' }),
  cancelRazorpaySubscription: async (id, o) => { cancelled.push({ id, o }); }
}, __filename);
const ctrl = require('./subscription.controller');

const plans = [
  { id: 'basic', display_name: 'Basic', price: 199, is_active: true, duration_options: [{ months: 1, price: 199 }] },
  { id: 'biz', display_name: 'Business', price: 999, is_active: true, duration_options: [{ months: 1, price: 999 }] }
];
const futureIso = (days) => new Date(Date.now() + days * 86400000).toISOString();
const twoRows = () => ([
  { id: 'old-business', business_id: 'b1', plan_id: 'biz', status: 'active', is_autopay: false, auto_renew: true, end_date: '2027-02-05T11:00:00.000Z', created_at: '2026-10-08T00:00:00Z' },
  { id: 'new-autopay', business_id: 'b1', plan_id: 'basic', status: 'active', is_autopay: true, auto_renew: true, razorpay_subscription_id: 'sub_x', end_date: '2026-10-14T09:00:59Z', created_at: '2026-10-14T09:00:59Z' }
]);

const call = async (handler, body = {}) => {
  const out = { status: null, body: null, err: null };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  await handler({ user: { businessId: 'b1' }, body }, res, (e) => { out.err = e; });
  return out;
};

test.beforeEach(() => { created.length = 0; cancelled.length = 0; });

// ── (c) lookups ──────────────────────────────────────────────────
test('getCurrentSubscription returns the Business row instead of PGRST116 when two rows are active', async () => {
  fake = createFakeSupabase({ plans, subscriptions: twoRows() });
  const out = await call(ctrl.getCurrentSubscription);
  assert.equal(out.err, null);
  assert.equal(out.status, 200);
  const data = out.body.data;
  assert.equal(data.subscription.id, 'old-business');
  assert.equal(data.isActive, true);
});

test('cancelAutoRenew works with two live rows (no PGRST116 / false 404)', async () => {
  fake = createFakeSupabase({ plans, subscriptions: twoRows() });
  const out = await call(ctrl.cancelAutoRenew);
  assert.equal(out.err, null);
  assert.equal(out.status, 200);
  // The picked row is the Business one (later end_date); it's non-autopay so no Razorpay call.
  assert.equal(fake.db.subscriptions.find(r => r.id === 'old-business').auto_renew, false);
  assert.equal(cancelled.length, 0);
});

// ── (b) downgrade guard ─────────────────────────────────────────
test('autopay create rejects a LOWER plan while a higher paid plan is active, naming the end date', async () => {
  fake = createFakeSupabase({ plans, subscriptions: [twoRows()[0]] });
  const out = await call(ctrl.createAutopaySubscription, { planId: 'basic' });
  assert.equal(out.status, 409);
  assert.match(out.body.message, /Business plan is active until 5 Feb 2027/);
  assert.match(out.body.message, /Basic/);
  assert.equal(created.length, 0);   // nothing created at Razorpay / in the DB
});

test('autopay create allows the same plan', async () => {
  fake = createFakeSupabase({ plans, subscriptions: [twoRows()[0]] });
  const out = await call(ctrl.createAutopaySubscription, { planId: 'biz' });
  assert.equal(out.status, 200);
  assert.equal(created.length, 1);
});

test('autopay create allows a higher plan', async () => {
  const basicRow = { ...twoRows()[1], end_date: futureIso(10) };
  fake = createFakeSupabase({ plans, subscriptions: [basicRow] });
  const out = await call(ctrl.createAutopaySubscription, { planId: 'biz' });
  assert.equal(out.status, 200);
  assert.equal(created.length, 1);
});

test('autopay create is not blocked by an ended higher plan', async () => {
  const ended = { ...twoRows()[0], end_date: '2026-09-01T00:00:00Z', status: 'active' };
  fake = createFakeSupabase({ plans, subscriptions: [ended] });
  const out = await call(ctrl.createAutopaySubscription, { planId: 'basic' });
  assert.equal(out.status, 200);
});
