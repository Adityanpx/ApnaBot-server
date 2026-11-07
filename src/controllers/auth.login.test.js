// Run: node --test src/controllers/auth.login.test.js
// Public POST /api/auth/login error contract (errors.code), superadmin-as-USER_NOT_FOUND, and the
// login / forgot-password rate limits. Goes through the real router + limiters over HTTP.
// Redis, config, supabase, logger, email are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const express = require('express');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('../config/env', { JWT_SECRET: 's1', JWT_REFRESH_SECRET: 's2', JWT_EXPIRY: '24h', JWT_REFRESH_EXPIRY: '30d' });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/email.service', { sendPasswordResetEmail: async () => {} });
stub('../utils/crypto', { generateResetToken: () => 't', generateOtp: () => '123456' });
stub('../config/redis', {
  get: async () => null, set: async () => {}, del: async () => {}, sadd: async () => {}, srem: async () => {},
  smembers: async () => [], expire: async () => {}, eval: async () => ['rotated', 'n']
});

const users = new Map(); // email -> row
let wanted;
const chain = {
  select: () => chain,
  eq: (col, val) => { if (col === 'email') wanted = val; return chain; },
  update: () => chain,
  maybeSingle: async () => ({ data: users.get(wanted) || null })
};
stub('../config/supabase', { from: () => chain });

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/auth', require('../routes/auth.routes'));

let server;
let base;
test.before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/auth`;
  const hash = await bcrypt.hash('secret1', 4);
  const mk = (email, over = {}) => users.set(email, {
    id: `id-${email}`, business_id: 'b1', role: 'owner', email, name: 'N', is_active: true, is_verified: true,
    password_hash: hash, can_view_chats: true, can_manage_rules: true, can_manage_bookings: true,
    can_view_customers: true, can_manage_billing: true, ...over
  });
  mk('owner@x.y');
  mk('inactive@x.y', { is_active: false });
  mk('unverified@x.y', { is_verified: false });
  mk('root@x.y', { role: 'superadmin', business_id: null });
  for (const e of ['lim1@x.y', 'lim2@x.y', 'ok@x.y']) mk(e);
});
test.after(() => server.close());

// Each call gets its own X-Forwarded-For so the per-IP caps never bleed between tests.
let ipSeq = 1;
const post = async (path, body, ip = `10.0.0.${ipSeq++}`) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
};

test('unknown email: 404 USER_NOT_FOUND', async () => {
  const r = await post('/login', { email: 'nobody@x.y', password: 'secret1' });
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { success: false, message: 'No account found with this email', data: null, errors: { code: 'USER_NOT_FOUND' } });
});

test('wrong password: 401 WRONG_PASSWORD', async () => {
  const r = await post('/login', { email: 'owner@x.y', password: 'wrong-pass' });
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { success: false, message: 'Incorrect password', data: null, errors: { code: 'WRONG_PASSWORD' } });
});

test('inactive user: same 403 + message, now with ACCOUNT_DEACTIVATED', async () => {
  const r = await post('/login', { email: 'inactive@x.y', password: 'secret1' });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { success: false, message: 'Account is deactivated', data: null, errors: { code: 'ACCOUNT_DEACTIVATED' } });
});

test('unverified email: unchanged 403 EMAIL_NOT_VERIFIED', async () => {
  const r = await post('/login', { email: 'unverified@x.y', password: 'secret1' });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, {
    success: false, message: 'Please verify your email before logging in', data: null, errors: { code: 'EMAIL_NOT_VERIFIED' }
  });
});

test('unverified with a wrong password is still WRONG_PASSWORD (password is checked first)', async () => {
  const r = await post('/login', { email: 'unverified@x.y', password: 'nope-nope' });
  assert.equal(r.status, 401);
  assert.equal(r.body.errors.code, 'WRONG_PASSWORD');
});

test('a superadmin account on public /login answers like an unknown email, even with the right password', async () => {
  const right = await post('/login', { email: 'root@x.y', password: 'secret1' });
  const wrong = await post('/login', { email: 'root@x.y', password: 'nope-nope' });
  for (const r of [right, wrong]) {
    assert.equal(r.status, 404);
    assert.equal(r.body.errors.code, 'USER_NOT_FOUND');
  }
});

test('a good login is unchanged: 200 with user and tokens', async () => {
  const r = await post('/login', { email: 'Owner@X.y', password: 'secret1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.message, 'Login successful');
  assert.equal(r.body.data.user.email, 'owner@x.y');
  assert.ok(r.body.data.accessToken && r.body.data.refreshToken);
});

test('missing fields: unchanged 400', async () => {
  const r = await post('/login', { email: 'owner@x.y' });
  assert.equal(r.status, 400);
  assert.equal(r.body.message, 'Email and password are required');
});

test('admin-login still works for the superadmin and stays generic for everyone else', async () => {
  const ok = await post('/admin-login', { email: 'root@x.y', password: 'secret1' });
  assert.equal(ok.status, 200);
  for (const body of [{ email: 'owner@x.y', password: 'secret1' }, { email: 'nobody@x.y', password: 'secret1' }, { email: 'root@x.y', password: 'nope-nope' }]) {
    const r = await post('/admin-login', body);
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { success: false, message: 'Invalid credentials', data: null, errors: null });
  }
});

test('login limiter: the 11th failed attempt for the same IP+email is a 429 with the standard body', async () => {
  const ip = '172.16.0.1';
  for (let i = 0; i < 10; i += 1) {
    const r = await post('/login', { email: 'lim1@x.y', password: 'wrong-pass' }, ip);
    assert.equal(r.status, 401, `attempt ${i + 1}`);
  }
  const blocked = await post('/login', { email: 'LIM1@x.y', password: 'wrong-pass' }, ip);
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.body, {
    success: false, message: 'Too many login attempts, please try again in 15 minutes', data: null, errors: { code: 'RATE_LIMITED' }
  });
  // another email from the same IP, and the same email from another IP, are not blocked
  assert.equal((await post('/login', { email: 'lim2@x.y', password: 'wrong-pass' }, ip)).status, 401);
  assert.equal((await post('/login', { email: 'lim1@x.y', password: 'wrong-pass' }, '172.16.0.2')).status, 401);
});

test('successful logins do not use up the login budget', async () => {
  const ip = '172.16.0.3';
  for (let i = 0; i < 12; i += 1) {
    const r = await post('/login', { email: 'ok@x.y', password: 'secret1' }, ip);
    assert.equal(r.status, 200, `login ${i + 1}`);
  }
});

test('IP-only cap: 61st failed attempt from one IP across many emails is a 429', async () => {
  const ip = '172.16.0.4';
  for (let i = 0; i < 60; i += 1) {
    const r = await post('/login', { email: `nobody${i}@x.y`, password: 'secret1' }, ip);
    assert.equal(r.status, 404, `attempt ${i + 1}`);
  }
  const blocked = await post('/login', { email: 'nobody-final@x.y', password: 'secret1' }, ip);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.errors.code, 'RATE_LIMITED');
});

test('forgot-password: always the same 200 message, 6th request per IP+email in an hour is a 429', async () => {
  const ip = '172.16.0.5';
  for (let i = 0; i < 5; i += 1) {
    const r = await post('/forgot-password', { email: 'nobody@x.y' }, ip);
    assert.equal(r.status, 200);
    assert.equal(r.body.message, 'If this email is registered, a reset link has been sent.');
  }
  const blocked = await post('/forgot-password', { email: 'nobody@x.y' }, ip);
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.body, {
    success: false, message: 'Too many reset requests, please try again in an hour', data: null, errors: { code: 'RATE_LIMITED' }
  });
});
