// Run: node --test src/utils/travelQuote.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCity, validateRouteInput, validateSettingsInput, validateVehicleFareInput, isNightMinute,
  computeRoundTripFare, priceVehicleTrip, roundTripReadiness, computeQuote, computeAdvance, DEFAULT_SETTINGS
} = require('./travelQuote');

test('normalizeCity trims, lowercases and collapses spaces', () => {
  assert.equal(normalizeCity('  Navi   Mumbai '), 'navi mumbai');
  assert.equal(normalizeCity(undefined), '');
});

test('validateRouteInput: create needs different cities and checks fares', () => {
  assert.ok(validateRouteInput({}).errors.length >= 2);
  assert.match(validateRouteInput({ fromCity: 'Pune', toCity: 'pune' }).errors[0], /different/);
  const ok = validateRouteInput({
    fromCity: ' Pune ', toCity: 'Mumbai', region: 'West', tollIncluded: null,
    fares: [{ tripType: 'oneway', vehicleId: 'v1', fare: 2500 }, { tripType: 'round_trip', vehicleId: 'v1', fare: 4999 }]
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.from_city, 'pune');
  assert.equal(ok.value.region, 'West');
  assert.equal(ok.value.toll_included, null);
  assert.equal(ok.value.fares.length, 2);
});

test('validateRouteInput: bad fares, trip types, duplicates and long labels are refused', () => {
  const base = { fromCity: 'a', toCity: 'b' };
  assert.ok(validateRouteInput({ ...base, fares: [{ tripType: 'local', vehicleId: 'v', fare: 5 }] }).errors.length);
  assert.ok(validateRouteInput({ ...base, fares: [{ tripType: 'oneway', vehicleId: 'v', fare: 0 }] }).errors.length);
  assert.ok(validateRouteInput({ ...base, fares: [{ tripType: 'oneway', vehicleId: 'v', fare: '5' }] }).errors.length);
  assert.ok(validateRouteInput({ ...base, fares: [{ tripType: 'oneway', vehicleId: 'v', fare: 5 }, { tripType: 'oneway', vehicleId: 'v', fare: 6 }] }).errors.length);
  assert.ok(validateRouteInput({ ...base, fromLabel: 'x'.repeat(25) }).errors.length);
  // a removal needs no fare
  assert.deepEqual(validateRouteInput({ ...base, fares: [{ tripType: 'oneway', vehicleId: 'v', remove: true }] }).errors, []);
});

test('validateRouteInput: an edit only carries the keys sent', () => {
  const { errors, value } = validateRouteInput({ region: '' }, { isEdit: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(value, { region: null });
});

test('validateSettingsInput: ranges and the reminder-before-expiry rule', () => {
  assert.ok(validateSettingsInput({}).errors.length);
  assert.ok(validateSettingsInput({ nightCharge: -1 }).errors.length);
  assert.ok(validateSettingsInput({ validHours: 0 }).errors.length);
  assert.ok(validateSettingsInput({ nightStartMinute: 1440 }).errors.length);
  assert.match(validateSettingsInput({ reminderAfterHours: 24 }).errors[0], /less than validHours/);
  assert.deepEqual(validateSettingsInput({ validHours: 48, reminderAfterHours: 24 }).errors, []);
  const ok = validateSettingsInput({ minimumCharge: 1500, tollIncluded: true });
  assert.deepEqual(ok.value, { minimum_charge: 1500, toll_included: true });
});

test('isNightMinute handles a window that wraps midnight and one that does not', () => {
  assert.equal(isNightMinute(23 * 60, 1320, 360), true);
  assert.equal(isNightMinute(2 * 60, 1320, 360), true);
  assert.equal(isNightMinute(12 * 60, 1320, 360), false);
  assert.equal(isNightMinute(360, 1320, 360), false);
  assert.equal(isNightMinute(60, 0, 120), true);
  assert.equal(isNightMinute(60, 600, 600), false);
  assert.equal(isNightMinute(null, 1320, 360), false);
});

test('computeQuote: base fare only with default settings', () => {
  const q = computeQuote({ baseFare: 2500, tripType: 'oneway' });
  assert.equal(q.total, 2500);
  assert.deepEqual(q.extras, []);
  assert.equal(q.tollIncluded, false);
});

test('computeQuote: One Way keeps the night charge and rounding to 10; the old business-wide allowance is gone', () => {
  const settings = { ...DEFAULT_SETTINGS, nightCharge: 300, driverAllowancePerDay: 250 };
  const night = computeQuote({ baseFare: 2503, tripType: 'oneway', pickupMinute: 23 * 60, settings });
  assert.equal(night.total, 2800);
  const day = computeQuote({ baseFare: 2500, tripType: 'oneway', pickupMinute: 10 * 60, settings });
  assert.equal(day.total, 2500);
  // retired: a package Round Trip no longer picks up a per-day allowance from the settings, and is not rounded to 10
  const rt = computeQuote({ baseFare: 4999, tripType: 'round_trip', days: 2, pickupMinute: 10 * 60, settings });
  assert.equal(rt.total, 4999);
  assert.deepEqual(rt.extras, []);
  assert.equal('driverAllowancePerDay' in DEFAULT_SETTINGS, false);
});

test('computeQuote: a formula Round Trip = km charge + vehicle allowance, then the night charge, to the rupee', () => {
  const roundTrip = computeRoundTripFare({ oneWayKm: 185, days: 3, minKmPerDay: 250, ratePerKm: 23, allowancePerUnit: 300 });
  const day = computeQuote({ baseFare: 0, tripType: 'round_trip', roundTrip, pickupMinute: 10 * 60 });
  assert.equal(day.total, 18150);
  assert.equal(day.baseFare, 17250);
  assert.deepEqual(day.extras.map(e => [e.key, e.amount]), [['driver_allowance', 900]]);
  const night = computeQuote({ baseFare: 0, tripType: 'round_trip', roundTrip, pickupMinute: 23 * 60, settings: { ...DEFAULT_SETTINGS, nightCharge: 250 } });
  assert.deepEqual(night.extras.map(e => [e.key, e.amount]), [['driver_allowance', 900], ['night_charge', 250]]);
  assert.equal(night.total, 18400);
  // the minimum charge still lifts a low total as its own line
  const low = computeRoundTripFare({ oneWayKm: 20, days: 1, minKmPerDay: 100, ratePerKm: 10 });
  const lifted = computeQuote({ baseFare: 0, tripType: 'round_trip', roundTrip: low, settings: { ...DEFAULT_SETTINGS, minimumCharge: 1500 } });
  assert.equal(lifted.total, 1500);
  assert.deepEqual(lifted.extras.map(e => [e.key, e.amount]), [['minimum_charge', 500]]);
});

// Pune -> Shirdi 185 km one way, Innova Rs 23/km, 250 km minimum a day, Rs 300 allowance
const SHIRDI = { oneWayKm: 185, minKmPerDay: 250, ratePerKm: 23, allowancePerUnit: 300 };
const fare = (over) => computeRoundTripFare({ ...SHIRDI, days: 1, ...over });

test('computeRoundTripFare: 1 day = 8,810 and 3 days = 18,150 (the approved worked examples)', () => {
  const one = fare({ days: 1 });
  assert.equal(one.billedKm, 370);
  assert.equal(one.kmCharge, 8510);
  assert.deepEqual(one.allowance, { perUnit: 300, units: 1, basis: 'day', amount: 300 });
  assert.equal(one.total, 8810);
  const three = fare({ days: 3 });
  assert.equal(three.billedKm, 750);
  assert.equal(three.kmCharge, 17250);
  assert.equal(three.allowance.amount, 900);
  assert.equal(three.total, 18150);
});

test('computeRoundTripFare: the minimum km wins on a short route, 2 x distance on a long one', () => {
  const short = fare({ oneWayKm: 66, days: 1 });
  assert.equal(short.billedKm, 250);
  assert.equal(short.total, 6050);
  const long = fare({ oneWayKm: 450, days: 2 });
  assert.equal(long.billedKm, 900);
  assert.equal(long.total, 21300);
});

test('computeRoundTripFare: allowance per day vs per night; a same-day return has 0 nights; allowance 0 or missing', () => {
  assert.equal(fare({ days: 3, allowanceBasis: 'day' }).total, 18150);
  const night = fare({ days: 3, allowanceBasis: 'night' });
  assert.deepEqual(night.allowance, { perUnit: 300, units: 2, basis: 'night', amount: 600 });
  assert.equal(night.total, 17850);
  const sameDay = fare({ days: 1, allowanceBasis: 'night' });
  assert.equal(sameDay.allowance.amount, 0);
  assert.equal(sameDay.total, 8510);
  assert.equal(fare({ days: 3, allowancePerUnit: 0 }).total, 17250);
  assert.equal(fare({ days: 3, allowancePerUnit: null }).total, 17250);
  assert.equal(fare({ days: 3, allowancePerUnit: undefined }).total, 17250);
});

test('computeRoundTripFare: rounds to the nearest rupee, half up, and the lines add up to the total', () => {
  // 367.4 km x 22.75 = 8,358.35 + 300 -> 8,658
  const down = fare({ oneWayKm: 183.7, ratePerKm: 22.75 });
  assert.equal(down.total, 8658);
  // 367.4 km x 22.5 = 8,266.5 + 300 = 8,566.5 -> 8,567 (no float noise)
  const half = fare({ oneWayKm: 183.7, ratePerKm: 22.5 });
  assert.equal(half.total, 8567);
  for (const r of [down, half, fare({ days: 3 }), fare({ oneWayKm: 99.9, ratePerKm: 17.35, allowancePerUnit: 150.5, days: 2 })]) {
    assert.equal(r.kmCharge + r.allowance.amount, r.total);
    assert.ok(Number.isInteger(r.total) && Number.isInteger(r.kmCharge));
  }
});

test('computeRoundTripFare: nothing missing is guessed - null, 0 or negative inputs say what is missing', () => {
  assert.deepEqual(fare({ minKmPerDay: null }), { ok: false, reason: 'missing_min_km' });
  assert.deepEqual(fare({ minKmPerDay: 0 }), { ok: false, reason: 'missing_min_km' });
  assert.deepEqual(fare({ oneWayKm: null }), { ok: false, reason: 'missing_distance' });
  assert.deepEqual(fare({ oneWayKm: -5 }), { ok: false, reason: 'missing_distance' });
  assert.deepEqual(fare({ ratePerKm: null }), { ok: false, reason: 'missing_rate' });
  assert.deepEqual(fare({ ratePerKm: 0 }), { ok: false, reason: 'missing_rate' });
  assert.deepEqual(fare({ days: null }), { ok: false, reason: 'missing_days' });
  assert.deepEqual(fare({ days: 0 }), { ok: false, reason: 'missing_days' });
  assert.deepEqual(fare({ days: 1.5 }), { ok: false, reason: 'missing_days' });
  // a numeric column can arrive as a string
  assert.equal(fare({ oneWayKm: '185', ratePerKm: '23' }).total, 8810);
});

test('priceVehicleTrip: One Way is the fare as entered; a fixed Round Trip fare wins for any days and is not rounded', () => {
  const vehicle = { perKmRate: 23, minKmPerDay: 250, driverAllowancePerDay: 300 };
  assert.deepEqual(priceVehicleTrip({ tripType: 'oneway', fare: 4200, vehicle }), { ok: true, method: 'fixed', baseFare: 4200, total: 4200 });
  for (const days of [1, 3, 9]) {
    const r = priceVehicleTrip({ tripType: 'round_trip', days, fare: 7300, oneWayKm: 185, vehicle });
    assert.equal(r.method, 'package');
    assert.equal(r.total, 7300);
  }
  assert.equal(priceVehicleTrip({ tripType: 'round_trip', days: 2, fare: 4999, vehicle }).total, 4999);
  // a package price needs no distance, min km or rate
  assert.equal(priceVehicleTrip({ tripType: 'round_trip', days: 2, fare: 7300, vehicle: {} }).ok, true);
});

test('priceVehicleTrip: without a package price the formula runs; missing inputs say owner confirms', () => {
  const vehicle = { perKmRate: 23, minKmPerDay: 250, driverAllowancePerDay: 300 };
  const three = priceVehicleTrip({ tripType: 'round_trip', days: 3, fare: null, oneWayKm: 185, vehicle });
  assert.equal(three.method, 'formula');
  assert.equal(three.total, 18150);
  assert.equal(three.baseFare, 17250);
  assert.equal(priceVehicleTrip({ tripType: 'round_trip', days: 3, oneWayKm: 185, vehicle, allowanceBasis: 'night' }).total, 17850);
  assert.deepEqual(priceVehicleTrip({ tripType: 'round_trip', days: 3, oneWayKm: 185, vehicle: { ...vehicle, minKmPerDay: null } }), { ok: false, reason: 'missing_min_km' });
  assert.deepEqual(priceVehicleTrip({ tripType: 'round_trip', days: 3, oneWayKm: null, vehicle }), { ok: false, reason: 'missing_distance' });
  assert.deepEqual(priceVehicleTrip({ tripType: 'round_trip', days: 3, oneWayKm: 185, vehicle: { ...vehicle, perKmRate: 0 } }), { ok: false, reason: 'missing_rate' });
  assert.deepEqual(priceVehicleTrip({ tripType: 'oneway', fare: null }), { ok: false, reason: 'missing_fare' });
});

test('roundTripReadiness: a route is ready when at least one vehicle can be priced, else says what to add', () => {
  const full = { perKmRate: 23, minKmPerDay: 250 };
  assert.deepEqual(roundTripReadiness({ oneWayKm: 185, vehicles: [{ fare: null, vehicle: full }] }), { ready: true, reason: null });
  assert.deepEqual(roundTripReadiness({ oneWayKm: null, vehicles: [{ fare: 7300, vehicle: {} }] }), { ready: true, reason: null });
  assert.deepEqual(roundTripReadiness({ oneWayKm: null, vehicles: [{ fare: null, vehicle: full }] }), { ready: false, reason: 'add_distance' });
  assert.deepEqual(roundTripReadiness({ oneWayKm: 185, vehicles: [{ fare: null, vehicle: { perKmRate: 23, minKmPerDay: null } }] }), { ready: false, reason: 'add_min_km' });
  assert.deepEqual(roundTripReadiness({ oneWayKm: 185, vehicles: [{ fare: null, vehicle: { perKmRate: 0, minKmPerDay: 250 } }] }), { ready: false, reason: 'add_rate' });
  assert.deepEqual(roundTripReadiness({ oneWayKm: 185, vehicles: [] }), { ready: false, reason: 'no_vehicle' });
  // one complete vehicle is enough; the incomplete one is "owner confirms" later
  assert.equal(roundTripReadiness({ oneWayKm: 185, vehicles: [{ fare: null, vehicle: {} }, { fare: null, vehicle: full }] }).ready, true);
});

test('validateVehicleFareInput: min km above 0, allowance 0 or more, null clears, only keys sent', () => {
  assert.deepEqual(validateVehicleFareInput({}), { errors: [], value: {} });
  assert.deepEqual(validateVehicleFareInput({ minKmPerDay: 250, driverAllowancePerDay: 0 }), { errors: [], value: { min_km_per_day: 250, driver_allowance_per_day: 0 } });
  assert.deepEqual(validateVehicleFareInput({ minKmPerDay: null, driverAllowancePerDay: '' }).value, { min_km_per_day: null, driver_allowance_per_day: null });
  assert.equal(validateVehicleFareInput({ minKmPerDay: 0 }).errors.length, 1);
  assert.equal(validateVehicleFareInput({ minKmPerDay: -1 }).errors.length, 1);
  assert.equal(validateVehicleFareInput({ minKmPerDay: '250' }).errors.length, 1);
  assert.equal(validateVehicleFareInput({ driverAllowancePerDay: -1 }).errors.length, 1);
});

test('route and settings input: oneWayDistanceKm and allowanceBasis', () => {
  const r = validateRouteInput({ oneWayDistanceKm: 185.5 }, { isEdit: true });
  assert.deepEqual(r, { errors: [], value: { one_way_distance_km: 185.5 } });
  assert.equal(validateRouteInput({ oneWayDistanceKm: null }, { isEdit: true }).value.one_way_distance_km, null);
  assert.equal(validateRouteInput({ oneWayDistanceKm: '' }, { isEdit: true }).value.one_way_distance_km, null);
  for (const bad of [0, -3, 5001, '185', NaN]) assert.equal(validateRouteInput({ oneWayDistanceKm: bad }, { isEdit: true }).errors.length, 1);
  assert.deepEqual(validateSettingsInput({ allowanceBasis: 'night' }).value, { allowance_basis: 'night' });
  assert.equal(validateSettingsInput({ allowanceBasis: 'week' }).errors.length, 1);
  assert.equal(DEFAULT_SETTINGS.allowanceBasis, 'day');
  // the retired field is no longer accepted
  assert.deepEqual(validateSettingsInput({ driverAllowancePerDay: 300 }).errors, ['Nothing to update']);
});

test('computeQuote: the minimum charge lifts a low total; the route toll override wins', () => {
  const q = computeQuote({ baseFare: 800, tripType: 'oneway', tollOverride: true, settings: { ...DEFAULT_SETTINGS, minimumCharge: 1500 } });
  assert.equal(q.total, 1500);
  assert.equal(q.extras.at(-1).key, 'minimum_charge');
  assert.equal(q.extras.at(-1).amount, 700);
  assert.equal(q.tollIncluded, true);
  assert.equal(computeQuote({ baseFare: 1, tripType: 'oneway', tollOverride: false, settings: { ...DEFAULT_SETTINGS, tollIncluded: true } }).tollIncluded, false);
});

test('computeAdvance uses the business-wide advance settings', () => {
  assert.equal(computeAdvance(null, 1000), null);
  assert.equal(computeAdvance({ requireAdvancePayment: false, advancePaymentType: 'percentage', advancePaymentValue: 20 }, 2500), null);
  assert.equal(computeAdvance({ requireAdvancePayment: true, advancePaymentType: 'percentage', advancePaymentValue: 20 }, 2500), 500);
  assert.equal(computeAdvance({ requireAdvancePayment: true, advancePaymentType: 'percentage', advancePaymentValue: 33.3 }, 2500), 832.5);
  assert.equal(computeAdvance({ requireAdvancePayment: true, advancePaymentType: 'fixed', advancePaymentValue: 1000 }, 2500), 1000);
  assert.equal(computeAdvance({ requireAdvancePayment: true, advancePaymentType: 'fixed', advancePaymentValue: 5000 }, 2500), 2500);
  assert.equal(computeAdvance({ requireAdvancePayment: true, advancePaymentType: 'fixed', advancePaymentValue: 0 }, 2500), null);
});

// ── Seats for a passenger answer (quote flow vehicle filter) ──
test('minSeatsFor: bands use the upper end, plain numbers themselves, anything else no filter', () => {
  const { minSeatsFor } = require('./travelQuote');
  assert.equal(minSeatsFor('1-4'), 4);
  assert.equal(minSeatsFor('5-6'), 6);
  assert.equal(minSeatsFor('7+'), 7);
  assert.equal(minSeatsFor('5'), 5);
  assert.equal(minSeatsFor('lots'), null);
  assert.equal(minSeatsFor(undefined), null);
});

test('filterOptionsBySeats: keeps what seats the party, unknown seats stay, indexes restart at 0', () => {
  const { filterOptionsBySeats } = require('./travelQuote');
  const options = [{ index: 0, name: 'Dzire', seats: 4 }, { index: 1, name: 'Mystery', seats: null }, { index: 2, name: 'Crysta', seats: 7 }];
  assert.deepEqual(filterOptionsBySeats(options, '5-6').map(o => [o.name, o.index]), [['Mystery', 0], ['Crysta', 1]]);
  assert.deepEqual(filterOptionsBySeats(options, '1-4').map(o => o.name), ['Dzire', 'Mystery', 'Crysta']);
  assert.equal(filterOptionsBySeats(options, '7+').length, 2);
  assert.equal(filterOptionsBySeats(options, 'unknown'), options);
  assert.deepEqual(filterOptionsBySeats([{ index: 0, seats: 4 }], '7+'), []);
});

test('validateRouteInput: label / region translations are { language: text <= 24 }, never en, null or {} clears', () => {
  const ok = validateRouteInput({ toLabelTranslations: { mr: ' शिर्डी ', gu: '' }, regionTranslations: null, fromLabelTranslations: {} }, { isEdit: true });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.value, { to_label_translations: { mr: 'शिर्डी' }, region_translations: null, from_label_translations: null });
  for (const bad of [{ en: 'Pune' }, { xx: 'Pune' }, { mr: 'x'.repeat(25) }, { mr: 5 }, 'text', ['a']]) {
    assert.equal(validateRouteInput({ fromLabelTranslations: bad }, { isEdit: true }).errors.length, 1, JSON.stringify(bad));
  }
});
