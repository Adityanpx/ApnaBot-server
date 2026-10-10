// Run: node --test src/routes/subscription.plans.routes.test.js
// GET /api/subscription/plans is public (no token); every other subscription
// route still needs one. Config, supabase and the controller are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/env', {});
stub('../config/supabase', {});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/auth.service', { verifyAccessToken: () => { throw new Error('bad'); } });
const ok = (req, res) => res.json({ ok: true });
stub('../controllers/subscription.controller', new Proxy({}, { get: () => ok }));

const app = express();
app.use('/api/subscription', require('./subscription.routes'));

let server; let base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/subscription`;
});
test.after(() => server.close());

test('GET /plans works without a token', async () => {
  const res = await fetch(`${base}/plans`);
  assert.equal(res.status, 200);
});

test('GET / (current subscription) still needs a token', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 401);
});

test('POST /create still needs a token', async () => {
  const res = await fetch(`${base}/create`, { method: 'POST' });
  assert.equal(res.status, 401);
});
