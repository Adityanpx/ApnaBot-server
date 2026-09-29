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
    if (!definition.categories.includes(category)) {
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

module.exports = { getCategoryFeatures, setCategoryFeature };
