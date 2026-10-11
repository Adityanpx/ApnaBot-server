// Run: node --test src/controllers/auth.staffSwitchOff.test.js
// Staff switch Off hides the staff management routes only: an existing staff
// account still logs in and passes protect, and neither consults the feature
// switch (the stubbed service throws if asked). Refresh has no switch code
// either; it is covered by auth.sessions.test.js.
// Redis, config, supabase, logger are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('../config/env', { JWT_SECRET: 's1', JWT_REFRESH_SECRET: 's2', JWT_EXPIRY: '24h', JWT_REFRESH_EXPIRY: '30d' });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/email.service', {});
stub('../utils/crypto', { generateResetToken: () => 't', generateOtp: () => '123456' });
const store = new Map();
stub('../config/redis', {
  get: async (k) => (store.has(k) ? store.get(k) : null),
  set: async (k, v) => { store.set(k, v); },
  del: async () => {},
  sadd: async () => {},
  srem: async () => {},
  smembers: async () => [],
  expire: async () => {},
  eval: async () => ['rotated', 'n']
});
let switchAsked = 0;
stub('../services/categoryFeature.service', {
  isEnabled: async () => { switchAsked += 1; throw new Error('the staff switch must not be consulted here'); }
});

let user;
const chain = { select: () => chain, eq: () => chain, update: () => chain, maybeSingle: async () => ({ data: user }) };
stub('../config/supabase', { from: () => chain });

const { login } = require('./auth.controller');
const { protect } = require('../middleware/auth.middleware');
const { verifyAccessToken } = require('../services/auth.service');

const call = async (handler, req) => {
  const out = { status: 200 };
  const res = { status: (c) => { out.status = c; return res; }, json: (b) => { out.body = b; return res; } };
  let nextCalled = false;
  await handler(req, res, (e) => { if (e) throw e; nextCalled = true; });
  out.nextCalled = nextCalled;
  return out;
};

test('an existing staff account logs in and passes protect with the staff switch Off', async () => {
  user = {
    id: 'staff1', business_id: 'b1', role: 'staff', email: 's@x.y', name: 'S', is_active: true, is_verified: true,
    password_hash: await bcrypt.hash('secret1', 4),
    can_view_chats: true, can_manage_rules: false, can_manage_bookings: true, can_view_customers: true, can_manage_billing: false
  };
  const loggedIn = await call(login, { body: { email: 's@x.y', password: 'secret1' }, headers: {} });
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.body.data.user.role, 'staff');
  const { accessToken } = loggedIn.body.data;
  assert.equal(verifyAccessToken(accessToken).userId, 'staff1');

  const req = { headers: { authorization: `Bearer ${accessToken}` } };
  const guarded = await call(protect, req);
  assert.equal(guarded.nextCalled, true);
  assert.equal(req.user.role, 'staff');
  assert.equal(req.user.businessId, 'b1');

  assert.equal(switchAsked, 0);
});
