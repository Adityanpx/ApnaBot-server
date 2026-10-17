// Run: node --test src/services/subscription.service.trial.test.js
// A 'trial' subscription is a live subscription: the daily expiry cron expires it (and
// deactivates the business, with the plan_expired push), plan_expiring fires for it, and the
// webhook tenant lookup / plan middleware / getActiveSubscription treat it as live.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFakeSupabase } = require('../test-support/fakeSupabase');

let fake; let expiredNotices; let notified;
const stubModule = (file, exports) => {
  const p = require.resolve(path.join(__dirname, file));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stubModule('../config/supabase.js', { from: (t) => fake.from(t), rpc: (n, a) => fake.rpc(n, a) });
stubModule('../config/redis.js', { get: async () => null, set: async () => {}, del: async () => {} });
stubModule('../utils/logger.js', { info: () => {}, warn: () => {}, error: () => {} });
stubModule('../config/env.js', {});
stubModule('../utils/crypto.js', { encrypt: (v) => v });
stubModule('./whatsapp.service.js', {});
stubModule('./notification.service.js', { notifyOnce: async (...a) => { notified.push(a); } });
stubModule('./razorpaySubscriptions.service.js', { cancelRazorpaySubscription: async () => {} });

const notifications = require('./subscriptionNotifications.service');
// runExpiryCheck calls sendPlanExpiredNotice on the real module; spy on it.
const realExpired = notifications.sendPlanExpiredNotice;
notifications.sendPlanExpiredNotice = (businessId, subId) => { expiredNotices.push([businessId, subId]); };
test.after(() => { notifications.sendPlanExpiredNotice = realExpired; });

const subscriptionService = require('./subscription.service');
const { getCurrentSubscriptionRow } = require('./currentSubscription.service');

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const seed = (subscriptions) => {
  fake = createFakeSupabase({});
  fake.db.businesses = [{ id: 'b1', is_active: true, phone_number_id: 'pn1' }, { id: 'b2', is_active: true, phone_number_id: 'pn2' }];
  fake.db.plans = [{ id: 'basic', name: 'basic' }];
  fake.db.subscriptions = subscriptions;
  expiredNotices = []; notified = [];
};
const row = (over) => ({ plan_id: 'basic', is_autopay: false, ...over });

test('runExpiryCheck expires an ended trial, deactivates the business and sends the plan_expired push', async () => {
  seed([row({ id: 't1', business_id: 'b1', status: 'trial', end_date: iso(-DAY) })]);
  const result = await subscriptionService.runExpiryCheck();
  assert.equal(result.expiredCount, 1);
  assert.equal(fake.db.subscriptions[0].status, 'expired');
  assert.equal(fake.db.businesses.find((b) => b.id === 'b1').is_active, false);
  assert.deepEqual(expiredNotices, [['b1', 't1']]);
});

test('runExpiryCheck leaves a running trial alone, and does not deactivate a business another live row covers', async () => {
  seed([
    row({ id: 't-running', business_id: 'b1', status: 'trial', end_date: iso(2 * DAY) }),
    row({ id: 't-ended', business_id: 'b2', status: 'trial', end_date: iso(-DAY) }),
    row({ id: 'paid', business_id: 'b2', status: 'active', end_date: iso(20 * DAY) })
  ]);
  await subscriptionService.runExpiryCheck();
  const status = (id) => fake.db.subscriptions.find((s) => s.id === id).status;
  assert.equal(status('t-running'), 'trial');
  assert.equal(status('t-ended'), 'expired');
  assert.equal(fake.db.businesses.find((b) => b.id === 'b1').is_active, true);
  assert.equal(fake.db.businesses.find((b) => b.id === 'b2').is_active, true); // covered by the paid row
  assert.deepEqual(expiredNotices, []);
});

test('plan_expiring fires for a trial ending within 3 days (once, to the right business), not for a longer one', async () => {
  seed([
    row({ id: 't-soon', business_id: 'b1', status: 'trial', end_date: iso(2 * DAY) }),
    row({ id: 't-later', business_id: 'b2', status: 'trial', end_date: iso(6 * DAY) })
  ]);
  await notifications.sendPlanExpiringNotices();
  assert.equal(notified.length, 1);
  assert.equal(notified[0][0], 'b1');
  assert.equal(notified[0][1], 'plan_expiring');
  assert.equal(notified[0][3], 't-soon');
});

test('getActiveSubscription and the tenant/plan lookups treat a trial row as live', async () => {
  seed([row({ id: 't1', business_id: 'b1', status: 'trial', end_date: iso(3 * DAY) })]);
  const active = await subscriptionService.getActiveSubscription('b1');
  assert.equal(active.id, 't1');
  const current = await getCurrentSubscriptionRow('b1', { statuses: ['active', 'trial'] });
  assert.equal(current.data.id, 't1');
});

test('createSubscription({ durationDays }) ends the period that many days out', async () => {
  seed([]);
  const sub = await subscriptionService.createSubscription('b1', 'basic', { status: 'trial', durationDays: 7 });
  assert.ok(Math.abs((new Date(sub.end_date) - new Date(sub.start_date)) / DAY - 7) < 0.01);
  assert.equal(sub.status, 'trial');
});
