// Run: node --test src/controllers/publicServiceForm.noRoles.test.js
// A form built in the form builder has no `role`s: the travel fields are detected by name / options /
// visibleWhen (resolveTravelFields), and the GET response fills the roles in for the website.
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
  { name: 'trip_type', type: 'radio', label: 'Trip Type', options: ['One way', 'Round trip', 'Local rental'], required: true },
  { name: 'pickup_location', type: 'address_autocomplete', label: 'Pickup', required: true },
  { name: 'drop_location', type: 'address_autocomplete', label: 'Drop', required: true },
  { name: 'rental_package', type: 'dropdown', label: 'Rental Package', options: ['6 HRs / 60 KMs', '8 HRs / 80 KMs'], visibleWhen: { field: 'trip_type', equals: 'Local rental' }, required: true },
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
  bookingService.findDistanceBasedVehicleOptions = async (...args) => {
    distanceCalls.push(args);
    return [{ vehicleId: DZIRE, name: 'Swift Dzire', fare: 480, source: 'distance_estimate', distanceKm: 20.9, perKmRate: 23 }];
  };
  whatsappService.sendTextMessage = async () => ({});
  bookingConsentService.claimAfterBooking = async () => null;
  db.businesses = [{ id: B1, name: 'Jyotirling', business_category: 'travels', flow_fields: [] }];
  db.customers = [{ business_id: B1, whatsapp_number: CUSTOMER, preferred_language: null }];
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

test('GET: roles are filled in on a form that has none, and nothing is saved', async () => {
  const out = await call(controller.getServiceForm, {});
  const roles = Object.fromEntries(out.body.data.flowFields.map(f => [f.name, f.role]));
  assert.equal(roles.trip_type, 'tripType');
  assert.equal(roles.rental_package, 'rentalPackage');
  assert.equal(roles.pickup_location, 'pickup');
  assert.equal(roles.drop_location, 'drop');
  assert.equal(roles.choose_a_vehicle, undefined);
  assert.ok(db.flow_nodes[0].form_fields.every(f => !('role' in f)), 'stored fields untouched');
});

test('GET: an existing role is never overwritten', async () => {
  db.flow_nodes[0].form_fields = FIELDS.map(f => (f.name === 'pickup_location' ? { ...f, role: 'drop' } : f));
  const out = await call(controller.getServiceForm, {});
  assert.equal(out.body.data.flowFields.find(f => f.name === 'pickup_location').role, 'drop');
});

test('submit local rental + vehicle with package → package fare (required drop left empty)', async () => {
  const out = await submit(rentalValues('Swift Dzire'));
  assert.equal(out.status, 200);
  const c = created[2];
  assert.equal(c.vehicleFare, 1500);
  assert.equal(c.fareSource, 'rental_package');
  assert.ok(!('distanceKm' in c));
  assert.equal(distanceCalls.length, 0);
});

test('submit local rental + vehicle without the chosen package (business has packages) → 400', async () => {
  const out = await submit(rentalValues('Toyota Innova Crysta'));
  assert.equal(out.status, 400);
  assert.equal(created, null);
});

test('submit local rental, business with no packages → no fare, no distance', async () => {
  db.rental_packages = [];
  const out = await submit(rentalValues('Toyota Innova Crysta'));
  assert.equal(out.status, 200);
  for (const key of ['vehicleFare', 'fareSource', 'distanceKm']) assert.ok(!(key in created[2]), key);
  assert.equal(distanceCalls.length, 0);
});

test('getVehicleQuote local rental → distanceKm null, distance service untouched', async () => {
  const out = await call(controller.getVehicleQuote, { pickupDescription: 'Pune', tripType: 'Local rental', rentalPackage: '6 HRs / 60 KMs' });
  assert.equal(out.status, 200);
  assert.equal(out.body.data.distanceKm, null);
  assert.equal(distanceCalls.length, 0);
});

test('submit one way on the same form → distance fare unchanged', async () => {
  const out = await submit({ trip_type: 'One way', pickup_location: address('Pune'), drop_location: address('Mumbai'), choose_a_vehicle: 'Swift Dzire' });
  assert.equal(out.status, 200);
  assert.equal(distanceCalls.length, 1);
  assert.equal(created[2].vehicleFare, 480);
  assert.equal(created[2].fareSource, 'distance_estimate');
  assert.equal(created[2].choose_a_vehicle, 'Swift Dzire (₹23/km)');
});
