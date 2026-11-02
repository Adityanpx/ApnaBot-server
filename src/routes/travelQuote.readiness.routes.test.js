// Run: node --test src/routes/travelQuote.readiness.routes.test.js
// GET /api/travel/quote-readiness: the real route, controller and feature middleware; the checklist service, auth and the
// database are stand-ins. The point: it answers while the travel_quotes switch is OFF (that is one of its items) while every
// other /api/travel route still 404s, it needs a logged-in business, and the keyword the owner is considering is passed on.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const db = { businesses: [{ id: 'biz', business_category: 'travels' }], category_features: [], business_features: [] };
const from = (table) => {
  const filters = [];
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push((r) => r[c] === v); return q; },
    maybeSingle: async () => ({ data: (db[table] || []).find((r) => filters.every((f) => f(r))) || null, error: null }),
    then: (resolve) => resolve({ data: (db[table] || []).filter((r) => filters.every((f) => f(r))), error: null })
  };
  return q;
};
stub('../config/supabase', { from, rpc: async () => ({ data: null, error: null }) });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/distanceMatrix.service', { getDistanceKm: async () => null });
const calls = [];
stub('../services/quoteReadiness.service', {
  getQuoteReadiness: async (businessId, entry) => { calls.push({ businessId, entry }); return { ready: true, items: [], acknowledgements: [] }; }
});
stub('../middleware/auth.middleware', {
  protect: (req, res, next) => {
    req.user = { userId: 'u', businessId: req.headers['x-business'] || null, role: req.headers['x-role'] || 'owner' };
    next();
  },
  requireBusiness: (req, res, next) => (req.user.businessId ? next() : res.status(403).json({ success: false, message: 'No business found.' }))
});

const app = express();
app.use(express.json());
app.use('/api/travel', require('./travelQuote.routes'));
app.use(require('../middleware/errorHandler.middleware'));

let server; let base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server.close());
test.beforeEach(() => { calls.length = 0; });

const get = async (path, { role = 'owner', business = 'biz' } = {}) => {
  const res = await fetch(base + path, { headers: { 'x-role': role, ...(business ? { 'x-business': business } : {}) } });
  return { status: res.status, body: await res.json() };
};

test('answers while the travel_quotes switch is OFF; the other travel routes are still 404 FEATURE_DISABLED', async () => {
  const readiness = await get('/travel/quote-readiness');
  assert.equal(readiness.status, 200);
  assert.deepEqual(readiness.body.data, { ready: true, items: [], acknowledgements: [] });
  const routes = await get('/travel/routes');
  assert.equal(routes.status, 404);
  assert.equal(routes.body.errors.code, 'FEATURE_DISABLED');
});

test('any member can read it (staff too), and it needs a business', async () => {
  assert.equal((await get('/travel/quote-readiness', { role: 'staff' })).status, 200);
  assert.equal((await get('/travel/quote-readiness', { business: null })).status, 403);
  assert.equal(calls.length, 1);
});

test('it is read-only: the business comes from the login, never from the request', async () => {
  await get('/travel/quote-readiness?businessId=someone-else');
  assert.equal(calls[0].businessId, 'biz');
  const post = await fetch(`${base}/travel/quote-readiness`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-business': 'biz' }, body: '{}' });
  assert.notEqual(post.status, 200);
});

test('the keyword and aliases the owner is considering are passed on', async () => {
  await get('/travel/quote-readiness?keyword=fare&aliases=get%20fare,%20rate');
  assert.deepEqual(calls[0].entry, { keyword: 'fare', aliases: ['get fare', 'rate'] });
  await get('/travel/quote-readiness');
  assert.deepEqual(calls[1].entry, { keyword: undefined, aliases: undefined });
});
