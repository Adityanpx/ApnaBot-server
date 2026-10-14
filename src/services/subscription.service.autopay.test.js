// Run: node --test src/services/subscription.service.autopay.test.js
// Autopay row status/window, getActiveSubscription duplicate handling, and
// the daily cron's rules (never deactivate a business with another live row;
// expire abandoned pending_start autopay rows).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase, stub } = require('../testUtils/fakeSupabase');

let fake;
const redisStore = new Map();
stub('../config/supabase', { from: (t) => fake.from(t) }, __filename);
stub('../config/redis', {
  get: async (k) => redisStore.get(k) || null,
  set: async (k, v) => { redisStore.set(k, v); },
  del: async (k) => { redisStore.delete(k); }
}, __filename);
stub('../utils/logger', { info: () => {}, error: () => {}, warn: () => {} }, __filename);
stub('./subscriptionNotifications.service', { sendSubscriptionPausedNotice: async () => {} }, __filename);
stub('./tenant.service', { invalidateTenantCache: async () => {} }, __filename);
const svc = require('./subscription.service');

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const row = (o) => ({ business_id: 'b1', plan_id: 'p1', status: 'active', is_autopay: false, created_at: iso(-30 * DAY), start_date: iso(-30 * DAY), end_date: iso(30 * DAY), ...o });

test.beforeEach(() => redisStore.clear());

// ── (a) autopay row ──────────────────────────────────────────────
test('autopay row is pending_start when the business has another live subscription', async () => {
  fake = createFakeSupabase({ subscriptions: [row({ id: 'old' })] });
  const sub = await svc.createAutopaySubscriptionRow('b1', 'p2', { razorpaySubscriptionId: 'sub_1', mandatedAmountPaise: 19900 });
  assert.equal(sub.status, 'pending_start');
  assert.equal(sub.is_autopay, true);
  assert.equal(fake.db.subscriptions.find(r => r.id === 'old').status, 'active'); // old one untouched
});

test('autopay row is active only when the business has no live subscription', async () => {
  fake = createFakeSupabase({ subscriptions: [row({ id: 'gone', status: 'expired' }), row({ id: 'lapsed', end_date: iso(-DAY) })] });
  const sub = await svc.createAutopaySubscriptionRow('b1', 'p2', { razorpaySubscriptionId: 'sub_1', mandatedAmountPaise: 19900 });
  assert.equal(sub.status, 'active');
});

test('a past_due row inside grace still counts as live', async () => {
  fake = createFakeSupabase({ subscriptions: [row({ id: 'late', status: 'past_due' })] });
  const sub = await svc.createAutopaySubscriptionRow('b1', 'p2', { razorpaySubscriptionId: 'sub_1', mandatedAmountPaise: 19900 });
  assert.equal(sub.status, 'pending_start');
});

test('end_date is a short window after start_date, never equal to it', async () => {
  fake = createFakeSupabase({ subscriptions: [] });
  const sub = await svc.createAutopaySubscriptionRow('b1', 'p2', { razorpaySubscriptionId: 'sub_1', mandatedAmountPaise: 19900 });
  const window = Date.parse(sub.end_date) - Date.parse(sub.start_date);
  assert.ok(window > 0 && window <= 7 * DAY, `window was ${window}ms`);
});

test('scheduled startAt rows stay pending_start with the window counted from startAt', async () => {
  fake = createFakeSupabase({ subscriptions: [] });
  const startAt = new Date(Date.now() + 10 * DAY);
  const sub = await svc.createAutopaySubscriptionRow('b1', 'p2', { razorpaySubscriptionId: 'sub_1', mandatedAmountPaise: 19900, startAt });
  assert.equal(sub.status, 'pending_start');
  assert.ok(Date.parse(sub.end_date) > startAt.getTime());
});

// ── (c) getActiveSubscription ────────────────────────────────────
test('getActiveSubscription does not throw on two active rows and prefers the later end_date', async () => {
  fake = createFakeSupabase({ plans: [{ id: 'p1', price: 999 }], subscriptions: [
    row({ id: 'business', end_date: iso(100 * DAY) }),
    row({ id: 'basic-autopay', end_date: iso(-1000), created_at: iso(-1000) })
  ] });
  const sub = await svc.getActiveSubscription('b1');
  assert.equal(sub.id, 'business');
});

// ── (c) cron ─────────────────────────────────────────────────────
test('cron: expired row with another unexpired active row does NOT deactivate the business', async () => {
  fake = createFakeSupabase({ businesses: [{ id: 'b1', is_active: true, phone_number_id: 'pn' }], subscriptions: [
    row({ id: 'lapsed', end_date: iso(-DAY) }),
    row({ id: 'current', end_date: iso(100 * DAY) })
  ] });
  await svc.runExpiryCheck();
  assert.equal(fake.db.subscriptions.find(r => r.id === 'lapsed').status, 'expired');
  assert.equal(fake.db.subscriptions.find(r => r.id === 'current').status, 'active');
  assert.equal(fake.db.businesses[0].is_active, true);
});

test('cron: an other trial row also keeps the business active', async () => {
  fake = createFakeSupabase({ businesses: [{ id: 'b1', is_active: true }], subscriptions: [
    row({ id: 'lapsed', end_date: iso(-DAY) }), row({ id: 'trial', status: 'trial', end_date: iso(5 * DAY) })
  ] });
  await svc.runExpiryCheck();
  assert.equal(fake.db.businesses[0].is_active, true);
});

test('cron: expired row with nothing else live still deactivates the business', async () => {
  fake = createFakeSupabase({ businesses: [{ id: 'b1', is_active: true }], subscriptions: [
    row({ id: 'lapsed', end_date: iso(-DAY) }), row({ id: 'cancelled', status: 'cancelled', end_date: iso(100 * DAY) })
  ] });
  await svc.runExpiryCheck();
  assert.equal(fake.db.businesses[0].is_active, false);
});

test('cron: grace-expired past_due row does not deactivate a business with another live row', async () => {
  fake = createFakeSupabase({ businesses: [{ id: 'b1', is_active: true }], subscriptions: [
    row({ id: 'late', status: 'past_due', grace_until: iso(-DAY) }), row({ id: 'current', end_date: iso(100 * DAY) })
  ] });
  await svc.runExpiryCheck();
  assert.equal(fake.db.subscriptions.find(r => r.id === 'late').status, 'paused');
  assert.equal(fake.db.businesses[0].is_active, true);
});

test('cron: abandoned pending_start autopay rows expire; future scheduled/non-autopay ones are left alone', async () => {
  fake = createFakeSupabase({ businesses: [{ id: 'b1', is_active: true }], subscriptions: [
    row({ id: 'current', end_date: iso(100 * DAY) }),
    row({ id: 'abandoned', status: 'pending_start', is_autopay: true, end_date: iso(-DAY) }),
    row({ id: 'scheduled', status: 'pending_start', is_autopay: true, end_date: iso(10 * DAY) }),
    row({ id: 'manual-pending', status: 'pending_start', is_autopay: false, end_date: iso(-DAY) })
  ] });
  const res = await svc.runExpiryCheck();
  const byId = (id) => fake.db.subscriptions.find(r => r.id === id).status;
  assert.equal(byId('abandoned'), 'expired');
  assert.equal(byId('scheduled'), 'pending_start');
  assert.equal(byId('manual-pending'), 'pending_start');
  assert.equal(res.stalePendingCount, 1);
  assert.equal(fake.db.businesses[0].is_active, true);
});
