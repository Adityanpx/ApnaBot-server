const supabase = require('../config/supabase');
const { errorResponse } = require('../utils/response');
const { isTravelFeaturedCategory } = require('../config/categoryFeatures');

/**
 * Every business is on the graph booking engine now, so this no longer gates
 * on businesses.booking_engine (kept as a no-op rather than removed outright
 * — full removal, alongside dropping the column itself, happens in the later
 * DB-migration cleanup step). Still attaches req.graphBusiness so handlers
 * don't each re-query business_category/servedCities/disabledBookingFields,
 * which the reserved-field-key guard, the servedCities-options guard, and
 * the disabledBookingFields overlay all separately need.
 *
 * servedCities moved to business_travel_settings (migration 20260921130000)
 * — only queried for travel-featured categories, since this middleware runs
 * on every /api/flow-graph request regardless of business category and most
 * businesses never have a non-empty servedCities to begin with.
 */
const requireGraphEngine = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { data: business, error } = await supabase
      .from('businesses')
      .select('business_category, sub_categories, disabled_booking_fields')
      .eq('id', businessId)
      .maybeSingle();
    if (error) throw error;
    if (!business) {
      return errorResponse(res, 404, 'Business not found');
    }

    let servedCities = [];
    if (isTravelFeaturedCategory(business.business_category, business.sub_categories)) {
      const { data: travelSettings, error: travelSettingsErr } = await supabase
        .from('business_travel_settings')
        .select('served_cities')
        .eq('business_id', businessId)
        .maybeSingle();
      if (travelSettingsErr) throw travelSettingsErr;
      servedCities = travelSettings?.served_cities || [];
    }

    req.graphBusiness = {
      businessCategory: business.business_category,
      servedCities,
      disabledBookingFields: business.disabled_booking_fields || []
    };

    next();
  } catch (error) {
    next(error);
  }
};

module.exports = { requireGraphEngine };
