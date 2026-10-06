const Razorpay = require('razorpay');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const subscriptionService = require('../services/subscription.service');
const usageService = require('../services/usage.service');
const razorpaySubscriptionsService = require('../services/razorpaySubscriptions.service');
const { successResponse, errorResponse } = require('../utils/response');
const config = require('../config/env');
const logger = require('../utils/logger');
const { toCamelCase } = require('../utils/caseConvert');

const razorpay = new Razorpay({
  key_id: config.RAZORPAY_KEY_ID,
  key_secret: config.RAZORPAY_KEY_SECRET
});

/**
 * GET /api/subscription
 * Get current plan + usage + expiry for the business
 */
const getCurrentSubscription = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const [subResult, usage] = await Promise.all([
      supabase
        .from('subscriptions')
        .select('*, plan:plans(*)')
        .eq('business_id', businessId)
        .in('status', ['active', 'trial'])
        .maybeSingle(),
      usageService.getUsageForBusiness(businessId)
    ]);

    if (subResult.error) throw subResult.error;
    const subscription = subResult.data
      ? { ...toCamelCase(subResult.data), plan: toCamelCase(subResult.data.plan) }
      : null;

    return successResponse(res, 200, {
      subscription: subscription || null,
      plan: subscription?.plan || null,
      usage,
      isActive: !!subscription
    });
  } catch (error) {
    logger.error('Error in getCurrentSubscription:', error);
    next(error);
  }
};

/**
 * GET /api/subscription/plans
 * List all available active plans
 */
const getPlans = async (req, res, next) => {
  try {
    const { data: plans, error } = await supabase
      .from('plans')
      .select('*')
      .eq('is_active', true)
      .order('price', { ascending: true });
    if (error) throw error;
    return successResponse(res, 200, { plans: (plans || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getPlans:', error);
    next(error);
  }
};

/**
 * POST /api/subscription/create
 * Create a Razorpay order for subscription payment
 */
const createSubscriptionOrder = async (req, res, next) => {
  try {
    const { planId, durationMonths = 1 } = req.body;
    const businessId = req.user.businessId;

    if (!planId) return errorResponse(res, 400, 'planId is required');

    const { data: plan } = await supabase.from('plans').select('*').eq('id', planId).maybeSingle();
    if (!plan || !plan.is_active) return errorResponse(res, 404, 'Plan not found');

    const durationOption = (plan.duration_options || []).find(d => d.months === durationMonths);
    if (!durationOption) return errorResponse(res, 400, `Duration of ${durationMonths} months is not available for this plan`);

    const order = await razorpay.orders.create({
      amount: durationOption.price * 100, // paise
      currency: 'INR',
      receipt: `sub_${Date.now()}`, // Max 40 chars: "sub_" + 13 digits = 17 chars
      notes: {
        businessId: businessId.toString(),
        planId: planId.toString(),
        planName: plan.name,
        durationMonths: durationMonths.toString()
      }
    });

    logger.info(`Razorpay order created: ${order.id} for business ${businessId}, ${durationMonths} months`);
    return successResponse(res, 200, {
      orderId: order.id,
      keyId: config.RAZORPAY_KEY_ID,
      amount: order.amount,
      currency: order.currency,
      plan: {
        _id: plan.id,
        name: plan.name,
        displayName: plan.display_name,
        price: durationOption.price
      },
      durationMonths
    });
  } catch (error) {
    logger.error('Error in createSubscriptionOrder:', error);
    next(error);
  }
};

/**
 * POST /api/subscription/verify
 * Verify Razorpay payment signature and activate subscription
 */
const verifyAndActivate = async (req, res, next) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      planId,
      durationMonths = 1
    } = req.body;
    const businessId = req.user.businessId;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !planId) {
      return errorResponse(res, 400, 'Missing payment verification fields');
    }

    // Verify Razorpay signature
    const expectedSig = crypto
      .createHmac('sha256', config.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      logger.warn(`Invalid payment signature for business ${businessId}`);
      return errorResponse(res, 400, 'Invalid payment signature');
    }

    // Activate subscription
    const subscription = await subscriptionService.createSubscription(businessId, planId, {
      status: 'active',
      razorpayPaymentId: razorpay_payment_id,
      razorpaySubscriptionId: razorpay_order_id,
      durationMonths
    });

    const { data: populated, error } = await supabase
      .from('subscriptions')
      .select('*, plan:plans(*)')
      .eq('id', subscription.id)
      .single();
    if (error) throw error;

    logger.info(`Subscription activated for business ${businessId}, payment ${razorpay_payment_id}`);
    const camelPopulated = { ...toCamelCase(populated), plan: toCamelCase(populated.plan) };
    return successResponse(res, 200, { subscription: camelPopulated }, 'Subscription activated successfully');
  } catch (error) {
    logger.error('Error in verifyAndActivate:', error);
    next(error);
  }
};

