// Run: node --test src/services/adminBusinessList.service.test.js
// Super Admin businesses list: filter parsing, the combined filter (incl. owner name / email / phone
// search) and the owner / current-subscription lookups.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeAdminDb } = require('../test-support/fakeAdminBusinessDb');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const tables = { businesses: [], users: [], subscriptions: [] };
const log = {};
const fakeDb = createFakeAdminDb(tables, log);
stub('../config/supabase', fakeDb);
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });

const svc = require('./adminBusinessList.service');

const run = async (query) => {
  const apply = await svc.buildBusinessFilter(svc.parseBusinessFilters(query));
  const out = await apply(fakeDb.from('businesses').select('*'));
  return out.data.map((b) => b.id);
};

const plan = (name) => ({ id: `plan-${name}`, name, display_name: name.toUpperCase() });

test.beforeEach(() => {
  for (const k of Object.keys(log)) delete log[k];
  tables.businesses = [
    { id: 'b1', name: 'Sai Travels', city: 'Pune', owner_user_id: 'u1', business_category: 'travels', is_active: true, is_whatsapp_connected: true },
    { id: 'b2', name: 'Moon Salon', city: 'Nashik', owner_user_id: 'u2', business_category: 'salon', is_active: false, is_whatsapp_connected: false },
    { id: 'b3', name: 'Cafe Katta', city: 'Delhi', owner_user_id: 'u3', business_category: 'general', is_active: true, is_whatsapp_connected: false }
  ];
  tables.users = [
    { id: 'u1', name: 'Ravi Patil', email: 'ravi@example.com', phone: '+919876543210', role: 'owner' },
    { id: 'u2', name: 'Asha', email: 'asha.k@example.com', phone: null, role: 'owner' },
    { id: 'u3', name: 'Dev', email: 'dev@example.com', phone: '+919111111111', role: 'owner' },
    { id: 's1', name: 'Ravi Staff', email: 'staff@example.com', phone: '+919222222222', role: 'staff' }
  ];
  tables.subscriptions = [];
});

test('parseBusinessFilters: booleans only from "true" / "false", unknown values dropped', () => {
  assert.deepEqual(svc.parseBusinessFilters({ isActive: 'true', connected: 'false', businessCategory: 'salon', search: ' a,b ' }),
    { search: 'a b', isActive: true, connected: false, businessCategory: 'salon' });
  assert.deepEqual(svc.parseBusinessFilters({ isActive: 'yes', connected: ['true'], businessCategory: ['x'] }),
    { search: '', isActive: undefined, connected: undefined, businessCategory: undefined });
  assert.equal(svc.parseBusinessFilters().search, '');
});

test('filter: no filters returns everything and makes no owner lookup', async () => {
  assert.deepEqual(await run({}), ['b1', 'b2', 'b3']);
  assert.equal(log.or, undefined);
});

test('filter: connected true / false', async () => {
  assert.deepEqual(await run({ connected: 'true' }), ['b1']);
  assert.deepEqual(await run({ connected: 'false' }), ['b2', 'b3']);
});

test('filter: isActive and businessCategory combine', async () => {
  assert.deepEqual(await run({ isActive: 'false' }), ['b2']);
  assert.deepEqual(await run({ isActive: 'true', businessCategory: 'general' }), ['b3']);
  assert.deepEqual(await run({ isActive: 'true', businessCategory: 'salon' }), []);
});

test('search: business name and city', async () => {
  assert.deepEqual(await run({ search: 'salon' }), ['b2']);
  assert.deepEqual(await run({ search: 'pune' }), ['b1']);
});

test('search: owner name and owner email', async () => {
  assert.deepEqual(await run({ search: 'ravi patil' }), ['b1']);
  assert.deepEqual(await run({ search: 'asha.k@example' }), ['b2']);
});

test('search: owner phone needs 4+ digits, and a staff member is never matched as an owner', async () => {
  assert.deepEqual(await run({ search: '98765' }), ['b1']);
  assert.ok(log.or[0].expr.includes('phone.ilike.%98765%'));
  assert.deepEqual(await run({ search: '9222222222' }), []);
  log.or.length = 0;
  await run({ search: '987' });
  assert.ok(!log.or[0].expr.includes('phone.ilike'));
});

test('search: combines with the other filters', async () => {
  assert.deepEqual(await run({ search: 'example.com', connected: 'true' }), ['b1']);
});

test('loadOwners: map of owner id to name / email / phone, ignoring null owners', async () => {
  const owners = await svc.loadOwners([{ owner_user_id: 'u1' }, { owner_user_id: null }, { owner_user_id: 'u1' }]);
  assert.deepEqual(Object.keys(owners), ['u1']);
  assert.equal(owners.u1.phone, '+919876543210');
});

test('loadCurrentSubscriptions: active and trial only, absent when none', async () => {
  tables.subscriptions = [
    { id: 's1', business_id: 'b1', status: 'active', end_date: '2027-01-01', created_at: '2026-01-01', plan: plan('pro') },
    { id: 's2', business_id: 'b2', status: 'expired', end_date: '2026-01-01', created_at: '2025-01-01', plan: plan('free') },
    { id: 's3', business_id: 'b3', status: 'trial', end_date: '2026-12-01', created_at: '2026-10-01', plan: plan('trial') }
  ];
  const subs = await svc.loadCurrentSubscriptions(['b1', 'b2', 'b3']);
  assert.deepEqual(subs.b1, { status: 'active', plan: { id: 'plan-pro', name: 'pro', displayName: 'PRO' } });
  assert.equal(subs.b2, undefined);
  assert.equal(subs.b3.status, 'trial');
});

test('loadCurrentSubscriptions: several live rows pick the newest (latest end date)', async () => {
  tables.subscriptions = [
    { id: 's1', business_id: 'b1', status: 'trial', end_date: '2026-11-10', created_at: '2026-10-01', plan: plan('trial') },
    { id: 's2', business_id: 'b1', status: 'active', end_date: '2027-05-10', created_at: '2026-10-20', plan: plan('pro') }
  ];
  const subs = await svc.loadCurrentSubscriptions(['b1']);
  assert.equal(subs.b1.status, 'active');
  assert.equal(subs.b1.plan.name, 'pro');
});

test('loadCurrentSubscriptions: a subscription whose plan is missing gives plan null', async () => {
  tables.subscriptions = [{ id: 's1', business_id: 'b1', status: 'active', end_date: '2027-01-01', created_at: '2026-01-01', plan: null }];
  assert.deepEqual(await svc.loadCurrentSubscriptions(['b1']), { b1: { status: 'active', plan: null } });
});
