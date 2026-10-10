// A customer who stopped MARKETING messages from a business
// (customers.marketing_blocked_at, 20261014130000_customers_marketing_blocked.sql).
// Meta tells us two ways: a send/status fails with 131050, or - before any send -
// the user_preferences webhook (userPreferences.service.js).
// The block applies exactly where the marketing rule does (requiresMarketingOptIn);
// it is separate from opted_out_at, which is the customer's STOP.
//
// Cleared ONLY by a user_preferences "resume", the customer's START message
// (webhook.controller.js) or the owner (customer.controller.js#resumeMarketing).
//
// Every write is scoped to ONE business and never inserts, so an unknown
// customer or number matches nothing. Errors are logged, never thrown: a signal
// must not fail the send or the webhook it rides on.
const supabase = require('../config/supabase');
const logger = require('../utils/logger');

const MARKETING_STOPPED_CODE = 131050;

const isMarketingStoppedCode = (code) => Number(code) === MARKETING_STOPPED_CODE;

/**
 * Stamp marketing_blocked_at on one customer of one business. The first stamp
 * wins, so a repeat (a retried webhook, a second failed send) is a no-op.
 * Name the customer by id or, failing that, by whatsapp number.
 * @param {{ businessId: string, customerId?: string|null, whatsappNumber?: string|null, at?: string|Date }} target
 */
const blockMarketing = async ({ businessId, customerId = null, whatsappNumber = null, at = new Date() }) => {
  try {
    if (!businessId || (!customerId && !whatsappNumber)) return;
    let query = supabase.from('customers')
      .update({ marketing_blocked_at: new Date(at).toISOString() })
      .eq('business_id', businessId)
      .is('marketing_blocked_at', null);
    query = customerId ? query.eq('id', customerId) : query.eq('whatsapp_number', whatsappNumber);
    const { error } = await query;
    if (error) logger.error(`Could not record that a customer stopped marketing for business ${businessId}`, error);
  } catch (err) {
    logger.error(`Could not record that a customer stopped marketing for business ${businessId}`, err);
  }
};

/**
 * The customer resumed marketing at `at`. Only a stamp OLDER than that is cleared,
 * so a late-arriving resume cannot undo a newer stop.
 */
const resumeMarketing = async ({ businessId, customerId, at = new Date() }) => {
  try {
    const { error } = await supabase.from('customers')
      .update({ marketing_blocked_at: null })
      .eq('business_id', businessId)
      .eq('id', customerId)
      .lt('marketing_blocked_at', new Date(at).toISOString());
    if (error) logger.error(`Could not record that a customer resumed marketing for business ${businessId}`, error);
  } catch (err) {
    logger.error(`Could not record that a customer resumed marketing for business ${businessId}`, err);
  }
};

module.exports = {
  MARKETING_STOPPED_CODE,
  isMarketingStoppedCode,
  blockMarketing,
  resumeMarketing
};
