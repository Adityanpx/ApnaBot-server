// Run: node --test src/services/razorpaySubscriptions.service.test.js
// Mode-keyed Razorpay plan ids, self-heal on a 400 for a stored id, the
// read-only plan check, and the sanitised client error for Razorpay failures.
// Razorpay SDK, DB, config and logger are stubbed in memory.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const rzpErr = (statusCode, description) => ({
  statusCode,
  error: { code: 'BAD_REQUEST_ERROR', description, field: 'plan_id' }
});

const calls = { fetch: [], create: [], subCreate: [], rpc: [] };
let existingRzpPlans = new Set();
let fetchError = null;       // overrides the not-found behaviour for fetch
let planRows = [];
let nextPlanSeq = 1;
const logs = { info: [], warn: [], error: [] };

class FakeRazorpay {
  constructor() {
    this.plans = {
      fetch: async (id) => {
        calls.fetch.push(id);
        if (fetchError) throw fetchError;
        if (!existingRzpPlans.has(id)) throw rzpErr(400, 'The ID provided is invalid or could not be found.');
        return { id };
      },
      create: async (body) => {
        calls.create.push(body);
        const id = `plan_NEW${nextPlanSeq++}`;
        existingRzpPlans.add(id);
        return { id };
      }
    };
    this.subscriptions = {
      create: async (body) => {
        calls.subCreate.push(body);
        if (!existingRzpPlans.has(body.plan_id)) throw rzpErr(400, 'The ID provided is invalid or could not be found.');
        return { id: 'sub_1', short_url: 'https://rzp.io/x' };
      }
    };
  }
}
stub('razorpay', FakeRazorpay);

const config = { RAZORPAY_KEY_ID: 'rzp_live_ABC', RAZORPAY_KEY_SECRET: 'secret' };
stub('../config/env', config);
stub('../utils/logger', {
  info: (m) => logs.info.push(m),
  warn: (m) => logs.warn.push(m),
  error: (m) => logs.error.push(String(m))
});
stub('../config/supabase', {
  rpc: async (name, args) => { calls.rpc.push({ name, args }); return { error: null }; },
  from: () => ({ select: async () => ({ data: planRows, error: null }) })
});

const svc = require('./razorpaySubscriptions.service');

test.beforeEach(() => {
  calls.fetch = []; calls.create = []; calls.subCreate = []; calls.rpc = [];
  existingRzpPlans = new Set();
  fetchError = null;
  planRows = [];
  nextPlanSeq = 1;
  logs.info = []; logs.warn = []; logs.error = [];
  config.RAZORPAY_KEY_ID = 'rzp_live_ABC';
});

const plan = (ids) => ({ id: 'p1', display_name: 'Basic', razorpay_plan_ids: ids });

test('getKeyMode derives mode from key prefix', () => {
  assert.equal(svc.getKeyMode(), 'live');
  config.RAZORPAY_KEY_ID = 'rzp_test_XYZ';
  assert.equal(svc.getKeyMode(), 'test');
  config.RAZORPAY_KEY_ID = 'weird';
  assert.equal(svc.getKeyMode(), 'unknown');
});

test('unknown key mode refuses to create anything', async () => {
  config.RAZORPAY_KEY_ID = 'weird';
  await assert.rejects(() => svc.getOrCreateRazorpayPlan(plan({}), 19900), /rzp_live_ or rzp_test_/);
  assert.equal(calls.create.length, 0);
});

test('stored id for the current mode that exists is reused, nothing created', async () => {
  existingRzpPlans.add('plan_OK');
  const id = await svc.getOrCreateRazorpayPlan(plan({ 'live:19900': 'plan_OK' }), 19900);
  assert.equal(id, 'plan_OK');
  assert.deepEqual(calls.fetch, ['plan_OK']);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.rpc.length, 0);
});

test('no stored id: a mode-keyed plan is created and persisted', async () => {
  const id = await svc.getOrCreateRazorpayPlan(plan({}), 19900);
  assert.equal(id, 'plan_NEW1');
  assert.deepEqual(calls.fetch, []);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].item.amount, 19900);
  assert.deepEqual(calls.rpc, [{ name: 'set_razorpay_plan_id', args: { p_plan_id: 'p1', p_price_key: 'live:19900', p_rzp_plan_id: 'plan_NEW1' } }]);
});

test('other-mode key is not used for the current mode', async () => {
  await svc.getOrCreateRazorpayPlan(plan({ 'test:19900': 'plan_T' }), 19900);
  assert.deepEqual(calls.fetch, []);
  assert.equal(calls.rpc[0].args.p_price_key, 'live:19900');
});

test('stored id that 400s is replaced, logged with mode, price and new id', async () => {
  const id = await svc.getOrCreateRazorpayPlan(plan({ 'live:19900': 'plan_DEAD' }), 19900);
  assert.equal(id, 'plan_NEW1');
  assert.equal(calls.create.length, 1);
  assert.equal(calls.rpc[0].args.p_price_key, 'live:19900');
  assert.ok(logs.warn.some(m => m.includes('plan_DEAD') && m.includes('live')));
  const created = logs.info.find(m => m.startsWith('Created Razorpay plan'));
  assert.ok(created.includes('plan_NEW1') && created.includes('mode=live') && created.includes('19900') && created.includes('plan_DEAD'));
});

