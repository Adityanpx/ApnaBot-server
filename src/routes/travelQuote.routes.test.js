// Run: node --test src/routes/travelQuote.routes.test.js
// /api/travel (rate card, quote settings, quotes) and /api/reports/quotes: the real routes,
// controller and services run; auth and the DB are an in-memory stand-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

let db = {};
let idCounter = 0;
// Embeds (vehicle:vehicles(...), customer:customers(...)) are not resolved by this stand-in.
const from = (table) => {
  db[table] = db[table] || [];
  const filters = [];
  let op = 'select'; let payload = null; let conflict = null; let range = null; let order = null;
  const matches = (r) => filters.every(f => f(r));
  const exec = () => {
    if (op === 'insert' || op === 'upsert') {
      const rows = (Array.isArray(payload) ? payload : [payload]).map(r => ({ ...r }));
      return rows.map(row => {
        const keys = conflict ? conflict.split(',') : null;
        const hit = keys && db[table].find(e => keys.every(k => e[k] === row[k]));
        if (hit) { Object.assign(hit, row); return hit; }
        const created = { id: `id-${++idCounter}`, is_active: true, sort_order: 0, ...row };
        db[table].push(created);
        return created;
      });
    }
    if (op === 'update') { const hit = db[table].filter(matches); hit.forEach(r => Object.assign(r, payload)); return hit; }
    if (op === 'delete') { const hit = db[table].filter(matches); db[table] = db[table].filter(r => !hit.includes(r)); return hit; }
    let rows = db[table].filter(matches);
    if (order) rows = [...rows].sort((a, b) => (a[order.col] > b[order.col] ? 1 : a[order.col] < b[order.col] ? -1 : 0) * (order.asc ? 1 : -1));
    const total = rows.length;
    if (range) rows = rows.slice(range[0], range[1] + 1);
    return Object.assign(rows, { total });
  };
  const q = {
    select: () => q,
    insert: (r) => { op = 'insert'; payload = r; return q; },
    upsert: (r, o) => { op = 'upsert'; payload = r; conflict = o && o.onConflict; return q; },
    update: (r) => { op = 'update'; payload = r; return q; },
    delete: () => { op = 'delete'; return q; },
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
    order: (col, { ascending = true } = {}) => { order = order || { col, asc: ascending }; return q; },
    range: (a, b) => { range = [a, b]; return q; },
    maybeSingle: async () => { const r = exec(); return { data: r[0] || null, error: null }; },
    single: async () => { const r = exec(); return r[0] ? { data: r[0], error: null } : { data: null, error: { message: 'no row' } }; },
    then: (resolve) => { const r = exec(); resolve({ data: r, error: null, count: r.total ?? r.length }); }
  };
  return q;
};
stub('../config/supabase', {
  from,
  rpc: async (name) => ({
    data: name === 'report_travel_quote_stats'
      ? [{ sent: 4, accepted: 2, paid: 1, expired: 1, cancelled: 0, handoff: 1, quoted_amount: '10000', advance_collected: '500' }]
      : null,
    error: null
  })
});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
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
app.use('/api/reports', require('./reports.routes'));
app.use(require('../middleware/errorHandler.middleware'));

let server; let base;
test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server.close());

const call = async (method, path, { body, role = 'owner', business = 'sg' } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-role': role, 'x-business': business },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
};

test.beforeEach(() => {
  idCounter = 0;
  db = {
    businesses: [
      { id: 'sg', business_category: 'travels', require_advance_payment: true, advance_payment_type: 'percentage', advance_payment_value: 20, payment_qr_url: 'https://qr' },
      { id: 'shop', business_category: 'grocery' }
    ],
    category_features: [],
    business_features: [{ business_id: 'sg', feature: 'travel_quotes', is_enabled: true }],
    vehicles: [{ id: 'v1', business_id: 'sg' }, { id: 'vx', business_id: 'other' }],
    travel_routes: [], route_fares: [], travel_quote_settings: [], travel_quotes: []
  };
});

test('off by default: 404 FEATURE_DISABLED until the switch is on, and never for a non-travel category', async () => {
  db.business_features = [];
  const off = await call('GET', '/travel/routes');
  assert.equal(off.status, 404);
  assert.equal(off.body.errors.code, 'FEATURE_DISABLED');
  db.business_features = [{ business_id: 'shop', feature: 'travel_quotes', is_enabled: true }];
  assert.equal((await call('GET', '/travel/routes', { business: 'shop' })).status, 404);
  assert.equal((await call('GET', '/reports/quotes?period=week')).status, 404);
});

test('writes are owner-only; staff can read', async () => {
  const body = { fromCity: 'Pune', toCity: 'Mumbai' };
  assert.equal((await call('POST', '/travel/routes', { body, role: 'staff' })).status, 403);
  assert.equal((await call('PUT', '/travel/quote-settings', { body: { minimumCharge: 1 }, role: 'staff' })).status, 403);
  assert.equal((await call('GET', '/travel/routes', { role: 'staff' })).status, 200);
  assert.equal((await call('GET', '/travel/quotes', { role: 'staff' })).status, 200);
});

