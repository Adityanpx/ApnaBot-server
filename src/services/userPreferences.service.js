// Meta's user_preferences webhook: a customer stopped or resumed MARKETING
// messages from a business (category marketing_messages, value stop|resume).
// Kept apart from marketingBlock.service.js, which the send paths load, because
// resolving the business needs the tenant cache (Redis).
const supabase = require('../config/supabase');
const tenantService = require('./tenant.service');
const marketingBlock = require('./marketingBlock.service');
const logger = require('../utils/logger');

const PREFERENCE_CATEGORY = 'marketing_messages';

/** 919876543210 -> ...3210: enough to recognise a number in a log, not to copy it. */
const tail = (number) => `...${String(number === null || number === undefined ? '' : number).slice(-4)}`;

/**
 * One `user_preferences` webhook change. Safe whether or not the field is
 * subscribed (nothing arrives until it is) and for any payload shape: an
 * unrecognised or unknown wa_id is logged and ignored, other preference
 * categories are skipped.
 * @param {Object} value changes[].value
 */
const handleUserPreferences = async (value) => {
  try {
    const prefs = Array.isArray(value && value.user_preferences) ? value.user_preferences : [];
    if (prefs.length === 0) return;
    const phoneNumberId = value.metadata && value.metadata.phone_number_id;
    if (!phoneNumberId) {
      logger.warn('user_preferences: no phone_number_id in the payload - ignored');
      return;
    }
    const tenant = await tenantService.resolveBusinessByPhoneNumberId(phoneNumberId);
    if (!tenant) {
      logger.warn(`user_preferences: no active, connected business for phoneNumberId ${phoneNumberId} - ignored`);
      return;
    }

    for (const pref of prefs) {
      if (!pref || pref.category !== PREFERENCE_CATEGORY) continue;
      if (pref.value !== 'stop' && pref.value !== 'resume') continue;
      if (typeof pref.wa_id !== 'string' || !pref.wa_id) continue;

      const { data: customer, error } = await supabase.from('customers').select('id')
        .eq('business_id', tenant.businessId).eq('whatsapp_number', pref.wa_id).maybeSingle();
      if (error) {
        logger.error('user_preferences: customer lookup failed', error);
        continue;
      }
      if (!customer) {
        logger.info(`user_preferences: no customer ${tail(pref.wa_id)} for business ${tenant.businessId} - ignored`);
        continue;
      }
      const ts = Number(pref.timestamp);
      const at = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date();
      if (pref.value === 'stop') await marketingBlock.blockMarketing({ businessId: tenant.businessId, customerId: customer.id, at });
      else await marketingBlock.resumeMarketing({ businessId: tenant.businessId, customerId: customer.id, at });
    }
  } catch (err) {
    logger.error('Error handling a user_preferences webhook:', err);
  }
};

module.exports = { handleUserPreferences };
