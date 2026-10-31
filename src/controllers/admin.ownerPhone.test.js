// Run: node --test src/controllers/admin.ownerPhone.test.js
// Super Admin businesses list + detail: ownerName / ownerEmail / ownerPhone, and list search that
// also matches the owner's phone (with the search term sanitised before it reaches .or()).
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const tables = { businesses: [], users: [], subscriptions: [], customers: [], bookings: [], business_travel_settings: [] };
let orArgs; let phoneLookups;

const from = (table) => {
  const filters = []; let phoneLike = null;
  const run = () => {
    let rows = tables[table].filter((r) => filters.every((f) => f(r)));
    if (phoneLike) rows = rows.filter((r) => (r.phone || '').includes(phoneLike));
    return rows.map((r) => ({ ...r }));
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push((r) => r[c] === v); return q; },
    in: (c, vals) => { filters.push((r) => vals.includes(r[c])); return q; },
    ilike: (c, pattern) => { if (c === 'phone') { phoneLike = pattern.replace(/%/g, ''); phoneLookups.push(pattern); } return q; },
    or: (expr) => {
      orArgs = expr;
      const m = /owner_user_id\.in\.\(([^)]*)\)/.exec(expr);
      const term = /name\.ilike\.%([^%]*)%/.exec(expr)[1].toLowerCase();
      const ownerIds = m ? m[1].split(',') : [];
      filters.push((r) => (r.name || '').toLowerCase().includes(term) || (r.city || '').toLowerCase().includes(term) || ownerIds.includes(r.owner_user_id));
      return q;
    },
    order: () => q,
    range: () => q,
    limit: () => q,
    maybeSingle: async () => ({ data: run()[0] || null, error: null }),
    then: (resolve) => { const data = run(); return resolve({ data, error: null, count: data.length }); }
  };
  return q;
};
stub('../config/supabase', { from });
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

const call = async (handler, req) => {
  const out = { status: 200 };
  const res = { status: (c) => { out.status = c; return res; }, json: (b) => { out.body = b; return res; } };
  await handler(req, res, (e) => { throw e; });
  return out;
};

test.beforeEach(() => {
  orArgs = undefined; phoneLookups = [];
  tables.businesses = [
    { id: 'b1', name: 'Sai Travels', city: 'Pune', owner_user_id: 'u1', business_category: 'general', sub_categories: [], is_active: true },
    { id: 'b2', name: 'Moon Salon', city: 'Nashik', owner_user_id: 'u2', business_category: 'general', sub_categories: [], is_active: true },
    { id: 'b3', name: 'No Owner Co', city: 'Delhi', owner_user_id: null, business_category: 'general', sub_categories: [], is_active: true }
  ];
  tables.users = [
    { id: 'u1', name: 'Ravi', email: 'ravi@x.com', phone: '+919876543210', role: 'owner', business_id: 'b1' },
    { id: 'u2', name: 'Asha', email: 'asha@x.com', phone: null, role: 'owner', business_id: 'b2' },
    { id: 's1', name: 'Staffer', email: 's@x.com', phone: '+919111111111', role: 'staff', business_id: 'b1' }
  ];
  tables.subscriptions = []; tables.customers = []; tables.bookings = []; tables.business_travel_settings = [];
});

test('list: each business carries ownerName / ownerEmail / ownerPhone (null when none)', async () => {
  const out = await call(admin.getBusinesses, { query: {} });
  const byId = Object.fromEntries(out.body.data.businesses.map((b) => [b.id, b]));
  assert.equal(byId.b1.ownerPhone, '+919876543210');
  assert.equal(byId.b1.ownerName, 'Ravi');
  assert.equal(byId.b1.ownerEmail, 'ravi@x.com');
  assert.equal(byId.b1.ownerUserId.phone, '+919876543210');
  assert.equal(byId.b2.ownerPhone, null);
  assert.equal(byId.b3.ownerName, null);
  assert.equal(byId.b3.ownerPhone, null);
});

test('list: search matches the owner phone (digits, +91 or spaces)', async () => {
  for (const search of ['98765', '+91 98765 43210', '9876543210']) {
    const out = await call(admin.getBusinesses, { query: { search } });
    assert.deepEqual(out.body.data.businesses.map((b) => b.id), ['b1'], search);
  }
});

test('list: search still matches name and city, and short digit runs skip the phone lookup', async () => {
  assert.deepEqual((await call(admin.getBusinesses, { query: { search: 'salon' } })).body.data.businesses.map((b) => b.id), ['b2']);
  assert.deepEqual((await call(admin.getBusinesses, { query: { search: 'pune' } })).body.data.businesses.map((b) => b.id), ['b1']);
  phoneLookups = [];
  await call(admin.getBusinesses, { query: { search: '987' } });
  assert.deepEqual(phoneLookups, []);
});

test('list: a staff phone is not matched as an owner phone', async () => {
  const out = await call(admin.getBusinesses, { query: { search: '9111111111' } });
  assert.deepEqual(out.body.data.businesses, []);
});

test('list: filter characters in the search never reach the .or() string', async () => {
  await call(admin.getBusinesses, { query: { search: 'x,owner_user_id.in.(u1,u2),name.ilike.%' } });
  const clauses = orArgs.split(',');
  assert.equal(clauses.length, 2);
  assert.match(clauses[0], /^name\.ilike\.%[^,()%*]*%$/);
  assert.match(clauses[1], /^city\.ilike\.%[^,()%*]*%$/);
  assert.doesNotMatch(orArgs, /\(/);
});

test('list: a search that is only filter characters applies no search filter', async () => {
  const out = await call(admin.getBusinesses, { query: { search: ',()%' } });
  assert.equal(orArgs, undefined);
  assert.equal(out.body.data.businesses.length, 3);
});

test('detail: business has ownerName / ownerEmail / ownerPhone and users[] carry phone', async () => {
  const out = await call(admin.getBusinessById, { params: { id: 'b1' } });
  const { business, users } = out.body.data;
  assert.equal(business.ownerPhone, '+919876543210');
  assert.equal(business.ownerName, 'Ravi');
  assert.equal(business.ownerEmail, 'ravi@x.com');
  assert.equal(business.ownerUserId.phone, '+919876543210');
  assert.deepEqual(users.map((u) => u.phone), ['+919876543210', '+919111111111']);
});

test('detail: an owner without a phone gives ownerPhone null', async () => {
  const out = await call(admin.getBusinessById, { params: { id: 'b2' } });
  assert.equal(out.body.data.business.ownerPhone, null);
  assert.equal(out.body.data.business.ownerName, 'Asha');
});
