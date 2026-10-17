const supabase = require('../config/supabase');
const { invalidateRulesCache } = require('./chatbot.service');
const { deleteBusinessGraphRows } = require('./flowSnapshot.service');
const { importTemplateIntoBusiness } = require('./categoryTemplateImport.service');
const tenantService = require('./tenant.service');
const logger = require('../utils/logger');

const FALLBACK_CATEGORY = 'general';

// Active default category template for a category, or null.
const findDefaultTemplate = async (category) => {
  const { data, error } = await supabase
    .from('flow_snapshots').select('*')
    .eq('is_category_template', true).eq('is_default', true).eq('is_active', true)
    .eq('category', category)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

// business_category_templates.flow_fields for a category, or null.
const findFlowFieldsTemplate = async (category) => {
  const { data, error } = await supabase
    .from('business_category_templates').select('flow_fields')
    .eq('business_category', category)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

// The business's own category's row, else the 'general' one.
const withFallback = async (category, finder) => {
  const own = category ? await finder(category) : null;
  if (own || category === FALLBACK_CATEGORY) return own;
  return finder(FALLBACK_CATEGORY);
};

/**
 * Seeds a brand-new business with its category's default setup: the default
 * category template's graph (flow_nodes/flow_edges, same import as the owner's
 * "Import starter template") and the category's booking-form flow_fields.
 * Falls back to the 'general' category for each when the business's own
 * category has none.
 *
 * Idempotent and never overwriting: a business that already has ANY flow_nodes
 * is left completely alone (graph, flow_fields and all). Never throws - a
 * failure is logged and the business simply starts empty, as it did before
 * this existed. A failed graph write is rolled back (best effort) so the
 * business is never left with a half-copied graph.
 *
 * @param {string} businessId
 * @returns {Promise<{applied:boolean, reason?:string, templateId?:string, templateName?:string, flowFieldsApplied?:boolean}>}
 */
const applyDefaultSetup = async (businessId) => {
  let reachedWrites = false;
  let phoneNumberId = null;
  try {
    const { data: business, error: businessErr } = await supabase
      .from('businesses').select('id, business_category, flow_fields, phone_number_id')
      .eq('id', businessId).maybeSingle();
    if (businessErr) throw businessErr;
    if (!business) return { applied: false, reason: 'business_not_found' };
    phoneNumberId = business.phone_number_id || null;

    const { data: existingNodes, error: nodesErr } = await supabase
      .from('flow_nodes').select('id').eq('business_id', businessId).limit(1);
    if (nodesErr) throw nodesErr;
    if ((existingNodes || []).length > 0) return { applied: false, reason: 'already_has_nodes' };

    reachedWrites = true;
    const category = business.business_category;
    const result = { applied: false, reason: 'no_default_template', flowFieldsApplied: false };

    const template = await withFallback(category, findDefaultTemplate);
    if (template) {
      try {
        await importTemplateIntoBusiness(businessId, template, { snapshotName: `Default ${template.name}` });
      } catch (importErr) {
        try { await deleteBusinessGraphRows(businessId); } catch (rollbackErr) {
          logger.error('applyDefaultSetup: rollback of a partial graph failed', { businessId, error: rollbackErr.message });
        }
        throw importErr;
      }
      const { error: seedErr } = await supabase
        .from('businesses').update({ seeded_from_template_name: template.name }).eq('id', businessId);
      if (seedErr) throw seedErr;
      Object.assign(result, { applied: true, reason: undefined, templateId: template.id, templateName: template.name });
    }

    const hasFlowFields = Array.isArray(business.flow_fields) && business.flow_fields.length > 0;
    if (!hasFlowFields) {
      const fieldsTemplate = await withFallback(category, findFlowFieldsTemplate);
      const fields = fieldsTemplate && fieldsTemplate.flow_fields;
      if (Array.isArray(fields) && fields.length > 0) {
        const { error: fieldsErr } = await supabase
          .from('businesses').update({ flow_fields: fields }).eq('id', businessId);
        if (fieldsErr) throw fieldsErr;
        result.flowFieldsApplied = true;
        result.applied = true;
        result.reason = undefined;
      }
    }

    logger.info('applyDefaultSetup: done', { businessId, category, ...result });
    return result;
  } catch (error) {
    logger.error('applyDefaultSetup failed - business starts empty', { businessId, error: error.message });
    return { applied: false, reason: 'error' };
  } finally {
    if (reachedWrites) {
      await invalidateRulesCache(businessId);
      // A brand-new business has no WhatsApp number yet, so there is normally no tenant entry.
      if (phoneNumberId) {
        try { await tenantService.invalidateTenantCache(phoneNumberId); } catch (cacheErr) {
          logger.error('applyDefaultSetup: tenant cache invalidation failed', { businessId, error: cacheErr.message });
        }
      }
    }
  }
};

module.exports = { applyDefaultSetup };