/**
 * POST /api/subscription/cancel
 * Disable auto-renew. Subscription stays active until endDate. For an
 * autopay subscription, also cancels at Razorpay (cancel_at_cycle_end) so
 * money stops being pulled — the DB-only flag flip alone was a real gap for
 * autopay subs, since Razorpay would keep charging otherwise.
 */
const cancelAutoRenew = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { data: sub } = await supabase
      .from('subscriptions').select('*').eq('business_id', businessId)
      .in('status', ['active', 'past_due']).maybeSingle();
    if (!sub) return errorResponse(res, 404, 'No active subscription found');
    if (!sub.auto_renew) return errorResponse(res, 400, 'Auto-renew is already disabled');

    // If this is a real autopay subscription, cancel it at Razorpay.
    // cancel_at_cycle_end = true keeps the current period active; Razorpay
    // will not attempt further charges but the customer keeps access until
    // end_date. For legacy one-time subs (is_autopay=false), skip the API
    // call — there's nothing to cancel on Razorpay's side.
    if (sub.is_autopay && sub.razorpay_subscription_id) {
      try {
        await razorpaySubscriptionsService.cancelRazorpaySubscription(
          sub.razorpay_subscription_id,
          { cancelAtCycleEnd: true }
        );
      } catch (err) {
        logger.error(`Razorpay cancel failed for sub ${sub.razorpay_subscription_id}:`, err);
        return errorResponse(res, 502, 'Could not cancel with payment provider. Try again.');
      }
    }

    const { data: updated, error } = await supabase
      .from('subscriptions').update({ auto_renew: false }).eq('id', sub.id).select().single();
    if (error) throw error;

    logger.info(`Auto-renew cancelled for business ${businessId} (autopay=${sub.is_autopay})`);
    const camelUpdated = toCamelCase(updated);
    return successResponse(
      res, 200, camelUpdated,
      `Auto-renew cancelled. Subscription active until ${new Date(updated.end_date).toDateString()}`
    );
  } catch (error) {
    logger.error('Error in cancelAutoRenew:', error);
    next(error);
  }
};

/**
 * POST /api/subscription/autopay/create
 * Body: { planId }
 * Response: { subscriptionId, shortUrl, razorpayKeyId, mandatedAmountPaise }
 *
 * Only supports monthly (durationMonths = 1). Callers who pass durationMonths
 * != 1 should go through the existing /create (one-time Orders) endpoint.
 */
