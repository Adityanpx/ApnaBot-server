// Run: node --test src/seeds/planSeed.test.js
// The seed is first-run defaults only: it creates missing plans and never overwrites an existing one
// (plans are managed from Super Admin).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('../test-support/fakeSupabase');

let fake;
const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/supabase', { from: (t) => fake.from(t) });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
const seedPlans = require('./planSeed');

test('fresh database: creates basic, pro, business with derived duration_options', async () => {
  fake = createFakeSupabase();
  await seedPlans();
  assert.deepEqual(fake.db.plans.map(p => p.name), ['basic', 'pro', 'business']);
  const basic = fake.db.plans[0];
  assert.deepEqual(basic.duration_options.map(t => t.price), [199, 537, 955, 1672]);
});

test('existing plan is left exactly as Super Admin edited it; missing ones are still created', async () => {
  fake = createFakeSupabase();
  fake.db.plans = [{ id: 'p1', name: 'basic', display_name: 'Starter', price: 249, is_active: false, msg_limit: 7 }];
  await seedPlans();
  assert.deepEqual(fake.db.plans[0], { id: 'p1', name: 'basic', display_name: 'Starter', price: 249, is_active: false, msg_limit: 7 });
  assert.deepEqual(fake.db.plans.map(p => p.name), ['basic', 'pro', 'business']);
});
