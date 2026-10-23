// Run: node --test src/services/payment.service.activated.test.js
// subscription.activated: activates the new row and retires the business's
// other active/trial rows (cancelling their Razorpay autopay).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase, stub } = require('../testUtils/fakeSupabase');

let fake;
const rzpCancels = [];
let rzpCancelShouldFail = false;
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
stub('../utils/logger', { info: () => {}, error: () => {}, warn: () => {} }, __filename);
stub('./razorpaySubscriptions.service', {
  cancelRazorpaySubscription: async (id, opts) => {
    rzpCancels.push({ id, opts });
    if (rzpCancelShouldFail) throw new Error('rzp down');
  }
}, __filename);
const { handleRazorpayWebhook } = require('./payment.service');

const activated = (rzpId, n) => ({
  event: 'subscription.activated',
  payload: { subscription: { entity: { id: rzpId, current_end: Math.floor(Date.parse('2026-11-14T00:00:00Z') / 1000) } } },
  eventId: `evt-${n}`
});
const send = (e) => handleRazorpayWebhook({ event: e.event, payload: e.payload }, e.eventId);
const seed = () => createFakeSupabase({
  webhook_events: [],
  businesses: [{ id: 'b1', is_active: true, phone_number_id: 'pn' }, { id: 'b2', is_active: true, phone_number_id: 'pn2' }],
  subscriptions: [
    { id: 'old-legacy', business_id: 'b1', status: 'active', is_autopay: false, razorpay_subscription_id: null },
    { id: 'old-trial', business_id: 'b1', status: 'trial', is_autopay: false, razorpay_subscription_id: null },
    { id: 'old-autopay', business_id: 'b1', status: 'active', is_autopay: true, razorpay_subscription_id: 'sub_old' },
    { id: 'new', business_id: 'b1', status: 'pending_start', is_autopay: true, razorpay_subscription_id: 'sub_new' },
    { id: 'history', business_id: 'b1', status: 'expired', is_autopay: false, razorpay_subscription_id: null },
    { id: 'other-biz', business_id: 'b2', status: 'active', is_autopay: true, razorpay_subscription_id: 'sub_b2' }
  ]
});
const status = (id) => fake.db.subscriptions.find(r => r.id === id).status;

test.beforeEach(() => { rzpCancels.length = 0; rzpCancelShouldFail = false; });

test('activation activates the new row and cancels the business\'s other active/trial rows', async () => {
  fake = seed();
  await send(activated('sub_new', 1));
  assert.equal(status('new'), 'active');
  assert.equal(status('old-legacy'), 'cancelled');
  assert.equal(status('old-trial'), 'cancelled');
  assert.equal(status('old-autopay'), 'cancelled');
  assert.equal(status('history'), 'expired');       // history untouched
  assert.equal(status('other-biz'), 'active');      // other businesses untouched
});

test('the old autopay mandate is cancelled at Razorpay (immediately); legacy rows trigger no Razorpay call', async () => {
  fake = seed();
  await send(activated('sub_new', 2));
  assert.deepEqual(rzpCancels, [{ id: 'sub_old', opts: undefined }]);
});

test('a Razorpay cancel failure is logged, the DB rows are still cancelled, the event does not throw', async () => {
  fake = seed();
  rzpCancelShouldFail = true;
  await send(activated('sub_new', 3));
  assert.equal(status('old-autopay'), 'cancelled');
  assert.equal(status('new'), 'active');
});

test('a re-delivered activation event is a no-op (idempotency unchanged)', async () => {
  fake = seed();
  await send(activated('sub_new', 4));
  rzpCancels.length = 0;
  await send(activated('sub_new', 4));
  assert.equal(rzpCancels.length, 0);
});

test('activation sets current_period_start to Razorpay\'s cycle start (the real start of the counter period)', async () => {
  fake = seed();
  const e = activated('sub_new', 5);
  e.payload.subscription.entity.current_start = Math.floor(Date.parse('2026-10-14T06:30:00Z') / 1000);
  await send(e);
  const row = fake.db.subscriptions.find(r => r.id === 'new');
  assert.equal(new Date(row.current_period_start).toISOString(), '2026-10-14T06:30:00.000Z');
  assert.equal(new Date(row.end_date).toISOString(), '2026-11-14T00:00:00.000Z');
});

test('activation without current_start leaves current_period_start unset (readers fall back to start_date)', async () => {
  fake = seed();
  await send(activated('sub_new', 6));
  assert.equal(fake.db.subscriptions.find(r => r.id === 'new').current_period_start, undefined);
});
