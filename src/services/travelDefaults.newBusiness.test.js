// Run: node --test src/services/travelDefaults.newBusiness.test.js
// A brand-new travels business: no travel_quote_settings row, no min km / allowance on its vehicle, one vehicle
// with a per-km rate, and the signup flags (no old driver-DA switch). Nothing here depends on any real business.
// Also the night-basis wording of the Driver DA line in the booking confirmation / summary (en hi mr + a machine language).
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
const state = { business: null, oneWayKm: 150 };
stub('./business.service', { getBusinessById: async () => state.business });
stub('./distanceMatrix.service', { getDistanceKm: async () => state.oneWayKm });
stub('./reports.service', { getPeriodRanges: () => ({}) });

const bookingService = require('./booking.service');
const travelQuoteService = require('./travelQuote.service');
const { computeQuote, priceVehicleTrip, DEFAULT_SETTINGS } = require('../utils/travelQuote');
const { computeFeatureFlags } = require('../config/categoryFeatures');

const { B1, uuid } = h;
const NEW_VEHICLE = { id: uuid(1), business_id: B1, is_active: true, custom_name: 'Swift', catalog: { name: 'Swift', photo_url: null, seats: 4 }, per_km_rate: 14 };

// what signup writes into business_travel_settings for category travels: the flags only (the old round_trip_* columns keep their defaults)
const SIGNUP_ROW = { business_id: B1, ...computeFeatureFlags({ businessCategory: 'travels' }) };
const asSettings = (row) => ({
  enableDistanceFares: row.enable_distance_fares, roundTripPerDayKm: 250, roundTripDriverDaEnabled: false, roundTripDriverDaAmount: 0
});

test.beforeEach(() => {
  const db = h.reset();
  db.vehicles = [{ ...NEW_VEHICLE }];
  db.travel_quote_settings = []; // a new business has none
  db.businesses = [{ id: B1, require_advance_payment: false, advance_payment_type: null, advance_payment_value: null, payment_qr_url: null }];
  state.business = { id: B1, travelSettings: asSettings(SIGNUP_ROW) };
  state.oneWayKm = 150;
});

test('signup flags for travels / cab: fleet and distance fares on, and no old round_trip_* key is written', () => {
  for (const businessCategory of ['travels', 'cab']) {
    assert.deepEqual(computeFeatureFlags({ businessCategory }), { enable_fleet: true, enable_distance_fares: true });
  }
  assert.deepEqual(computeFeatureFlags({ businessCategory: 'multi_brand', subCategories: ['travels', 'salon'] }), { enable_fleet: true, enable_distance_fares: true });
});

test('no settings row: the quote settings are the defaults (basis day, toll off, no night charge, no minimum)', async () => {
  const { settings } = await travelQuoteService.getSettings(B1);
  assert.deepEqual(settings, { ...DEFAULT_SETTINGS, driverAllowancePerDay: 0 });
  assert.equal(settings.allowanceBasis, 'day');
  assert.equal(settings.tollIncluded, false);
});

test('no settings row: a One Way quote has no extras, no night charge, toll not included', () => {
  const quote = computeQuote({ baseFare: 3004, tripType: 'oneway', pickupMinute: 23 * 60, settings: DEFAULT_SETTINGS });
  assert.equal(quote.total, 3000); // rounded to 10 like every One Way fare
  assert.deepEqual(quote.extras, []);
  assert.equal(quote.tollIncluded, false);
});

test('new vehicle (min km and allowance empty): the quote asks the owner to confirm a Round Trip - it never guesses', () => {
  const priced = priceVehicleTrip({
    tripType: 'round_trip', days: 2, fare: null, oneWayKm: 150,
    vehicle: { perKmRate: 14, minKmPerDay: null, driverAllowancePerDay: null }, allowanceBasis: DEFAULT_SETTINGS.allowanceBasis
  });
  assert.deepEqual(priced, { ok: false, reason: 'missing_min_km' });
});

test('new business estimate: One Way is distance x rate; Round Trip uses 250 km a day, no allowance, basis day', async () => {
  const oneWay = await bookingService.findDistanceBasedVehicleOptions(B1, 'Pune', 'Nashik', 'One Way');
  assert.equal(oneWay[0].fare, 2100); // 150 x 14

  const expected = { 1: 4200, 2: 7000, 3: 10500 }; // 1 day: 2 x 150 = 300 km (> 250); 2 days: 500 km; 3 days: 750 km
  for (const [days, fare] of Object.entries(expected)) {
    const [card] = await bookingService.findDistanceBasedVehicleOptions(B1, 'Pune', 'Nashik', 'Round Trip', days);
    assert.equal(card.fare, fare, `${days} days`);
    assert.equal(card.driverDaIncluded, undefined, 'no allowance when the vehicle has none');
    assert.equal(card.driverDaTotal, undefined);
    // the tap prices the card again to the same amount
    assert.deepEqual(bookingService.repriceEstimateOption(card, 14), { fare, driverDaTotal: 0 });
  }
});

test('new business estimate: the old driver-DA switch is off by default, so a stale amount cannot leak in', async () => {
  state.business.travelSettings = { ...state.business.travelSettings, roundTripDriverDaAmount: 500 }; // amount without the switch
  const [card] = await bookingService.findDistanceBasedVehicleOptions(B1, 'Pune', 'Nashik', 'Round Trip', 2);
  assert.equal(card.driverDaIncluded, undefined);
  assert.equal(card.fare, 7000);
});

