// Run: node --test src/routes/travelQuote.readiness.routes.test.js
// Also POST /quote-flow/enable|disable (owner only, works while the switch is off; the switch service is a stand-in).
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
const switchCalls = [];
let switchResult = null;
const okResult = (enabled) => ({ ok: true, status: 200, message: 'done', readiness: { ready: true, enabled, items: [], acknowledgements: [] } });
stub('../services/quoteFlowSwitch.service', {
  enableQuoteFlow: async (businessId, body) => { switchCalls.push({ fn: 'enable', businessId, body }); return switchResult || okResult(true); },
  disableQuoteFlow: async (businessId) => { switchCalls.push({ fn: 'disable', businessId }); return switchResult || okResult(false); }
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

// ── POST /quote-flow/enable | disable ───────────────────────────────────────────────────────────
const post = async (path, body = {}, { role = 'owner', business = 'biz' } = {}) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-role': role, ...(business ? { 'x-business': business } : {}) },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
};

test('enable / disable: owner only (staff refused), a business is required, and they work while the switch is OFF', async () => {
  switchCalls.length = 0;
  assert.equal((await post('/travel/quote-flow/enable', {}, { role: 'staff' })).status, 403);
  assert.equal((await post('/travel/quote-flow/disable', {}, { role: 'staff' })).status, 403);
  assert.equal((await post('/travel/quote-flow/enable', {}, { business: null })).status, 403);
  assert.equal(switchCalls.length, 0);
  const enabled = await post('/travel/quote-flow/enable');
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.data.readiness.enabled, true);
  assert.equal((await post('/travel/quote-flow/disable')).status, 200);
  assert.deepEqual(switchCalls.map((c) => c.fn), ['enable', 'disable']);
});

test('enable: the business is the login\'s and the body is only keyword / aliases / acknowledgeRoundTripTeam', async () => {
  switchCalls.length = 0;
  await post('/travel/quote-flow/enable', { businessId: 'someone-else', keyword: ' fare ', aliases: ['get fare'], acknowledgeRoundTripTeam: true, extra: 1 });
  assert.deepEqual(switchCalls[0], { fn: 'enable', businessId: 'biz', body: { keyword: 'fare', aliases: ['get fare'], acknowledgeRoundTripTeam: true } });
  switchCalls.length = 0;
  await post('/travel/quote-flow/enable', {});
  assert.deepEqual(switchCalls[0].body, { keyword: undefined, aliases: undefined, acknowledgeRoundTripTeam: false });
  assert.equal((await post('/travel/quote-flow/enable', { keyword: '' })).status, 400);
  assert.equal((await post('/travel/quote-flow/enable', { aliases: 'x' })).status, 400);
  assert.equal((await post('/travel/quote-flow/enable', { acknowledgeRoundTripTeam: 'yes' })).status, 400);
});

test('a refusal carries its status, a code, the readiness and what blocks', async () => {
  switchResult = { ok: false, status: 409, code: 'NOT_READY', message: 'Quotes cannot be enabled yet: One Way routes.', readiness: { ready: false, items: [] }, blockers: [{ key: 'routes_one_way' }] };
  const blocked = await post('/travel/quote-flow/enable');
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.errors.code, 'NOT_READY');
  assert.deepEqual(blocked.body.errors.blockers, [{ key: 'routes_one_way' }]);
  switchResult = { ok: false, status: 403, code: 'PROTECTED_BUSINESS', message: 'Search cab AI is a live production bot', readiness: null, blockers: [] };
  const protectedRun = await post('/travel/quote-flow/disable');
  assert.equal(protectedRun.status, 403);
  assert.equal(protectedRun.body.errors.code, 'PROTECTED_BUSINESS');
  switchResult = null;
});
