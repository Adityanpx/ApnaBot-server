// Duplicate protection for the public web-form submit (POST /api/public/service-form/:token/submit).
// A double tap, or a retry after a dropped response, would otherwise create two bookings: the token is only
// marked used after the booking exists. The page sends an optional Idempotency-Key header; the first request
// with a key claims it, a repeat gets the original success back, and a failed attempt releases the key so the
// customer can fix the form and submit again with the same one.
//
// Redis key formsubmit:<token>:<key>: 'pending' while the first request runs (short TTL, so a crashed request
// cannot lock the key), then the booking id for 24 hours. Fails open: a Redis error means no protection, not
// a failed submit.
const redis = require('../config/redis');
const logger = require('../utils/logger');

const DONE_TTL_SECONDS = 24 * 60 * 60;
const PENDING_TTL_SECONDS = 120;
const PENDING = 'pending';
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

const redisKey = (token, key) => `formsubmit:${token}:${key}`;

/** The header's value when present and well-formed; null when absent; false when present but malformed. */
const readKey = (req) => {
  const raw = req.get ? req.get('Idempotency-Key') : req.headers?.['idempotency-key'];
  if (raw === undefined || raw === null || raw === '') return null;
  return typeof raw === 'string' && KEY_PATTERN.test(raw) ? raw : false;
};

/**
 * Tries to claim the key.
 * @returns {Promise<{ state: 'new' }|{ state: 'done', bookingId: string }|{ state: 'pending' }>}
 */
const claim = async (token, key) => {
  try {
    const claimed = await redis.set(redisKey(token, key), PENDING, 'EX', PENDING_TTL_SECONDS, 'NX');
    if (claimed === 'OK') return { state: 'new' };
    const value = await redis.get(redisKey(token, key));
    if (value && value !== PENDING) return { state: 'done', bookingId: value };
    if (!value) return { state: 'new' };
    return { state: 'pending' };
  } catch (error) {
    logger.error('Form submit idempotency: could not claim the key, continuing without protection:', error);
    return { state: 'new' };
  }
};

/** Records the booking the key produced, for 24 hours. */
const complete = async (token, key, bookingId) => {
  try {
    await redis.set(redisKey(token, key), String(bookingId || 'unknown'), 'EX', DONE_TTL_SECONDS);
  } catch (error) {
    logger.error('Form submit idempotency: could not store the booking id:', error);
  }
};

/** Frees a key whose request did not create a booking. */
const release = async (token, key) => {
  try {
    if ((await redis.get(redisKey(token, key))) === PENDING) await redis.del(redisKey(token, key));
  } catch (error) {
    logger.error('Form submit idempotency: could not release the key:', error);
  }
};

module.exports = { readKey, claim, complete, release, redisKey, KEY_PATTERN };
