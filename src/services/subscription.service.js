const supabase = require('../config/supabase');
const redis = require('../config/redis');
const subscriptionNotifications = require('./subscriptionNotifications.service');
const tenantService = require('./tenant.service');
const logger = require('../utils/logger');

const CACHE_KEY = (businessId) => `subscription:${businessId}`;
const CACHE_TTL = 300; // 5 minutes

/**
 * Get active subscription for business with plan details.
 * Redis-first, falls back to Supabase.
 */
const getActiveSubscription = async (businessId) => {
  try {
    const cacheKey = CACHE_KEY(businessId);
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    // Ordered multi-row select instead of .maybeSingle() — defense in
    // depth. A write-path bug (or a manual DB edit, or a migration) could
    // leave 2+ 'active' rows for a business; .maybeSingle() throws
    // PGRST116 on that instead of returning one, which took down SG
    // Travels' webhook on 2026-08-31. Take the most recent instead of
    // failing, but log it so the underlying duplicate is still visible.
    const { data: subs, error } = await supabase
      .from('subscriptions')
      .select('*, plan:plans(*)')
      .eq('business_id', businessId)
      .eq('status', 'active')
      .order('created_at', { ascending: false });
    if (error) throw error;

    if (subs && subs.length > 1) {
      logger.warn(`Business ${businessId} has ${subs.length} active subscriptions — using most recent (${subs[0].id}, created_at ${subs[0].created_at}). Duplicate-active-row state should be investigated.`);
    }

    const sub = subs && subs.length > 0 ? subs[0] : null;

    if (sub) await redis.set(cacheKey, JSON.stringify(sub), 'EX', CACHE_TTL);
    return sub;
  } catch (error) {
    logger.error('Error in getActiveSubscription:', error);
    throw error;
  }
};

/**
 * Invalidate subscription cache — call after any subscription change
 */
const invalidateSubscriptionCache = async (businessId) => {
  try {
    await redis.del(CACHE_KEY(businessId));
    logger.info(`Subscription cache cleared for business ${businessId}`);
  } catch (error) {
    logger.error('Error clearing subscription cache:', error);
  }
};

/**
 * Create a new subscription (trial or paid).
 * Cancels any existing active subscription first.
 */
