// Plan field rules shared by the admin create/update endpoints, the seed and the
// recompute script. plans.price is the MONTHLY price and the single source of truth;
// duration_options is derived from it (Monthly = price, longer tiers = price x months
// less the tier's stored discount %, rounded to the nearest rupee).

const DEFAULT_TIERS = [
  { months: 3, label: 'Quarterly', discount: 10 },
  { months: 6, label: 'Half-Yearly', discount: 20 },
  { months: 12, label: 'Yearly', discount: 30 }
];

const MAX_FEATURES = 30;
const MAX_FEATURE_LENGTH = 200;

const isPrice = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isDiscount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;

/**
 * Validates an admin-supplied durationOptions array against the plan's monthly price.
 * Returns an error message or null. Only months, label and discount are taken from
 * the tiers afterwards (amounts are recomputed), but the Monthly amount must agree.
 */
const validateDurationOptions = (options, price) => {
  if (!Array.isArray(options)) return 'durationOptions must be an array';
  const seen = new Set();
  for (const tier of options) {
    if (!tier || !Number.isInteger(tier.months) || tier.months < 1) {
      return 'every duration option needs an integer months >= 1';
    }
    if (seen.has(tier.months)) return `durationOptions has months=${tier.months} more than once`;
    seen.add(tier.months);
    if (tier.discount !== undefined && !isDiscount(tier.discount)) {
      return 'discount must be a number between 0 and 100';
    }
  }
  const monthly = options.find(t => t.months === 1);
  if (!monthly) return 'durationOptions must include a Monthly (months=1) option';
  if (Number(monthly.price) !== Number(price)) {
    return `the Monthly option price (${monthly.price}) must equal the plan price (${price})`;
  }
  return null;
};

/**
 * Derives the full duration_options array from the monthly price. Per-tier label and
 * discount come from `existingOptions` when present (so an admin's custom discounts
 * survive a price change), else from the 10/20/30 defaults. Extra tiers in
 * `existingOptions` (e.g. 2 months) are kept and recomputed. Monthly is always first.
 */
const buildDurationOptions = (price, existingOptions = []) => {
  const existing = Array.isArray(existingOptions) ? existingOptions : [];
  const byMonths = new Map(existing.filter(t => t && Number.isInteger(t.months)).map(t => [t.months, t]));
  const defaults = new Map(DEFAULT_TIERS.map(t => [t.months, t]));
  const months = [...new Set([...defaults.keys(), ...byMonths.keys()])].filter(m => m > 1).sort((a, b) => a - b);

  const tiers = months.map((m) => {
    const stored = byMonths.get(m);
    const def = defaults.get(m);
    const discount = stored && isDiscount(stored.discount) ? stored.discount : (def ? def.discount : 0);
    const label = (stored && stored.label) || (def ? def.label : `${m} Months`);
    return { months: m, price: Math.round(price * m * (1 - discount / 100)), label, discount };
  });
  return [{ months: 1, price, label: 'Monthly', discount: 0 }, ...tiers];
};

/** Validates features / isPopular / sortOrder / storageLimitMb / broadcastRecipientLimit. Returns an error message or null. */
const validatePlanExtras = ({ features, isPopular, sortOrder, storageLimitMb, broadcastRecipientLimit }) => {
  if (features !== undefined) {
    if (!Array.isArray(features) || features.length > MAX_FEATURES ||
        !features.every(f => typeof f === 'string' && f.trim().length > 0 && f.length <= MAX_FEATURE_LENGTH)) {
      return `features must be an array of up to ${MAX_FEATURES} non-empty strings (max ${MAX_FEATURE_LENGTH} characters each)`;
    }
  }
  if (isPopular !== undefined && typeof isPopular !== 'boolean') return 'isPopular must be true or false';
  if (sortOrder !== undefined && !Number.isInteger(sortOrder)) return 'sortOrder must be an integer';
  if (storageLimitMb !== undefined && (!Number.isInteger(storageLimitMb) || storageLimitMb < 0)) {
    return 'storageLimitMb must be a non-negative integer';
  }
  if (broadcastRecipientLimit !== undefined &&
      (!Number.isInteger(broadcastRecipientLimit) || (broadcastRecipientLimit < 1 && broadcastRecipientLimit !== -1))) {
    return 'broadcastRecipientLimit must be a whole number from 1, or -1 for unlimited';
  }
  return null;
};

/**
 * Public plans API shape (GET /api/subscription/plans): what the plan cards render and the purchase
 * flow needs. Whitelist, so a new plans column never leaks. Rule / customer limits and the payment-link
 * flag stay in the DB but are not advertised. Input is a plans row (snake_case); output is camelCase.
 */
const toPublicPlan = (p) => ({
  id: p.id,
  name: p.name,
  displayName: p.display_name,
  price: p.price,
  durationOptions: p.duration_options,
  isPopular: p.is_popular,
  features: p.features,
  sortOrder: p.sort_order,
  msgLimit: p.msg_limit,
  imagesPerReply: p.images_per_reply,
  videoPerReply: p.video_per_reply,
  carouselMaxCards: p.carousel_max_cards,
  storageLimitMb: p.storage_limit_mb,
  staffEnabled: p.staff_enabled,
  maxStaff: p.max_staff,
  bookingEnabled: p.booking_enabled,
  broadcastRecipientLimit: p.broadcast_recipient_limit
});

const cleanFeatures = (features) => features.map(f => f.trim());

/** Public plan ordering: sort_order ascending, then monthly price ascending. */
const comparePlans = (a, b) =>
  ((a.sort_order ?? a.sortOrder ?? 0) - (b.sort_order ?? b.sortOrder ?? 0)) ||
  (Number(a.price) - Number(b.price));

module.exports = {
  DEFAULT_TIERS,
  isPrice,
  validateDurationOptions,
  buildDurationOptions,
  validatePlanExtras,
  toPublicPlan,
  cleanFeatures,
  comparePlans
};
