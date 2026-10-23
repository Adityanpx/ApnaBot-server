// Run: node --test src/controllers/publicServiceForm.idempotency.test.js
// The public web-form submit: an optional Idempotency-Key header makes a repeat request return the original
// success without creating a second booking; a failed attempt frees the key; and the form-definition response
// tells the website each name / date / checkIn / checkOut / dob field's role (same detection as answerValidation.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');

// A working in-memory Redis for the idempotency keys (stubRedis installed an inert one).
const store = new Map();
const fakeRedis = {
  set: async (key, value, ...args) => {
    if (args.includes('NX') && store.has(key)) return null;
    store.set(key, value);
    return 'OK';
  },
  get: async (key) => store.get(key) ?? null,
  del: async (key) => { store.delete(key); }
};
require.cache[require.resolve('../config/redis')].exports = fakeRedis;

const bookingService = require('../services/booking.service');
const whatsappService = require('../services/whatsapp.service');
const bookingConsentService = require('../services/bookingConsent.service');
const controller = require('./publicServiceForm.controller');

const { B1, uuid } = h;
const TOKEN = '11111111-2222-4333-8444-555555555555';
const NODE = uuid(600);
const CUSTOMER = '919800000001';
const KEY = 'form-1700000000-abcdef';

const FIELDS = [
  { name: 'customerName', type: 'text', label: 'Full name', required: true },
  { name: 'shopName', type: 'text', label: 'Shop name' },
  { name: 'travelDate', type: 'date', label: 'Travel date' },
  { name: 'checkIn', type: 'date', label: 'Check in' },
  { name: 'checkOut', type: 'date', label: 'Check out' },
  { name: 'dob', type: 'date', label: 'Date of birth' },
  { name: 'notes', type: 'textarea', label: 'Notes' }
];

let db; let created;
const real = { create: bookingService.createBookingAndConfirmation, text: whatsappService.sendTextMessage, claim: bookingConsentService.claimAfterBooking };
test.beforeEach(() => {
  db = h.reset(); store.clear(); created = [];
  bookingService.createBookingAndConfirmation = async (...args) => { created.push(args); return { text: 'Booked', bookingId: `bk-${created.length}` }; };
  whatsappService.sendTextMessage = async () => ({});
  bookingConsentService.claimAfterBooking = async () => null;
  db.businesses = [{ id: B1, name: 'Hotel', business_category: 'hotel', flow_fields: [] }];
  db.customers = [{ business_id: B1, whatsapp_number: CUSTOMER, preferred_language: null }];
  db.business_bot_settings = [];
  db.flow_nodes = [{ id: NODE, business_id: B1, node_type: 'reply', keyword: 'book', reply_kind: 'web_form_trigger', form_fields: FIELDS }];
  db.booking_form_tokens = [{ id: 1, token: TOKEN, business_id: B1, customer_number: CUSTOMER, flow_node_id: NODE, expires_at: new Date(Date.now() + 60000).toISOString(), used_at: null }];
});
test.afterEach(() => {
  bookingService.createBookingAndConfirmation = real.create;
  whatsappService.sendTextMessage = real.text;
  bookingConsentService.claimAfterBooking = real.claim;
});

const call = async (handler, { body, key } = {}) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  const headers = key ? { 'idempotency-key': key } : {};
  await handler({ params: { token: TOKEN }, body, query: {}, headers, get: (name) => headers[name.toLowerCase()] }, res, (err) => { throw err; });
  return out;
};
const submit = (values, key) => call(controller.submitServiceForm, { body: { values }, key });

test('a repeat with the same Idempotency-Key returns the original success and creates no second booking', async () => {
  const first = await submit({ customerName: 'Ravi Kumar' }, KEY);
  assert.equal(first.status, 200);
  assert.equal(created.length, 1);
  assert.equal(db.booking_form_tokens[0].used_at !== null, true, 'the token is used now - a plain repeat would be a 410');

  const second = await submit({ customerName: 'Ravi Kumar' }, KEY);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(created.length, 1, 'no new booking');
  assert.equal(store.get(`formsubmit:${TOKEN}:${KEY}`), 'bk-1', 'key -> booking id');
});

test('a different key is a different submission', async () => {
  await submit({ customerName: 'Ravi Kumar' }, KEY);
  db.booking_form_tokens[0].used_at = null;
  await submit({ customerName: 'Ravi Kumar' }, 'another-key-12345');
  assert.equal(created.length, 2);
});

test('without the header nothing changes: a second submit after the token is used is still the 410', async () => {
  assert.equal((await submit({ customerName: 'Ravi Kumar' })).status, 200);
  assert.equal((await submit({ customerName: 'Ravi Kumar' })).status, 410);
  assert.equal(created.length, 1);
});

test('a failed attempt (422) frees the key, so the corrected form can be submitted with the same one', async () => {
  const bad = await submit({ customerName: '1234' }, KEY);
  assert.equal(bad.status, 422);
  assert.equal(created.length, 0);
  assert.equal(store.has(`formsubmit:${TOKEN}:${KEY}`), false);
  const good = await submit({ customerName: 'Ravi Kumar' }, KEY);
  assert.equal(good.status, 200);
  assert.equal(created.length, 1);
});

test('a malformed Idempotency-Key is a 400', async () => {
  const out = await submit({ customerName: 'Ravi Kumar' }, 'short');
  assert.equal(out.status, 400);
  assert.equal(created.length, 0);
});

test('a Redis failure fails open: the submit goes through unprotected', async () => {
  const saved = { set: fakeRedis.set, get: fakeRedis.get };
  fakeRedis.set = async () => { throw new Error('redis down'); };
  fakeRedis.get = async () => { throw new Error('redis down'); };
  try {
    assert.equal((await submit({ customerName: 'Ravi Kumar' }, KEY)).status, 200);
    assert.equal(created.length, 1);
  } finally { Object.assign(fakeRedis, saved); }
});

test('GET: name / date / checkIn / checkOut / dob roles come from answerValidation detection; other fields get none', async () => {
  const out = await call(controller.getServiceForm, {});
  const roles = Object.fromEntries(out.body.data.flowFields.map(f => [f.name, f.role]));
  assert.deepEqual(roles, {
    customerName: 'name',
    shopName: undefined, // a thing's name, not a person's
    travelDate: 'date', checkIn: 'checkIn', checkOut: 'checkOut', dob: 'dob', notes: undefined
  });
  assert.ok(db.flow_nodes[0].form_fields.every(f => !('role' in f)), 'stored fields untouched');
});

test('GET: an existing stored role is kept', async () => {
  db.flow_nodes[0].form_fields = [{ name: 'guestName', type: 'text', label: 'Guest', role: 'custom' }];
  const out = await call(controller.getServiceForm, {});
  assert.equal(out.body.data.flowFields[0].role, 'custom');
});
