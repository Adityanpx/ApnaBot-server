// Run: node --test src/services/usage.service.test.js
// The message counter: outbound sends only, per subscription period. The database RPC is the exact count,
// Redis (key usage:<biz>:<periodStartISO>, TTL to period end + 7 days) is the read cache. Redis / Supabase /
// subscription lookup are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

const hash = new Map();
const evals = [];
let redisDown = false;
let rpcImpl;
const rpcCalls = [];
let usageRows = [];
const notifyOnceCalls = [];
const emits = [];
let subscription;

const redis = {
  eval: async (script, n, key, total, ttl) => {
    if (redisDown) throw new Error('redis down');
    evals.push({ key, total: Number(total), ttl: Number(ttl) });
    const h = hash.get(key) || {};
    if (Number(total) > (h.used || 0)) h.used = Number(total);
    hash.set(key, h);
    return 1;
  },
  hincrby: async (key, field, n) => { if (redisDown) throw new Error('redis down'); const h = hash.get(key) || {}; h[field] = (h[field] || 0) + n; hash.set(key, h); return h[field]; },
  ttl: async () => -1,
  expire: async () => {},
  hget: async (key, field) => { if (redisDown) throw new Error('redis down'); return (hash.get(key) || {})[field] ?? null; }
};
const supabase = {
  rpc: async (name, args) => { rpcCalls.push({ name, args }); return rpcImpl(name, args); },
  from: () => {
    const f = {};
    const q = { select: () => q, eq: (c, v) => { f[c] = v; return q; }, maybeSingle: async () => ({ data: usageRows.find(r => r.business_id === f.business_id && r.period_start === f.period_start) || null, error: null }) };
    return q;
  }
};
const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/redis', redis);
stub('../config/supabase', supabase);
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('./notification.service', { notifyOnce: async (...a) => { notifyOnceCalls.push(a); } });
stub('./socket.service', { emitToBusiness: (...a) => { emits.push(a); } });
stub('./subscription.service', { getActiveSubscription: async () => subscription });
const usage = require('./usage.service');

const base = (over) => ({
  start_date: '2026-10-01T00:00:00.000Z', current_period_start: '2026-10-01T00:00:00.000Z',
  end_date: '2026-11-01T00:00:00.000Z', is_autopay: false, plan: { msg_limit: 100 }, ...over
});
const KEY = 'usage:b:2026-10-01T00:00:00.000Z';

test.beforeEach((t) => {
  hash.clear(); evals.length = 0; rpcCalls.length = 0; usageRows = []; notifyOnceCalls.length = 0; emits.length = 0;
  redisDown = false;
  let total = 0;
  rpcImpl = async (name, args) => ({ data: (total += args.p_delta), error: null });
  subscription = base();
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-10T00:00:00Z') });
});

test('recordOutbound: one atomic RPC per send with the period start, Redis raised to its total, TTL = period end + 7 days', async () => {
  const total = await usage.recordOutbound('b');
  assert.equal(total, 1);
  assert.deepEqual(rpcCalls, [{ name: 'increment_usage_period', args: {
    p_business_id: 'b', p_period_start: '2026-10-01T00:00:00.000Z', p_period_end: '2026-11-01T00:00:00.000Z', p_delta: 1
  } }]);
  assert.equal(evals.length, 1);
  assert.equal(evals[0].key, KEY);
  assert.equal(evals[0].ttl, (22 + 7) * 24 * 3600); // Oct 10 -> Nov 1 is 22 days
  assert.deepEqual(emits[0], ['b', 'usage_update', { msgCount: 1, used: 1, limit: 100 }]);
});

test('recordOutbound with a count (a broadcast batch) adds exactly that much, in one call', async () => {
  assert.equal(await usage.recordOutbound('b', { count: 42 }), 42);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].args.p_delta, 42);
});

test('recordOutbound: an autopay placeholder period has no end, so the key gets a 31-day + 7-day TTL', async () => {
  subscription = base({ is_autopay: true, current_period_start: null, end_date: '2026-10-03T00:00:00.000Z' });
  await usage.recordOutbound('b');
  assert.equal(rpcCalls[0].args.p_period_end, null);
  assert.equal(evals[0].ttl, (31 - 9 + 7) * 24 * 3600); // 31 days from Oct 1, seen from Oct 10
});

