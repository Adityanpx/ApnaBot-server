// How many recipients one broadcast may have: min(plan limit, MAX_BROADCAST_RECIPIENTS).
// plans.broadcast_recipient_limit -1 = unlimited (the env cap alone applies). A business with no
// active/trial subscription also gets the env cap only, so no live account loses a send on deploy.
// One place for sendBroadcast, the catalogue broadcast (preview + send) and audience-summary.
const config = require('../config/env');
const logger = require('../utils/logger');
const { getCurrentSubscriptionRow } = require('./currentSubscription.service');

const PLAN_BROADCAST_LIMIT = 'PLAN_BROADCAST_LIMIT';

/**
 * Pure. @param {Object|null} plan a plans row (snake_case) or null
 * @returns {{ cap: number, planLimited: boolean, planName: string|null }}
 *   planLimited = the plan's limit is what sets the cap (it is below the env cap).
 */
const capFromPlan = (plan, envCap) => {
  const limit = plan ? Number.parseInt(plan.broadcast_recipient_limit, 10) : NaN;
  if (!Number.isFinite(limit) || limit < 0) return { cap: envCap, planLimited: false, planName: null };
  return { cap: Math.min(limit, envCap), planLimited: limit < envCap, planName: plan.display_name || plan.name || null };
};

/**
 * Effective cap for a business. A failed subscription read falls back to the env cap (and logs):
 * a transient DB error must not block every broadcast.
 */
const getBroadcastCap = async (businessId) => {
  const envCap = config.MAX_BROADCAST_RECIPIENTS;
  const { data, error } = await getCurrentSubscriptionRow(businessId, { statuses: ['active', 'trial'] });
  if (error) {
    logger.warn(`broadcast cap: could not read the subscription for ${businessId}, using the env cap`, { message: error.message });
    return capFromPlan(null, envCap);
  }
  return capFromPlan(data?.plan || null, envCap);
};

const planLimitMessage = (cap) => `This plan sends a broadcast to up to ${cap} customers. Upgrade for more.`;

/** The existing env-cap refusal, unchanged wording. */
const envLimitMessage = (count, cap) =>
  `This broadcast has ${count} eligible recipients, which exceeds the current limit of ${cap}. Contact support to send larger broadcasts.`;

/**
 * Null when `count` fits, else { status, message, code, limit }. Plan-set cap -> 403 PLAN_BROADCAST_LIMIT;
 * env-set cap -> the previous 400 TOO_MANY_RECIPIENTS.
 */
const overCapRefusal = (count, { cap, planLimited, planName }) => {
  if (count <= cap) return null;
  if (planLimited) return { status: 403, message: planLimitMessage(cap), code: PLAN_BROADCAST_LIMIT, limit: cap, plan: planName };
  return { status: 400, message: envLimitMessage(count, cap), code: 'TOO_MANY_RECIPIENTS', limit: cap, plan: null };
};

module.exports = { PLAN_BROADCAST_LIMIT, capFromPlan, getBroadcastCap, overCapRefusal, planLimitMessage };
