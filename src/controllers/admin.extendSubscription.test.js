// Run: node --test src/controllers/admin.extendSubscription.test.js
// Super Admin extend: reviving an expired subscription starts a new message-counter period (current_period_start = now);
// extending one that is still running keeps its period.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
h.cfg.RAZORPAY_KEY_ID = 'rzp_test_x'; h.cfg.RAZORPAY_KEY_SECRET = 's';
require('../test-support/stubRedis');
const admin = require('./admin.controller');

const { B1 } = h;
const NOW = '2026-10-20T10:00:00.000Z';
let db;
test.beforeEach((t) => {
  db = h.reset();
  t.mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
  db.businesses = [{ id: B1, phone_number_id: 'pn', is_active: false }];
});

const extend = async (days) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await admin.extendSubscription({ params: { id: B1 }, body: { days } }, res, (err) => { throw err; });
  return out;
};
const sub = () => db.subscriptions[0];

test('reviving an expired row starts a new counter period now', async () => {
  db.subscriptions = [{ id: 's1', business_id: B1, status: 'expired', created_at: '2026-08-01T00:00:00Z', start_date: '2026-08-01T00:00:00Z', current_period_start: '2026-08-01T00:00:00Z', end_date: '2026-09-01T00:00:00Z' }];
  await extend(30);
  assert.equal(sub().status, 'active');
  assert.equal(sub().current_period_start, NOW);
  assert.equal(sub().end_date, '2026-11-19T10:00:00.000Z');
});

test('an "active" row whose end_date has already passed counts as expired too', async () => {
  db.subscriptions = [{ id: 's1', business_id: B1, status: 'active', created_at: '2026-08-01T00:00:00Z', start_date: '2026-09-01T00:00:00Z', current_period_start: '2026-09-01T00:00:00Z', end_date: '2026-10-01T00:00:00Z' }];
  await extend(30);
  assert.equal(sub().current_period_start, NOW);
});

test('extending a running subscription keeps its counter period', async () => {
  db.subscriptions = [{ id: 's1', business_id: B1, status: 'active', created_at: '2026-10-01T00:00:00Z', start_date: '2026-10-01T00:00:00Z', current_period_start: '2026-10-01T00:00:00Z', end_date: '2026-11-01T00:00:00Z' }];
  await extend(30);
  assert.equal(sub().current_period_start, '2026-10-01T00:00:00Z');
  assert.equal(sub().end_date, '2026-12-01T00:00:00.000Z');
});
