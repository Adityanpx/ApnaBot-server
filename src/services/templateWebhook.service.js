// Template webhook events (message_template_status_update,
// message_template_quality_update, template_category_update) → the matching
// message_templates row. Kept out of webhook.controller.js so the lookup — in
// particular the business scoping of the name fallback — is testable.
const supabase = require('../config/supabase');
const logger = require('../utils/logger');

const STORED_CATEGORIES = ['MARKETING', 'UTILITY'];

/**
 * The one business whose WABA id this is (entry.id of a template event), or
 * null when it's unknown or shared by several businesses.
 */
const businessIdForWaba = async (wabaId) => {
  if (!wabaId) return null;
  const { data, error } = await supabase.from('businesses').select('id').eq('waba_id', String(wabaId)).limit(2);
  if (error) throw error;
  return data && data.length === 1 ? data[0].id : null;
};

/**
 * Updates the template an event is about. Looked up by Meta's template id;
 * failing that, by name (+ language when Meta sent it) among THAT WABA's
 * business's rows that were never given a meta_template_id.
 * @returns {Promise<{ row: Object|null, error: Object|null }>}
 */
const updateTemplateForWebhook = async ({ metaTemplateId, name, language, wabaId }, fields) => {
  if (metaTemplateId) {
    const { data, error } = await supabase.from('message_templates')
      .update(fields).eq('meta_template_id', metaTemplateId).select().maybeSingle();
    if (error) return { row: null, error };
    if (data) return { row: data, error: null };
  }

  if (name) {
    const businessId = await businessIdForWaba(wabaId);
    if (!businessId) {
      logger.warn('Template webhook: name fallback skipped - no single business for this WABA', { wabaId, name });
      return { row: null, error: null };
    }
    let query = supabase.from('message_templates')
      .update(fields).eq('business_id', businessId).eq('name', name).is('meta_template_id', null);
    if (language) query = query.eq('language', language);
    const { data, error } = await query.select().maybeSingle();
    if (error) return { row: null, error };
    return { row: data, error: null };
  }
  return { row: null, error: null };
};

/** The row fields a message_template_quality_update event changes, or null if it carries no score. */
const qualityUpdateFields = (value) => {
  const score = value && value.new_quality_score;
  return typeof score === 'string' && score ? { quality_score: score.toUpperCase() } : null;
};

/**
 * The row fields a template_category_update event changes, or null when it
 * names no stored category (e.g. a heads-up about a future change, or AUTHENTICATION).
 */
const categoryUpdateFields = (value) => {
  const category = value && typeof value.new_category === 'string' ? value.new_category.toUpperCase() : null;
  return STORED_CATEGORIES.includes(category) ? { category } : null;
};

module.exports = { updateTemplateForWebhook, qualityUpdateFields, categoryUpdateFields, businessIdForWaba };
