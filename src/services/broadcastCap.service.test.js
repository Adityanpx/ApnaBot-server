// Run: node --test src/services/broadcastCap.service.test.js
// Effective broadcast cap = min(plan broadcast_recipient_limit, MAX_BROADCAST_RECIPIENTS); -1 and
// "no active subscription" both mean the env cap alone; the refusal is 403 PLAN_BROADCAST_LIMIT only
// when the plan sets the cap.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/env', { MAX_BROADCAST_RECIPIENTS: 2000 });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
let subResult;
const lookups = [];
stub('./currentSubscription.service', { getCurrentSubscriptionRow: async (id, opts) => { lookups.push([id, opts]); return subResult; } });
const { capFromPlan, getBroadcastCap, overCapRefusal, planLimitMessage } = require('./broadcastCap.service');

const plan = (limit, display_name = 'Basic') => ({ display_name, broadcast_recipient_limit: limit });

test('capFromPlan: min(plan, env); -1 / missing / null plan = env cap', () => {
  assert.deepEqual(capFromPlan(plan(100), 2000), { cap: 100, planLimited: true, planName: 'Basic' });
  assert.deepEqual(capFromPlan(plan(500, 'Pro'), 2000), { cap: 500, planLimited: true, planName: 'Pro' });
  assert.deepEqual(capFromPlan(plan(-1, 'Business'), 2000), { cap: 2000, planLimited: false, planName: null });
  assert.equal(capFromPlan(plan(5000), 2000).cap, 2000, 'a plan above the env cap is held to the env cap');
  assert.equal(capFromPlan(plan(5000), 2000).planLimited, false, 'so the env cap is what refuses');
  assert.deepEqual(capFromPlan({}, 2000), { cap: 2000, planLimited: false, planName: null });
  assert.deepEqual(capFromPlan(null, 2000), { cap: 2000, planLimited: false, planName: null });
});

test('getBroadcastCap: reads the active/trial subscription plan', async () => {
  subResult = { data: { plan: plan(100) }, error: null };
  assert.deepEqual(await getBroadcastCap('b1'), { cap: 100, planLimited: true, planName: 'Basic' });
  assert.deepEqual(lookups.at(-1), ['b1', { statuses: ['active', 'trial'] }]);
});

test('getBroadcastCap: no subscription, or a failed read, falls back to the env cap only', async () => {
  subResult = { data: null, error: null };
  assert.equal((await getBroadcastCap('b1')).cap, 2000);
  subResult = { data: null, error: new Error('db down') };
  const out = await getBroadcastCap('b1');
  assert.deepEqual([out.cap, out.planLimited], [2000, false]);
});

test('overCapRefusal: exactly the cap is fine; plan cap -> 403 PLAN_BROADCAST_LIMIT with the plan message; env cap -> 400 TOO_MANY_RECIPIENTS', () => {
  const byPlan = capFromPlan(plan(100), 2000);
  assert.equal(overCapRefusal(100, byPlan), null);
  assert.deepEqual(overCapRefusal(101, byPlan), {
    status: 403, message: 'This plan sends a broadcast to up to 100 customers. Upgrade for more.',
    code: 'PLAN_BROADCAST_LIMIT', limit: 100, plan: 'Basic'
  });
  assert.equal(planLimitMessage(500), 'This plan sends a broadcast to up to 500 customers. Upgrade for more.');
  const byEnv = capFromPlan(plan(-1), 2000);
  assert.equal(overCapRefusal(2000, byEnv), null);
  const refused = overCapRefusal(2001, byEnv);
  assert.deepEqual([refused.status, refused.code, refused.limit], [400, 'TOO_MANY_RECIPIENTS', 2000]);
  assert.match(refused.message, /exceeds the current limit of 2000\. Contact support/);
});
