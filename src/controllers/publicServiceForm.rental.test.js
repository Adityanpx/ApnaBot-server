// Run: node --test src/controllers/publicServiceForm.rental.test.js
// Web-form submit / vehicle-quote for a Local rental: priced from rental_packages, never by distance.
// In-memory Supabase (storage test harness); booking creation and WhatsApp sends are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const bookingService = require('../services/booking.service');
const whatsappService = require('../services/whatsapp.service');
const bookingConsentService = require('../services/bookingConsent.service');
const controller = require('./publicServiceForm.controller');

const { B1, uuid } = h;
const TOKEN = '11111111-2222-4333-8444-555555555555';
const NODE = uuid(600);
const CUSTOMER = '919800000001';
const INNOVA = uuid(1);
const DZIRE = uuid(2);
const address = (text) => JSON.stringify({ description: text, lat: 1, lng: 2 });

const FIELDS = [
  { name: 'trip_type', type: 'radio', label: 'Trip Type', options: ['One Way', 'Round Trip', 'Local rental'], role: 'tripType', required: true },
  { name: 'pickup_location', type: 'address_autocomplete', label: 'Pickup Location', role: 'pickup', required: true },
  { name: 'drop_location', type: 'address_autocomplete', label: 'Drop Location', role: 'drop', required: false },
  { name: 'rental_package', type: 'dropdown', label: 'Rental Package', options: ['6 HRs / 60 KMs', '8 HRs / 80 KMs'], role: 'rentalPackage', visibleWhen: { field: 'trip_type', equals: 'Local rental' }, required: true },
  { name: 'choose_a_vehicle', type: 'icon_select', label: 'Choose a Vehicle', source: 'vehicle_catalog', required: true }
];

let db;
let created;
let distanceCalls;
const real = {
  create: bookingService.createBookingAndConfirmation,
  distance: bookingService.findDistanceBasedVehicleOptions,
  text: whatsappService.sendTextMessage,
  claim: bookingConsentService.claimAfterBooking
};
test.beforeEach(() => {
  db = h.reset();
  created = null;
  distanceCalls = [];
  bookingService.createBookingAndConfirmation = async (...args) => { created = args; return { text: 'Booked' }; };
  // The real function returns [] for a local rental before touching Google; this stand-in records calls
  // and prices a one-way trip, so a local rental reaching it would show up in distanceCalls.
  bookingService.findDistanceBasedVehicleOptions = async (...args) => {
    distanceCalls.push(args);
    return [{ vehicleId: DZIRE, name: 'Swift Dzire', fare: 480, source: 'distance_estimate', distanceKm: 20.9, perKmRate: 23 }];
  };
  whatsappService.sendTextMessage = async () => ({});
  bookingConsentService.claimAfterBooking = async () => null;
  db.businesses = [{ id: B1, name: 'Acme Travels', business_category: 'travels', flow_fields: [] }];
  db.customers = [{ business_id: B1, whatsapp_number: CUSTOMER, preferred_language: 'mr' }];
  db.business_bot_settings = [];
  db.flow_nodes = [{ id: NODE, business_id: B1, node_type: 'reply', keyword: 'book', reply_kind: 'web_form_trigger', form_fields: FIELDS }];
  db.booking_form_tokens = [{ id: 1, token: TOKEN, business_id: B1, customer_number: CUSTOMER, flow_node_id: NODE, expires_at: new Date(Date.now() + 60000).toISOString(), used_at: null }];
  db.vehicles = [
    { id: INNOVA, business_id: B1, is_active: true, custom_name: 'Toyota Innova Crysta', catalog: { name: 'Innova', photo_url: null, seats: 7 } },
    { id: DZIRE, business_id: B1, is_active: true, custom_name: 'Swift Dzire', catalog: { name: 'Dzire', photo_url: null, seats: 4 } }
  ];
  db.rental_packages = [
    { id: 'rp1', business_id: B1, vehicle_id: DZIRE, package_key: '6hr_60km', label: '6 hr/60 km', price: 1500, extra_km_rate: 12, extra_hr_rate: 150, is_active: true }
  ];
});
test.afterEach(() => {
  bookingService.createBookingAndConfirmation = real.create;
  bookingService.findDistanceBasedVehicleOptions = real.distance;
  whatsappService.sendTextMessage = real.text;
  bookingConsentService.claimAfterBooking = real.claim;
});

