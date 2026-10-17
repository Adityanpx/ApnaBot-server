// Run: node --test src/services/admin.service.stats.test.js
// getPlatformStats: activeSubscriptions counts only 'active' rows; trialSubscriptions counts
// 'trial' rows separately (free trials are not paid subscriptions and are not revenue).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFakeSupabase } = require('../test-support/fakeSupabase');

let fake;
const stubModule = (file, exports) => {
  const p = require.resolve(path.join(__dirname, file));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stubModule('../config/supabase.js', { from: (t) => fake.from(t) });
stubModule('../utils/logger.js', { info: () => {}, warn: () => {}, error: () => {} });

const { getPlatformStats } = require('./admin.service');

test('trialSubscriptions is counted separately and activeSubscriptions is unchanged', async () => {
  fake = createFakeSupabase({});
  fake.db.businesses = [{ id: 'b1', is_active: true }, { id: 'b2', is_active: true }, { id: 'b3', is_active: false }];
  fake.db.users = [{ id: 'u1', role: 'owner' }];
  fake.db.messages = []; fake.db.bookings = [];
  fake.db.subscriptions = [
    { id: 's1', business_id: 'b1', status: 'active' },
    { id: 's2', business_id: 'b2', status: 'trial' },
    { id: 's3', business_id: 'b3', status: 'trial' },
    { id: 's4', business_id: 'b3', status: 'expired' },
    { id: 's5', business_id: 'b1', status: 'cancelled' }
  ];
  const stats = await getPlatformStats();
  assert.equal(stats.activeSubscriptions, 1);
  assert.equal(stats.trialSubscriptions, 2);
  assert.equal(stats.totalBusinesses, 3);
});

test('no trials gives 0, not undefined', async () => {
  fake = createFakeSupabase({});
  fake.db.subscriptions = [{ id: 's1', business_id: 'b1', status: 'active' }];
  const stats = await getPlatformStats();
  assert.equal(stats.trialSubscriptions, 0);
  assert.equal(stats.activeSubscriptions, 1);
});
