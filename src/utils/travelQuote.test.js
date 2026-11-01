// Run: node --test src/utils/travelQuote.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCity, validateRouteInput, validateSettingsInput, isNightMinute, computeQuote, computeAdvance, DEFAULT_SETTINGS
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

test('computeQuote: night charge, round-trip driver allowance, rounding to 10', () => {
  const settings = { ...DEFAULT_SETTINGS, nightCharge: 300, driverAllowancePerDay: 250 };
  const night = computeQuote({ baseFare: 2503, tripType: 'oneway', pickupMinute: 23 * 60, settings });
  assert.equal(night.total, 2800);
  const day = computeQuote({ baseFare: 2500, tripType: 'oneway', pickupMinute: 10 * 60, settings });
  assert.equal(day.total, 2500);
  const rt = computeQuote({ baseFare: 4999, tripType: 'round_trip', days: 2, pickupMinute: 10 * 60, settings });
  assert.equal(rt.total, 5500);
  assert.equal(rt.extras[0].amount, 500);
  // allowance is round-trip only
  assert.equal(computeQuote({ baseFare: 2500, tripType: 'oneway', days: 2, settings }).total, 2500);
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