test('create a route with fares, list it, edit it, delete it', async () => {
  const created = await call('POST', '/travel/routes', {
    body: { fromCity: ' Pune ', toCity: 'Mumbai', region: 'West', fares: [{ tripType: 'oneway', vehicleId: 'v1', fare: 2500 }] }
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.fromCity, 'pune');
  assert.equal(created.body.data.fares.length, 1);
  assert.equal(db.route_fares[0].route_id, created.body.data.id);

  const listed = await call('GET', '/travel/routes');
  assert.equal(listed.body.data.routes.length, 1);
  assert.equal(listed.body.data.routes[0].fares[0].fare, 2500);

  const id = created.body.data.id;
  const edited = await call('PUT', `/travel/routes/${id}`, {
    body: { toLabel: 'Mumbai City', fares: [{ tripType: 'oneway', vehicleId: 'v1', fare: 2600 }, { tripType: 'round_trip', vehicleId: 'v1', fare: 4999 }] }
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.toLabel, 'Mumbai City');
  assert.deepEqual(db.route_fares.map(f => f.fare).sort(), [2600, 4999]);

  const removed = await call('PUT', `/travel/routes/${id}`, { body: { fares: [{ tripType: 'round_trip', vehicleId: 'v1', remove: true }] } });
  assert.equal(removed.body.data.fares.length, 1);

  assert.equal((await call('DELETE', `/travel/routes/${id}`)).status, 200);
  assert.equal(db.route_fares.length, 0);
  assert.equal(db.travel_routes.length, 0);
});

test('a route cannot be renamed, a vehicle of another business is refused, a missing route is 404', async () => {
  const { body } = await call('POST', '/travel/routes', { body: { fromCity: 'a', toCity: 'b' } });
  assert.equal((await call('PUT', `/travel/routes/${body.data.id}`, { body: { toCity: 'c' } })).status, 400);
  const foreign = await call('POST', '/travel/routes', { body: { fromCity: 'a', toCity: 'b', fares: [{ tripType: 'oneway', vehicleId: 'vx', fare: 100 }] } });
  assert.equal(foreign.status, 404);
  assert.equal((await call('PUT', '/travel/routes/nope', { body: { region: 'x' } })).status, 404);
  assert.equal((await call('POST', '/travel/routes', { body: { fromCity: 'a' } })).status, 400);
});

test('turning a route off turns its fares off', async () => {
  const { body } = await call('POST', '/travel/routes', { body: { fromCity: 'a', toCity: 'b', fares: [{ tripType: 'oneway', vehicleId: 'v1', fare: 100 }] } });
  await call('PUT', `/travel/routes/${body.data.id}`, { body: { isActive: false } });
  assert.equal(db.route_fares[0].is_active, false);
});

test('fares saved through the old endpoint show up as unlisted routes', async () => {
  db.route_fares = [{ id: 'f1', business_id: 'sg', from_city: 'pune', to_city: 'satara', trip_type: 'oneway', vehicle_id: 'v1', fare: 1800, is_active: true, route_id: null }];
  const { body } = await call('GET', '/travel/routes');
  assert.equal(body.data.routes.length, 1);
  assert.equal(body.data.routes[0].unlisted, true);
  assert.equal(body.data.routes[0].id, null);
  assert.equal(body.data.routes[0].fromLabel, 'Pune');
});

test('quote settings: defaults, validation, save, and the advance shown read-only', async () => {
  const first = await call('GET', '/travel/quote-settings');
  assert.equal(first.body.data.settings.validHours, 24);
  assert.equal(first.body.data.settings.reminderAfterHours, 3);
  assert.deepEqual(first.body.data.advance, { requireAdvancePayment: true, advancePaymentType: 'percentage', advancePaymentValue: 20, hasPaymentQr: true });
  assert.equal((await call('PUT', '/travel/quote-settings', { body: { reminderAfterHours: 30 } })).status, 400);
  const saved = await call('PUT', '/travel/quote-settings', { body: { nightCharge: 300, minimumCharge: 1500 } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.settings.nightCharge, 300);
  assert.equal(saved.body.data.settings.validHours, 24);
});

test('quotes: list with a status filter; cancel only while waiting for the customer', async () => {
  db.travel_quotes = [
    { id: 'q1', business_id: 'sg', status: 'sent', sent_at: '2026-11-01T10:00:00Z' },
    { id: 'q2', business_id: 'sg', status: 'accepted', sent_at: '2026-11-02T10:00:00Z' },
    { id: 'q3', business_id: 'shop', status: 'sent', sent_at: '2026-11-03T10:00:00Z' }
  ];
  const all = await call('GET', '/travel/quotes');
  assert.deepEqual(all.body.data.quotes.map(q => q.id), ['q2', 'q1']);
  assert.equal((await call('GET', '/travel/quotes?status=bogus')).status, 400);
  assert.equal((await call('GET', '/travel/quotes?status=sent')).body.data.quotes.length, 1);
  assert.equal((await call('PUT', '/travel/quotes/q2/cancel')).status, 409);
  assert.equal((await call('PUT', '/travel/quotes/q3/cancel')).status, 404);
  assert.equal((await call('PUT', '/travel/quotes/q1/cancel')).status, 200);
  assert.equal(db.travel_quotes[0].status, 'cancelled');
});

test('GET /reports/quotes: period check and the numbers', async () => {
  assert.equal((await call('GET', '/reports/quotes?period=year')).status, 400);
  const { status, body } = await call('GET', '/reports/quotes?period=month');
  assert.equal(status, 200);
  assert.equal(body.data.current.sent, 4);
  assert.equal(body.data.current.advanceCollected, 500);
  assert.equal(body.data.current.conversionRate, 0.25);
  assert.equal(body.data.growth.sent, 0);
});