test('a vehicle with a per-km rate of 0 or less is never offered at Rs 0 (One Way or Round Trip)', async () => {
  const db = h.reset();
  db.travel_quote_settings = [];
  db.vehicles = [{ ...NEW_VEHICLE, per_km_rate: 0 }, { ...NEW_VEHICLE, id: uuid(2), custom_name: 'Etios', per_km_rate: 16 }];
  assert.deepEqual((await bookingService.findDistanceBasedVehicleOptions(B1, 'Pune', 'Nashik', 'One Way')).map(o => o.name), ['Etios']);
  assert.deepEqual((await bookingService.findDistanceBasedVehicleOptions(B1, 'Pune', 'Nashik', 'Round Trip', 2)).map(o => o.name), ['Etios']);
});

test('the estimate and the quote agree once the owner sets min km and the allowance on the vehicle', async () => {
  const db = h.reset();
  db.travel_quote_settings = [];
  db.vehicles = [{ ...NEW_VEHICLE, min_km_per_day: 300, driver_allowance_per_day: 400 }];
  const [card] = await bookingService.findDistanceBasedVehicleOptions(B1, 'Pune', 'Nashik', 'Round Trip', 2);
  const quote = priceVehicleTrip({
    tripType: 'round_trip', days: 2, fare: null, oneWayKm: 150,
    vehicle: { perKmRate: 14, minKmPerDay: 300, driverAllowancePerDay: 400 }, allowanceBasis: 'day'
  });
  assert.equal(card.fare, quote.total);
  assert.equal(card.fare, 600 * 14 + 800);
});

// ---- night-basis wording --------------------------------------------------------------------------------------

const summary = (collected, lang) => bookingService.buildBookingSummaryBody(collected, [], false, lang);
const night = (units, extra = {}) => ({ vehicleFare: 17850, fareSource: 'distance_estimate', distanceKm: 750, driverDaTotal: units * 300, driverDaDays: units, driverDaPerDay: 300, driverDaBasis: 'night', ...extra });

test('night basis: the Driver DA line says nights, with 1 night / 2 nights (en)', () => {
  assert.match(summary(night(2), 'en'), /Driver DA: \*₹600 \(2 nights × ₹300\)\*/);
  assert.match(summary(night(1), 'en'), /Driver DA: \*₹300 \(1 night × ₹300\)\*/);
  assert.doesNotMatch(summary(night(2), 'en'), /days/);
  assert.match(summary(night(2), null), /\(2 nights × ₹300\)/, 'no language = English');
});

test('night basis: hi and mr use their own night word, with no unfilled placeholder', () => {
  const hi = summary(night(2), 'hi');
  const mr = summary(night(2), 'mr');
  assert.match(hi, /ड्राइवर भत्ता \(DA\): \*₹600 \(2 रात × ₹300\)\*/);
  assert.match(mr, /ड्रायव्हर भत्ता \(DA\): \*₹600 \(2 रात्री × ₹300\)\*/);
  assert.match(summary(night(1), 'mr'), /1 रात्र × ₹300/);
  for (const text of [hi, mr]) assert.doesNotMatch(text, /\{\{|दिन|दिवस/);
});

test('night basis in a machine-translated language: the machine text with its placeholders filled (never "days")', () => {
  for (const lang of ['gu', 'kn', 'ta', 'te', 'ml', 'bn', 'pa', 'or']) {
    const text = summary(night(2), lang);
    assert.doesNotMatch(text, /\{\{/, `${lang}: unfilled placeholder`);
    assert.match(text, /600/, lang);
    assert.match(text, /\(2 /, `${lang}: the count`);
    assert.match(text, /300\)/, `${lang}: the per-night amount`);
    // not the day wording
    assert.notEqual(text, summary({ ...night(2), driverDaBasis: 'day' }, lang), `${lang}: night differs from day`);
  }
});

test('day basis and bookings saved before driverDaBasis existed: the day wording, unchanged', () => {
  const day = { vehicleFare: 9750, fareSource: 'distance_estimate', distanceKm: 750, driverDaTotal: 900, driverDaDays: 3, driverDaPerDay: 300 };
  assert.match(summary(day, 'en'), /Driver DA: \*₹900 \(3 days × ₹300\)\*/);
  assert.match(summary({ ...day, driverDaBasis: 'day' }, 'en'), /\(3 days × ₹300\)/);
});

test('the estimate card carries the basis the allowance was counted in', async () => {
  const db = h.reset();
  db.vehicles = [{ ...NEW_VEHICLE, min_km_per_day: 250, driver_allowance_per_day: 300 }];
  db.travel_quote_settings = [{ business_id: B1, allowance_basis: 'night' }];
  const [card] = await bookingService.findDistanceBasedVehicleOptions(B1, 'Pune', 'Nashik', 'Round Trip', 3);
  assert.deepEqual([card.driverDaBasis, card.driverDaDays, card.driverDaTotal], ['night', 2, 600]);
  db.travel_quote_settings = [];
  const [dayCard] = await bookingService.findDistanceBasedVehicleOptions(B1, 'Pune', 'Nashik', 'Round Trip', 3);
  assert.deepEqual([dayCard.driverDaBasis, dayCard.driverDaDays, dayCard.driverDaTotal], ['day', 3, 900]);
});
