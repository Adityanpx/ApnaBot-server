// src/services/razorpaySubscriptions.service.js
const Razorpay = require('razorpay');
const config = require('../config/env');
const logger = require('../utils/logger');
const supabase = require('../config/supabase');

const razorpay = new Razorpay({
  key_id: config.RAZORPAY_KEY_ID,
  key_secret: config.RAZORPAY_KEY_SECRET
});

/**
 * Razorpay keeps test-mode and live-mode objects in separate worlds: a plan id
 * created under rzp_test_ keys 400s ("The ID provided is invalid or could not
 * be found") under rzp_live_ keys and vice versa. Derive the mode from the key
 * prefix so stored plan ids can be keyed by it.
 */
const getKeyMode = () => {
  const keyId = config.RAZORPAY_KEY_ID || '';
  if (keyId.startsWith('rzp_live_')) return 'live';
  if (keyId.startsWith('rzp_test_')) return 'test';
  return 'unknown';
};

// razorpay_plan_ids keys are "<mode>:<pricePaise>" (e.g. "live:19900").
const planKey = (mode, pricePaise) => `${mode}:${pricePaise}`;

const isRazorpay400 = (err) => err?.statusCode === 400;
const rzpDescription = (err) => err?.error?.description || err?.message || String(err);

/**
 * Look up plan.razorpay_plan_ids["<mode>:<pricePaise>"]; create + persist a new
 * Razorpay Plan if that price hasn't been mapped yet for this key mode. Persist
 * via the set_razorpay_plan_id RPC (atomic jsonb merge against the live row) so a
 * concurrent request for the same (plan, price) pair never creates two
 * Razorpay Plans for it — supabase-js's .update() can't reference a
 * column's own current value, hence the RPC.
 *
 * A stored id is verified with a Razorpay fetch first. Only a 400 (id not
 * found for these keys) triggers re-creation; any other failure (network, 401,
 * 5xx) is rethrown, because creating a plan is permanent and must not happen
 * on a transient error.
 */
const getOrCreateRazorpayPlan = async (plan, pricePaise) => {
  const mode = getKeyMode();
  if (mode === 'unknown') {
    throw new Error('RAZORPAY_KEY_ID must start with rzp_live_ or rzp_test_');
  }
  const priceKey = planKey(mode, pricePaise);
  const existingId = plan.razorpay_plan_ids?.[priceKey];

  if (existingId) {
    try {
      await razorpay.plans.fetch(existingId);
      return existingId;
    } catch (err) {
      if (!isRazorpay400(err)) throw err;
      logger.warn(`Stored Razorpay plan ${existingId} (${priceKey}) not found in ${mode} mode for plan ${plan.id} — creating a replacement. Razorpay: ${rzpDescription(err)}`);
    }
  }

  const created = await razorpay.plans.create({
    period: 'monthly',
    interval: 1,
    item: {
      name: `${plan.display_name} — Monthly`,
      amount: pricePaise,
      currency: 'INR',
      description: `Monthly autopay for ${plan.display_name}`
    },
    notes: {
      apnabot_plan_id: plan.id,
      price_paise: String(pricePaise),
      key_mode: mode
    }
  });

  const { error } = await supabase.rpc('set_razorpay_plan_id', {
    p_plan_id: plan.id,
    p_price_key: priceKey,
    p_rzp_plan_id: created.id
  });
  if (error) throw error;

  logger.info(`Created Razorpay plan ${created.id} (mode=${mode}, price=${pricePaise} paise) for plan ${plan.id}${existingId ? `, replacing ${existingId}` : ''}`);
  return created.id;
};

/**
 * Create a Razorpay Subscription — this is what the customer authorizes.
 * total_count = number of billing cycles; caller passes 120 (10 years) for
 * "until cancelled". start_at is a unix timestamp; omit for immediate
 * first-cycle start.
 */
