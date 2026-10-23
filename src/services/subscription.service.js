const supabase = require('../config/supabase');
const redis = require('../config/redis');
const subscriptionNotifications = require('./subscriptionNotifications.service');
const tenantService = require('./tenant.service');
const logger = require('../utils/logger');
const { getCurrentSubscriptionRow } = require('./currentSubscription.service');
const { supersedeOtherSubscriptions } = require('./supersedeSubscriptions.service');

const CACHE_KEY = (businessId) => `subscription:${businessId}`;
const CACHE_TTL = 300; // 5 minutes
// How long an unconfirmed autopay row lives before the daily cron expires it.
const AUTOPAY_PENDING_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Get active subscription for business with plan details.
 * Redis-first, falls back to Supabase.
 */
const getActiveSubscription = async (businessId) => {
  try {
    const cacheKey = CACHE_KEY(businessId);
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    // Shared pick rule (non-pending, latest end_date, latest created_at). A
    // duplicate-active state (write-path bug, manual DB edit) must never throw
    // PGRST116 — that took down SG Travels' webhook on 2026-08-31 — so the
    // helper picks one and logs a warning.
    const { data: sub, error } = await getCurrentSubscriptionRow(businessId, { statuses: ['active', 'trial'] });
    if (error) throw error;

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
 * Cancels the business's other live subscriptions first (and their autopay mandates).
 */
const createSubscription = async (businessId, planId, options = {}) => {
  try {
    // Renewing the same plan before expiry: stack the new period on top of
    // the remaining time instead of discarding it.
    const { data: existing } = await supabase
      .from('subscriptions')
      .select('plan_id, end_date, start_date, current_period_start')
      .eq('business_id', businessId)
      .eq('status', 'active')
      .order('end_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    const renewFrom = existing && existing.plan_id === planId && new Date(existing.end_date) > new Date()
      ? new Date(existing.end_date)
      : null;
    // The message counter's period. A stacked early renewal keeps the running period (utils/usagePeriod.js
    // keeps stepping monthly from it), so buying early never resets the counter; every other purchase -
    // first, renewal after expiry, reactivation, trial -> paid - starts a new period now.
    const periodStart = renewFrom ? new Date(existing.current_period_start || existing.start_date) : null;

    // Retire the business's other live rows, cancelling any autopay mandate at
    // Razorpay so it stops charging (a Razorpay failure is logged, not thrown).
    await supersedeOtherSubscriptions(businessId, { statuses: ['active', 'trial', 'past_due', 'pending_start'] });

    const durationMonths = options.durationMonths || 1;
    const startDate = new Date();
    const endDate = renewFrom ? new Date(renewFrom) : new Date();
    if (options.durationDays) endDate.setDate(endDate.getDate() + options.durationDays);
    else endDate.setMonth(endDate.getMonth() + durationMonths);

    const { data: sub, error } = await supabase
      .from('subscriptions')
      .insert({
        business_id: businessId,
        plan_id: planId,
        status: options.status || 'active',
        start_date: startDate.toISOString(),
        current_period_start: (periodStart || startDate).toISOString(),
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
 * Create a subscription row for an autopay flow: 'pending_start' when the
 * business already has a live subscription, 'active' only when it has none.
 * The subscription.activated webhook activates it and cancels the business's
 * other active/trial rows. Does NOT cancel existing subs here (unlike
 * createSubscription) so abandoning authorization never kills the current one.
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
    // end_date is a short placeholder window, never == start_date: if checkout
    // is abandoned the row ages out (runExpiryCheck expires stale pending_start
    // autopay rows); if authorised, the activated/charged webhooks overwrite it
    // with Razorpay's real current_end.
    const endDate = new Date(startDate.getTime() + AUTOPAY_PENDING_WINDOW_MS);

    // A business that already has a live subscription keeps it until Razorpay
    // confirms the new mandate (subscription.activated supersedes it). Only a
    // business with nothing live gets 'active' straight away, so tenant/feature
    // gating works in the seconds before the webhook.
    const { data: liveRows, error: liveErr } = await supabase
      .from('subscriptions')
      .select('id')
      .eq('business_id', businessId)
      .in('status', ['active', 'trial', 'past_due'])
      .gt('end_date', now.toISOString())
      .limit(1);
    if (liveErr) throw liveErr;
    const hasLive = (liveRows || []).length > 0;

    const { data: sub, error } = await supabase
      .from('subscriptions')
      .insert({
        business_id: businessId,
        plan_id: planId,
        status: startAt || hasLive ? 'pending_start' : 'active',
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
 * True if the business has an active/trial row other than `excludeId` whose
 * period has not ended — the daily cron must not deactivate such a business.
 */
const hasOtherLiveSubscription = async (businessId, excludeId, nowIso) => {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('business_id', businessId)
    .in('status', ['active', 'trial'])
    .neq('id', excludeId)
    .gte('end_date', nowIso)
    .limit(1);
  if (error) throw error;
  return (data || []).length > 0;
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
      .in('status', ['active', 'trial'])
      .lt('end_date', now);
    if (error) throw error;

    logger.info(`Found ${expiredSubs.length} expired subscriptions`);

    for (const sub of expiredSubs) {
      try {
        const { error: subErr } = await supabase
          .from('subscriptions').update({ status: 'expired' }).eq('id', sub.id);
        if (subErr) throw subErr;

        // Another unexpired active/trial row (e.g. a newer plan) keeps the
        // business live — only deactivate when nothing else covers it.
        let leftWithoutCover = false;
        if (await hasOtherLiveSubscription(sub.business_id, sub.id, now)) {
          logger.info(`Business ${sub.business_id} keeps running: another active/trial subscription covers it after ${sub.id} expired`);
        } else {
          const { error: bizErr } = await supabase
            .from('businesses').update({ is_active: false }).eq('id', sub.business_id);
          if (bizErr) throw bizErr;
          leftWithoutCover = true;
        }

        // Clear Redis caches
        await redis.del(CACHE_KEY(sub.business_id));

        const { data: business } = await supabase
          .from('businesses').select('phone_number_id').eq('id', sub.business_id).maybeSingle();
        if (business?.phone_number_id) {
          await redis.del(`tenant:${business.phone_number_id}`);
        }

        logger.info(`Subscription expired for business ${sub.business_id}`);
        // Critical push to the owner (fire and forget), only when the bot actually stopped.
        if (leftWithoutCover) subscriptionNotifications.sendPlanExpiredNotice(sub.business_id, sub.id);
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

        if (await hasOtherLiveSubscription(sub.business_id, sub.id, now)) {
          logger.info(`Business ${sub.business_id} keeps running: another active/trial subscription covers it after ${sub.id} was paused`);
        } else {
          const { error: bizErr } = await supabase
            .from('businesses').update({ is_active: false }).eq('id', sub.business_id);
          if (bizErr) throw bizErr;
        }

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

    // ── Abandoned autopay checkouts — a pending_start autopay row whose short
    // window has passed was never confirmed by Razorpay. Expire it; the
    // business is untouched (the row never gated anything).
    const { data: stalePending, error: staleErr } = await supabase
      .from('subscriptions')
      .update({ status: 'expired' })
      .eq('status', 'pending_start')
      .eq('is_autopay', true)
      .lt('end_date', now)
      .select('id');
    if (staleErr) throw staleErr;

    logger.info(`Expired ${(stalePending || []).length} stale pending_start autopay subscriptions`);

    return { expiredCount: expiredSubs.length, pausedCount: expiredGrace.length, stalePendingCount: (stalePending || []).length };
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