const call = async (handler, body) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params: { token: TOKEN }, body, query: {} }, res, (err) => { throw err; });
  return out;
};
const submit = (values) => call(controller.submitServiceForm, { values });
const rentalValues = (vehicle) => ({
  trip_type: 'Local rental', pickup_location: address('Pune Station'), rental_package: '6 HRs / 60 KMs', choose_a_vehicle: vehicle
});
const collectedOf = () => created[2];
const summaryOf = () => bookingService.buildBookingSummaryBody(created[2], created[3], false, 'mr');

test('submit local rental, vehicle with a package: rental fare, extra rates, no distance', async () => {
  const out = await submit(rentalValues('Swift Dzire'));
  assert.equal(out.status, 200);
  const c = collectedOf();
  assert.equal(c.vehicleFare, 1500);
  assert.equal(c.fareSource, 'rental_package');
  assert.equal(c.rentalPackageId, 'rp1');
  assert.equal(c.extraKmRate, 12);
  assert.equal(c.extraHrRate, 150);
  assert.ok(!('distanceKm' in c));
  assert.equal(c.choose_a_vehicle, 'Swift Dzire', 'plain name, no (₹x/km)');
  assert.equal(distanceCalls.length, 0);
  const text = summaryOf();
  assert.match(text, /भाडे: \*₹1500\*/);
  assert.match(text, /अतिरिक्त किमी ₹12\/किमी/);
  assert.doesNotMatch(text, /अंतर:/);
});

test('submit local rental, vehicle without a package: no fare, no distance, no fare/toll lines', async () => {
  const out = await submit(rentalValues('Toyota Innova Crysta'));
  assert.equal(out.status, 200);
  const c = collectedOf();
  for (const key of ['vehicleFare', 'fareSource', 'distanceKm', 'driverDaTotal']) assert.ok(!(key in c), key);
  assert.equal(c.choose_a_vehicle, 'Toyota Innova Crysta');
  assert.equal(distanceCalls.length, 0);
  const text = summaryOf();
  assert.match(text, /Toyota Innova Crysta/);
  assert.doesNotMatch(text, /Fare|भाडे|अंतर|टोल|Toll/);
});

test('submit local rental: an unknown vehicle is still rejected', async () => {
  const out = await submit(rentalValues('Not A Vehicle'));
  assert.equal(out.status, 400);
  assert.equal(created, null);
});

test('submit one way: unchanged distance behaviour', async () => {
  const out = await submit({
    trip_type: 'One Way', pickup_location: address('Pune'), drop_location: address('Mumbai'), choose_a_vehicle: 'Swift Dzire'
  });
  assert.equal(out.status, 200);
  assert.equal(distanceCalls.length, 1);
  const c = collectedOf();
  assert.equal(c.vehicleFare, 480);
  assert.equal(c.fareSource, 'distance_estimate');
  assert.equal(c.distanceKm, 20.9);
  assert.equal(c.choose_a_vehicle, 'Swift Dzire (₹23/km)');
});

test('vehicle-quote local rental with no drop: 200, distanceKm null, distance service not called', async () => {
  const out = await call(controller.getVehicleQuote, { pickupDescription: 'Pune Station', tripType: 'Local rental', rentalPackage: '6 HRs / 60 KMs' });
  assert.equal(out.status, 200);
  assert.equal(out.body.data.distanceKm, null);
  assert.equal(distanceCalls.length, 0);
  const byName = Object.fromEntries(out.body.data.vehicleQuotes.map(q => [q.name, q]));
  assert.equal(byName['Swift Dzire'].estimatedFare, 1500);
  assert.equal(byName['Swift Dzire'].perKmRate, null);
  assert.equal(byName['Toyota Innova Crysta'].estimatedFare, null);
});

test('vehicle-quote one way without a drop is still a 400', async () => {
  const out = await call(controller.getVehicleQuote, { pickupDescription: 'Pune', tripType: 'One Way' });
  assert.equal(out.status, 400);
});

test('submit local rental: a required drop field left empty does not block the booking', async () => {
  db.flow_nodes[0].form_fields = FIELDS.map(f => (f.role === 'drop' ? { ...f, required: true } : f));
  const out = await submit(rentalValues('Swift Dzire'));
  assert.equal(out.status, 200);
  assert.ok(created, 'booking was created');
});

test('submit one way: a required drop field left empty is still a 400', async () => {
  db.flow_nodes[0].form_fields = FIELDS.map(f => (f.role === 'drop' ? { ...f, required: true } : f));
  const out = await submit({ trip_type: 'One Way', pickup_location: address('Pune'), choose_a_vehicle: 'Swift Dzire' });
  assert.equal(out.status, 400);
  assert.match(out.body.message, /Drop Location/);
  assert.equal(created, null);
});
