const redis = require('../config/redis');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { istMonthKey, istMonthStart } = require('../utils/ist');

/**
 * Get current month key in YYYY-MM format (India time — the server runs in
 * UTC, where the month would roll over at 05:30 IST on the 1st)
 */
const getCurrentMonthKey = () => istMonthKey(new Date());

/**
 * Build Redis key for usage
 * @param {string} businessId
 * @returns {string}
 */
const getUsageKey = (businessId) => {
  const month = getCurrentMonthKey();
  return `usage:${businessId}:${month}`;
};

const USAGE_TYPE_COLUMNS = { inbound: 'inbound_count', outbound: 'outbound_count', booking: 'booking_count', paymentLink: 'payment_link_count' };

/**
 * Upsert-and-increment the Supabase usage row. No atomic upsert-increment via
 * REST, so read-then-write — acceptable since this only runs every 10th hit
 * (see incrementUsage), not on every message.
 */
const persistUsageIncrement = async (businessId, month, typeColumn) => {
  try {
    const { data: existing } = await supabase
      .from('usage').select('*').eq('business_id', businessId).eq('month', month).maybeSingle();

    if (existing) {
      const updates = { msg_count: (existing.msg_count || 0) + 10 };
      if (typeColumn) updates[typeColumn] = (existing[typeColumn] || 0) + 1;
      await supabase.from('usage').update(updates).eq('id', existing.id);
    } else {
      const insertRow = { business_id: businessId, month, msg_count: 10 };
      if (typeColumn) insertRow[typeColumn] = 1;
      await supabase.from('usage').insert(insertRow);
    }
  } catch (err) {
    logger.error('Error persisting usage to Supabase:', err);
  }
};

/**
 * Increment usage counter for a business
 * @param {string} businessId - The business ID
 * @param {string} type - Type: 'inbound', 'outbound', 'booking', 'paymentLink'
 * @returns {Promise<number>} - Current message count
 */
const incrementUsage = async (businessId, type) => {
  const usageKey = getUsageKey(businessId);
  const month = getCurrentMonthKey();

  try {
    // Increment counters in Redis atomically
    await redis.hincrby(usageKey, 'msgCount', 1);
    await redis.hincrby(usageKey, `${type}Count`, 1);

    // Check/set TTL (only if key is newly created)
    const ttl = await redis.ttl(usageKey);
    if (ttl === -1) {
      // Set TTL to end of current month (India time, matching the key)
      const now = new Date();
      const secondsUntilEndOfMonth = Math.ceil((istMonthStart(now, 1) - now) / 1000);
      await redis.expire(usageKey, secondsUntilEndOfMonth);
    }

    // Get current count
    const msgCount = await redis.hget(usageKey, 'msgCount');

    // Every 10 increments, persist to Supabase (fire and forget)
    if (msgCount % 10 === 0) {
      persistUsageIncrement(businessId, month, USAGE_TYPE_COLUMNS[type]);
    }

    return msgCount;
  } catch (error) {
    logger.error('Error in incrementUsage:', error);
    throw error;
  }
};

/**
 * Check if business has exceeded usage limit
 * @param {string} businessId - The business ID
 * @param {number} planMsgLimit - Message limit from plan (-1 for unlimited)
 * @returns {Promise<Object>} - { allowed, current, limit }
 */
const checkUsageLimit = async (businessId, planMsgLimit) => {
  if (planMsgLimit === -1) {
    return { allowed: true, current: 0, limit: -1 };
  }

  const usageKey = getUsageKey(businessId);
  const month = getCurrentMonthKey();

  try {
    // Try to get from Redis first
    let current = await redis.hget(usageKey, 'msgCount');

    if (!current) {
      // Fall back to Supabase
      const { data: usageRow } = await supabase
        .from('usage').select('msg_count').eq('business_id', businessId).eq('month', month).maybeSingle();
      current = usageRow ? usageRow.msg_count : 0;
    }

    current = parseInt(current) || 0;

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

/**
 * Get usage for a business
 * @param {string} businessId - The business ID
 * @returns {Promise<Object>} - Usage stats
 */
const getUsageForBusiness = async (businessId) => {
  const usageKey = getUsageKey(businessId);
  const month = getCurrentMonthKey();

  try {
    // Try Redis first
    const redisData = await redis.hgetall(usageKey);

    if (redisData && Object.keys(redisData).length > 0) {
      return {
        msgCount: parseInt(redisData.msgCount) || 0,
        inboundCount: parseInt(redisData.inboundCount) || 0,
        outboundCount: parseInt(redisData.outboundCount) || 0,
        bookingCount: parseInt(redisData.bookingCount) || 0,
        paymentLinkCount: parseInt(redisData.paymentLinkCount) || 0,
        month
      };
    }

    // Fall back to Supabase
    const { data: usageRow } = await supabase
      .from('usage').select('*').eq('business_id', businessId).eq('month', month).maybeSingle();

    return {
      msgCount: usageRow ? usageRow.msg_count : 0,
      inboundCount: usageRow ? usageRow.inbound_count : 0,
      outboundCount: usageRow ? usageRow.outbound_count : 0,
      bookingCount: usageRow ? usageRow.booking_count : 0,
      paymentLinkCount: usageRow ? usageRow.payment_link_count : 0,
      month
    };
  } catch (error) {
    logger.error('Error in getUsageForBusiness:', error);
    return {
      msgCount: 0,
      inboundCount: 0,
      outboundCount: 0,
      bookingCount: 0,
      paymentLinkCount: 0,
      month
    };
  }
};

/**
 * Force sync Redis counts to Supabase
 * @param {string} businessId - The business ID
 */
const syncUsageToSupabase = async (businessId) => {
  const usageKey = getUsageKey(businessId);
  const month = getCurrentMonthKey();

  try {
    const redisData = await redis.hgetall(usageKey);

    if (redisData && Object.keys(redisData).length > 0) {
      const payload = {
        msg_count: parseInt(redisData.msgCount) || 0,
        inbound_count: parseInt(redisData.inboundCount) || 0,
        outbound_count: parseInt(redisData.outboundCount) || 0,
        booking_count: parseInt(redisData.bookingCount) || 0,
        payment_link_count: parseInt(redisData.paymentLinkCount) || 0
      };

      const { data: existing } = await supabase
        .from('usage').select('id').eq('business_id', businessId).eq('month', month).maybeSingle();

      if (existing) {
        await supabase.from('usage').update(payload).eq('id', existing.id);
      } else {
        await supabase.from('usage').insert({ business_id: businessId, month, ...payload });
      }
      logger.info(`Usage synced to Supabase for business ${businessId}`);
    }
  } catch (error) {
    logger.error('Error in syncUsageToSupabase:', error);
    throw error;
  }
};

module.exports = {
  incrementUsage,
  checkUsageLimit,
  getUsageForBusiness,
  syncUsageToSupabase,
  getCurrentMonthKey
};
