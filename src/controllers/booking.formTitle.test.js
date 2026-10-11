// Run: node --test src/controllers/booking.formTitle.test.js
// Bookings list: ?formTitle= exact-match filter, formTitle in each row, and GET /bookings/form-titles
// (the distinct web-form names for the filter dropdown). In-memory Supabase (storage test harness).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const { createFakeSupabase } = require('../test-support/fakeSupabase');
const controller = require('./booking.controller');

const { B1, B2 } = h;

let db;
test.beforeEach(() => {
  h.reset();
  // distinct_booking_form_titles (migration 20261017120000) modelled in memory.
  h.state.fake = createFakeSupabase({
    rpc: {
      distinct_booking_form_titles: ({ p_business_id }, data) => [...new Set((data.bookings || [])
        .filter(b => b.business_id === p_business_id && b.form_title != null).map(b => b.form_title))].sort()
    }
  });
  db = h.state.fake.db;
  db.bookings = [
    { id: 'b1', business_id: B1, form_key: null, form_title: 'Site visit', created_at: '2026-10-03T00:00:00Z' },
    { id: 'b2', business_id: B1, form_key: null, form_title: 'Callback', created_at: '2026-10-02T00:00:00Z' },
    { id: 'b3', business_id: B1, form_key: 'demo', form_title: 'Free demo', created_at: '2026-10-01T00:00:00Z' },
    { id: 'b4', business_id: B1, form_key: null, form_title: null, created_at: '2026-09-30T00:00:00Z' },
    { id: 'b5', business_id: B1, form_key: null, form_title: 'Site visit', created_at: '2026-09-29T00:00:00Z' },
    { id: 'b6', business_id: B2, form_key: null, form_title: 'Other business form', created_at: '2026-10-03T00:00:00Z' }
  ];
});

const call = async (handler, { query = {} } = {}) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params: {}, body: {}, query, user: { businessId: B1, userId: 'u1' } }, res, (err) => { throw err; });
  return out;
};
const ids = (out) => out.body.data.bookings.map(b => b.id);

test('list: no formTitle returns every booking of the business, each with formTitle', async () => {
  const out = await call(controller.getBookings);
  assert.deepEqual(ids(out), ['b1', 'b2', 'b3', 'b4', 'b5']);
  assert.equal(out.body.data.bookings[0].formTitle, 'Site visit');
  assert.equal(out.body.data.bookings[3].formTitle, null);
});

test('list: ?formTitle= is an exact match', async () => {
  assert.deepEqual(ids(await call(controller.getBookings, { query: { formTitle: 'Site visit' } })), ['b1', 'b5']);
  assert.deepEqual(ids(await call(controller.getBookings, { query: { formTitle: 'Callback' } })), ['b2']);
  assert.deepEqual(ids(await call(controller.getBookings, { query: { formTitle: 'Site' } })), [], 'no partial match');
  assert.deepEqual(ids(await call(controller.getBookings, { query: { formTitle: 'site visit' } })), [], 'case-sensitive');
});

test('list: ?formTitle= never reaches another business\'s bookings', async () => {
  assert.deepEqual(ids(await call(controller.getBookings, { query: { formTitle: 'Other business form' } })), []);
});

test('list: an empty formTitle is ignored, and combines with the Bot Builder ?form= filter', async () => {
  assert.equal(ids(await call(controller.getBookings, { query: { formTitle: '  ' } })).length, 5);
  assert.deepEqual(ids(await call(controller.getBookings, { query: { formTitle: 'Free demo', form: 'demo' } })), ['b3']);
  assert.deepEqual(ids(await call(controller.getBookings, { query: { formTitle: 'Site visit', form: 'demo' } })), []);
});

test('form-titles: the distinct, sorted names on this business\'s bookings, nulls left out', async () => {
  const out = await call(controller.getFormTitles);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.data, { formTitles: ['Callback', 'Free demo', 'Site visit'] });
});

test('form-titles: empty when the business has none', async () => {
  db.bookings = db.bookings.filter(b => b.business_id === B2);
  const out = await call(controller.getFormTitles);
  assert.deepEqual(out.body.data, { formTitles: [] });
});
