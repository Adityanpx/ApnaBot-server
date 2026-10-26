// Unlisted-business requests: an owner whose business is not in the category list signs up as
// 'general' and says what they are (POST /api/business requestedCategoryText). This records the
// request and tells the Averix team; Super Admin works the list (routes/businessRequest.routes.js).
const supabase = require('../config/supabase');
const config = require('../config/env');
const { toCamelCase } = require('../utils/caseConvert');
const logger = require('../utils/logger');

const STATUSES = ['new', 'contacted', 'set_up'];
const REQUESTED_TEXT_MAX = 100;
const NOTES_MAX = 2000;

/** Where the "new request" mail goes: the env override if set, else every active superadmin user. */
const getNotifyEmails = async () => {
  const override = (config.BUSINESS_REQUEST_NOTIFY_EMAIL || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (override.length > 0) return override;
  const { data, error } = await supabase.from('users').select('email').eq('role', 'superadmin').eq('is_active', true);
  if (error) throw error;
  return (data || []).map((u) => u.email).filter(Boolean);
};

/**
 * Records the request and mails the team. NEVER throws or rejects: signup must not fail because
 * of this. The row is written first; a failed mail (or recipient lookup) is only logged, and the
 * request still shows in Super Admin.
 * @param {{ business: { id: string, name: string }, userId: string, requestedText: string, contactPhone: string }} args
 * @returns {Promise<{ recorded: boolean, emailsSent: number }>}
 */
const recordRequest = async ({ business, userId, requestedText, contactPhone }) => {
  const result = { recorded: false, emailsSent: 0 };
  let owner = null;
  try {
    const { data, error: ownerErr } = await supabase.from('users').select('name, email').eq('id', userId).maybeSingle();
    if (ownerErr) throw ownerErr;
    owner = data;
  } catch (error) {
    logger.error(`recordRequest: could not read the owner of business ${business.id}:`, error);
  }

  try {
    const { error } = await supabase.from('business_requests').insert({
      business_id: business.id,
      requested_text: requestedText,
      contact_phone: contactPhone,
      owner_name: owner ? owner.name : null,
      owner_email: owner ? owner.email : null
    });
    if (error) throw error;
    result.recorded = true;
  } catch (error) {
    logger.error(`recordRequest: could not save the request for business ${business.id}:`, error);
  }

  try {
    const recipients = await getNotifyEmails();
    if (recipients.length === 0) {
      logger.warn(`recordRequest: no recipient for the business request of ${business.id} (no active superadmin, no BUSINESS_REQUEST_NOTIFY_EMAIL)`);
    } else {
      // Lazy: email.service builds its Brevo client on import, which signup tests should not need.
      result.emailsSent = await require('./email.service').sendBusinessRequestEmail(recipients, {
        businessName: business.name,
        requestedText,
        contactPhone,
        ownerName: owner ? owner.name : '',
        ownerEmail: owner ? owner.email : ''
      });
    }
  } catch (error) {
    logger.error(`recordRequest: could not notify the team about business ${business.id}:`, error);
  }
  return result;
};

/** Adds the business name / category to request rows. Owner name and email are the signup snapshot. */
const toListItems = async (rows) => {
  const ids = [...new Set(rows.map((r) => r.business_id))];
  let businessesById = {};
  if (ids.length > 0) {
    const { data, error } = await supabase.from('businesses').select('id, name, business_category').in('id', ids);
    if (error) throw error;
    businessesById = Object.fromEntries((data || []).map((b) => [b.id, b]));
  }
  return rows.map((r) => {
    const business = businessesById[r.business_id];
    return {
      ...toCamelCase(r),
      businessName: business ? business.name : null,
      businessCategory: business ? business.business_category : null
    };
  });
};

/** @returns {Promise<{ requests: object[], total: number }>} newest first */
const listRequests = async ({ status, page, limit }) => {
  const from = (page - 1) * limit;
  let query = supabase.from('business_requests').select('*', { count: 'exact' });
  if (status) query = query.eq('status', status);
  const { data, error, count } = await query.order('created_at', { ascending: false }).range(from, from + limit - 1);
  if (error) throw error;
  return { requests: await toListItems(data || []), total: count || 0 };
};

/** @returns {Promise<object|null>} the updated request, or null when the id does not exist */
const updateRequest = async (id, changes) => {
  const { data, error } = await supabase.from('business_requests').update(changes).eq('id', id).select().maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return (await toListItems([data]))[0];
};

module.exports = {
  STATUSES,
  REQUESTED_TEXT_MAX,
  NOTES_MAX,
  getNotifyEmails,
  recordRequest,
  listRequests,
  updateRequest
};
