// Run: node --test src/services/business.service.test.js
// getDashboardStats' "new customers today": an imported contact's
// first_seen_at is the import time, so only customers who have messaged
// (total_messages > 0) count. In-memory Supabase; usage / crypto stubbed
// (no Redis connection).
const test = require('node:test');
const assert = require('node:assert/strict');

const today = new Date();
today.setHours(9, 0, 0, 0);
const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

const tables = {
  customers: [
    { business_id: 'b', first_seen_at: today.toISOString(), total_messages: 1 },     // messaged in today
    { business_id: 'b', first_seen_at: today.toISOString(), total_messages: 0 },     // imported today
    { business_id: 'b', first_seen_at: today.toISOString(), total_messages: 0 },     // imported today
    { business_id: 'b', first_seen_at: yesterday.toISOString(), total_messages: 5 }, // yesterday
    { business_id: 'other', first_seen_at: today.toISOString(), total_messages: 2 }
  ],
  messages: [],
  bookings: []
};

const from = (table) => {
  const filters = [];
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    gt: (c, v) => { filters.push(r => r[c] > v); return q; },
    gte: (c, v) => { filters.push(r => r[c] >= v); return q; },
    then: (resolve) => resolve({ count: tables[table].filter(r => filters.every(f => f(r))).length, error: null })
  };
  return q;
};

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/supabase', { from });
stub('../utils/crypto', { generateWebhookToken: () => 'x', encrypt: (t) => t });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('./usage.service', { getUsageForBusiness: async () => null });
const { getDashboardStats } = require('./business.service');

test('new customers today: only customers who have messaged, not today\'s imports', async () => {
  const stats = await getDashboardStats('b');
  assert.equal(stats.newCustomersToday, 1);
  assert.equal(stats.totalCustomers, 4); // the total still includes imported contacts
});
