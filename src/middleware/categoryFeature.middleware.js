const supabase = require('../config/supabase');
const categoryFeatureService = require('../services/categoryFeature.service');
const { errorResponse } = require('../utils/response');

/**
 * Lets a request through only while `feature` is switched on (Super Admin →
 * Business Settings → <category> → Features) for the business's category.
 * Otherwise 404 — the same response these routes gave when they weren't
 * mounted at all, so the web app's availability probe (GET /bot-settings)
 * keeps working unchanged. Must run after protect + requireBusiness.
 */
const requireCategoryFeature = (feature) => async (req, res, next) => {
  try {
    const { data: business, error } = await supabase
      .from('businesses').select('business_category').eq('id', req.user.businessId).maybeSingle();
    if (error) throw error;
    if (!business || !(await categoryFeatureService.isEnabled(business.business_category, feature))) {
      return errorResponse(res, 404, 'Not found');
    }
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = { requireCategoryFeature };
