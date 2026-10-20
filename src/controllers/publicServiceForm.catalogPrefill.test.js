// Run: node --test src/controllers/publicServiceForm.catalogPrefill.test.js
// A web form opened from a catalogue Order: the token carries prefill [{ key, value }]. GET shows them as
// read-only chips and locks a form field with the same name; the submit enforces the token's values (a tampered
// page cannot change them), saves the chip-only values on the booking and lists them in the confirmation.
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
const PREFILL = [{ key: 'catalogCollection', value: 'Silk Sarees' }, { key: 'catalogDesignNo', value: 'A-102' }, { key: 'catalogPrice', value: '1,499' }];
const FIELDS = [
  { name: 'name', type: 'text', label: 'Your name', required: true },
  { name: 'catalogDesignNo', type: 'text', label: 'Design no', required: true }
];

let db; let created;
const real = { create: bookingService.createBookingAndConfirmation, text: whatsappService.sendTextMessage, claim: bookingConsentService.claimAfterBooking };
test.beforeEach(() => {
  db = h.reset(); created = null;
  bookingService.createBookingAndConfirmation = async (...args) => { created = args; return { text: 'Booked' }; };
  whatsappService.sendTextMessage = async () => ({});
  bookingConsentService.claimAfterBooking = async () => null;
  db.businesses = [{ id: B1, name: 'Shambhu', business_category: 'menswear', flow_fields: [] }];
  db.customers = [{ business_id: B1, whatsapp_number: CUSTOMER, preferred_language: 'hi' }];
  db.business_bot_settings = [];
  db.flow_nodes = [{ id: NODE, business_id: B1, node_type: 'reply', keyword: 'form', reply_kind: 'web_form_trigger', form_fields: FIELDS }];
  db.booking_form_tokens = [{ id: 1, token: TOKEN, business_id: B1, customer_number: CUSTOMER, flow_node_id: NODE, prefill: PREFILL, expires_at: new Date(Date.now() + 60000).toISOString(), used_at: null }];
});
test.afterEach(() => {
  bookingService.createBookingAndConfirmation = real.create;
  whatsappService.sendTextMessage = real.text;
  bookingConsentService.claimAfterBooking = real.claim;
});

const call = async (handler, body) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params: { token: TOKEN }, body, query: {} }, res, (err) => { throw err; });
  return out;
};

test('GET: chips for every entry (labels in the customer language), the matching field prefilled and locked', async () => {
  const { body } = await call(controller.getServiceForm, {});
  assert.deepEqual(body.data.orderChips.map(c => [c.key, c.value]), [['catalogCollection', 'Silk Sarees'], ['catalogDesignNo', 'A-102'], ['catalogPrice', '1,499']]);
  assert.notEqual(body.data.orderChips[0].label, 'Collection', 'Hindi label');
  assert.deepEqual(body.data.prefill, { catalogDesignNo: 'A-102' });
  assert.deepEqual(body.data.lockedFields, ['catalogDesignNo']);
});

test('GET: an ordinary form (no prefill on the token) has none of the new keys', async () => {
  db.booking_form_tokens[0].prefill = null;
  const { body } = await call(controller.getServiceForm, {});
  for (const key of ['orderChips', 'lockedFields', 'prefill']) assert.equal(key in body.data, false, key);
});

test('submit: the locked field is forced to the token value (even if the page sent another or none), chip-only values are saved', async () => {
  const out = await call(controller.submitServiceForm, { values: { name: 'Ravi', catalogDesignNo: 'TAMPERED' } });
  assert.equal(out.status, 200);
  const [, , collected, orderedFields] = created;
  assert.equal(collected.catalogDesignNo, 'A-102');
  assert.equal(collected.catalogCollection, 'Silk Sarees');
  assert.equal(collected.catalogPrice, '1,499');
  assert.equal(collected.name, 'Ravi');
  assert.deepEqual(orderedFields.map(f => f.fieldKey), ['catalogCollection', 'catalogPrice', 'name', 'catalogDesignNo'], 'order lines first, each key once');
  assert.equal(orderedFields[0].label, 'Collection');
  assert.notEqual(orderedFields[0].summaryLabel, 'Collection', 'confirmation in Hindi');
  assert.equal(created[5].fieldLabels.catalogPrice, 'Price');

  created = null;
  db.booking_form_tokens[0].used_at = null;
  const missing = await call(controller.submitServiceForm, { values: { name: 'Ravi' } });
  assert.equal(missing.status, 200, 'a locked REQUIRED field needs no value from the page');
  assert.equal(created[2].catalogDesignNo, 'A-102');
});

test('submit: a token without prefill behaves exactly as before', async () => {
  db.booking_form_tokens[0].prefill = null;
  const out = await call(controller.submitServiceForm, { values: { name: 'Ravi', catalogDesignNo: 'X-1' } });
  assert.equal(out.status, 200);
  assert.deepEqual(Object.keys(created[2]).sort(), ['catalogDesignNo', 'name']);
  assert.deepEqual(created[3].map(f => f.fieldKey), ['name', 'catalogDesignNo']);
});

test('a junk prefill on a token is ignored entry by entry', async () => {
  db.booking_form_tokens[0].prefill = [{ key: 'hack', value: 'x' }, { key: 'catalogPrice', value: '5' }, 'nope'];
  const { body } = await call(controller.getServiceForm, {});
  assert.deepEqual(body.data.orderChips.map(c => c.key), ['catalogPrice']);
  assert.equal('lockedFields' in body.data, false);
});
