const supabase = require('../config/supabase');
const businessCategoryService = require('../services/businessCategory.service');
const categoryFeatureService = require('../services/categoryFeature.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * GET /api/admin/category-features/:category
 * The feature switches that apply to this category, with their state.
 * An empty list means the category has no switchable features.
 */
const getCategoryFeatures = async (req, res, next) => {
  try {
    const { category } = req.params;
    if (!(await businessCategoryService.isKnownCategory(category))) {
      return errorResponse(res, 400, `Invalid category: ${category}`);
    }
    const features = await categoryFeatureService.listForCategory(category);
    return successResponse(res, 200, { features });
  } catch (error) {
    logger.error('Error in getCategoryFeatures:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/category-features/:category/:feature
 * Body: { isEnabled: boolean }. Applies immediately to every business in
 * the category — no redeploy.
 */
const setCategoryFeature = async (req, res, next) => {
  try {
    const { category, feature } = req.params;
    const { isEnabled } = req.body || {};
    if (typeof isEnabled !== 'boolean') return errorResponse(res, 400, 'isEnabled must be true or false');
    const definition = categoryFeatureService.FEATURES[feature];
    if (!definition) return errorResponse(res, 404, `Unknown feature: ${feature}`);
    if (!categoryFeatureService.appliesTo(category, feature)) {
      return errorResponse(res, 400, `"${definition.label}" is not available for the ${category} category`);
    }
    await categoryFeatureService.setEnabled(category, feature, isEnabled);
    logger.info(`Category feature ${feature} ${isEnabled ? 'enabled' : 'disabled'} for ${category} by superadmin`, {
      userId: req.user.userId
    });
    const features = await categoryFeatureService.listForCategory(category);
    return successResponse(res, 200, { features }, `${definition.label} ${isEnabled ? 'switched on' : 'switched off'}`);
  } catch (error) {
    logger.error('Error in setCategoryFeature:', error);
    next(error);
  }
};

const loadBusinessCategory = async (businessId) => {
  const { data, error } = await supabase
    .from('businesses').select('id, business_category').eq('id', businessId).maybeSingle();
  if (error) throw error;
  return data;
};

/**
 * GET /api/admin/businesses/:id/features
 * The feature switches that apply to this business's category, each with
 * categoryEnabled, the business's override (true/false/null = follows the
 * category) and the resulting isEnabled.
 */
const getBusinessFeatures = async (req, res, next) => {
  try {
    const business = await loadBusinessCategory(req.params.id);
    if (!business) return errorResponse(res, 404, 'Business not found');
    const features = await categoryFeatureService.listForBusiness(business.id, business.business_category);
    return successResponse(res, 200, { features });
  } catch (error) {
    logger.error('Error in getBusinessFeatures:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/businesses/:id/features/:feature
 * Body: { override: true | false | null } — on / off for this business
 * only, or null to follow its category again. Applies immediately.
 */
const setBusinessFeature = async (req, res, next) => {
  try {
    const { id, feature } = req.params;
    const { override } = req.body || {};
    if (override !== null && typeof override !== 'boolean') return errorResponse(res, 400, 'override must be true, false or null');
    const definition = categoryFeatureService.FEATURES[feature];
    if (!definition) return errorResponse(res, 404, `Unknown feature: ${feature}`);
    const business = await loadBusinessCategory(id);
    if (!business) return errorResponse(res, 404, 'Business not found');
    if (!categoryFeatureService.appliesTo(business.business_category, feature)) {
      return errorResponse(res, 400, `"${definition.label}" is not available for the ${business.business_category} category`);
    }
    await categoryFeatureService.setBusinessOverride(id, feature, override);
    logger.info(`Business feature ${feature} override ${override === null ? 'removed' : override ? 'on' : 'off'} for business ${id} by superadmin`, {
      userId: req.user.userId
    });
    const features = await categoryFeatureService.listForBusiness(id, business.business_category);
    const message = override === null ? `${definition.label} now follows the category` : `${definition.label} ${override ? 'switched on' : 'switched off'} for this business`;
    return successResponse(res, 200, { features }, message);
  } catch (error) {
    logger.error('Error in setBusinessFeature:', error);
    next(error);
  }
};

module.exports = { getCategoryFeatures, setCategoryFeature, getBusinessFeatures, setBusinessFeature };
