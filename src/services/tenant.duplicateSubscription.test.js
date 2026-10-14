// Run: node --test src/services/tenant.duplicateSubscription.test.js
// Webhook tenant resolution and requireFeature survive two active rows
// (the PGRST116 class that took down SG Travels on 2026-08-31).
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
const tenantService = require('./tenant.service');
const { requireFeature } = require('../middleware/plan.middleware');

const plans = [
  { id: 'basic', display_name: 'Basic', price: 199, booking_enabled: false },
  { id: 'biz', display_name: 'Business', price: 999, booking_enabled: true }
];
const subs = () => ([
  { id: 'old-business', business_id: 'b1', plan_id: 'biz', status: 'active', end_date: '2027-02-05T11:00:00Z', created_at: '2026-10-08T00:00:00Z' },
  { id: 'new-autopay', business_id: 'b1', plan_id: 'basic', status: 'active', end_date: '2026-10-14T09:00:59Z', created_at: '2026-10-14T09:00:59Z' },
  { id: 'pending', business_id: 'b1', plan_id: 'basic', status: 'pending_start', end_date: '2030-01-01T00:00:00Z', created_at: '2026-10-15T00:00:00Z' }
]);

test.beforeEach(() => redisStore.clear());

test('resolveBusinessByPhoneNumberId returns a tenant (Business plan) with two active rows', async () => {
  fake = createFakeSupabase({
    plans, subscriptions: subs(),
    businesses: [{ id: 'b1', name: 'X', phone_number_id: 'pn1', is_active: true, is_whatsapp_connected: true }]
  });
  const tenant = await tenantService.resolveBusinessByPhoneNumberId('pn1');
  assert.equal(tenant.subscription.id, 'old-business');
  assert.equal(tenant.plan.display_name, 'Business');
});

test('requireFeature does not throw with two active rows and gates on the picked (Business) plan', async () => {
  fake = createFakeSupabase({ plans, subscriptions: subs() });
  let nextCalled = false; let status = null;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  await requireFeature('booking')({ user: { role: 'owner', businessId: 'b1' } }, res, () => { nextCalled = true; });
  assert.equal(status, null);
  assert.equal(nextCalled, true);
});
