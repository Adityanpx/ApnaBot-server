// Run: node --test src/controllers/auth.sessions.test.js
// Per-login refresh sessions: each login its own session, /refresh rotates
// the refresh token (old one valid for a 30s grace window), logout ends only
// the caller's session (body optional), password reset ends them all.
// Redis is a fake; its eval() mirrors ROTATE_LUA in auth.service.js (the Lua
// itself is not executed here). Config, supabase, logger are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const config = { JWT_SECRET: 's1', JWT_REFRESH_SECRET: 's2', JWT_EXPIRY: '24h', JWT_REFRESH_EXPIRY: '30d' };
stub('../config/env', config);
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/email.service', {});
stub('../utils/crypto', { generateResetToken: () => 't', generateOtp: () => '123456' });

const store = new Map(); // key -> { value, ttl }; sets hold a Set in value
const fakeRedis = {
  get: async (k) => (store.has(k) ? store.get(k).value : null),
  set: async (k, v, _ex, ttl) => { store.set(k, { value: v, ttl }); },
  del: async (...keys) => { keys.forEach(k => store.delete(k)); },
  sadd: async (k, m) => { if (!store.has(k)) store.set(k, { value: new Set() }); store.get(k).value.add(m); },
  srem: async (k, m) => { if (store.has(k)) store.get(k).value.delete(m); },
  smembers: async (k) => (store.has(k) ? [...store.get(k).value] : []),
  expire: async (k, ttl) => { if (store.has(k)) store.get(k).ttl = ttl; },
  // Mirrors ROTATE_LUA: key = session key, then presentedJti, newJti, nowMs, graceMs, ttl
  eval: async (_lua, _n, key, presented, newJti, now, grace, ttl) => {
    const e = store.get(key);
    if (!e) return ['revoked', ''];
    const rec = JSON.parse(e.value);
    if (rec.jti === presented) {
      rec.prevJti = rec.jti; rec.prevUntil = Number(now) + Number(grace); rec.jti = newJti;
      store.set(key, { value: JSON.stringify(rec), ttl: Number(ttl) });
      return ['rotated', newJti];
    }
    if (rec.prevJti === presented && rec.prevUntil && Number(now) < rec.prevUntil) return ['grace', rec.jti];
    store.delete(key);
    return ['reused', ''];
  }
};
stub('../config/redis', fakeRedis);

let user;
const chain = { select: () => chain, eq: () => chain, update: () => chain, maybeSingle: async () => ({ data: user }) };
stub('../config/supabase', { from: () => chain });

const auth = require('./auth.controller');
const authService = require('../services/auth.service');

const call = async (handler, { body, headers } = {}) => {
  const out = { status: 200 };
  const res = {
    status: (c) => { out.status = c; return res; },
    json: (b) => { out.body = b; return res; }
  };
  await handler({ body, headers: headers || {} }, res, (e) => { throw e; });
  return out;
};
const login = async () => (await call(auth.login, { body: { email: 'a@b.c', password: 'pw1234' } })).body.data;
const refresh = (refreshToken) => call(auth.refresh, { body: { refreshToken } });
const sessionKeys = () => [...store.keys()].filter(k => k.startsWith('refresh:'));

test.beforeEach(async () => {
  store.clear();
  user = {
    id: 'u1', email: 'a@b.c', name: 'A', role: 'owner', business_id: 'b1', is_active: true, is_verified: true,
    password_hash: await bcrypt.hash('pw1234', 4)
  };
});

test('two logins make two sessions and both can refresh', async () => {
  const a = await login(); const b = await login();
  assert.equal(sessionKeys().length, 2);
  assert.equal((await refresh(a.refreshToken)).status, 200);
  assert.equal((await refresh(b.refreshToken)).status, 200);
});

test('refresh rotates: returns a new refreshToken and a sid-bearing access token', async () => {
  const a = await login();
  const r = (await refresh(a.refreshToken)).body.data;
  assert.ok(r.accessToken && r.refreshToken);
  assert.notEqual(r.refreshToken, a.refreshToken);
  assert.equal(authService.verifyAccessToken(r.accessToken).sid, authService.verifyRefreshToken(a.refreshToken).sid);
  assert.equal((await refresh(r.refreshToken)).status, 200); // chain keeps working
});

