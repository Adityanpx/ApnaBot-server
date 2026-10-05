const supabase = require('../config/supabase');
const redis = require('../config/redis');
const logger = require('../utils/logger');

/**
 * Resolve business by phone number ID (used by webhook tenant resolution)
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @returns {Promise<Object|null>}
 */
const resolveBusinessByPhoneNumberId = async (phoneNumberId) => {
  try {
    const cacheKey = `tenant:${phoneNumberId}`;

    // Step 1: Check Redis cache
    const cachedTenant = await redis.get(cacheKey);
    if (cachedTenant) {
      logger.info(`Tenant cache hit for phoneNumberId: ${phoneNumberId}`);
      return JSON.parse(cachedTenant);
    }

    // Step 2: Cache miss - query DB
    const { data: business, error: bizErr } = await supabase
      .from('businesses')
      .select('*, owner:users!owner_user_id(name, email)')
      .eq('phone_number_id', phoneNumberId)
      .eq('is_active', true)
      // account_update (PARTNER_REMOVED etc.) switches this off without clearing the IDs.
      .eq('is_whatsapp_connected', true)
      .maybeSingle();
    if (bizErr) throw bizErr;

    if (!business) {
      logger.warn(`No business found for phoneNumberId: ${phoneNumberId}`);
      return null;
    }

    // Step 3: Load active subscription for business
    const { data: subscription, error: subErr } = await supabase
      .from('subscriptions')
      .select('*, plan:plans(*)')
      .eq('business_id', business.id)
      .eq('status', 'active')
      .maybeSingle();
    if (subErr) throw subErr;

    // Step 4: Build tenant object
    const tenant = {
      businessId: business.id,
      businessName: business.name,
      displayName: business.display_name,
      phoneNumberId: business.phone_number_id,
      accessToken: business.access_token, // Still encrypted here
      fallbackReply: business.fallback_reply,
      enableSmartFallback: business.enable_smart_fallback,
      businessCategory: business.business_category,
      isActive: business.is_active,
      subscription: subscription || null,
      plan: subscription ? subscription.plan : null
    };

    // Step 5: Store in Redis with 1 hour TTL
    await redis.set(cacheKey, JSON.stringify(tenant), 'EX', 3600);
    logger.info(`Tenant cached for phoneNumberId: ${phoneNumberId}`);

    return tenant;
  } catch (error) {
    logger.error('Error in resolveBusinessByPhoneNumberId:', error);
    throw error;
  }
};

/**
 * Invalidate tenant cache when business WhatsApp connection changes
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 */
const invalidateTenantCache = async (phoneNumberId) => {
  try {
    const cacheKey = `tenant:${phoneNumberId}`;
    await redis.del(cacheKey);
    logger.info(`Tenant cache invalidated for phoneNumberId: ${phoneNumberId}`);
  } catch (error) {
    logger.error('Error in invalidateTenantCache:', error);
    throw error;
  }
};

/**
 * Flush every cached tenant entry. Used when platform-level content shared
 * across many businesses changes (e.g. a business_type_templates row) —
 * unlike invalidateTenantCache, we don't have a single phoneNumberId to
 * target, so clear all tenant:* keys rather than wait out the 1hr TTL.
 */
const flushAllTenantCache = async () => {
  try {
    const keys = await redis.keys('tenant:*');
    if (keys.length > 0) {
      await redis.del(...keys);
      logger.info(`Flushed ${keys.length} tenant:* cache key(s)`);
    }
  } catch (error) {
    logger.error('Error in flushAllTenantCache:', error);
    throw error;
  }
};

module.exports = {
  resolveBusinessByPhoneNumberId,
  invalidateTenantCache,
  flushAllTenantCache
};