test('recordOutbound fails open: a Redis error is swallowed and the database count still happens', async () => {
  redisDown = true;
  assert.equal(await usage.recordOutbound('b'), 1);
  assert.equal(rpcCalls.length, 1);
});

test('recordOutbound: a database error falls back to counting in Redis and never throws', async () => {
  rpcImpl = async () => ({ data: null, error: { message: 'db down' } });
  assert.equal(await usage.recordOutbound('b'), 1);
  assert.equal(hash.get(KEY).used, 1);
});

test('the counter key follows the period: a renewal that moves current_period_start starts a fresh count', async () => {
  await usage.recordOutbound('b');
  subscription = base({ current_period_start: '2026-10-09T00:00:00.000Z', end_date: '2026-11-09T00:00:00.000Z' });
  hash.clear();
  const check = await usage.checkUsageLimit('b', 100);
  assert.equal(check.current, 0);
  assert.equal(check.allowed, true);
});

test('checkUsageLimit: reads Redis; falls back to usage_periods and warms Redis; blocks at the limit', async () => {
  usageRows = [{ business_id: 'b', period_start: '2026-10-01T00:00:00.000Z', outbound_count: 100 }];
  const blocked = await usage.checkUsageLimit('b', 100);
  assert.deepEqual(blocked, { allowed: false, current: 100, limit: 100 });
  assert.equal(hash.get(KEY).used, 100); // warmed
  assert.deepEqual(await usage.checkUsageLimit('b', 101), { allowed: true, current: 100, limit: 101 });
});

test('checkUsageLimit: unlimited plan, and a Redis + database failure both allow', async () => {
  assert.deepEqual(await usage.checkUsageLimit('b', -1), { allowed: true, current: 0, limit: -1 });
  redisDown = true;
  supabase.from = () => { throw new Error('db down'); };
  assert.deepEqual(await usage.checkUsageLimit('b', 100), { allowed: true, current: 0, limit: 100 });
});

test('90% / 100% alerts are keyed by period start, so they fire once per period, not per calendar month', async () => {
  const run = async (sub, used) => {
    notifyOnceCalls.length = 0; subscription = sub; hash.clear(); hash.set(`usage:b:${sub.current_period_start}`, { used });
    await usage.checkUsageLimit('b', 100);
    await new Promise((r) => setImmediate(r));
    return notifyOnceCalls;
  };
  assert.equal((await run(base(), 89)).length, 0);
  const at90 = await run(base(), 90);
  assert.deepEqual(at90[0].slice(0, 4), ['b', 'usage_90', {}, 'b:2026-10-01T00:00:00.000Z']);
  assert.equal(at90[0][4], (22 + 7) * 24 * 3600);
  assert.equal((await run(base(), 100))[0][1], 'usage_100');
  // A new period (renewal on Oct 9) is a new dedupe key: the alert can fire again within the same calendar month.
  const renewed = await run(base({ current_period_start: '2026-10-09T00:00:00.000Z', end_date: '2026-11-09T00:00:00.000Z' }), 95);
  assert.equal(renewed[0][3], 'b:2026-10-09T00:00:00.000Z');
});

test('getUsageForBusiness: { used, limit, periodStart, periodEnd, resetsOn } as ISO strings, msgCount === used', async () => {
  hash.set(KEY, { used: '37' });
  assert.deepEqual(await usage.getUsageForBusiness('b'), {
    used: 37, limit: 100, periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-11-01T00:00:00.000Z',
    resetsOn: '2026-11-01T00:00:00.000Z', msgCount: 37
  });
});

test('getUsageForBusiness for autopay: the 48-hour placeholder end_date is never returned as periodEnd / resetsOn', async () => {
  const placeholder = base({ is_autopay: true, current_period_start: null, end_date: '2026-10-03T00:00:00.000Z' });
  const u = await usage.getUsageForBusiness('b', placeholder);
  assert.equal(u.periodEnd, null);
  assert.equal(u.resetsOn, null);
  // once the activated webhook has set the real cycle, the real end shows
  const real = base({ is_autopay: true, current_period_start: '2026-10-09T00:00:00.000Z', end_date: '2026-11-09T00:00:00.000Z' });
  const v = await usage.getUsageForBusiness('b', real);
  assert.equal(v.periodEnd, '2026-11-09T00:00:00.000Z');
  assert.equal(v.resetsOn, '2026-11-09T00:00:00.000Z');
});
