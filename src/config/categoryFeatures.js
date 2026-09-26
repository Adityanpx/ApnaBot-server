// Per-category default feature flags applied at business creation time,
// keyed by the same category strings businesses.business_category (and
// multi_brand's sub_categories) allow. Each entry maps to a boolean column
// on business_travel_settings (migration 20260921130000) that already
// exists (enable_fleet, enable_distance_fares, round_trip_driver_da_enabled).
// enable_distance_fares and round_trip_driver_da_enabled are read by
// booking.service.js's fare estimate; enable_fleet is stored UI state only —
// nothing server-side (vehicle routes, booking engine, webhook) reads it, and
// it's only returned by the API for travel-featured categories (see
// isTravelFeaturedCategory / business.service.js#attachTravelSettings), so
// the web toggle is travel-only too. Deliberately not including flags like
// "service areas" or "round trip" since there's no column or read-site for
// those today (served_cities is a city list, not a toggle; round trip is
// just a tripType option the owner configures in their own flow graph). Add
// a real feature key here only once there's a column and a call site to
// back it.
//
// Only 'travels' and 'cab' get non-empty defaults today — both are
// vehicle-for-hire businesses with a per-trip distance fare model. Every
// other category defaults to no category-driven features; owners can still
// flip any of these manually via PUT /business, unchanged.
const CATEGORY_DEFAULT_FEATURES = {
  tailor: [],
  salon: [],
  garage: [],
  cab: ['fleet', 'distanceFares', 'driverDA'],
  coaching: [],
  gym: [],
  medical: [],
  general: [],
  photographer: [],
  caterer: [],
  tutor: [],
  jeweller: [],
  boutique: [],
  grocery: [],
  bakery: [],
  electronics_repair: [],
  real_estate: [],
  driving_school: [],
  travels: ['fleet', 'distanceFares', 'driverDA'],
  software_it: [],
  maha_eseva_kendra: [],
  tax_consultant: [],
  hotel: []
};

/**
 * @param {{ businessCategory: string, subCategories?: string[] }} business
 * @returns {{ enable_fleet: boolean, enable_distance_fares: boolean, round_trip_driver_da_enabled: boolean }}
 */
const computeFeatureFlags = ({ businessCategory, subCategories }) => {
  const categories = businessCategory === 'multi_brand'
    ? (subCategories || [])
    : [businessCategory];

  const features = new Set();
  categories.forEach((cat) =>
    (CATEGORY_DEFAULT_FEATURES[cat] || []).forEach((f) => features.add(f))
  );

  return {
    enable_fleet: features.has('fleet'),
    enable_distance_fares: features.has('distanceFares'),
    round_trip_driver_da_enabled: features.has('driverDA')
  };
};

// Categories business_travel_settings actually applies to. Kept as its own
// list (rather than derived from CATEGORY_DEFAULT_FEATURES) since a category
// could in principle gain a non-travel feature key in the future without
// meaning it should get a travel-settings row attached at read time.
const TRAVEL_FEATURED_CATEGORIES = ['travels', 'cab'];

/**
 * True when this business's own category, or — for multi_brand — any of its
 * subCategories, is one of the vehicle-for-hire categories
 * business_travel_settings applies to. Same categories-array resolution as
 * computeFeatureFlags, so a multi_brand business with 'travels'/'cab' as a
 * sub-category is treated consistently by both signup-time defaults and
 * runtime read/write gating.
 * @param {string} businessCategory
 * @param {string[]} [subCategories]
 * @returns {boolean}
 */
const isTravelFeaturedCategory = (businessCategory, subCategories) => {
  const categories = businessCategory === 'multi_brand' ? (subCategories || []) : [businessCategory];
  return categories.some((c) => TRAVEL_FEATURED_CATEGORIES.includes(c));
};

module.exports = { CATEGORY_DEFAULT_FEATURES, computeFeatureFlags, TRAVEL_FEATURED_CATEGORIES, isTravelFeaturedCategory };