test('refresh slides the Redis TTL back to JWT_REFRESH_EXPIRY', async () => {
  const a = await login();
  const key = sessionKeys()[0];
  store.get(key).ttl = 5;
  await refresh(a.refreshToken);
  assert.equal(store.get(key).ttl, 30 * 86400);
});

test('old refresh token works inside the grace window, is rejected after it', async () => {
  const realNow = Date.now;
  try {
    const a = await login();
    const t0 = realNow();
    Date.now = () => t0;
    assert.equal((await refresh(a.refreshToken)).status, 200); // rotate
    Date.now = () => t0 + 10_000;
    const again = await refresh(a.refreshToken); // parallel / retried
    assert.equal(again.status, 200);
    assert.ok(again.body.data.refreshToken);
    // the token a grace-window caller gets back is the session's current one
    assert.equal((await refresh(again.body.data.refreshToken)).status, 200);
    Date.now = () => t0 + 31_000;
    const late = await refresh(a.refreshToken);
    assert.equal(late.status, 401);
    assert.equal(late.body.message, 'Refresh token expired or revoked');
  } finally { Date.now = realNow; }
});

test('reuse after the grace window removes only that session', async () => {
  const realNow = Date.now;
  try {
    const a = await login(); const b = await login();
    const t0 = realNow();
    Date.now = () => t0;
    await refresh(a.refreshToken);
    Date.now = () => t0 + 60_000;
    assert.equal((await refresh(a.refreshToken)).status, 401);
    assert.equal(sessionKeys().length, 1);
    assert.equal((await refresh(b.refreshToken)).status, 200);
  } finally { Date.now = realNow; }
});

test('logout with the refresh token ends only that session', async () => {
  const a = await login(); const b = await login();
  assert.equal((await call(auth.logout, { body: { refreshToken: a.refreshToken } })).status, 200);
  assert.equal((await refresh(a.refreshToken)).status, 401);
  assert.equal((await refresh(b.refreshToken)).status, 200);
});

test('logout with no body ends the session named by the Bearer access token', async () => {
  const a = await login(); const b = await login();
  const out = await call(auth.logout, { headers: { authorization: `Bearer ${a.accessToken}` } });
  assert.equal(out.status, 200);
  assert.equal((await refresh(a.refreshToken)).status, 401);
  assert.equal((await refresh(b.refreshToken)).status, 200);
});

test('logout with nothing at all is a harmless 200', async () => {
  const a = await login();
  assert.equal((await call(auth.logout, {})).status, 200);
  assert.equal((await refresh(a.refreshToken)).status, 200);
});

test('password reset ends every session', async () => {
  const a = await login(); const b = await login();
  store.set('reset:u1', { value: 'tok' });
  const out = await call(auth.resetPassword, { body: { email: 'a@b.c', token: 'tok', newPassword: 'newpass1' } });
  assert.equal(out.status, 200);
  assert.equal((await refresh(a.refreshToken)).status, 401);
  assert.equal((await refresh(b.refreshToken)).status, 401);
  assert.deepEqual(sessionKeys(), []);
});

test('generateTokens (createBusiness) starts its own session', async () => {
  const a = await login();
  const t = await authService.generateTokens({ userId: 'u1', businessId: 'b2', role: 'owner' });
  assert.equal(sessionKeys().length, 2);
  assert.equal((await refresh(t.refreshToken)).status, 200);
  assert.equal((await refresh(a.refreshToken)).status, 200);
});

test('missing and wrong tokens keep the existing messages', async () => {
  const none = await refresh(undefined);
  assert.deepEqual([none.status, none.body.message], [400, 'Refresh token required']);
  const bad = await refresh('not-a-jwt');
  assert.deepEqual([bad.status, bad.body.message], [401, 'Invalid refresh token']);
  const a = await login();
  store.clear(); // session gone (Redis wipe / revoked)
  const gone = await refresh(a.refreshToken);
  assert.deepEqual([gone.status, gone.body.message], [401, 'Refresh token expired or revoked']);
});
