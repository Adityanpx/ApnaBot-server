// Run: node --test src/services/booking.rental.test.js
// normalizeTripType (tolerant trip-type mapping) and findRentalQuotesForForm (rental fares for the
// web form, label matching). In-memory Supabase (storage test harness).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const bookingService = require('./booking.service');

const { B1, B2, uuid } = h;
const INNOVA = uuid(1);
const DZIRE = uuid(2);

test('normalizeTripType: local rental spellings, Hindi/Marathi wording', () => {
  for (const value of ['Local Rental', 'Local rental', ' local  rental ', 'local-rental', 'Local_Rental', 'rental', 'लोकल रेंटल']) {
    assert.equal(bookingService.normalizeTripType(value), 'local', value);
    assert.equal(bookingService.isLocalRentalTrip(value), true, value);
  }
});

test('normalizeTripType: round trip and one way (everything else, incl. empty)', () => {
  assert.equal(bookingService.normalizeTripType('Round Trip'), 'round_trip');
  assert.equal(bookingService.normalizeTripType('round-trip'), 'round_trip');
  assert.equal(bookingService.normalizeTripType('राउंड ट्रिप'), 'round_trip');
  assert.equal(bookingService.normalizeTripType('One Way'), 'oneway');
  assert.equal(bookingService.normalizeTripType(''), 'oneway');
  assert.equal(bookingService.normalizeTripType(undefined), 'oneway');
  assert.equal(bookingService.normalizeTripType(null), 'oneway');
  assert.equal(bookingService.isLocalRentalTrip('One Way'), false);
});

const seed = () => {
  const db = h.reset();
  db.vehicles = [
    { id: INNOVA, business_id: B1, is_active: true, custom_name: 'Toyota Innova Crysta', catalog: { name: 'Innova', photo_url: null, seats: 7 } },
    { id: DZIRE, business_id: B1, is_active: true, custom_name: null, custom_photo_url: 'https://img/dzire.png', catalog: { name: 'Swift Dzire', photo_url: null, seats: 4 } },
    { id: uuid(3), business_id: B1, is_active: false, custom_name: 'Retired', catalog: { name: 'Retired', photo_url: null, seats: 4 } },
    { id: uuid(4), business_id: B2, is_active: true, custom_name: 'Other business', catalog: { name: 'Other', photo_url: null, seats: 4 } }
  ];
  db.rental_packages = [
    { id: 'rp1', business_id: B1, vehicle_id: DZIRE, package_key: '6hr_60km', label: '6 hr/60 km', price: 1500, extra_km_rate: 12, extra_hr_rate: 150, is_active: true },
    { id: 'rp2', business_id: B1, vehicle_id: DZIRE, package_key: '8hr_80km', label: '8 hr/80 km', price: 1800, extra_km_rate: 12, extra_hr_rate: 150, is_active: true },
    { id: 'rp3', business_id: B1, vehicle_id: INNOVA, package_key: '6hr_60km', label: '6 hr/60 km', price: 2500, extra_km_rate: 18, extra_hr_rate: 250, is_active: false }
  ];
  return db;
};

test('findRentalQuotesForForm: matches the package label loosely, per vehicle', async () => {
  seed();
  const quotes = await bookingService.findRentalQuotesForForm(B1, '6 HRs / 60 KMs');
  assert.deepEqual(quotes.map(q => q.name), ['Toyota Innova Crysta', 'Swift Dzire'], 'active vehicles of this business only');
  const dzire = quotes.find(q => q.name === 'Swift Dzire');
  assert.equal(dzire.fare, 1500);
  assert.equal(dzire.source, 'rental_package');
  assert.equal(dzire.rentalPackageId, 'rp1');
  assert.equal(dzire.extraKmRate, 12);
  assert.equal(dzire.extraHrRate, 150);
  assert.equal(dzire.photoUrl, 'https://img/dzire.png');
  assert.equal(dzire.seats, 4);
});

test('findRentalQuotesForForm: a vehicle with no active matching package gets fare null', async () => {
  seed();
  const innova = (await bookingService.findRentalQuotesForForm(B1, '6 HRs / 60 KMs')).find(q => q.vehicleId === INNOVA);
  assert.equal(innova.fare, null);
  assert.equal(innova.source, null);
});

test('findRentalQuotesForForm: no label or an unknown label → every vehicle, fare null', async () => {
  seed();
  for (const label of [undefined, '', '3 HRs / 30 KMs']) {
    const quotes = await bookingService.findRentalQuotesForForm(B1, label);
    assert.equal(quotes.length, 2);
    assert.ok(quotes.every(q => q.fare === null && q.source === null));
  }
});

test('findRentalQuotesForForm: a DB error is logged and returns []', async () => {
  const db = seed();
  db.vehicles = null; // makes the in-memory query throw
  assert.deepEqual(await bookingService.findRentalQuotesForForm(B1, '6 hr/60 km'), []);
});

test('findDistanceBasedVehicleOptions: a local rental is never distance-priced', async () => {
  seed();
  assert.deepEqual(await bookingService.findDistanceBasedVehicleOptions(B1, 'Pune', 'Mumbai', 'Local rental'), []);
});

// ---- label matching fallback (numbers) ----------------------------------------------------------

const priceFor = async (storedLabel, requestedLabel) => {
  const db = h.reset();
  db.vehicles = [{ id: DZIRE, business_id: B1, is_active: true, custom_name: 'Swift Dzire', catalog: { name: 'Dzire', photo_url: null, seats: 4 } }];
  db.rental_packages = [{ id: 'rp1', business_id: B1, vehicle_id: DZIRE, package_key: 'k', label: storedLabel, price: 1500, extra_km_rate: 12, extra_hr_rate: 150, is_active: true }];
  return (await bookingService.findRentalQuotesForForm(B1, requestedLabel))[0].fare;
};

test('package label: hours and km numbers match across wording', async () => {
  assert.equal(await priceFor('6 HRs / 60 KMs', '6 hours 60 km'), 1500);
  assert.equal(await priceFor('6 HRs / 60 KMs', '8hr/80km'), null);
  assert.equal(await priceFor('8 HRs / 80 KMs', '8hr/80km'), 1500);
  assert.equal(await priceFor('8hr/80km', '8 HRs / 80 KMs'), 1500);
});

test('package label: different numbers never match', async () => {
  assert.equal(await priceFor('8 HRs / 80 KMs', '6 HRs / 60 KMs'), null);
  assert.equal(await priceFor('6 HRs / 80 KMs', '6 HRs / 60 KMs'), null);
});

test('package label: labels without numbers match by text only', async () => {
  assert.equal(await priceFor('Full Day', 'full day'), 1500);
  assert.equal(await priceFor('Full Day', 'Half Day'), null);
});