test('non-400 failure on the stored id is rethrown and creates nothing', async () => {
  fetchError = { statusCode: 500, error: { code: 'SERVER_ERROR', description: 'boom' } };
  await assert.rejects(() => svc.getOrCreateRazorpayPlan(plan({ 'live:19900': 'plan_X' }), 19900), (e) => e.statusCode === 500);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.rpc.length, 0);

  fetchError = new Error('ECONNRESET');
  await assert.rejects(() => svc.getOrCreateRazorpayPlan(plan({ 'live:19900': 'plan_X' }), 19900), /ECONNRESET/);
  assert.equal(calls.create.length, 0);
});

test('createRazorpaySubscription logs mode + plan id, and the raw description on failure', async () => {
  await assert.rejects(
    () => svc.createRazorpaySubscription({ razorpayPlanId: 'plan_DEAD', totalCount: 120, notes: {} }),
    (e) => e.statusCode === 400
  );
  assert.ok(logs.info.some(m => m.includes('key_mode=live') && m.includes('plan_id=plan_DEAD')));
  assert.ok(logs.error.some(m => m.includes('The ID provided is invalid or could not be found.') && m.includes('plan_DEAD')));
  // the secret must never appear in logs
  assert.ok(![...logs.info, ...logs.warn, ...logs.error].some(m => m.includes('secret')));
  // the key id itself is never logged either, only the mode
  assert.ok(![...logs.info, ...logs.warn, ...logs.error].some(m => m.includes('ABC')));
});

test('verifyRazorpayPlans classifies ok / missing / other-mode and lists unmapped active plans', async () => {
  existingRzpPlans.add('plan_OK');
  planRows = [
    { id: 'a', name: 'basic', is_active: true, razorpay_plan_ids: { 'live:100': 'plan_OK', 'live:200': 'plan_DEAD', 'test:400': 'plan_T' } },
    { id: 'b', name: 'pro', is_active: true, razorpay_plan_ids: {} },
    { id: 'c', name: 'old', is_active: false, razorpay_plan_ids: {} },
    { id: 'd', name: 'biz', is_active: true, razorpay_plan_ids: { 'test:500': 'plan_T2' } }
  ];
  const r = await svc.verifyRazorpayPlans();
  assert.equal(r.keyMode, 'live');
  assert.deepEqual(r.summary, { ok: 1, missing: 1, error: 0, otherMode: 2 });
  assert.deepEqual(calls.fetch.sort(), ['plan_DEAD', 'plan_OK']); // other-mode never fetched
  assert.deepEqual(r.unmappedPlans.map(p => p.planId).sort(), ['b', 'd']);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.rpc.length, 0);
});

test('verifyRazorpayPlans reports non-400 fetch failures as error, not missing', async () => {
  fetchError = { statusCode: 500, error: { description: 'down' } };
  planRows = [{ id: 'a', name: 'basic', is_active: true, razorpay_plan_ids: { 'live:100': 'plan_X' } }];
  const r = await svc.verifyRazorpayPlans();
  assert.equal(r.summary.error, 1);
  assert.equal(r.summary.missing, 0);
});

// ── error handler ──────────────────────────────────────────────────────────
test('errorHandler: Razorpay 400 gives a sanitised 400, raw description only in logs', async () => {
  const errorHandler = require('../middleware/errorHandler.middleware');
  let thrown;
  const app = express();
  app.get('/boom', (req, res, next) => next(thrown));
  app.use(errorHandler);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/boom`;
  try {
    thrown = rzpErr(400, 'The ID provided is invalid or could not be found.');
    let res = await fetch(url);
    let body = await res.json();
    assert.equal(res.status, 400);
    assert.ok(!JSON.stringify(body).includes('The ID provided'));
    assert.ok(!JSON.stringify(body).includes('plan_id'));
    assert.match(body.message, /payment provider rejected/i);
    assert.ok(logs.error.some(m => m.includes('The ID provided is invalid')));

    thrown = { statusCode: 401, error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } };
    res = await fetch(url); body = await res.json();
    assert.equal(res.status, 502);
    assert.ok(!JSON.stringify(body).includes('Authentication failed'));

    thrown = { statusCode: 500, error: { code: 'SERVER_ERROR', description: 'internal detail' } };
    res = await fetch(url); body = await res.json();
    assert.equal(res.status, 502);

    // non-Razorpay errors keep their existing behaviour
    thrown = Object.assign(new Error('plain'), { statusCode: 418 });
    res = await fetch(url); body = await res.json();
    assert.equal(res.status, 418);
    assert.equal(body.message, 'plain');
  } finally {
    server.close();
  }
});
