// Run: node --test src/controllers/publicServiceForm.formTitle.test.js
// A web form's own name (flow_nodes.form_title): the public page's title, in the customer's
// language, below a published Bot Builder form's title; and the English snapshot saved on the
// booking at submit (form_key stays null). In-memory Supabase (storage test harness).
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
const FIELDS = [{ name: 'note', label: 'Your enquiry', type: 'text', required: true }];

let db;
let created;
const realCreate = bookingService.createBookingAndConfirmation;
const realText = whatsappService.sendTextMessage;
const realClaim = bookingConsentService.claimAfterBooking;
test.beforeEach(() => {
  db = h.reset();
  created = null;
  bookingService.createBookingAndConfirmation = async (...args) => { created = args; return { text: 'Booked' }; };
  whatsappService.sendTextMessage = async () => ({});
  bookingConsentService.claimAfterBooking = async () => null;
  db.businesses = [{ id: B1, name: 'Acme', business_category: 'software_it', flow_fields: [] }];
  db.customers = [{ business_id: B1, whatsapp_number: CUSTOMER, preferred_language: null }];
  db.business_bot_settings = [];
  db.flow_nodes = [{ id: NODE, business_id: B1, node_type: 'reply', keyword: 'enquiry', reply_kind: 'web_form_trigger', form_fields: FIELDS, form_title: 'Enquiry form', form_title_translations: { hi: 'पूछताछ फ़ॉर्म' } }];
  db.booking_form_tokens = [{ id: 1, token: TOKEN, business_id: B1, customer_number: CUSTOMER, flow_node_id: NODE, expires_at: new Date(Date.now() + 60000).toISOString(), used_at: null }];
});
test.afterEach(() => {
  bookingService.createBookingAndConfirmation = realCreate;
  whatsappService.sendTextMessage = realText;
  bookingConsentService.claimAfterBooking = realClaim;
});

const call = async (handler, { body = {} } = {}) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params: { token: TOKEN }, body, query: {} }, res, (err) => { throw err; });
  return out;
};
const getForm = async () => (await call(controller.getServiceForm)).body.data;
const setLanguage = (code) => { db.customers[0].preferred_language = code; };
const publishBotBuilder = () => { db.business_bot_settings = [{ business_id: B1, published_at: '2026-10-01T00:00:00Z', published_settings: { settings: {} } }]; };

// ---- GET: title precedence ----------------------------------------------------------------

test('GET: the node\'s form name is the page title, with no subtitle', async () => {
  const data = await getForm();
  assert.equal(data.formTitle, 'Enquiry form');
  assert.ok(!('formSubtitle' in data));
});

test('GET: the customer\'s language picks the translation, falling back to the English name', async () => {
  setLanguage('hi');
  assert.equal((await getForm()).formTitle, 'पूछताछ फ़ॉर्म');
  setLanguage('mr'); // no Marathi version
  assert.equal((await getForm()).formTitle, 'Enquiry form');
  setLanguage('en');
  assert.equal((await getForm()).formTitle, 'Enquiry form');
});

test('GET: a translation alone is enough for a customer in that language, and the English page has no title', async () => {
  db.flow_nodes[0].form_title = null;
  assert.ok(!('formTitle' in (await getForm())));
  setLanguage('hi');
  assert.equal((await getForm()).formTitle, 'पूछताछ फ़ॉर्म');
});

test('GET: no form name keeps today\'s response (no title keys)', async () => {
  db.flow_nodes[0].form_title = null;
  db.flow_nodes[0].form_title_translations = null;
  const data = await getForm();
  assert.ok(!('formTitle' in data) && !('formSubtitle' in data));
  assert.deepEqual(data.flowFields.map(f => f.name), ['note']);
});

test('GET: a published Bot Builder form keeps its own title and subtitle over the node\'s form name', async () => {
  db.flow_nodes[0].keyword = 'demo';
  publishBotBuilder();
  const data = await getForm();
  assert.equal(data.formTitle, 'Book a free demo class');
  assert.equal(data.formSubtitle, 'Takes about a minute.');
});

test('GET: a Bot Builder keyword without published settings falls through to the node\'s form name', async () => {
  db.flow_nodes[0].keyword = 'demo';
  const data = await getForm();
  assert.equal(data.formTitle, 'Enquiry form');
  assert.ok(!('formSubtitle' in data));
});

// ---- POST submit: snapshot on the booking --------------------------------------------------

const submit = () => call(controller.submitServiceForm, { body: { values: { note: 'Call me' } } });
const metaOf = () => created[5];

test('submit: the node\'s English form name is saved on the booking, form_key stays null', async () => {
  const out = await submit();
  assert.equal(out.status, 200);
  assert.equal(metaOf().formTitle, 'Enquiry form');
  assert.equal(metaOf().formKey, null);
  assert.deepEqual(metaOf().fieldLabels, { note: 'Your enquiry' });
  assert.ok(!('advance' in metaOf()), 'non-Bot-Builder forms keep the business-wide advance setting');
});

test('submit: the snapshot is the English title even when the customer saw a translation', async () => {
  setLanguage('hi');
  await submit();
  assert.equal(metaOf().formTitle, 'Enquiry form');
});

test('submit: no form name saves null as before', async () => {
  db.flow_nodes[0].form_title = null;
  await submit();
  assert.equal(metaOf().formTitle, null);
});

test('submit: a published Bot Builder form keeps its own key and title', async () => {
  db.flow_nodes[0].keyword = 'demo';
  publishBotBuilder();
  await submit();
  assert.equal(metaOf().formKey, 'demo');
  assert.notEqual(metaOf().formTitle, 'Enquiry form');
  assert.equal(typeof metaOf().formTitle, 'string');
});
