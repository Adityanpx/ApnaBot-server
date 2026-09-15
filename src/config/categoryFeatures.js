// Per-category default feature flags applied at business creation time,
// keyed by the same category strings businesses.business_category (and
// multi_brand's sub_categories) allow. Each entry maps to a boolean column
// that already exists and is actually read elsewhere (enable_fleet,
// enable_distance_fares, round_trip_driver_da_enabled) — deliberately not
// including flags like "service areas" or "round trip" since there's no
// businesses column or read-site for those today (served_cities is a city
// list, not a toggle; round trip is just a tripType option the owner
// configures in their own flow graph). Add a real feature key here only once
// there's a column and a call site to back it.
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
  tax_consultant: []
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

module.exports = { CATEGORY_DEFAULT_FEATURES, computeFeatureFlags };
