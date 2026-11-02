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
let googleKm = null; let googleCalls = [];
stub('../services/distanceMatrix.service', { getDistanceKm: async (from, to) => { googleCalls.push([from, to]); return googleKm; } });
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

// Embedded vehicles are not resolved by the stand-in, so a fare row carries its vehicle directly.
const fareRow = (over) => ({
  id: `f-${++idCounter}`, business_id: 'sg', from_city: 'pune', to_city: 'shirdi', trip_type: 'oneway', vehicle_id: 'v1', fare: 4200,
  is_active: true, route_id: 'r1', vehicle: { id: 'v1', is_active: true, per_km_rate: 23, min_km_per_day: 250, driver_allowance_per_day: 300 }, ...over
});

test('a route saves and returns its one-way distance; bad values are refused; empty clears it', async () => {
  const created = await call('POST', '/travel/routes', { body: { fromCity: 'Pune', toCity: 'Shirdi', oneWayDistanceKm: 185 } });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.oneWayDistanceKm, 185);
  assert.equal(db.travel_routes[0].one_way_distance_km, 185);
  const id = created.body.data.id;
  assert.equal((await call('PUT', `/travel/routes/${id}`, { body: { oneWayDistanceKm: 0 } })).status, 400);
  assert.equal((await call('PUT', `/travel/routes/${id}`, { body: { oneWayDistanceKm: '185' } })).status, 400);
  const edited = await call('PUT', `/travel/routes/${id}`, { body: { oneWayDistanceKm: 190.5 } });
  assert.equal(edited.body.data.oneWayDistanceKm, 190.5);
  const cleared = await call('PUT', `/travel/routes/${id}`, { body: { oneWayDistanceKm: null } });
  assert.equal(cleared.body.data.oneWayDistanceKm, null);
  // a route edit that doesn't mention the distance leaves it alone
  await call('PUT', `/travel/routes/${id}`, { body: { oneWayDistanceKm: 185 } });
  const other = await call('PUT', `/travel/routes/${id}`, { body: { region: 'West' } });
  assert.equal(other.body.data.oneWayDistanceKm, 185);
});

test('the route list says whether Round Trip is ready, and what to add when it is not', async () => {
  db.travel_routes = [{ id: 'r1', business_id: 'sg', from_city: 'pune', to_city: 'shirdi', is_active: true, sort_order: 0, one_way_distance_km: null }];
  db.route_fares = [fareRow()];
  const state = async () => (await call('GET', '/travel/routes')).body.data.routes[0].roundTrip;
  assert.deepEqual(await state(), { ready: false, reason: 'add_distance' });
  db.travel_routes[0].one_way_distance_km = 185;
  assert.deepEqual(await state(), { ready: true, reason: null });
  db.route_fares[0].vehicle.min_km_per_day = null;
  assert.deepEqual(await state(), { ready: false, reason: 'add_min_km' });
  db.route_fares[0].vehicle.min_km_per_day = 250;
  db.route_fares[0].vehicle.per_km_rate = 0;
  assert.deepEqual(await state(), { ready: false, reason: 'add_rate' });
  // a fixed Round Trip fare makes it ready with no distance, no min km and no rate
  db.travel_routes[0].one_way_distance_km = null;
  db.route_fares.push(fareRow({ trip_type: 'round_trip', fare: 7300 }));
  assert.deepEqual(await state(), { ready: true, reason: null });
  // an inactive vehicle does not count
  db.route_fares.forEach(f => { f.vehicle.is_active = false; });
  assert.deepEqual(await state(), { ready: false, reason: 'no_vehicle' });
  db.travel_routes[0].is_active = false;
  assert.deepEqual(await state(), { ready: false, reason: 'inactive' });
});

test('fill-distance: saves the Google distance for the route, rounded to 0.1 km, keyed on the city names', async () => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  const { body } = await call('POST', '/travel/routes', { body: { fromCity: 'Pune', toCity: 'Shirdi' } });
  const id = body.data.id;
  googleCalls = []; googleKm = 184.96;
  const res = await call('POST', `/travel/routes/${id}/fill-distance`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.distanceKm, 185);
  assert.equal(res.body.data.source, 'google');
  assert.equal(res.body.data.route.oneWayDistanceKm, 185);
  assert.equal(db.travel_routes[0].one_way_distance_km, 185);
  assert.deepEqual(googleCalls, [['pune', 'shirdi']]);
  // the owner can edit it afterwards
  assert.equal((await call('PUT', `/travel/routes/${id}`, { body: { oneWayDistanceKm: 190 } })).body.data.oneWayDistanceKm, 190);
});

