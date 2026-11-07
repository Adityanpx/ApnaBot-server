// Run: node --test src/controllers/auth.adminLogin.test.js
// POST /api/auth/admin-login (Super Admin app): every failure is the same generic 401 and only a
// verified, active superadmin gets tokens. Redis, config, supabase, logger are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('../config/env', { JWT_SECRET: 's1', JWT_REFRESH_SECRET: 's2', JWT_EXPIRY: '24h', JWT_REFRESH_EXPIRY: '30d' });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/email.service', {});
stub('../utils/crypto', { generateResetToken: () => 't', generateOtp: () => '123456' });
stub('../config/redis', {
  get: async () => null, set: async () => {}, del: async () => {}, sadd: async () => {}, srem: async () => {},
  smembers: async () => [], expire: async () => {}, eval: async () => ['rotated', 'n']
});

let user;
const chain = { select: () => chain, eq: () => chain, update: () => chain, maybeSingle: async () => ({ data: user }) };
stub('../config/supabase', { from: () => chain });

const { adminLogin } = require('./auth.controller');

const call = async (body) => {
  const out = { status: 200 };
  const res = { status: (c) => { out.status = c; return res; }, json: (b) => { out.body = b; return res; } };
  await adminLogin({ body, headers: {} }, res, (e) => { if (e) throw e; });
  return out;
};

const GENERIC = { success: false, message: 'Invalid credentials', data: null, errors: null };
let hash;
const mk = async (over = {}) => {
  hash = hash || await bcrypt.hash('secret1', 4);
  return {
    id: 'u1', business_id: null, role: 'superadmin', email: 'a@x.y', name: 'A', is_active: true, is_verified: true,
    password_hash: hash, can_view_chats: true, can_manage_rules: true, can_manage_bookings: true,
    can_view_customers: true, can_manage_billing: true, ...over
  };
};

test('a verified active superadmin with the right password gets tokens', async () => {
  user = await mk();
  const r = await call({ email: 'A@x.y', password: 'secret1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.user.role, 'superadmin');
  assert.ok(r.body.data.accessToken && r.body.data.refreshToken);
});

test('unknown email is the generic 401', async () => {
  user = null;
  const r = await call({ email: 'nobody@x.y', password: 'secret1' });
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, GENERIC);
});

test('wrong password is the generic 401', async () => {
  user = await mk();
  const r = await call({ email: 'a@x.y', password: 'nope-nope' });
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, GENERIC);
});

test('a non-superadmin with the right password is refused with the generic 401', async () => {
  for (const role of ['owner', 'staff']) {
    user = await mk({ role });
    const r = await call({ email: 'a@x.y', password: 'secret1' });
    assert.equal(r.status, 401, role);
    assert.deepEqual(r.body, GENERIC, role);
  }
});

test('an inactive or unverified superadmin gets the generic 401, not a 403 hint', async () => {
  for (const over of [{ is_active: false }, { is_verified: false }]) {
    user = await mk(over);
    const r = await call({ email: 'a@x.y', password: 'secret1' });
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, GENERIC);
  }
});

test('missing fields are a 400 that reveals nothing about accounts', async () => {
  user = await mk();
  for (const body of [{}, { email: 'a@x.y' }, { password: 'secret1' }, { email: 5, password: 'x' }]) {
    const r = await call(body);
    assert.equal(r.status, 400);
    assert.equal(r.body.message, 'Email and password are required');
  }
});
