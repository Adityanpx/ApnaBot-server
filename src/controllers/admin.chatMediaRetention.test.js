// Run: node --test src/controllers/admin.chatMediaRetention.test.js
// The Super Admin business list and detail carry each business's chat media retention override
// (businesses.chat_media_retention) as chatMediaRetention: null = follow the platform, 'never', or
// days as text. Comes from select('*') + toCamelCase; this locks it so a column whitelist can't drop it.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
// The controllers pull in crypto.js, which needs a 32-char key at load time.
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const admin = require('./admin.controller');

const { B1, B2 } = h;

let db;
test.beforeEach(() => {
  db = h.reset();
  const base = { payment_qr_url: null, profile_image: null, owner_user_id: null, business_category: 'coaching', sub_categories: [], is_active: true, created_at: '2026-10-01T00:00:00Z' };
  db.businesses = [
    { id: B1, name: 'SG Travels', ...base, chat_media_retention: '30' },
    { id: B2, name: 'Averix', ...base, chat_media_retention: null }
  ];
  db.users = []; db.subscriptions = []; db.customers = []; db.bookings = [];
});

const call = async (handler, { params = {}, query = {} } = {}) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params, query, body: {}, user: { userId: 'admin-1' } }, res, (err) => { throw err; });
  return out;
};

test('GET /businesses: every business includes chatMediaRetention (null when it follows the platform)', async () => {
  const { status, body } = await call(admin.getBusinesses);
  assert.equal(status, 200);
  const by = Object.fromEntries(body.data.businesses.map(b => [b.name, b.chatMediaRetention]));
  assert.deepEqual(by, { 'SG Travels': '30', Averix: null });
});

test('GET /businesses/:id: the business includes chatMediaRetention, including "never"', async () => {
  db.businesses[1].chat_media_retention = 'never';
  const one = await call(admin.getBusinessById, { params: { id: B1 } });
  assert.equal(one.status, 200);
  assert.equal(one.body.data.business.chatMediaRetention, '30');
  const two = await call(admin.getBusinessById, { params: { id: B2 } });
  assert.equal(two.body.data.business.chatMediaRetention, 'never');
});
