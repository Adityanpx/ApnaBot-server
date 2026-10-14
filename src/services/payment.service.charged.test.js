// Run: node --test src/services/payment.service.charged.test.js
// subscription.charged on a cancelled/superseded row must not reactivate it —
// it cancels the still-charging mandate instead. payment.failed for a one-time
// payment is logged.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase, stub } = require('../testUtils/fakeSupabase');

let fake;
const rzpCancels = [];
let rzpCancelShouldFail = false;
const errors = [];
const warns = [];
stub('../config/env', { RAZORPAY_WEBHOOK_SECRET: 'x' }, __filename);
stub('../config/supabase', { from: (t) => fake.from(t) }, __filename);
stub('./business.service', {}, __filename);
stub('./usage.service', {}, __filename);
stub('./socket.service', {}, __filename);
stub('./subscription.service', { invalidateSubscriptionCache: async () => {} }, __filename);
stub('./tenant.service', { invalidateTenantCache: async () => {} }, __filename);
stub('./subscriptionNotifications.service', {}, __filename);
stub('./customerPipeline.service', {}, __filename);
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {} }, __filename);
stub('../utils/caseConvert', { toCamelCase: (x) => x }, __filename);
stub('../utils/systemMessages', { getSystemMessage: () => '' }, __filename);
stub('../utils/logger', { info: () => {}, error: (...a) => errors.push(a), warn: (...a) => warns.push(a) }, __filename);
stub('./razorpaySubscriptions.service', {
  cancelRazorpaySubscription: async (id, opts) => {
    rzpCancels.push({ id, opts });
    if (rzpCancelShouldFail) throw new Error('rzp down');
  }
}, __filename);
const { handleRazorpayWebhook } = require('./payment.service');

const charged = (rzpId) => ({ subscription: { entity: { id: rzpId, current_end: Math.floor(Date.parse('2026-12-14T00:00:00Z') / 1000) } } });
const seed = () => createFakeSupabase({
  webhook_events: [],
  businesses: [{ id: 'b1', is_active: false, phone_number_id: 'pn' }],
  subscriptions: [
    { id: 'superseded', business_id: 'b1', status: 'cancelled', razorpay_subscription_id: 'sub_old', end_date: '2026-10-01T00:00:00Z', grace_until: null },
    { id: 'live', business_id: 'b1', status: 'active', razorpay_subscription_id: 'sub_live', end_date: '2026-10-20T00:00:00Z', grace_until: null },
    { id: 'late', business_id: 'b1', status: 'past_due', razorpay_subscription_id: 'sub_late', end_date: '2026-10-01T00:00:00Z', grace_until: '2026-10-15T00:00:00Z' }
  ]
});
const row = (id) => fake.db.subscriptions.find(r => r.id === id);

test.beforeEach(() => { rzpCancels.length = 0; rzpCancelShouldFail = false; errors.length = 0; warns.length = 0; });

test('charged on a cancelled row: NOT reactivated, business not re-enabled, mandate cancelled at Razorpay, loud log', async () => {
  fake = seed();
  await handleRazorpayWebhook({ event: 'subscription.charged', payload: charged('sub_old') }, 'evt-1');
  assert.equal(row('superseded').status, 'cancelled');
  assert.equal(row('superseded').end_date, '2026-10-01T00:00:00Z');
  assert.equal(fake.db.businesses[0].is_active, false);
  assert.deepEqual(rzpCancels, [{ id: 'sub_old', opts: undefined }]);
  assert.ok(errors.some(e => /sub_old/.test(String(e[0])) && /refund/i.test(String(e[0]))));
});

test('a Razorpay cancel failure on that path is logged and does not throw', async () => {
  fake = seed();
  rzpCancelShouldFail = true;
  await handleRazorpayWebhook({ event: 'subscription.charged', payload: charged('sub_old') }, 'evt-2');
  assert.equal(row('superseded').status, 'cancelled');
  assert.ok(errors.length >= 2);
});

test('charged on a live or past_due row still extends it and clears grace (unchanged)', async () => {
  fake = seed();
  await handleRazorpayWebhook({ event: 'subscription.charged', payload: charged('sub_late') }, 'evt-3');
  assert.equal(row('late').status, 'active');
  assert.equal(row('late').grace_until, null);
  assert.equal(new Date(row('late').end_date).toISOString(), '2026-12-14T00:00:00.000Z');
  assert.equal(fake.db.businesses[0].is_active, true);
  assert.equal(rzpCancels.length, 0);
});

test('payment.failed for a one-time payment is logged with its error details', async () => {
  fake = seed();
  const payload = { payment: { entity: {
    id: 'pay_1', order_id: 'order_1', amount: 19900, method: 'upi',
    error_code: 'BAD_REQUEST_ERROR', error_reason: 'payment_failed', error_source: 'issuer_bank',
    error_step: 'payment_authorization', error_description: 'Payment failed'
  } } };
  await handleRazorpayWebhook({ event: 'payment.failed', payload }, 'evt-4');
  const w = warns.find(a => /one-time payment failed/.test(a[0]));
  assert.ok(w);
  assert.equal(w[1].orderId, 'order_1');
  assert.equal(w[1].code, 'BAD_REQUEST_ERROR');
  assert.equal(w[1].reason, 'payment_failed');
  assert.equal(w[1].source, 'issuer_bank');
  assert.equal(w[1].step, 'payment_authorization');
});
