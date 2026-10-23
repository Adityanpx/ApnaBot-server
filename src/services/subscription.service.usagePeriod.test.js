// Run: node --test src/services/subscription.service.usagePeriod.test.js
// createSubscription sets subscriptions.current_period_start (the message counter's period): a new period for a
// first purchase, a renewal after expiry, a reactivation and trial -> paid; a stacked early renewal (same plan,
// bought before the running one ends) keeps the running period, so buying early never resets the counter.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase, stub } = require('../testUtils/fakeSupabase');
const { resolvePeriod } = require('../utils/usagePeriod');

let fake;
stub('../config/supabase', { from: (t) => fake.from(t) }, __filename);
stub('../config/redis', { get: async () => null, set: async () => {}, del: async () => {} }, __filename);
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} }, __filename);
stub('./subscriptionNotifications.service', {}, __filename);
stub('./tenant.service', { invalidateTenantCache: async () => {} }, __filename);
stub('./razorpaySubscriptions.service', { cancelRazorpaySubscription: async () => {} }, __filename);
const svc = require('./subscription.service');

const NOW = '2026-10-20T10:00:00.000Z';
const seed = (subscriptions) => createFakeSupabase({ businesses: [{ id: 'b1', phone_number_id: 'pn' }], subscriptions });

test.beforeEach((t) => { t.mock.timers.enable({ apis: ['Date'], now: new Date(NOW) }); });

test('first purchase: the period starts now', async () => {
  fake = seed([]);
  const sub = await svc.createSubscription('b1', 'pro', { status: 'active' });
  assert.equal(sub.current_period_start, NOW);
});

test('renewal after expiry: a new period starts now (the old one was long over)', async () => {
  fake = seed([{ id: 'old', business_id: 'b1', plan_id: 'pro', status: 'expired', start_date: '2026-08-01T00:00:00.000Z', current_period_start: '2026-08-01T00:00:00.000Z', end_date: '2026-09-01T00:00:00.000Z' }]);
  const sub = await svc.createSubscription('b1', 'pro', { status: 'active' });
  assert.equal(sub.current_period_start, NOW);
});

test('an active row whose end_date has passed (cron not run yet) renews into a new period', async () => {
  fake = seed([{ id: 'old', business_id: 'b1', plan_id: 'pro', status: 'active', start_date: '2026-09-01T00:00:00.000Z', current_period_start: '2026-09-01T00:00:00.000Z', end_date: '2026-10-01T00:00:00.000Z' }]);
  const sub = await svc.createSubscription('b1', 'pro', { status: 'active' });
  assert.equal(sub.current_period_start, NOW);
});

test('reactivation on a different plan: a new period starts now', async () => {
  fake = seed([{ id: 'old', business_id: 'b1', plan_id: 'basic', status: 'active', start_date: '2026-10-01T00:00:00.000Z', current_period_start: '2026-10-01T00:00:00.000Z', end_date: '2026-11-01T00:00:00.000Z' }]);
  const sub = await svc.createSubscription('b1', 'pro', { status: 'active' });
  assert.equal(sub.current_period_start, NOW);
});

test('trial -> paid (same plan id): the trial is not an active row, so the paid period starts now', async () => {
  fake = seed([{ id: 'trial', business_id: 'b1', plan_id: 'basic', status: 'trial', start_date: '2026-10-10T00:00:00.000Z', current_period_start: '2026-10-10T00:00:00.000Z', end_date: '2026-10-24T00:00:00.000Z' }]);
  const sub = await svc.createSubscription('b1', 'basic', { status: 'active' });
  assert.equal(sub.current_period_start, NOW);
});

test('a trial starts its own period now', async () => {
  fake = seed([]);
  const sub = await svc.createSubscription('b1', 'basic', { status: 'trial', durationDays: 14, autoRenew: false });
  assert.equal(sub.current_period_start, NOW);
});

test('stacked early renewal: keeps the running period, and the counter period only moves when the next month actually starts', async () => {
  fake = seed([{ id: 'running', business_id: 'b1', plan_id: 'pro', status: 'active', start_date: '2026-10-01T00:00:00.000Z', current_period_start: '2026-10-01T00:00:00.000Z', end_date: '2026-11-01T00:00:00.000Z' }]);
  const sub = await svc.createSubscription('b1', 'pro', { status: 'active' });
  assert.equal(sub.current_period_start, '2026-10-01T00:00:00.000Z');
  assert.equal(sub.end_date, '2026-12-01T00:00:00.000Z');
  // still the October period right after buying, and on Oct 31; November starts on Nov 1
  assert.equal(resolvePeriod(sub, new Date(NOW)).periodStart.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(resolvePeriod(sub, new Date('2026-10-31T23:59:00Z')).periodStart.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(resolvePeriod(sub, new Date('2026-11-01T00:00:00Z')).periodStart.toISOString(), '2026-11-01T00:00:00.000Z');
});

test('stacking on a row from before the column existed (no current_period_start) carries its start_date', async () => {
  fake = seed([{ id: 'running', business_id: 'b1', plan_id: 'pro', status: 'active', start_date: '2026-10-05T00:00:00.000Z', current_period_start: null, end_date: '2026-11-05T00:00:00.000Z' }]);
  const sub = await svc.createSubscription('b1', 'pro', { status: 'active' });
  assert.equal(sub.current_period_start, '2026-10-05T00:00:00.000Z');
});
