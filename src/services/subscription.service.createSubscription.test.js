// Run: node --test src/services/subscription.service.createSubscription.test.js
// One-time purchase (createSubscription, used by /verify) retires the business's
// other live rows and cancels any autopay mandate at Razorpay.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase, stub } = require('../testUtils/fakeSupabase');

let fake;
const rzpCancels = [];
let rzpCancelShouldFail = false;
const errors = [];
stub('../config/supabase', { from: (t) => fake.from(t) }, __filename);
stub('../config/redis', { get: async () => null, set: async () => {}, del: async () => {} }, __filename);
stub('../utils/logger', { info: () => {}, warn: () => {}, error: (...a) => errors.push(a) }, __filename);
stub('./subscriptionNotifications.service', {}, __filename);
stub('./tenant.service', { invalidateTenantCache: async () => {} }, __filename);
stub('./razorpaySubscriptions.service', {
  cancelRazorpaySubscription: async (id, opts) => {
    rzpCancels.push({ id, opts });
    if (rzpCancelShouldFail) throw new Error('rzp down');
  }
}, __filename);
const svc = require('./subscription.service');

const seed = () => createFakeSupabase({
  businesses: [{ id: 'b1', phone_number_id: 'pn' }, { id: 'b2', phone_number_id: 'pn2' }],
  subscriptions: [
    { id: 'autopay-active', business_id: 'b1', status: 'active', is_autopay: true, razorpay_subscription_id: 'sub_a', plan_id: 'basic', end_date: '2099-01-01T00:00:00Z' },
    { id: 'autopay-pastdue', business_id: 'b1', status: 'past_due', is_autopay: true, razorpay_subscription_id: 'sub_pd' },
    { id: 'autopay-pending', business_id: 'b1', status: 'pending_start', is_autopay: true, razorpay_subscription_id: 'sub_p' },
    { id: 'trial', business_id: 'b1', status: 'trial', is_autopay: false, razorpay_subscription_id: null },
    { id: 'legacy', business_id: 'b1', status: 'active', is_autopay: false, razorpay_subscription_id: 'order_old' },
    { id: 'history', business_id: 'b1', status: 'expired', is_autopay: true, razorpay_subscription_id: 'sub_h' },
    { id: 'other-biz', business_id: 'b2', status: 'active', is_autopay: true, razorpay_subscription_id: 'sub_b2' }
  ]
});
const status = (id) => fake.db.subscriptions.find(r => r.id === id).status;

test.beforeEach(() => { rzpCancels.length = 0; rzpCancelShouldFail = false; errors.length = 0; });

test('a one-time purchase cancels every old autopay mandate (active, past_due, pending_start) at Razorpay and marks all live rows cancelled', async () => {
  fake = seed();
  const sub = await svc.createSubscription('b1', 'biz', { status: 'active', razorpaySubscriptionId: 'order_new', durationMonths: 3 });
  assert.deepEqual(rzpCancels.map(c => c.id).sort(), ['sub_a', 'sub_p', 'sub_pd']);
  for (const id of ['autopay-active', 'autopay-pastdue', 'autopay-pending', 'trial', 'legacy']) assert.equal(status(id), 'cancelled', id);
  assert.equal(status('history'), 'expired');      // history untouched
  assert.equal(status('other-biz'), 'active');     // other businesses untouched
  assert.equal(sub.status, 'active');
  assert.equal(sub.razorpay_subscription_id, 'order_new');
});

test('a Razorpay cancel failure is logged loudly (naming the mandate); the DB rows are still cancelled and the purchase still succeeds', async () => {
  fake = seed();
  rzpCancelShouldFail = true;
  const sub = await svc.createSubscription('b1', 'biz', { status: 'active', razorpaySubscriptionId: 'order_new' });
  assert.equal(status('autopay-active'), 'cancelled');
  assert.equal(sub.status, 'active');
  assert.ok(errors.some(e => /sub_a/.test(String(e[0]))), 'error log names mandate sub_a');
});

test('a business with no autopay row makes no Razorpay call', async () => {
  fake = createFakeSupabase({
    businesses: [{ id: 'b1', phone_number_id: 'pn' }],
    subscriptions: [{ id: 'legacy', business_id: 'b1', status: 'active', is_autopay: false, razorpay_subscription_id: 'order_old' }]
  });
  await svc.createSubscription('b1', 'biz', { status: 'active' });
  assert.equal(rzpCancels.length, 0);
  assert.equal(status('legacy'), 'cancelled');
});
