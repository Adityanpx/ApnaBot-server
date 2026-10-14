// Run: node --test src/controllers/subscription.controller.verify.test.js
// /verify trusts the order (plan, duration, business read back from Razorpay),
// not the client body; re-checks the downgrade guard; is idempotent.
// Also POST /payment-failed logging.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createFakeSupabase, stub } = require('../testUtils/fakeSupabase');

let fake;
let orders = {};
const created = [];
const warns = [];
const SECRET = 'test_secret';
stub('razorpay', function Razorpay() {
  return { orders: { fetch: async (id) => {
    if (!orders[id]) throw new Error('order not found');
    return orders[id];
  } } };
}, __filename);
stub('../config/env', { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: SECRET }, __filename);
stub('../config/supabase', { from: (t) => fake.from(t) }, __filename);
stub('../utils/logger', { info: () => {}, error: () => {}, warn: (...a) => warns.push(a) }, __filename);
stub('../config/redis', { get: async () => null, set: async () => {}, del: async () => {} }, __filename);
stub('../services/usage.service', {}, __filename);
stub('../services/subscription.service', {
  createSubscription: async (businessId, planId, o) => {
    created.push({ businessId, planId, o });
    const row = { id: `new-${created.length}`, business_id: businessId, plan_id: planId, status: 'active', razorpay_subscription_id: o.razorpaySubscriptionId };
    fake.db.subscriptions.push(row);
    return row;
  }
}, __filename);
stub('../services/razorpaySubscriptions.service', {}, __filename);
const ctrl = require('./subscription.controller');

const plans = [
  { id: 'basic', display_name: 'Basic', price: 199, is_active: true, duration_options: [{ months: 1, price: 199 }] },
  { id: 'biz', display_name: 'Business', price: 999, is_active: true, duration_options: [{ months: 1, price: 999 }, { months: 12, price: 9999 }] }
];
const sig = (orderId, paymentId) => crypto.createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex');
const order = (id, notes, amount = 19900) => ({ id, amount, currency: 'INR', notes });
const verifyBody = (orderId, extra = {}) => ({
  razorpay_order_id: orderId, razorpay_payment_id: 'pay_1', razorpay_signature: sig(orderId, 'pay_1'), ...extra
});
const call = async (handler, body = {}, businessId = 'b1') => {
  const out = { status: null, body: null, err: null };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  await handler({ user: { businessId }, body }, res, (e) => { out.err = e; });
  return out;
};

test.beforeEach(() => {
  created.length = 0; warns.length = 0;
  fake = createFakeSupabase({ plans, subscriptions: [] });
  orders = {
    order_basic: order('order_basic', { businessId: 'b1', planId: 'basic', durationMonths: '1' }),
    order_biz12: order('order_biz12', { businessId: 'b1', planId: 'biz', durationMonths: '12' }, 999900),
    order_other: order('order_other', { businessId: 'b2', planId: 'basic', durationMonths: '1' })
  };
});

test('happy path: activates the plan and duration stored on the order', async () => {
  const out = await call(ctrl.verifyAndActivate, verifyBody('order_biz12', { planId: 'biz', durationMonths: 12 }));
  assert.equal(out.err, null);
  assert.equal(out.status, 200);
  assert.equal(created.length, 1);
  assert.equal(created[0].planId, 'biz');
  assert.equal(created[0].o.durationMonths, 12);
  assert.equal(created[0].o.razorpaySubscriptionId, 'order_biz12');
});

test('uses the order\'s plan/duration when the body omits planId/durationMonths', async () => {
  const out = await call(ctrl.verifyAndActivate, verifyBody('order_biz12'));
  assert.equal(out.status, 200);
  assert.equal(created[0].planId, 'biz');
  assert.equal(created[0].o.durationMonths, 12);
});

