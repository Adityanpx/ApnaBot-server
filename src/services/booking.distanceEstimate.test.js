// Run: node --test src/services/booking.distanceEstimate.test.js
// The distance estimate for a route with no fare (findDistanceBasedVehicleOptions) and the tap re-price
// (repriceEstimateOption). A Round Trip with a day count uses the quote's own formula (computeRoundTripFare):
// billed km = max(2 x one-way, days x min km). The vehicle's min km / allowance win; business_travel_settings
// are only the fallback for a null vehicle field. One Way is unchanged. In-memory Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');

const stub = (file, exports) => {
  const p = require.resolve(path.join(__dirname, file));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const state = { business: null, oneWayKm: 187.675, lookups: 0 };
stub('./business.service', { getBusinessById: async () => state.business });
stub('./distanceMatrix.service', { getDistanceKm: async () => { state.lookups += 1; return state.oneWayKm; } });

const bookingService = require('./booking.service');
const { computeRoundTripFare } = require('../utils/travelQuote');

const { B1, uuid } = h;
const catalog = { name: 'Car', photo_url: null, seats: 4 };
const vehicle = (n, extra = {}) => ({
  id: uuid(n), business_id: B1, is_active: true, custom_name: `Car ${n}`, catalog, per_km_rate: 13,
  min_km_per_day: null, driver_allowance_per_day: null, ...extra
});

// settings as business.service attaches them (camelCase business_travel_settings)
const SEARCH_CAB_LIKE = { enableDistanceFares: true, roundTripPerDayKm: 250, roundTripDriverDaEnabled: true, roundTripDriverDaAmount: 0 };

const seed = ({ vehicles, settings = SEARCH_CAB_LIKE, basis = null, oneWayKm = 187.675 }) => {
  const db = h.reset();
  db.vehicles = vehicles;
  db.travel_quote_settings = basis ? [{ business_id: B1, allowance_basis: basis }] : [];
  state.business = { id: B1, travelSettings: settings };
  state.oneWayKm = oneWayKm;
  state.lookups = 0;
  return db;
};
const rt = (days, trip = 'Round Trip') => bookingService.findDistanceBasedVehicleOptions(B1, 'Pune', 'Shirdi', trip, days);
const legacy = (days, rate, perDayKm = 250) => Math.round((days * perDayKm * rate) / 10) * 10; // the formula before this change

test('One Way: unchanged - one-way distance x rate, rounded to 10', async () => {
  seed({ vehicles: [vehicle(1)] });
  const [o] = await rt(undefined, 'One Way');
  assert.equal(o.fare, Math.round((187.675 * 13) / 10) * 10);
  assert.equal(o.distanceKm, 187.7);
  assert.equal(o.estimate, undefined);
  assert.equal(o.driverDaIncluded, undefined);
});

test('Round Trip with no day count: unchanged - twice the one-way distance x rate, no allowance', async () => {
  seed({ vehicles: [vehicle(1, { driver_allowance_per_day: 300 })] });
  const [o] = await rt(undefined);
  assert.equal(o.fare, Math.round((2 * 187.675 * 13) / 10) * 10);
  assert.equal(o.driverDaIncluded, undefined);
});

test('Round Trip with days: the Google lookup is no longer skipped', async () => {
  seed({ vehicles: [vehicle(1)] });
  await rt(2);
  assert.equal(state.lookups, 1);
});

test('Round Trip with days and a failed lookup: no estimate (nothing guessed)', async () => {
  seed({ vehicles: [vehicle(1)], oneWayKm: null });
  assert.deepEqual(await rt(2), []);
});

test('uses computeRoundTripFare: the card equals the quote formula for the same inputs', async () => {
  seed({ vehicles: [vehicle(1, { per_km_rate: 23, min_km_per_day: 250, driver_allowance_per_day: 300 })], basis: 'day' });
  const [o] = await rt(3);
  const expected = computeRoundTripFare({ oneWayKm: 187.675, days: 3, minKmPerDay: 250, ratePerKm: 23, allowancePerUnit: 300, allowanceBasis: 'day' });
  assert.equal(o.fare, expected.total);
  assert.equal(o.distanceKm, expected.billedKm);
  assert.equal(o.driverDaTotal, expected.allowance.amount);
});

test('vehicle fields set: min km and allowance come from the vehicle, not from the business settings', async () => {
  seed({
    vehicles: [vehicle(1, { min_km_per_day: 300, driver_allowance_per_day: 500 })],
    settings: { ...SEARCH_CAB_LIKE, roundTripPerDayKm: 100, roundTripDriverDaAmount: 999 }
  });
  const [o] = await rt(2); // 2 x 300 = 600 km (> 375.35), allowance 500 x 2 days
  assert.equal(o.distanceKm, 600);
  assert.equal(o.driverDaTotal, 1000);
  assert.equal(o.driverDaPerDay, 500);
  assert.equal(o.driverDaDays, 2);
  assert.equal(o.fare, 600 * 13 + 1000);
});

test('vehicle fields null: falls back to the business settings (min km, DA when enabled)', async () => {
  seed({
    vehicles: [vehicle(1)],
    settings: { ...SEARCH_CAB_LIKE, roundTripPerDayKm: 400, roundTripDriverDaEnabled: true, roundTripDriverDaAmount: 250 }
  });
  const [o] = await rt(2);
  assert.equal(o.distanceKm, 800);
  assert.equal(o.driverDaTotal, 500);
  assert.equal(o.fare, 800 * 13 + 500);
});

test('vehicle fields null and the settings DA switch is off: the settings amount is ignored', async () => {
  seed({ vehicles: [vehicle(1)], settings: { ...SEARCH_CAB_LIKE, roundTripDriverDaEnabled: false, roundTripDriverDaAmount: 250 } });
  const [o] = await rt(2);
  assert.equal(o.driverDaIncluded, undefined);
  assert.equal(o.fare, 500 * 13);
});

test('an allowance of 0 on the vehicle is a real value (no fallback to the settings amount)', async () => {
  seed({
    vehicles: [vehicle(1, { driver_allowance_per_day: 0 })],
    settings: { ...SEARCH_CAB_LIKE, roundTripDriverDaAmount: 250 }
  });
  const [o] = await rt(2);
  assert.equal(o.driverDaIncluded, undefined);
  assert.equal(o.fare, 500 * 13);
});

test('no min km anywhere (settings 0, vehicle null): 250 km per day', async () => {
  seed({ vehicles: [vehicle(1)], settings: { ...SEARCH_CAB_LIKE, roundTripPerDayKm: 0 } });
  const [o] = await rt(3);
  assert.equal(o.distanceKm, 750);
});

test('allowance basis: day charges days, night charges days - 1 (and a same-day return has none)', async () => {
  const v = vehicle(1, { min_km_per_day: 250, driver_allowance_per_day: 300 });
  seed({ vehicles: [v], basis: 'day' });
  const day = await rt(3);
  assert.equal(day[0].driverDaTotal, 900);
  assert.equal(day[0].driverDaDays, 3);

  seed({ vehicles: [v], basis: 'night' });
  const night = await rt(3);
  assert.equal(night[0].driverDaTotal, 600);
  assert.equal(night[0].driverDaDays, 2);
  assert.equal(night[0].fare, 750 * 13 + 600);

  const same = await rt(1);
  assert.equal(same[0].driverDaIncluded, undefined);
  assert.equal(same[0].driverDaTotal, undefined);
});

test('no travel_quote_settings row: basis defaults to day', async () => {
  seed({ vehicles: [vehicle(1, { min_km_per_day: 250, driver_allowance_per_day: 300 })], basis: null });
  const [o] = await rt(2);
  assert.equal(o.driverDaTotal, 600);
});

test('1 day: twice the one-way distance wins over the minimum km on a long route', async () => {
  seed({ vehicles: [vehicle(1, { min_km_per_day: 250 })], oneWayKm: 187.675 });
  const [o] = await rt(1);
  assert.equal(o.distanceKm, 375.4); // 2 x 187.675 = 375.35 (> 250)
  assert.equal(o.fare, Math.round(375.4 * 13)); // computeRoundTripFare works in tenths of a km: 3754 x 13 = 48802 -> 4880
});

test('2 days: the minimum km wins over twice the one-way distance', async () => {
  seed({ vehicles: [vehicle(1, { min_km_per_day: 250 })] });
  const [o] = await rt(2);
  assert.equal(o.distanceKm, 500);
  assert.equal(o.fare, 500 * 13);
});

test('Search cab AI-like settings (250 km, DA on / 0, vehicle fields null): same fare as before when days x min km wins', async () => {
  seed({ vehicles: [vehicle(1, { per_km_rate: 13 }), vehicle(2, { per_km_rate: 23 }), vehicle(3, { per_km_rate: 36 })] });
  for (const days of [2, 3, 4]) {
    const options = await rt(days);
    assert.deepEqual(options.map(o => o.fare), [13, 23, 36].map(rate => legacy(days, rate)), `${days} days`);
    assert.ok(options.every(o => o.driverDaIncluded === undefined), 'DA amount 0 adds nothing');
  }
  // a short route, 1 day: 250 km is more than twice the one-way distance, so also the same
  seed({ vehicles: [vehicle(1, { per_km_rate: 13 })], oneWayKm: 100 });
  assert.equal((await rt(1))[0].fare, legacy(1, 13));
});

test('a vehicle the formula cannot price (per-km rate 0) is left out; the others stay', async () => {
  seed({ vehicles: [vehicle(1, { per_km_rate: 0 }), vehicle(2, { per_km_rate: 23 })] });
  const options = await rt(2);
  assert.deepEqual(options.map(o => o.vehicleId), [uuid(2)]);
});

test('Round Trip fares are to the nearest rupee, not to 10 (as the quote)', async () => {
  seed({ vehicles: [vehicle(1, { per_km_rate: 16.5, min_km_per_day: 250 })] });
  const [o] = await rt(3); // 750 x 16.5 = 12375
  assert.equal(o.fare, 12375);
});

// ---- the tap re-price and the web-form re-verification ------------------------------------------------

test('tap re-price: with the unchanged rate, the fare and the allowance equal the card (day and night basis)', async () => {
  for (const basis of ['day', 'night']) {
    seed({ vehicles: [vehicle(1, { per_km_rate: 23, min_km_per_day: 250, driver_allowance_per_day: 300 })], basis });
    for (const days of [1, 2, 3]) {
      const [card] = await rt(days);
      const again = bookingService.repriceEstimateOption(card, 23);
      assert.equal(again.fare, card.fare, `${basis} ${days}`);
      assert.equal(again.driverDaTotal, card.driverDaTotal ?? 0, `${basis} ${days}`);
    }
  }
});

test('tap re-price: a changed per-km rate re-prices with the same formula; an unpriceable rate returns null', async () => {
  seed({ vehicles: [vehicle(1, { per_km_rate: 13, min_km_per_day: 250, driver_allowance_per_day: 300 })] });
  const [card] = await rt(3);
  const repriced = bookingService.repriceEstimateOption(card, 15);
  assert.equal(repriced.fare, 750 * 15 + 900);
  assert.equal(bookingService.repriceEstimateOption(card, 0), null);
});

test('tap re-price: a One Way card (no estimate) keeps the old distance x rate, rounded to 10', async () => {
  seed({ vehicles: [vehicle(1)] });
  const [card] = await rt(undefined, 'One Way');
  assert.deepEqual(bookingService.repriceEstimateOption(card, 13), { fare: card.fare, driverDaTotal: 0 });
  assert.equal(bookingService.repriceEstimateOption(card, 20).fare, Math.round((card.distanceKm * 20) / 10) * 10);
});

test('web-form re-verification: running the estimate again for the same trip gives the same fare, km and allowance', async () => {
  seed({ vehicles: [vehicle(1, { per_km_rate: 23, min_km_per_day: 250, driver_allowance_per_day: 300 })], basis: 'night' });
  const [shown] = await rt(3);
  const [atSubmit] = await rt(3);
  for (const key of ['fare', 'distanceKm', 'driverDaTotal', 'driverDaPerDay', 'driverDaDays']) assert.equal(atSubmit[key], shown[key], key);
});
