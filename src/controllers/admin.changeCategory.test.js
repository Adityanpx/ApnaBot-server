// Run: node --test src/controllers/admin.changeCategory.test.js
// PUT /api/admin/businesses/:id/category: changes the category AND the business_travel_settings
// flags derived from it, validates the category, and drops the cached tenant. Services stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const tables = { businesses: [], business_travel_settings: [] };
let failTable = null; let invalidatedTenants; let invalidatedRules; let redisDown; let logs;

const from = (table) => {
  const filters = []; let payload = null;
  const run = () => {
    if (failTable === table && payload) return { data: null, error: new Error(`${table} write failed`) };
    const rows = tables[table].filter((r) => filters.every((f) => f(r)));
    if (payload) rows.forEach((r) => Object.assign(r, payload));
    return { data: rows.map((r) => ({ ...r })), error: null };
  };
  const q = {
    select: () => q,
    update: (row) => { payload = row; return q; },
    eq: (col, val) => { filters.push((r) => r[col] === val); return q; },
    maybeSingle: async () => { const out = run(); return { data: out.data ? out.data[0] || null : null, error: out.error }; },
    then: (resolve) => resolve(run())
  };
  return q;
};
stub('../config/supabase', { from });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: (...a) => logs.push(a) });
stub('../services/booking.service', {});
stub('../services/subscription.service', { invalidateSubscriptionCache: async () => {} });
stub('../services/tenant.service', {
  invalidateTenantCache: async (id) => { if (redisDown) throw new Error('redis down'); invalidatedTenants.push(id); }
});
stub('../services/admin.service', {});
stub('../services/business.service', {});
stub('../services/chatbot.service', { invalidateRulesCache: async (id) => { invalidatedRules.push(id); } });
stub('../services/razorpaySubscriptions.service', {});
stub('../services/businessCategory.service', { isKnownCategory: async (v) => ['general', 'travels', 'salon', 'multi_brand', 'cab'].includes(v) });

const { changeBusinessCategory } = require('./admin.controller');

const call = async (id, body) => {
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
  await changeBusinessCategory({ params: { id }, body, user: { userId: 'admin-1' } }, res, (e) => { throw e; });
  return out;
};

test.beforeEach(() => {
  tables.businesses = [
    { id: 'b1', business_category: 'general', sub_categories: [], phone_number_id: 'pn1' },
    { id: 'b2', business_category: 'general', sub_categories: [], phone_number_id: null }
  ];
  tables.business_travel_settings = [
    { business_id: 'b1', enable_fleet: false, enable_distance_fares: false, round_trip_driver_da_enabled: false, round_trip_per_day_km: 250 },
    { business_id: 'b2', enable_fleet: false, enable_distance_fares: false, round_trip_driver_da_enabled: false, round_trip_per_day_km: 250 }
  ];
  failTable = null; invalidatedTenants = []; invalidatedRules = []; redisDown = false; logs = [];
});

test('general -> travels: category changes and the travel flags are recomputed like signup would', async () => {
  const out = await call('b1', { businessCategory: 'travels' });
  assert.equal(out.status, 200);
  assert.equal(tables.businesses[0].business_category, 'travels');
  const flags = tables.business_travel_settings[0];
  assert.equal(flags.enable_fleet, true);
  assert.equal(flags.enable_distance_fares, true);
  assert.equal(flags.round_trip_driver_da_enabled, true);
  assert.equal(flags.round_trip_per_day_km, 250, 'fare values the flags do not cover are left alone');
  assert.equal(out.body.data.previousCategory, 'general');
  assert.equal(out.body.data.businessCategory, 'travels');
  assert.deepEqual(out.body.data.travelSettings, { enableFleet: true, enableDistanceFares: true, roundTripDriverDaEnabled: true });
  assert.equal(out.body.data.cacheInvalidated, true);
});

test('travels -> salon: the travel flags go back to off', async () => {
  tables.businesses[0].business_category = 'travels';
  Object.assign(tables.business_travel_settings[0], { enable_fleet: true, enable_distance_fares: true, round_trip_driver_da_enabled: true });
  assert.equal((await call('b1', { businessCategory: 'salon' })).status, 200);
  assert.deepEqual(
    [tables.business_travel_settings[0].enable_fleet, tables.business_travel_settings[0].enable_distance_fares, tables.business_travel_settings[0].round_trip_driver_da_enabled],
    [false, false, false]
  );
});

test('the cached tenant (by phone number id) and the rules cache are dropped; no WhatsApp number = nothing to drop', async () => {
  await call('b1', { businessCategory: 'salon' });
  assert.deepEqual(invalidatedTenants, ['pn1']);
  assert.deepEqual(invalidatedRules, ['b1']);
  invalidatedTenants = [];
  await call('b2', { businessCategory: 'salon' });
  assert.deepEqual(invalidatedTenants, []);
});

test('a Redis failure after the change does not turn it into an error', async () => {
  redisDown = true;
  const out = await call('b1', { businessCategory: 'salon' });
  assert.equal(out.status, 200);
  assert.equal(out.body.data.cacheInvalidated, false);
  assert.equal(tables.businesses[0].business_category, 'salon');
});

test('validation: missing / unknown category is a 400, multi_brand is refused, unknown business is a 404; nothing changes', async () => {
  assert.equal((await call('b1', {})).status, 400);
  assert.equal((await call('b1', { businessCategory: 5 })).status, 400);
  assert.equal((await call('b1', { businessCategory: 'spaceship' })).status, 400);
  assert.equal((await call('b1', { businessCategory: 'multi_brand' })).status, 400);
  assert.equal((await call('nope', { businessCategory: 'salon' })).status, 404);
  assert.equal(tables.businesses[0].business_category, 'general');
  assert.equal(tables.business_travel_settings[0].enable_fleet, false);
});

test('a failed travel-settings write is reported (so the admin repeats the request), and says so in the log', async () => {
  failTable = 'business_travel_settings';
  await assert.rejects(() => call('b1', { businessCategory: 'travels' }), /write failed/);
  assert.ok(logs.some((l) => String(l[0]).includes('repeat the request')));
  failTable = null;
  assert.equal((await call('b1', { businessCategory: 'travels' })).status, 200, 'the repeat finishes the job');
  assert.equal(tables.business_travel_settings[0].enable_fleet, true);
});

test('same category again is idempotent', async () => {
  assert.equal((await call('b1', { businessCategory: 'general' })).status, 200);
  assert.equal(tables.businesses[0].business_category, 'general');
});
