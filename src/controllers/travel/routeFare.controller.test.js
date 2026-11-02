// Run: node --test src/controllers/travel/routeFare.controller.test.js
// POST / PUT /api/route-fares (Fleet -> Route Fares): the same rules as a fare in Rates -> Routes - validation,
// city keys, and the off_reason marker (a manual switch-off is not revived by a route off / on cascade).
// The last tests run the real travelRoute.service cascade on an in-memory table to prove it end to end.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const stub = (rel, exports) => {
  const p = require.resolve(path.join(__dirname, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

let rows; let routes; let upserted; let updated;
const matches = (filters) => (r) => filters.every(f => f(r));
stub('../../config/supabase', {
  from: (table) => {
    const filters = [];
    let op = null;
    let payload = null;
    const run = () => {
      const list = ({ route_fares: rows, travel_routes: routes }[table] || []).filter(matches(filters));
      if (op === 'update') list.forEach(r => Object.assign(r, payload));
      return list;
    };
    const q = {
      select: () => q,
      eq: (c, v) => { filters.push(r => r[c] === v); return q; },
      is: (c, v) => { filters.push(r => (r[c] === undefined ? null : r[c]) === v); return q; },
      upsert: (row) => { upserted = row; op = 'upsert'; payload = row; return q; },
      update: (row) => { updated = row; op = 'update'; payload = row; return q; },
      maybeSingle: async () => {
        if (table === 'vehicles') return { data: { id: 'v1' }, error: null };
        return { data: run()[0] || null, error: null };
      },
      single: async () => {
        const list = run(); // applies an update to the in-memory rows
        return table === 'travel_routes' ? { data: list[0] || null, error: null }
          : { data: { id: 'rf1', ...(upserted || {}), ...(updated || {}) }, error: null };
      },
      then: (resolve, reject) => Promise.resolve({ data: run(), error: null }).then(resolve, reject)
    };
    return q;
  }
});
stub('../../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
const controller = require('./routeFare.controller');
const routeService = require('../../services/travelRoute.service');

const call = async (fn, { body, params = {} }) => {
  upserted = undefined; updated = undefined;
  const res = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
  let nextError = null;
  await fn({ body, params, user: { businessId: 'b1' } }, res, (e) => { nextError = e; });
  assert.equal(nextError, null);
  return res;
};
const good = { fromCity: '  Pune ', toCity: 'New   Delhi', tripType: 'round_trip', vehicleId: 'v1', fare: 5200 };

test.beforeEach(() => { routes = [{ id: 'r1', business_id: 'b1', from_city: 'pune', to_city: 'shirdi', is_active: true }]; rows = [{ id: 'rf1', business_id: 'b1', from_city: 'pune', to_city: 'shirdi', trip_type: 'oneway', vehicle_id: 'v1', fare: 3000, is_active: true, off_reason: null }]; });

test('POST: cities normalised like Rates (trim, inner spaces collapsed, lowercase); the fare is saved on and the manual marker cleared', async () => {
  const res = await call(controller.createRouteFare, { body: good });
  assert.equal(res.statusCode, 201);
  assert.equal(upserted.from_city, 'pune');
  assert.equal(upserted.to_city, 'new delhi');
  assert.equal(upserted.fare, 5200); // as entered: no rounding on save, on either screen
  assert.equal(upserted.is_active, true);
  assert.equal(upserted.off_reason, null);
});

test('POST: invalid input is a 400 with a readable message and nothing is written', async () => {
  for (const [override, message] of [
    [{ fare: 0 }, /fare must be a number above 0/],
    [{ fare: -10 }, /fare must be a number above 0/],
    [{ fare: '5000' }, /fare must be a number above 0/],
    [{ fare: null }, /fare must be a number above 0/],
    [{ fare: undefined }, /fare must be a number above 0/],
    [{ tripType: 'weekly' }, /tripType must be one of/],
    [{ toCity: ' pune ' }, /must be different/],
    [{ fromCity: '' }, /fromCity is required/],
    [{ vehicleId: undefined }, /vehicleId is required/]
  ]) {
    const res = await call(controller.createRouteFare, { body: { ...good, ...override } });
    assert.equal(res.statusCode, 400, JSON.stringify(override));
    assert.match(res.body.message, message);
    assert.equal(upserted, undefined);
  }
});

test('POST: a missing tripType still means oneway; outstation and local stay allowed (the table accepts them)', async () => {
  const { tripType, ...withoutTrip } = good;
  await call(controller.createRouteFare, { body: withoutTrip });
  assert.equal(upserted.trip_type, 'oneway');
  for (const t of ['outstation', 'local']) {
    const res = await call(controller.createRouteFare, { body: { ...good, tripType: t } });
    assert.equal(res.statusCode, 201);
  }
});

test('PUT: switching off sets off_reason manual, switching on clears it', async () => {
  await call(controller.updateRouteFare, { params: { id: 'rf1' }, body: { isActive: false } });
  assert.deepEqual(updated, { is_active: false, off_reason: 'manual' });
  await call(controller.updateRouteFare, { params: { id: 'rf1' }, body: { isActive: true } });
  assert.deepEqual(updated, { is_active: true, off_reason: null });
});

test('PUT: a price alone never touches is_active or off_reason', async () => {
  await call(controller.updateRouteFare, { params: { id: 'rf1' }, body: { fare: 3200 } });
  assert.deepEqual(updated, { fare: 3200 });
});

test('PUT: invalid values are a 400; only the keys sent are checked', async () => {
  for (const body of [{ fare: 0 }, { fare: 'x' }, { tripType: 'weekly' }, { isActive: 'no' }, { fromCity: ' ' }]) {
    const res = await call(controller.updateRouteFare, { params: { id: 'rf1' }, body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(updated, undefined);
  }
  const ok = await call(controller.updateRouteFare, { params: { id: 'rf1' }, body: { toCity: ' Nashik ' } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(updated, { to_city: 'nashik' });
});

test('end to end: a fare switched off in Fleet is not revived when the route is switched off and on in Rates', async () => {
  rows.push({ id: 'rf2', business_id: 'b1', from_city: 'pune', to_city: 'shirdi', trip_type: 'round_trip', vehicle_id: 'v1', fare: 5200, is_active: true, off_reason: null });
  await call(controller.updateRouteFare, { params: { id: 'rf2' }, body: { isActive: false } });
  assert.deepEqual([rows[1].is_active, rows[1].off_reason], [false, 'manual']);

  // the real Rates cascade (travelRoute.service#updateRoute): route off -> every fare off; route on -> only fares with no marker
  const cascade = (isActive) => routeService.updateRoute('b1', 'r1', { isActive });
  await cascade(false);
  assert.deepEqual(rows.map(r => r.is_active), [false, false]);
  await cascade(true);
  assert.deepEqual(rows.map(r => r.is_active), [true, false], 'the Fleet switch-off survives the route off / on');

  // and switching it back on in Fleet clears the marker, so the cascade treats it like any other fare again
  await call(controller.updateRouteFare, { params: { id: 'rf2' }, body: { isActive: true } });
  assert.deepEqual([rows[1].is_active, rows[1].off_reason], [true, null]);
  await cascade(false);
  await cascade(true);
  assert.deepEqual(rows.map(r => r.is_active), [true, true]);
});

test('Rates and Fleet write the same columns for an on / off', () => {
  const { fareSwitchColumns } = require('../../utils/travelQuote');
  assert.deepEqual(fareSwitchColumns(false), { is_active: false, off_reason: 'manual' });
  assert.deepEqual(fareSwitchColumns(true), { is_active: true, off_reason: null });
  assert.deepEqual(fareSwitchColumns(undefined), {});
  assert.equal(typeof routeService.updateRoute, 'function');
});
