// src/services/supersedeSubscriptions.service.js
// Retire a business's other live subscription rows when a new one takes over,
// cancelling any Razorpay autopay mandate so the customer isn't billed twice.
// Shared by the autopay path (payment.service subscription.activated) and the
// one-time path (subscription.service createSubscription). Dependency-light
// (supabase + logger only) so both can import it without a cycle.
const supabase = require('../config/supabase');
const logger = require('../utils/logger');

/**
 * Mark the business's other rows in `statuses` 'cancelled', cancelling each
 * autopay row's Razorpay mandate first (immediately — the new subscription
 * replaces it). A Razorpay failure is logged loudly but does not stop the DB
 * row being cancelled; the mandate would then need cancelling by hand (the
 * subscription.charged handler also cancels it if it ever charges again).
 *
 * @param {string} businessId
 * @param {Object} [opts]
 * @param {string|null} [opts.keepId] - row to leave alone (omit when the new row isn't inserted yet)
 * @param {string[]} [opts.statuses] - which row statuses to retire
 */
const supersedeOtherSubscriptions = async (businessId, { keepId = null, statuses = ['active', 'trial'] } = {}) => {
  let query = supabase.from('subscriptions').select('id, is_autopay, razorpay_subscription_id')
    .eq('business_id', businessId)
    .in('status', statuses);
  if (keepId) query = query.neq('id', keepId);
  const { data: others, error } = await query;
  if (error) throw error;

  for (const old of others || []) {
    if (old.is_autopay && old.razorpay_subscription_id) {
      try {
        // Lazy: that module builds a Razorpay client at load, which throws
        // without keys — and this file is imported by unrelated code and tests.
        const razorpaySubscriptionsService = require('./razorpaySubscriptions.service');
        await razorpaySubscriptionsService.cancelRazorpaySubscription(old.razorpay_subscription_id);
      } catch (rzpErr) {
        logger.error(`Could not cancel superseded Razorpay subscription ${old.razorpay_subscription_id} (db ${old.id}) — cancel it manually to stop billing:`, rzpErr);
      }
    }
    const { error: cancelErr } = await supabase.from('subscriptions')
      .update({ status: 'cancelled' }).eq('id', old.id);
    if (cancelErr) throw cancelErr;
    logger.info(`Subscription ${old.id} superseded${keepId ? ` by ${keepId}` : ''} for business ${businessId}`);
  }
};

module.exports = { supersedeOtherSubscriptions };
