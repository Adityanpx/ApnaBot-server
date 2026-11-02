// Run: node --test src/controllers/travel/vehicle.controller.test.js
// The Round Trip fields (minKmPerDay, driverAllowancePerDay) on POST/PUT /api/vehicles.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

let inserted; let updated;
const vehicleRow = (over = {}) => ({ id: 'v1', business_id: 'b1', catalog_id: 'c1', per_km_rate: 23, min_km_per_day: null, driver_allowance_per_day: null, ...over });
stub('../../config/supabase', {
  from: (table) => {
    const q = {
      select: () => q,
      insert: (row) => { inserted = row; return q; },
      update: (row) => { updated = row; return q; },
      eq: () => q,
      maybeSingle: async () => ({ data: table === 'vehicles' ? { id: 'v1' } : { id: 'c1' }, error: null }),
      single: async () => ({ data: vehicleRow({ ...(inserted || {}), ...(updated || {}) }), error: null })
    };
    return q;
  }
});
stub('../../services/r2.service', {});
stub('../../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
const controller = require('./vehicle.controller');

const run = async (fn, { body, params = {} }) => {
  inserted = undefined; updated = undefined;
  const res = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
  let nextError = null;
  await fn({ body, params, user: { businessId: 'b1' } }, res, (e) => { nextError = e; });
  assert.equal(nextError, null);
  return res;
};

test('create: the Round Trip fields are saved as columns; null and empty leave them unset', async () => {
  const res = await run(controller.createVehicle, { body: { catalogId: 'c1', perKmRate: 23, minKmPerDay: 250, driverAllowancePerDay: 300 } });
  assert.equal(res.statusCode, 201);
  assert.equal(inserted.min_km_per_day, 250);
  assert.equal(inserted.driver_allowance_per_day, 300);
  assert.equal(res.body.data.minKmPerDay, 250);
  await run(controller.createVehicle, { body: { catalogId: 'c1' } });
  assert.equal('min_km_per_day' in inserted, false);
  assert.equal('driver_allowance_per_day' in inserted, false);
});

test('create and edit: min km must be above 0 and the allowance 0 or more', async () => {
  const create = await run(controller.createVehicle, { body: { catalogId: 'c1', minKmPerDay: 0 } });
  assert.equal(create.statusCode, 400);
  assert.equal(inserted, undefined);
  const edit = await run(controller.updateVehicle, { params: { id: 'v1' }, body: { driverAllowancePerDay: -5 } });
  assert.equal(edit.statusCode, 400);
  assert.equal(updated, undefined);
});

test('edit: only the keys sent are written; null clears a field; perKmRate handling is unchanged', async () => {
  await run(controller.updateVehicle, { params: { id: 'v1' }, body: { minKmPerDay: 250 } });
  assert.deepEqual(updated, { min_km_per_day: 250 });
  await run(controller.updateVehicle, { params: { id: 'v1' }, body: { minKmPerDay: null, driverAllowancePerDay: 0, perKmRate: 0 } });
  assert.deepEqual(updated, { min_km_per_day: null, driver_allowance_per_day: 0, per_km_rate: 0 });
});