test('pay a cheap order and claim a pricier plan -> 400, nothing activated', async () => {
  const out = await call(ctrl.verifyAndActivate, verifyBody('order_basic', { planId: 'biz', durationMonths: 1 }));
  assert.equal(out.status, 400);
  assert.match(out.body.message, /does not match what was paid for/);
  assert.equal(created.length, 0);
});

test('pay a 1-month order and claim 12 months of the same plan -> 400', async () => {
  const out = await call(ctrl.verifyAndActivate, verifyBody('order_basic', { planId: 'basic', durationMonths: 12 }));
  assert.equal(out.status, 400);
  assert.equal(created.length, 0);
});

test('an order created by another business is rejected with 403', async () => {
  const out = await call(ctrl.verifyAndActivate, verifyBody('order_other', { planId: 'basic' }));
  assert.equal(out.status, 403);
  assert.equal(created.length, 0);
});

test('a bad signature is rejected before the order is looked at', async () => {
  const out = await call(ctrl.verifyAndActivate, verifyBody('order_basic', { razorpay_signature: 'nope' }));
  assert.equal(out.status, 400);
  assert.match(out.body.message, /Invalid payment signature/);
  assert.equal(created.length, 0);
});

test('an order with no plan notes (not created by /create) is rejected', async () => {
  orders.order_bare = order('order_bare', { businessId: 'b1' });
  const out = await call(ctrl.verifyAndActivate, verifyBody('order_bare'));
  assert.equal(out.status, 400);
  assert.equal(created.length, 0);
});

test('downgrade guard is re-checked at verify: paid lower plan while a higher one runs -> 409 (payment-received message)', async () => {
  fake = createFakeSupabase({ plans, subscriptions: [
    { id: 's1', business_id: 'b1', plan_id: 'biz', status: 'active', end_date: '2099-02-05T11:00:00.000Z', created_at: '2026-10-08T00:00:00Z' }
  ] });
  const out = await call(ctrl.verifyAndActivate, verifyBody('order_basic', { planId: 'basic' }));
  assert.equal(out.status, 409);
  assert.match(out.body.message, /Business plan is active until/);
  assert.match(out.body.message, /payment was received/);
  assert.equal(created.length, 0);
});

test('verifying the same order twice is idempotent: one subscription, second call returns it', async () => {
  const first = await call(ctrl.verifyAndActivate, verifyBody('order_basic', { planId: 'basic' }));
  const second = await call(ctrl.verifyAndActivate, verifyBody('order_basic', { planId: 'basic' }));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(created.length, 1);
});

// ── POST /payment-failed ─────────────────────────────────────────
test('payment-failed logs the whitelisted fields, drops extras, caps length and strips newlines', async () => {
  const out = await call(ctrl.reportPaymentFailed, {
    code: 'BAD_REQUEST_ERROR', reason: 'payment_failed', source: 'issuer_bank', step: 'payment_authorization',
    description: 'x'.repeat(1000) + '\nFAKE LOG LINE', orderId: 'order_1', paymentId: 'pay_1', flow: 'onetime',
    razorpay_signature: 'secret-sig', password: 'hunter2', code2: 5
  });
  assert.equal(out.status, 200);
  const w = warns.find(a => /payment\.failed/.test(a[0]));
  assert.ok(w);
  const meta = w[1];
  assert.equal(meta.businessId, 'b1');
  assert.equal(meta.code, 'BAD_REQUEST_ERROR');
  assert.equal(meta.orderId, 'order_1');
  assert.equal(meta.description.length, 300);
  assert.ok(!/\n/.test(meta.description));
  assert.equal('razorpay_signature' in meta, false);
  assert.equal('password' in meta, false);
});

test('payment-failed ignores non-string values and an empty body', async () => {
  const out = await call(ctrl.reportPaymentFailed, { code: { a: 1 }, orderId: 42 });
  assert.equal(out.status, 200);
  const meta = warns.find(a => /payment\.failed/.test(a[0]))[1];
  assert.deepEqual(Object.keys(meta), ['businessId']);
  assert.equal((await call(ctrl.reportPaymentFailed, undefined)).status, 200);
});
