// Run: node --test src/routes/features.routes.test.js
// GET /api/features: the effective feature map for the caller's own business,
// any role. The real route, controller and service run; auth and the DB
// (businesses, category_features, business_features) are stubbed in memory.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const tables = { businesses: [], category_features: [], business_features: [] };
const query = (table) => {
  const filters = [];
  const q = {
    select: () => q,
    eq: (col, val) => { filters.push([col, val]); return q; },
    maybeSingle: async () => ({ data: tables[table].find(r => filters.every(([c, v]) => r[c] === v)) || null, error: null }),
    then: (resolve) => resolve({ data: tables[table].filter(r => filters.every(([c, v]) => r[c] === v)), error: null })
  };
  return q;
};
stub('../config/supabase', { from: query });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../middleware/auth.middleware', {
  protect: (req, res, next) => {
    if (req.headers['x-anon']) return res.status(401).json({ success: false, message: 'No token provided' });
    req.user = { userId: 'u', businessId: req.headers['x-business'] || null, role: req.headers['x-role'] || 'owner' };
    next();
  },
  requireBusiness: (req, res, next) => (req.user.businessId ? next() : res.status(403).json({ success: false, message: 'No business found.' }))
});

const app = express();
app.use('/api/features', require('./features.routes'));
app.use((err, req, res, next) => res.status(500).json({ success: false, message: err.message })); // eslint-disable-line no-unused-vars

let server; let base;
test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/features`;
});
test.after(() => server.close());

test.beforeEach(() => {
  tables.businesses = [
    { id: 'sg', business_category: 'travels' },
    { id: 'newbiz', business_category: 'travels' },
    { id: 'daring', business_category: 'coaching' }
  ];
  tables.category_features = [];
  tables.business_features = [];
});

const get = (headers = {}) => fetch(base, { headers });
// catalogue is the one feature that is ON by default (categoryFeature.service.js defaultEnabled).
const ALL_OFF = { followups: false, opt_in_links: false, contact_import: false, owner_phone_media: false, staff: false, broadcasts: false, catalogue: true };

test('a new business with no override and no category row: every feature is Off except the default-on catalogue, in the usual wrapper', async () => {
  const res = await get({ 'x-business': 'newbiz' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(typeof body.message, 'string');
  assert.deepEqual(body.data, { features: ALL_OFF });
});

test('owner: an override On shows that feature On, the rest Off', async () => {
  tables.business_features.push({ business_id: 'sg', feature: 'staff', is_enabled: true });
  const { data } = await (await get({ 'x-business': 'sg', 'x-role': 'owner' })).json();
  assert.deepEqual(data.features, { ...ALL_OFF, staff: true });
});

test('staff user of the same business gets the same map', async () => {
  tables.business_features.push({ business_id: 'sg', feature: 'staff', is_enabled: true });
  const owner = await (await get({ 'x-business': 'sg', 'x-role': 'owner' })).json();
  const staff = await (await get({ 'x-business': 'sg', 'x-role': 'staff' })).json();
  assert.equal(staff.success, true);
  assert.deepEqual(staff.data, owner.data);
});

test('an Off override beats an On category switch; each business sees its own state', async () => {
  tables.category_features.push({ category: 'travels', feature: 'broadcasts', is_enabled: true });
  tables.business_features.push({ business_id: 'sg', feature: 'broadcasts', is_enabled: false });
  const sg = (await (await get({ 'x-business': 'sg' })).json()).data.features;
  const other = (await (await get({ 'x-business': 'newbiz' })).json()).data.features;
  assert.equal(sg.broadcasts, false);
  assert.equal(other.broadcasts, true);
});

test('only features that apply to the category appear (bot_builder is coaching-only)', async () => {
  const travels = (await (await get({ 'x-business': 'sg' })).json()).data.features;
  const coaching = (await (await get({ 'x-business': 'daring' })).json()).data.features;
  assert.equal('bot_builder' in travels, false);
  assert.deepEqual(coaching, { bot_builder: false, ...ALL_OFF });
});

test('401 without a token, 403 without a business, 404 when the business row is gone', async () => {
  assert.equal((await get({ 'x-anon': '1' })).status, 401);
  assert.equal((await get({})).status, 403);
  assert.equal((await get({ 'x-business': 'ghost' })).status, 404);
});
