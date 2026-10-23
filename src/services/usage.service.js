const redis = require('../config/redis');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { resolvePeriod } = require('../utils/usagePeriod');
const notificationService = require('./notification.service');

// How long a usage key outlives its period, so a late read still finds it.
const KEY_GRACE_SECONDS = 7 * 24 * 60 * 60;
// An autopay row on its placeholder end_date has no known period end.
const UNKNOWN_END_SECONDS = 31 * 24 * 60 * 60;

/**
 * Redis key for one business's counter in one period.
 * @param {string} businessId
 * @param {Date} periodStart
 * @returns {string}
 */
const getUsageKey = (businessId, periodStart) => `usage:${businessId}:${periodStart.toISOString()}`;

// Seconds until the period ends plus the grace window (never less than the grace window).
const keyTtlSeconds = ({ periodStart, periodEnd }, now = new Date()) => {
  const end = periodEnd || new Date(periodStart.getTime() + UNKNOWN_END_SECONDS * 1000);
  return Math.max(Math.ceil((end.getTime() - now.getTime()) / 1000), 0) + KEY_GRACE_SECONDS;
};

// Raises the Redis count to the database's authoritative total (never lowers it, so an out-of-order
// write cannot walk the counter back) and sets the TTL once.
const RAISE_COUNT_LUA = `
local c = tonumber(redis.call('HGET', KEYS[1], 'used') or '0')
if tonumber(ARGV[1]) > c then redis.call('HSET', KEYS[1], 'used', ARGV[1]) end
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return 1
`;

// The business's current subscription row (Redis-cached 5 min), or null. Lazy require: subscription.service
// is heavier than this module and payment.service loads both.
const loadSubscription = async (businessId) => {
  try {
    return await require('./subscription.service').getActiveSubscription(businessId);
  } catch (error) {
    logger.error('Error loading the subscription for usage:', error);
    return null;
  }
};

/**
 * Counts messages ApnaBot actually sent for a business, in its current subscription period.
 * Called at every successful send point (whatsapp.worker.js for everything queued; the few
 * direct sends - broadcast template batches, window-aware templates, the web-form confirmation,
 * the session-timeout notice - call it themselves). The database RPC is the exact, atomic count;
 * Redis is the read cache. Never throws.
 * @param {string} businessId
 * @param {Object} [opts]
 * @param {number} [opts.count=1] messages sent (a broadcast batch passes its sent total)
 * @param {Object|null} [opts.subscription] the row, when the caller already has it
 * @returns {Promise<number|null>} the period's new total, or null when it could not be counted
 */
const recordOutbound = async (businessId, { count = 1, subscription } = {}) => {
  if (!businessId || !(count > 0)) return null;
  try {
    const sub = subscription !== undefined ? subscription : await loadSubscription(businessId);
    const period = resolvePeriod(sub);
    const key = getUsageKey(businessId, period.periodStart);
    const ttl = keyTtlSeconds(period);

    let total = null;
    try {
      const { data, error } = await supabase.rpc('increment_usage_period', {
        p_business_id: businessId,
        p_period_start: period.periodStart.toISOString(),
        p_period_end: period.periodEnd ? period.periodEnd.toISOString() : null,
        p_delta: count
      });
      if (error) throw error;
      total = typeof data === 'number' ? data : parseInt(data, 10);
      if (Number.isNaN(total)) total = null;
    } catch (rpcError) {
      logger.error('Error counting outbound usage in the database:', rpcError);
    }

    try {
      if (total !== null) {
        await redis.eval(RAISE_COUNT_LUA, 1, key, String(total), String(ttl));
      } else {
        // Database unreachable: keep the cached count moving so the limit still tracks.
        total = await redis.hincrby(key, 'used', count);
        if ((await redis.ttl(key)) < 0) await redis.expire(key, ttl);
      }
    } catch (redisError) {
      logger.error('Error counting outbound usage in Redis:', redisError);
    }

    emitUsageUpdate(businessId, total, sub);
    return total;
  } catch (error) {
    logger.error('Error in recordOutbound:', error);
    return null;
  }
};

// Live counter for the owner's dashboard. Never throws.
const emitUsageUpdate = (businessId, used, sub) => {
  if (used === null || used === undefined) return;
  try {
    const limit = sub?.plan?.msg_limit;
    require('./socket.service').emitToBusiness(businessId.toString(), 'usage_update', {
      msgCount: used,
      used,
      limit: limit === undefined ? null : limit
    });
  } catch (error) {
    logger.error('Error emitting usage_update:', error);
  }
};