const createSubscription = async (businessId, planId, options = {}) => {
  try {
    // Renewing the same plan before expiry: stack the new period on top of
    // the remaining time instead of discarding it.
    const { data: existing } = await supabase
      .from('subscriptions')
      .select('plan_id, end_date')
      .eq('business_id', businessId)
      .eq('status', 'active')
      .order('end_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    const renewFrom = existing && existing.plan_id === planId && new Date(existing.end_date) > new Date()
      ? new Date(existing.end_date)
      : null;

    // Cancel existing active subscriptions
    const { error: cancelErr } = await supabase
      .from('subscriptions')
      .update({ status: 'cancelled' })
      .eq('business_id', businessId)
      .eq('status', 'active');
    if (cancelErr) throw cancelErr;

    const durationMonths = options.durationMonths || 1;
    const startDate = new Date();
    const endDate = renewFrom ? new Date(renewFrom) : new Date();
    endDate.setMonth(endDate.getMonth() + durationMonths);

    const { data: sub, error } = await supabase
      .from('subscriptions')
      .insert({
        business_id: businessId,
        plan_id: planId,
        status: options.status || 'active',
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
        razorpay_subscription_id: options.razorpaySubscriptionId || null,
        razorpay_payment_id: options.razorpayPaymentId || null,
        auto_renew: options.autoRenew !== undefined ? options.autoRenew : true
      })
      .select()
      .single();
    if (error) throw error;

    // Activate business on subscription creation
    const { data: business, error: bizErr } = await supabase
      .from('businesses').update({ is_active: true }).eq('id', businessId)
      .select('phone_number_id').maybeSingle();
    if (bizErr) throw bizErr;

    await invalidateSubscriptionCache(businessId);
    // The webhook's tenant cache holds its own subscription/plan snapshot
    // (1h TTL) — without this a renewal or plan change isn't seen until it expires.
    if (business?.phone_number_id) {
      try {
        await tenantService.invalidateTenantCache(business.phone_number_id);
      } catch (cacheErr) {
        logger.error(`Error invalidating tenant cache for business ${businessId}:`, cacheErr);
      }
    }

    logger.info(`Subscription created for business ${businessId}, plan ${planId}`);
    return sub;
  } catch (error) {
    logger.error('Error in createSubscription:', error);
    throw error;
  }
};

/**
 * Create a subscription row in 'pending_start' state for an autopay flow.
 * The row is upgraded to 'active' by the subscription.activated webhook.
 * Does NOT cancel existing active subs (unlike createSubscription) — that
 * happens on webhook confirmation to avoid killing the current sub if the
 * customer abandons authorization.
 *
 * opts:
 *   razorpaySubscriptionId (string) — required
 *   mandatedAmountPaise (integer)   — required
 *   startAt (Date | null)           — if set, row is 'pending_start' until that time
 *                                     (used for scheduled upgrades)
 */
const createAutopaySubscriptionRow = async (businessId, planId, opts) => {
  try {
    const {
      razorpaySubscriptionId,
      mandatedAmountPaise,
      startAt = null
    } = opts;

    if (!razorpaySubscriptionId) throw new Error('razorpaySubscriptionId required');
    if (!Number.isInteger(mandatedAmountPaise)) throw new Error('mandatedAmountPaise required');

    const now = new Date();
    const startDate = startAt || now;
    // end_date is a placeholder; it will be updated by the subscription.charged
    // webhook on every successful debit. For 'pending_start' rows it stays at
    // start_date until activation.
    const endDate = new Date(startDate);

    const { data: sub, error } = await supabase
      .from('subscriptions')
      .insert({
        business_id: businessId,
        plan_id: planId,
        status: startAt ? 'pending_start' : 'active',
        // ↑ 'active' is a placeholder — the webhook flips to 'active' on first
        // charge. Using 'active' here (instead of e.g. 'trial') avoids breaking
        // the tenant cache lookup during the ~5s window between subscribe and
        // first webhook. If you want a distinct 'pending_activation' state,
        // add it in a follow-up migration; leaving it out for this pass.
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
        razorpay_subscription_id: razorpaySubscriptionId,
        auto_renew: true,
        is_autopay: true,
        mandated_amount_paise: mandatedAmountPaise
      })
      .select()
      .single();
    if (error) throw error;

    await invalidateSubscriptionCache(businessId);
    return sub;
  } catch (error) {
    logger.error('Error in createAutopaySubscriptionRow:', error);
    throw error;
  }
};

/**
 * Daily expiry check — called by cron job in server.js
 * Expires subscriptions past endDate, deactivates businesses
 */
const runExpiryCheck = async () => {
  try {
    const now = new Date().toISOString();
    logger.info('Running subscription expiry check...');

    const { data: expiredSubs, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('status', 'active')
      .lt('end_date', now);
    if (error) throw error;

    logger.info(`Found ${expiredSubs.length} expired subscriptions`);

    for (const sub of expiredSubs) {
      try {
        const { error: subErr } = await supabase
          .from('subscriptions').update({ status: 'expired' }).eq('id', sub.id);
        if (subErr) throw subErr;

        const { error: bizErr } = await supabase
          .from('businesses').update({ is_active: false }).eq('id', sub.business_id);
        if (bizErr) throw bizErr;

        // Clear Redis caches
        await redis.del(CACHE_KEY(sub.business_id));

        const { data: business } = await supabase
          .from('businesses').select('phone_number_id').eq('id', sub.business_id).maybeSingle();
        if (business?.phone_number_id) {
          await redis.del(`tenant:${business.phone_number_id}`);
        }

        logger.info(`Subscription expired for business ${sub.business_id}`);
      } catch (err) {
        logger.error(`Error processing expiry for sub ${sub.id}:`, err);
      }
    }

    // ── Grace-period sweep — flip 'past_due' rows whose grace has expired ──
    // Runs in the same daily cron. If we later want faster reaction than 24h
    // (e.g. flip to paused within 1h of grace expiry), add a second interval
    // in server.js; for now daily is fine.
    const { data: expiredGrace, error: graceErr } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('status', 'past_due')
      .lt('grace_until', now);
    if (graceErr) throw graceErr;

    logger.info(`Found ${expiredGrace.length} past_due subscriptions with expired grace`);

    for (const sub of expiredGrace) {
      try {
        const { error: subErr } = await supabase
          .from('subscriptions').update({ status: 'paused' }).eq('id', sub.id);
        if (subErr) throw subErr;

        const { error: bizErr } = await supabase
          .from('businesses').update({ is_active: false }).eq('id', sub.business_id);
        if (bizErr) throw bizErr;

        await redis.del(CACHE_KEY(sub.business_id));

        const { data: business } = await supabase
          .from('businesses').select('phone_number_id').eq('id', sub.business_id).maybeSingle();
        if (business?.phone_number_id) {
          await redis.del(`tenant:${business.phone_number_id}`);
        }

        logger.info(`Subscription paused (grace expired) for business ${sub.business_id}`);
        await subscriptionNotifications.sendSubscriptionPausedNotice(sub.business_id);
      } catch (err) {
        logger.error(`Error flipping past_due -> paused for sub ${sub.id}:`, err);
      }
    }

    return { expiredCount: expiredSubs.length, pausedCount: expiredGrace.length };
  } catch (error) {
    logger.error('Error in runExpiryCheck:', error);
    throw error;
  }
};

module.exports = {
  getActiveSubscription,
  invalidateSubscriptionCache,
  createSubscription,
  createAutopaySubscriptionRow,
  runExpiryCheck
};
