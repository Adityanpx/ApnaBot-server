const supabase = require('../config/supabase');
const categoryFeatureService = require('../services/categoryFeature.service');
const { errorResponse } = require('../utils/response');

/**
 * Lets a request through only while `feature` is switched on (Super Admin →
 * Business Settings → <category> → Features) for the business's category.
 * Otherwise 404 (errors.code 'FEATURE_DISABLED' when the switch is off) — the same response these routes gave when they weren't
 * mounted at all, so the web app's availability probe (GET /bot-settings)
 * keeps working unchanged. Must run after protect + requireBusiness.
 * `off` ({ code, message }) lets a route that has its own screen say which switch is off: the 404 then carries
 * that message and errors { code, feature } instead of the generic ones (the catalogue broadcast uses it).
 */
const requireCategoryFeature = (feature, off = null) => async (req, res, next) => {
  try {
    const { data: business, error } = await supabase
      .from('businesses').select('business_category').eq('id', req.user.businessId).maybeSingle();
    if (error) throw error;
    // The business's own override (Super Admin → Businesses → Features) wins
    // over its category's switch.
    if (!business) return errorResponse(res, 404, 'Not found');
    if (!(await categoryFeatureService.isEnabled(business.business_category, feature, req.user.businessId))) {
      if (off) return errorResponse(res, 404, off.message, { code: off.code, feature });
      return errorResponse(res, 404, 'Not found', { code: 'FEATURE_DISABLED' });
    }
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = { requireCategoryFeature };