// The count for a period: Redis first, then the database (warming Redis with it). Throws on a database error.
const readUsed = async (businessId, period) => {
  const key = getUsageKey(businessId, period.periodStart);
  let used = null;
  try {
    used = await redis.hget(key, 'used');
  } catch (redisError) {
    logger.error('Error reading usage from Redis:', redisError);
  }
  if (used !== null && used !== undefined) return parseInt(used, 10) || 0;

  const { data: row, error } = await supabase
    .from('usage_periods').select('outbound_count')
    .eq('business_id', businessId).eq('period_start', period.periodStart.toISOString()).maybeSingle();
  if (error) throw error;
  const count = row ? row.outbound_count : 0;
  try {
    await redis.eval(RAISE_COUNT_LUA, 1, key, String(count), String(keyTtlSeconds(period)));
  } catch (redisError) {
    logger.error('Error warming the usage cache:', redisError);
  }
  return count;
};

/**
 * Check if business has exceeded usage limit
 * @param {string} businessId - The business ID
 * @param {number} planMsgLimit - Message limit from plan (-1 for unlimited)
 * @param {Object|null} [subscription] the business's subscription row (the tenant snapshot has it)
 * @returns {Promise<Object>} - { allowed, current, limit }
 */
const checkUsageLimit = async (businessId, planMsgLimit, subscription) => {
  if (planMsgLimit === -1) {
    return { allowed: true, current: 0, limit: -1 };
  }

  try {
    const sub = subscription !== undefined ? subscription : await loadSubscription(businessId);
    const period = resolvePeriod(sub);
    const current = await readUsed(businessId, period);

    // Critical push at 90% / 100% of the plan (fire and forget, once per level per period).
    checkUsageThresholds(businessId, current, planMsgLimit, period);

    if (current >= planMsgLimit) {
      return { allowed: false, current, limit: planMsgLimit };
    }

    return { allowed: true, current, limit: planMsgLimit };
  } catch (error) {
    logger.error('Error in checkUsageLimit:', error);
    // On error, allow the request (fail open)
    return { allowed: true, current: 0, limit: planMsgLimit };
  }
};

// Usage levels that trigger a critical push, highest first.
const USAGE_ALERTS = [
  { percent: 100, type: 'usage_100' },
  { percent: 90, type: 'usage_90' }
];

/**
 * Pushes a critical alert when this period's usage has reached 90% / 100% of the
 * plan limit - once per level per period (Redis key named after the period start, kept a week past
 * the period's end). Fire-and-forget: never throws. Reaching 100% also counts as 90%, but
 * only the highest level reached is sent.
 * @param {string} businessId
 * @param {number} current messages used this period
 * @param {number} limit plan message limit (-1 = unlimited)
 * @param {{ periodStart: Date, periodEnd: Date|null }} period
 */
const checkUsageThresholds = async (businessId, current, limit, period) => {
  try {
    if (!limit || limit <= 0) return;
    const percent = (current / limit) * 100;
    const alert = USAGE_ALERTS.find((a) => percent >= a.percent);
    if (!alert) return;
    await notificationService.notifyOnce(
      businessId,
      alert.type,
      {},
      `${businessId}:${period.periodStart.toISOString()}`,
      keyTtlSeconds(period)
    );
  } catch (error) {
    logger.error('Error in checkUsageThresholds:', error);
  }
};

/**
 * Usage for the business's current period, for GET /api/subscription and the dashboard stats.
 * msgCount is the same number as used, for clients that predate the period fields.
 * @param {string} businessId - The business ID
 * @param {Object|null} [subscription] the business's current subscription row (with its plan), when the caller has it
 * @returns {Promise<{ used:number, limit:number|null, periodStart:string, periodEnd:string|null, resetsOn:string|null, msgCount:number }>}
 */
const getUsageForBusiness = async (businessId, subscription) => {
  const sub = subscription !== undefined ? subscription : await loadSubscription(businessId);
  const period = resolvePeriod(sub);
  const limit = sub?.plan?.msg_limit;
  let used = 0;
  try {
    used = await readUsed(businessId, period);
  } catch (error) {
    logger.error('Error in getUsageForBusiness:', error);
  }
  const periodEnd = period.periodEnd ? period.periodEnd.toISOString() : null;
  return {
    used,
    limit: limit === undefined ? null : limit,
    periodStart: period.periodStart.toISOString(),
    periodEnd,
    resetsOn: periodEnd,
    msgCount: used
  };
};

module.exports = {
  recordOutbound,
  checkUsageLimit,
  getUsageForBusiness,
  checkUsageThresholds,
  getUsageKey,
  keyTtlSeconds
};
