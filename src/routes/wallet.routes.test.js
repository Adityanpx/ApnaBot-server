// Run: node --test src/routes/wallet.routes.test.js
// While WALLET_BILLING_ENABLED is off every /api/wallet route 404s and nothing
// is created (no wallet row, no Razorpay order). Auth, the wallet service and
// Razorpay are stubbed; the middleware, routes and controller are real.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const calls = { getOrCreateWallet: 0, creditWallet: 0, ordersCreate: 0 };
stub('../middleware/auth.middleware', {
  protect: (req, res, next) => { req.user = { userId: 'u', businessId: 'b', role: 'owner' }; next(); },
  requireBusiness: (req, res, next) => next()
});
stub('../services/wallet.service', {
  getOrCreateWallet: async () => { calls.getOrCreateWallet += 1; return { id: 'w', balance_paise: 500 }; },
  creditWallet: async () => { calls.creditWallet += 1; return 500; }
});
stub('razorpay', function Razorpay() {
  this.orders = {
    create: async () => { calls.ordersCreate += 1; return { id: 'order_1', amount: 1000, currency: 'INR' }; },
    fetch: async () => ({ amount: 1000 })
  };
});

const config = require('../config/env');
const app = express();
app.use(express.json());
app.use('/api/wallet', require('./wallet.routes'));

let server; let base;
test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/wallet`;
});
test.after(() => server.close());
test.beforeEach(() => { Object.keys(calls).forEach((k) => { calls[k] = 0; }); });

const call = (method, path, body) => fetch(`${base}${path}`, {
  method,
  headers: { 'content-type': 'application/json' },
  body: method === 'GET' ? undefined : JSON.stringify(body || {})
});

const ROUTES = [
  ['GET', ''],
  ['GET', '/transactions'],
  ['POST', '/topup/initiate'],
  ['POST', '/topup/verify']
];

test('all four wallet routes 404 when the flag is off', async () => {
  config.WALLET_BILLING_ENABLED = false;
  for (const [method, path] of ROUTES) {
    const res = await call(method, path, { amountRupees: 10 });
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal((await res.json()).message, 'Wallet is not enabled');
  }
});

test('GET /api/wallet creates no wallet row when off', async () => {
  config.WALLET_BILLING_ENABLED = false;
  await call('GET', '');
  assert.equal(calls.getOrCreateWallet, 0);
});

test('top-up initiate creates no Razorpay order and verify credits nothing when off', async () => {
  config.WALLET_BILLING_ENABLED = false;
  await call('POST', '/topup/initiate', { amountRupees: 10 });
  await call('POST', '/topup/verify', { razorpay_order_id: 'o', razorpay_payment_id: 'p', razorpay_signature: 's', amountRupees: 10 });
  assert.equal(calls.ordersCreate, 0);
  assert.equal(calls.creditWallet, 0);
});

test('routes pass through when the flag is on', async () => {
  config.WALLET_BILLING_ENABLED = true;
  const bal = await call('GET', '');
  assert.equal(bal.status, 200);
  assert.equal((await bal.json()).data.balancePaise, 500);
  assert.equal(calls.getOrCreateWallet, 1);

  const init = await call('POST', '/topup/initiate', { amountRupees: 10 });
  assert.equal(init.status, 200);
  assert.equal(calls.ordersCreate, 1);
});