const createRazorpaySubscription = async ({ razorpayPlanId, totalCount, startAt, notes }) => {
  const mode = getKeyMode();
  logger.info(`Creating Razorpay subscription: key_mode=${mode}, plan_id=${razorpayPlanId}, total_count=${totalCount}`);
  let sub;
  try {
    sub = await razorpay.subscriptions.create({
      plan_id: razorpayPlanId,
      total_count: totalCount,
      quantity: 1,
      customer_notify: 1,
      start_at: startAt || undefined,
      notes: notes || {}
    });
  } catch (err) {
    logger.error(`Razorpay subscriptions.create failed: key_mode=${mode}, plan_id=${razorpayPlanId}, status=${err?.statusCode}, code=${err?.error?.code}, description=${rzpDescription(err)}`);
    throw err;
  }

  logger.info(`Created Razorpay subscription ${sub.id} for plan ${razorpayPlanId}`);
  return sub;
};

/**
 * Fetch every mapped Razorpay plan id and report which exist in the current
 * key mode. Read-only (GETs only). Keys of the other mode are listed but
 * not fetched. Active plans with no current-mode
 * mapping are listed in `unmappedPlans` (a plan is created on first use).
 */
const verifyRazorpayPlans = async () => {
  const mode = getKeyMode();
  const { data: plans, error } = await supabase
    .from('plans').select('id, name, is_active, razorpay_plan_ids');
  if (error) throw error;

  const entries = [];
  const unmappedPlans = [];
  for (const plan of plans || []) {
    const ids = plan.razorpay_plan_ids || {};
    let hasCurrent = false;
    for (const [key, rzpPlanId] of Object.entries(ids)) {
      const entry = { planId: plan.id, planName: plan.name, key, razorpayPlanId: rzpPlanId };
      if (!key.startsWith(`${mode}:`)) {
        entries.push({ ...entry, status: 'other_mode' });
      } else {
        hasCurrent = true;
        try {
          await razorpay.plans.fetch(rzpPlanId);
          entries.push({ ...entry, status: 'ok' });
        } catch (err) {
          entries.push({
            ...entry,
            status: isRazorpay400(err) ? 'missing' : 'error',
            detail: rzpDescription(err)
          });
        }
      }
    }
    if (!hasCurrent && plan.is_active) unmappedPlans.push({ planId: plan.id, planName: plan.name });
  }

  const count = (status) => entries.filter(e => e.status === status).length;
  return {
    keyMode: mode,
    summary: {
      ok: count('ok'), missing: count('missing'), error: count('error'),
      otherMode: count('other_mode')
    },
    entries,
    unmappedPlans
  };
};

/**
 * Cancel a Razorpay Subscription. cancelAtCycleEnd=true keeps the current
 * billing period active and stops future charges; omit/false cancels
 * immediately. NOTE: the SDK takes an options object ({cancel_at_cycle_end})
 * as the second arg, not a raw 0/1 int — verified against razorpay-node's
 * own docs (documents/subscription.md) before writing this.
 * Idempotent: a 400 "subscription already cancelled/completed" from
 * Razorpay is treated as success.
 */
const cancelRazorpaySubscription = async (razorpaySubscriptionId, { cancelAtCycleEnd } = {}) => {
  try {
    const cancelled = cancelAtCycleEnd
      ? await razorpay.subscriptions.cancel(razorpaySubscriptionId, { cancel_at_cycle_end: true })
      : await razorpay.subscriptions.cancel(razorpaySubscriptionId);
    logger.info(`Cancelled Razorpay subscription ${razorpaySubscriptionId} (cancelAtCycleEnd=${!!cancelAtCycleEnd})`);
    return cancelled;
  } catch (error) {
    const description = error?.error?.description || error?.description || '';
    if (/already\s+(cancelled|canceled)|already been cancelled|completed/i.test(description)) {
      logger.info(`Razorpay subscription ${razorpaySubscriptionId} already cancelled — treating as success`);
      return null;
    }
    throw error;
  }
};

/**
 * Fetch a Razorpay Subscription's current state. Used by admin diagnostics
 * and by the webhook handler when it needs to reconfirm state.
 */
const fetchRazorpaySubscription = async (razorpaySubscriptionId) => {
  return razorpay.subscriptions.fetch(razorpaySubscriptionId);
};

module.exports = {
  getKeyMode,
  getOrCreateRazorpayPlan,
  verifyRazorpayPlans,
  createRazorpaySubscription,
  cancelRazorpaySubscription,
  fetchRazorpaySubscription
};
