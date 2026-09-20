const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const businessService = require('../services/business.service');
const { invalidateRulesCache } = require('../services/chatbot.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * GET /api/admin/business-category-templates
 * List all business_category_templates rows (booking-form field templates,
 * one per category) for the SuperAdmin UI.
 */
const getBusinessCategoryTemplates = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('business_category_templates')
      .select('*')
      .order('business_category', { ascending: true });
    if (error) throw error;

    return successResponse(res, 200, { templates: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getBusinessCategoryTemplates:', error);
    next(error);
  }
};

/**
 * POST /api/admin/business-category-templates/:category/apply/:businessId
 * Copies the template's flow_fields verbatim into that business's
 * businesses.flow_fields column via a direct update — booking-form fields
 * only. Does NOT touch flow_nodes/flow_edges (the conversation graph); that
 * has its own SuperAdmin template mechanism (flow_snapshots
 * is_category_template rows, /api/admin/category-templates).
 */
const applyBusinessCategoryTemplate = async (req, res, next) => {
  try {
    const { category, businessId } = req.params;

    const { data: template, error: templateErr } = await supabase
      .from('business_category_templates')
      .select('flow_fields')
      .eq('business_category', category)
      .maybeSingle();
    if (templateErr) throw templateErr;
    if (!template) return errorResponse(res, 404, `No template found for category "${category}"`);

    const { data: business, error: businessErr } = await supabase
      .from('businesses').select('id').eq('id', businessId).maybeSingle();
    if (businessErr) throw businessErr;
    if (!business) return errorResponse(res, 404, 'Business not found');

    const flowFields = await businessService.updateFlowFields(businessId, template.flow_fields);

    await invalidateRulesCache(businessId);

    return successResponse(res, 200, { flowFields: flowFields || [] }, `Template "${category}" applied to business ${businessId}`);
  } catch (error) {
    logger.error('Error in applyBusinessCategoryTemplate:', error);
    next(error);
  }
};

module.exports = { getBusinessCategoryTemplates, applyBusinessCategoryTemplate };
