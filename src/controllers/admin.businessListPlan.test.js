// Run: node --test src/controllers/admin.businessListPlan.test.js
// Super Admin businesses list: plan + subscriptionStatus per row (newest active-or-trial, null when none),
// the connected filter, and search by owner name / email, all through getBusinesses.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeAdminDb } = require('../test-support/fakeAdminBusinessDb');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const tables = { businesses: [], users: [], subscriptions: [], business_travel_settings: [] };
stub('../config/supabase', createFakeAdminDb(tables));
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/booking.service', {});
stub('../services/subscription.service', {});
stub('../services/tenant.service', {});
stub('../services/admin.service', {});
stub('../services/business.service', { attachTravelSettings: async (b) => b, flattenTravelSettings: (b) => b });
stub('../services/chatbot.service', {});
stub('../services/razorpaySubscriptions.service', {});
stub('../services/businessCategory.service', {});

const admin = require('./admin.controller');

const list = async (query) => {
  const out = {};
  const res = { status: () => res, json: (b) => { out.body = b; return res; } };
  await admin.getBusinesses({ query }, res, (e) => { throw e; });
  return Object.fromEntries(out.body.data.businesses.map((b) => [b.id, b]));
};

const sub = (id, businessId, status, endDate, planName) => ({
  id, business_id: businessId, status, end_date: endDate, created_at: '2026-10-01',
  plan: { id: `p-${planName}`, name: planName, display_name: planName.toUpperCase() }
});

test.beforeEach(() => {
  tables.businesses = [
    { id: 'b1', name: 'Sai Travels', city: 'Pune', owner_user_id: 'u1', business_category: 'travels', sub_categories: [], is_whatsapp_connected: true, is_active: true },
    { id: 'b2', name: 'Moon Salon', city: 'Nashik', owner_user_id: 'u2', business_category: 'salon', sub_categories: [], is_whatsapp_connected: false, is_active: true },
    { id: 'b3', name: 'Cafe', city: 'Delhi', owner_user_id: 'u2', business_category: 'general', sub_categories: [], is_whatsapp_connected: false, is_active: true }
  ];
  tables.users = [
    { id: 'u1', name: 'Ravi', email: 'ravi@example.com', phone: null, role: 'owner' },
    { id: 'u2', name: 'Asha', email: 'asha@example.com', phone: null, role: 'owner' }
  ];
  tables.subscriptions = [
    sub('s1', 'b1', 'trial', '2026-11-10', 'trial'),
    sub('s2', 'b1', 'active', '2027-05-10', 'pro'),
    sub('s3', 'b2', 'expired', '2026-01-01', 'free')
  ];
  tables.business_travel_settings = [];
});

test('list: plan and subscriptionStatus come from the newest active-or-trial subscription', async () => {
  const rows = await list({});
  assert.equal(rows.b1.subscriptionStatus, 'active');
  assert.deepEqual(rows.b1.plan, { id: 'p-pro', name: 'pro', displayName: 'PRO' });
});

test('list: no live subscription gives null plan and null status (expired rows do not count)', async () => {
  const rows = await list({});
  assert.equal(rows.b2.plan, null);
  assert.equal(rows.b2.subscriptionStatus, null);
  assert.equal(rows.b3.plan, null);
});

test('list: every row carries isWhatsappConnected and subCategories', async () => {
  const rows = await list({});
  assert.equal(rows.b1.isWhatsappConnected, true);
  assert.equal(rows.b2.isWhatsappConnected, false);
  assert.deepEqual(rows.b1.subCategories, []);
});

test('list: connected filter', async () => {
  assert.deepEqual(Object.keys(await list({ connected: 'true' })), ['b1']);
  assert.deepEqual(Object.keys(await list({ connected: 'false' })), ['b2', 'b3']);
});

test('list: search matches the owner name and email', async () => {
  assert.deepEqual(Object.keys(await list({ search: 'asha' })), ['b2', 'b3']);
  assert.deepEqual(Object.keys(await list({ search: 'ravi@example' })), ['b1']);
});