test('fill-distance: no API key, no result, or someone else\'s route are clear errors and save nothing', async () => {
  const { body } = await call('POST', '/travel/routes', { body: { fromCity: 'Pune', toCity: 'Shirdi' } });
  const id = body.data.id;
  const key = process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  const noKey = await call('POST', `/travel/routes/${id}/fill-distance`);
  assert.equal(noKey.status, 503);
  assert.match(noKey.body.message, /Type the one-way distance/);
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  googleKm = null;
  const none = await call('POST', `/travel/routes/${id}/fill-distance`);
  assert.equal(none.status, 422);
  assert.match(none.body.message, /Pune to Shirdi.*Type the one-way distance/);
  googleKm = 6000;
  assert.equal((await call('POST', `/travel/routes/${id}/fill-distance`)).status, 422);
  assert.equal(db.travel_routes[0].one_way_distance_km ?? null, null);
  assert.equal((await call('POST', `/travel/routes/${id}/fill-distance`, { business: 'shop' })).status, 404);
  assert.equal((await call('POST', `/travel/routes/${id}/fill-distance`, { role: 'staff' })).status, 403);
  if (key === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = key;
});

test('quote settings: the allowance basis is saved; the retired per-day allowance is returned read-only and never written', async () => {
  const first = await call('GET', '/travel/quote-settings');
  assert.equal(first.body.data.settings.allowanceBasis, 'day');
  assert.equal(first.body.data.settings.driverAllowancePerDay, 0);
  assert.equal((await call('PUT', '/travel/quote-settings', { body: { allowanceBasis: 'weekly' } })).status, 400);
  const saved = await call('PUT', '/travel/quote-settings', { body: { allowanceBasis: 'night' } });
  assert.equal(saved.body.data.settings.allowanceBasis, 'night');
  assert.equal(db.travel_quote_settings[0].allowance_basis, 'night');
  // sent on its own there is nothing to save
  assert.equal((await call('PUT', '/travel/quote-settings', { body: { driverAllowancePerDay: 300 } })).status, 400);
});

test('the live web Rates -> Settings page still saves: a PUT with every key it sends, the retired allowance included, is 200 and the allowance is ignored', async () => {
  db.travel_quote_settings = [{ business_id: 'sg', night_charge: 0, night_start_minute: 1320, night_end_minute: 360, driver_allowance_per_day: 500, toll_included: false, minimum_charge: 0, valid_hours: 24, reminder_after_hours: 3, allowance_basis: 'day' }];
  const got = await call('GET', '/travel/quote-settings');
  // the page builds its form from this: it must still be a number
  assert.equal(got.body.data.settings.driverAllowancePerDay, 500);
  const res = await call('PUT', '/travel/quote-settings', {
    body: { nightCharge: 250, driverAllowancePerDay: 999, minimumCharge: 1500, nightStartMinute: 1260, nightEndMinute: 330, tollIncluded: true, validHours: 48, reminderAfterHours: 6 }
  });
  assert.equal(res.status, 200);
  const s = res.body.data.settings;
  assert.deepEqual([s.nightCharge, s.minimumCharge, s.nightStartMinute, s.nightEndMinute, s.tollIncluded, s.validHours, s.reminderAfterHours], [250, 1500, 1260, 330, true, 48, 6]);
  assert.equal(s.driverAllowancePerDay, 500); // ignored, not written
  assert.equal(db.travel_quote_settings[0].driver_allowance_per_day, 500);
  assert.equal(db.travel_quote_settings[0].night_charge, 250);
});

test('the route list works for vehicles with none of the new fields set (nulls, or the keys absent)', async () => {
  db.travel_routes = [{ id: 'r1', business_id: 'sg', from_city: 'pune', to_city: 'shirdi', is_active: true, sort_order: 0, one_way_distance_km: null }];
  const nulls = { id: 'v1', is_active: true, per_km_rate: null, min_km_per_day: null, driver_allowance_per_day: null };
  db.route_fares = [fareRow({ vehicle: nulls }), fareRow({ vehicle_id: 'v2', vehicle: { id: 'v2', is_active: true } })];
  const res = await call('GET', '/travel/routes');
  assert.equal(res.status, 200);
  const route = res.body.data.routes[0];
  assert.equal(route.oneWayDistanceKm, null);
  assert.deepEqual(route.roundTrip, { ready: false, reason: 'add_distance' });
  assert.equal(route.fares.length, 2);
  assert.equal(route.fares[0].fare, 4200);
  // an unlisted route (fares, no travel_routes row) works too
  db.travel_routes = [];
  const unlisted = (await call('GET', '/travel/routes')).body.data.routes[0];
  assert.equal(unlisted.unlisted, true);
  assert.deepEqual(unlisted.roundTrip, { ready: false, reason: 'add_distance' });
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
