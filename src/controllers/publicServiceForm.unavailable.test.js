// Run: node --test src/controllers/publicServiceForm.unavailable.test.js
// The 410 (expired / used) response carries what the web "link not available" screen needs: language,
// businessName, businessPhone (digits only), formTitle. A lookup failure still answers 410 with
// just { language }. In-memory Supabase (storage test harness).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const businessService = require('../services/business.service');
const controller = require('./publicServiceForm.controller');

const { B1, uuid } = h;
const TOKEN = '11111111-2222-4333-8444-555555555555';
const NODE = uuid(600);
const CUSTOMER = '919800000001';

let db;
const realGetBusinessById = businessService.getBusinessById;
test.beforeEach(() => {
  db = h.reset();
  db.businesses = [{ id: B1, name: 'Acme', display_name: 'Acme Travels', whatsapp_number: '+91 92841 28827', business_category: 'software_it', flow_fields: [] }];
  db.customers = [{ business_id: B1, whatsapp_number: CUSTOMER, preferred_language: 'hi' }];
  db.business_bot_settings = [];
  db.flow_nodes = [{ id: NODE, business_id: B1, node_type: 'reply', keyword: 'enquiry', reply_kind: 'web_form_trigger', form_fields: [], form_title: 'Enquiry form', form_title_translations: { hi: 'पूछताछ फ़ॉर्म' } }];
  db.booking_form_tokens = [{ id: 1, token: TOKEN, business_id: B1, customer_number: CUSTOMER, flow_node_id: NODE, expires_at: new Date(Date.now() - 60000).toISOString(), used_at: null }];
});
test.afterEach(() => { businessService.getBusinessById = realGetBusinessById; });

const getForm = async () => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await controller.getServiceForm({ params: { token: TOKEN }, body: {}, query: {} }, res, (err) => { throw err; });
  return out;
};

test('expired token: 410 with language, businessName, businessPhone (digits) and the translated formTitle', async () => {
  const out = await getForm();
  assert.equal(out.status, 410);
  assert.deepEqual(out.body.errors, { language: 'hi', businessName: 'Acme Travels', businessPhone: '919284128827', formTitle: 'पूछताछ फ़ॉर्म' });
});

test('used token: same fields', async () => {
  db.booking_form_tokens[0].expires_at = new Date(Date.now() + 60000).toISOString();
  db.booking_form_tokens[0].used_at = new Date().toISOString();
  const out = await getForm();
  assert.equal(out.status, 410);
  assert.deepEqual(out.body.errors, { language: 'hi', businessName: 'Acme Travels', businessPhone: '919284128827', formTitle: 'पूछताछ फ़ॉर्म' });
});

test('businessName falls back to name when there is no display name', async () => {
  db.businesses[0].display_name = null;
  assert.equal((await getForm()).body.errors.businessName, 'Acme');
});

test('business lookup failure: still 410, with just { language }', async () => {
  businessService.getBusinessById = async () => { throw new Error('db down'); };
  const out = await getForm();
  assert.equal(out.status, 410);
  assert.deepEqual(out.body.errors, { language: 'hi' });
});

test('unknown token stays 404', async () => {
  db.booking_form_tokens = [];
  assert.equal((await getForm()).status, 404);
});