const createAutopaySubscription = async (req, res, next) => {
  try {
    const { planId } = req.body;
    const businessId = req.user.businessId;

    if (!planId) return errorResponse(res, 400, 'planId is required');

    const { data: plan } = await supabase.from('plans').select('*').eq('id', planId).maybeSingle();
    if (!plan || !plan.is_active) return errorResponse(res, 404, 'Plan not found');

    // Find the monthly duration option; refuse if the admin has not configured one
    const monthly = (plan.duration_options || []).find(d => d.months === 1);
    if (!monthly) return errorResponse(res, 400, 'This plan has no monthly option configured');

    const pricePaise = Math.round(Number(monthly.price) * 100);
    if (!Number.isInteger(pricePaise) || pricePaise <= 0) {
      return errorResponse(res, 400, 'Invalid monthly price on plan');
    }

    // 1. Get-or-create the Razorpay Plan for this (plan, price) combo.
    const razorpayPlanId = await razorpaySubscriptionsService
      .getOrCreateRazorpayPlan(plan, pricePaise);

    // 2. Create the Razorpay Subscription. total_count = 120 gives ~10 years
    //    of monthly cycles, effectively "until cancelled".
    const rzpSub = await razorpaySubscriptionsService.createRazorpaySubscription({
      razorpayPlanId,
      totalCount: 120,
      startAt: null,
      notes: {
        apnabot_business_id: businessId,
        apnabot_plan_id: planId
      }
    });

    // 3. Insert the pending DB row. We create as 'active' (not pending) so
    //    tenant cache / feature gating already works in the ~seconds between
    //    checkout completion and the webhook. The webhook will re-set the
    //    correct end_date and status.
    const dbRow = await subscriptionService.createAutopaySubscriptionRow(
      businessId,
      planId,
      { razorpaySubscriptionId: rzpSub.id, mandatedAmountPaise: pricePaise }
    );

    logger.info(`Autopay subscription created: rzp=${rzpSub.id}, db=${dbRow.id}, business=${businessId}`);

    return successResponse(res, 200, {
      subscriptionId: rzpSub.id,
      shortUrl: rzpSub.short_url,          // fallback if Checkout modal fails
      razorpayKeyId: config.RAZORPAY_KEY_ID,
      mandatedAmountPaise: pricePaise
    });
  } catch (error) {
    logger.error('Error in createAutopaySubscription:', error);
    next(error);
  }
};

/**
 * POST /api/subscription/autopay/verify
 * Body: { razorpay_payment_id, razorpay_subscription_id, razorpay_signature }
 *
 * Confirms the mandate authorization payment. The actual "subscription is
 * live" state transition happens on the subscription.activated webhook —
 * this endpoint just verifies the signature and returns 200 so the UI
 * can show a "processing" state.
 */
const verifyAutopayAuthorization = async (req, res, next) => {
  try {
    const {
      razorpay_payment_id,
      razorpay_subscription_id,
      razorpay_signature
    } = req.body;
    const businessId = req.user.businessId;

    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      return errorResponse(res, 400, 'Missing authorization verification fields');
    }

    // NOTE: subscription-authorization signature is over payment_id|subscription_id
    // (NOT order_id|payment_id as for one-time orders).
    const expectedSig = crypto
      .createHmac('sha256', config.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      logger.warn(`Invalid autopay authorization signature for business ${businessId}, sub ${razorpay_subscription_id}`);
      return errorResponse(res, 400, 'Invalid authorization signature');
    }

    // Confirm the DB row belongs to this business (defense against a user
    // pasting someone else's subscription id).
    const { data: dbSub, error: dbErr } = await supabase
      .from('subscriptions')
      .select('id, business_id')
      .eq('razorpay_subscription_id', razorpay_subscription_id)
      .maybeSingle();
    if (dbErr) throw dbErr;
    if (!dbSub || dbSub.business_id !== businessId) {
      logger.warn(`Autopay verify: subscription ${razorpay_subscription_id} not found or belongs to different business`);
      return errorResponse(res, 404, 'Subscription not found');
    }

    logger.info(`Autopay authorization verified: sub=${razorpay_subscription_id}, business=${businessId}`);
    return successResponse(res, 200, { pending: true },
      'Authorization received. Subscription will activate momentarily.');
  } catch (error) {
    logger.error('Error in verifyAutopayAuthorization:', error);
    next(error);
  }
};

module.exports = {
  getCurrentSubscription,
  getPlans,
  createSubscriptionOrder,
  verifyAndActivate,
  cancelAutoRenew,
  createAutopaySubscription,
  verifyAutopayAuthorization
};
