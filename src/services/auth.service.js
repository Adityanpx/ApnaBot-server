const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const redis = require('../config/redis');

// Sessions: one per login. Redis holds refresh:{userId}:{sid} -> JSON
// { jti, prevJti, prevUntil } (jti = the current refresh token, prevJti = the
// one it replaced, still accepted until prevUntil) and sessions:{userId}, the
// set of that user's sids so password reset can revoke them all. Every
// rotation slides the session's expiry back to JWT_REFRESH_EXPIRY.
const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 3600;
const ROTATION_GRACE_MS = 30 * 1000;

const UNITS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
const refreshTtlSeconds = () => {
  const m = /^(\d+)\s*([smhdw])?$/.exec(String(config.JWT_REFRESH_EXPIRY || '').trim());
  if (!m) return DEFAULT_REFRESH_TTL_SECONDS;
  return Number(m[1]) * (m[2] ? UNITS[m[2]] : 1) || DEFAULT_REFRESH_TTL_SECONDS;
};

const sessionKey = (userId, sid) => `refresh:${userId}:${sid}`;
const sessionsSetKey = (userId) => `sessions:${userId}`;

const generateAccessToken = (payload) => {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRY
  });
};

const signRefreshToken = (userId, sid, jti) => {
  return jwt.sign({ userId, sid, jti }, config.JWT_REFRESH_SECRET, {
    expiresIn: refreshTtlSeconds()
  });
};

const verifyAccessToken = (token, options) => {
  return jwt.verify(token, config.JWT_SECRET, options);
};

const verifyRefreshToken = (token) => {
  return jwt.verify(token, config.JWT_REFRESH_SECRET);
};

const trackSession = async (userId, sid, ttl) => {
  await redis.sadd(sessionsSetKey(userId), sid);
  await redis.expire(sessionsSetKey(userId), ttl);
};

/**
 * Start a new session (login / register / business creation). The access
 * token carries the session's sid so logout can find it without a body.
 */
const startSession = async (userId, accessPayload) => {
  const sid = crypto.randomUUID();
  const jti = crypto.randomUUID();
  const ttl = refreshTtlSeconds();
  await redis.set(sessionKey(userId, sid), JSON.stringify({ jti }), 'EX', ttl);
  await trackSession(userId, sid, ttl);
  return {
    accessToken: generateAccessToken({ ...accessPayload, userId, sid }),
    refreshToken: signRefreshToken(userId, sid, jti)
  };
};

// Atomic compare-and-rotate so parallel refreshes cannot orphan each other's
// new token. Returns [status, jti]: 'rotated' (presented token was current),
// 'grace' (it was the previous one, still inside its window — jti is the
// current one), 'revoked' (no such session), 'reused' (stale token past its
// window; the session is deleted).
const ROTATE_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'revoked', ''} end
local rec = cjson.decode(raw)
if rec.jti == ARGV[1] then
  rec.prevJti = rec.jti
  rec.prevUntil = tonumber(ARGV[3]) + tonumber(ARGV[4])
  rec.jti = ARGV[2]
  redis.call('SET', KEYS[1], cjson.encode(rec), 'EX', tonumber(ARGV[5]))
  return {'rotated', ARGV[2]}
end
if rec.prevJti == ARGV[1] and rec.prevUntil and tonumber(ARGV[3]) < rec.prevUntil then
  return {'grace', rec.jti}
end
redis.call('DEL', KEYS[1])
return {'reused', ''}
`;

/**
 * Exchange a verified refresh token's claims for the session's next token.
 * Returns { status, refreshToken? } — see ROTATE_LUA for the statuses.
 */
const rotateSession = async (decoded) => {
  const { userId, sid, jti } = decoded;
  if (!userId || !sid || !jti) return { status: 'revoked' };
  const ttl = refreshTtlSeconds();
  const [status, currentJti] = await redis.eval(
    ROTATE_LUA, 1, sessionKey(userId, sid),
    jti, crypto.randomUUID(), Date.now(), ROTATION_GRACE_MS, ttl
  );
  if (status === 'rotated') {
    await trackSession(userId, sid, ttl);
    return { status, refreshToken: signRefreshToken(userId, sid, currentJti) };
  }
  if (status === 'grace') {
    return { status, refreshToken: signRefreshToken(userId, sid, currentJti) };
  }
  if (status === 'reused') await redis.srem(sessionsSetKey(userId), sid);
  return { status };
};

const revokeSession = async (userId, sid) => {
  await redis.del(sessionKey(userId, sid));
  await redis.srem(sessionsSetKey(userId), sid);
};

// Password reset / change: every device must log in again.
const revokeAllSessions = async (userId) => {
  const sids = await redis.smembers(sessionsSetKey(userId));
  if (sids.length) await redis.del(...sids.map(sid => sessionKey(userId, sid)));
  await redis.del(sessionsSetKey(userId));
};

/**
 * Create a session and return both tokens in one call
 * Called by business.controller.js after business creation
 */
const generateTokens = (payload) => startSession(payload.userId, payload);

const buildPermissions = (role) => {
  if (role === 'superadmin') {
    return {
      canViewChats: true,
      canManageRules: true,
      canManageBookings: true,
      canViewCustomers: true,
      canManageBilling: true
    };
  }

  if (role === 'owner') {
    return {
      canViewChats: true,
      canManageRules: true,
      canManageBookings: true,
      canViewCustomers: true,
      canManageBilling: true
    };
  }

  if (role === 'staff') {
    return {
      canViewChats: true,
      canManageRules: false,
      canManageBookings: true,
      canViewCustomers: true,
      canManageBilling: false
    };
  }

  return {};
};

module.exports = {
  generateAccessToken,
  generateTokens,
  startSession,
  rotateSession,
  revokeSession,
  revokeAllSessions,
  verifyAccessToken,
  verifyRefreshToken,
  buildPermissions
};
