// What we know about problems with a business's WhatsApp account that only
// Meta can tell us - today, a missing/failing payment method (error 131042).
// Meta documents no field that reports payment status, so this is reactive:
// a failed send or failed status webhook sets businesses.payment_issue_at
// (20261014120000_business_payment_issue.sql), and it is cleared when a
// broadcast sent after it is delivered, or by the owner.
//
// Every function here swallows its own errors (logged): recording a problem
// must never fail a send or a webhook.
const supabase = require('../config/supabase');
const logger = require('../utils/logger');

const PAYMENT_ISSUE_CODE = 131042;

const isPaymentIssueCode = (code) => Number(code) === PAYMENT_ISSUE_CODE;

/**
 * Remember a payment-method failure. The first failure wins ("since" stays
 * put), so a repeat is a no-op.
 * @param {string} businessId
 * @param {string|Date} [at] when the failure happened; now by default
 */
const recordPaymentIssue = async (businessId, at = new Date()) => {
  try {
    const { error } = await supabase.from('businesses')
      .update({ payment_issue_at: new Date(at).toISOString(), payment_issue_code: PAYMENT_ISSUE_CODE })
      .eq('id', businessId)
      .is('payment_issue_at', null);
    if (error) logger.error(`Could not record the payment issue for business ${businessId}`, error);
  } catch (err) {
    logger.error(`Could not record the payment issue for business ${businessId}`, err);
  }
};

/**
 * A message sent at `sentAt` was delivered: that proves payment works only if
 * it was sent AFTER the problem began, so only then is the flag cleared. One
 * atomic conditional update - a business with no flag matches nothing.
 */
const clearPaymentIssueIfSentAfter = async (businessId, sentAt) => {
  try {
    const { error } = await supabase.from('businesses')
      .update({ payment_issue_at: null, payment_issue_code: null })
      .eq('id', businessId)
      .lt('payment_issue_at', new Date(sentAt).toISOString());
    if (error) logger.error(`Could not clear the payment issue for business ${businessId}`, error);
  } catch (err) {
    logger.error(`Could not clear the payment issue for business ${businessId}`, err);
  }
};

/**
 * The owner says it is fixed.
 * @returns {Promise<boolean>} false when it could not be cleared
 */
const dismissPaymentIssue = async (businessId) => {
  try {
    const { error } = await supabase.from('businesses')
      .update({ payment_issue_at: null, payment_issue_code: null })
      .eq('id', businessId);
    if (error) {
      logger.error(`Could not dismiss the payment issue for business ${businessId}`, error);
      return false;
    }
    return true;
  } catch (err) {
    logger.error(`Could not dismiss the payment issue for business ${businessId}`, err);
    return false;
  }
};

/**
 * Business response data with paymentIssue { since, code } | null in place of
 * the raw columns (never returned). Takes the camelCase business-response
 * object and returns it.
 */
const withPaymentIssue = (businessData) => {
  const { paymentIssueAt, paymentIssueCode } = businessData;
  delete businessData.paymentIssueAt;
  delete businessData.paymentIssueCode;
  businessData.paymentIssue = paymentIssueAt
    ? { since: paymentIssueAt, code: paymentIssueCode ?? PAYMENT_ISSUE_CODE }
    : null;
  return businessData;
};

module.exports = {
  PAYMENT_ISSUE_CODE,
  isPaymentIssueCode,
  recordPaymentIssue,
  clearPaymentIssueIfSentAfter,
  dismissPaymentIssue,
  withPaymentIssue
};
