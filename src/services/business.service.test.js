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

test('"today" is the India-time day, even on a UTC server just after midnight IST', async (t) => {
  const tz = process.env.TZ;
  process.env.TZ = 'UTC'; // Render runs in UTC
  t.after(() => { process.env.TZ = tz; if (tz === undefined) delete process.env.TZ; });
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-04T18:45:00Z') }); // 00:15 IST Oct 5
  const saved = { messages: tables.messages, bookings: tables.bookings };
  t.after(() => Object.assign(tables, saved));
  tables.messages = [
    { business_id: 'b', direction: 'inbound', created_at: '2026-10-04T18:35:00.000Z' }, // 00:05 IST Oct 5 → today
    { business_id: 'b', direction: 'inbound', created_at: '2026-10-04T18:25:00.000Z' }, // 23:55 IST Oct 4 → yesterday
    { business_id: 'b', direction: 'inbound', created_at: '2026-10-04T06:00:00.000Z' }  // Oct 4 IST → yesterday
  ];
  tables.bookings = [
    { business_id: 'b', created_at: '2026-10-04T18:31:00.000Z' }, // 00:01 IST Oct 5
    { business_id: 'b', created_at: '2026-10-04T10:00:00.000Z' }  // Oct 4 IST
  ];
  const stats = await getDashboardStats('b');
  assert.equal(stats.todayMessageCount, 1);
  assert.equal(stats.todayInboundCount, 1);
  assert.equal(stats.todayBookingCount, 1);
});

test('business getters never expose the encrypted 2-step-verification PIN', async () => {
  const { attachTravelSettings } = require('./business.service');
  const out = await attachTravelSettings({ id: 'b', businessCategory: 'general', subCategories: [], whatsappRegisterPin: 'enc(123456)', name: 'Biz' });
  assert.equal(out.whatsappRegisterPin, undefined);
  assert.equal(out.name, 'Biz');
});
