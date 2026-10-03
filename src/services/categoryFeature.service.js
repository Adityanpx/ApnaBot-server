// Super Admin on/off feature switches per business category
// (category_features, 20260929140000_category_features.sql; no row = off),
// with optional per-business overrides (business_features,
// 20261002120000_business_features.sql; no row = follow the category).
// Not to be confused with config/categoryFeatures.js, which holds per-
// category DEFAULT values for business_travel_settings columns.
const supabase = require('../config/supabase');

// Every switchable feature, with the categories it applies to — a list, or
// '*' for every category (including ones added later from Super Admin). The
// DB check constraints (category_features.feature, business_features.feature)
// must list the same keys.
const ALL_CATEGORIES = '*';
const FEATURES = {
  bot_builder: {
    label: 'Bot Builder & Courses',
    description: 'Lets these businesses manage their courses and build their WhatsApp bot from settings (Courses and Bot Builder pages).',
    categories: ['coaching']
  },
  followups: {
    label: 'Follow-up automations',
    description: 'Lets these businesses set up automatic follow-up messages to their customers (enquiry nudges, review requests, payment reminders, win-back).',
    categories: ALL_CATEGORIES
  },
  opt_in_links: {
    label: 'Opt-in links & QR poster',
    description: 'Lets these businesses create WhatsApp links / QR posters that ask customers to opt in to offers with a Yes/No button.',
    categories: ALL_CATEGORIES
  },
  contact_import: {
    label: 'Contact import & groups',
    description: 'Lets these businesses import contacts from a CSV / Excel file or Google Sheet, group their customers, and broadcast to a group.',
    categories: ALL_CATEGORIES
  }
};

/** Whether `feature` exists and applies to businesses in `category`. */
const appliesTo = (category, feature) => {
  const definition = FEATURES[feature];
  if (!definition) return false;
  return definition.categories === ALL_CATEGORIES || definition.categories.includes(category);
};

/** The category switch alone (no row = off). */
const isCategoryEnabled = async (category, feature) => {
  const { data, error } = await supabase
    .from('category_features').select('is_enabled')
    .eq('category', category).eq('feature', feature).maybeSingle();
  if (error) throw error;
  return !!data?.is_enabled;
};

/** The business's override: true / false, or null when it follows its category. */
const getBusinessOverride = async (businessId, feature) => {
  const { data, error } = await supabase
    .from('business_features').select('is_enabled')
    .eq('business_id', businessId).eq('feature', feature).maybeSingle();
  if (error) throw error;
  return data ? data.is_enabled : null;
};

/**
 * Whether `feature` is on for a business in `category`: never for a category
 * the feature doesn't apply to; otherwise the business's own override when it
 * has one (businessId given), else the category switch. Read on every call (no
 * cache) so a Super Admin toggle applies immediately on every server
 * instance; callers are dashboard-frequency routes — the webhook only calls
 * it for 'opt_in_links', on a message whose JOIN code matched an active link
 * or on a language-picker tap (webhook.controller.js).
 */
const isEnabled = async (category, feature, businessId = null) => {
  if (!appliesTo(category, feature)) return false;
  if (businessId) {
    const override = await getBusinessOverride(businessId, feature);
    if (override !== null) return override;
  }
  return isCategoryEnabled(category, feature);
};

/** Every feature that applies to `category`, with its current state. */
const listForCategory = async (category) => {
  const applicable = Object.entries(FEATURES).filter(([key]) => appliesTo(category, key));
  if (applicable.length === 0) return [];
  const { data, error } = await supabase
    .from('category_features').select('feature, is_enabled, updated_at').eq('category', category);
  if (error) throw error;
  const rows = new Map((data || []).map(r => [r.feature, r]));
  return applicable.map(([key, f]) => ({
    feature: key,
    label: f.label,
    description: f.description,
    isEnabled: !!rows.get(key)?.is_enabled,
    updatedAt: rows.get(key)?.updated_at || null
  }));
};

/** Turn a feature on/off for a category (upsert). */
const setEnabled = async (category, feature, isEnabledValue) => {
  const { error } = await supabase
    .from('category_features')
    .upsert({ category, feature, is_enabled: isEnabledValue }, { onConflict: 'category,feature' });
  if (error) throw error;
};

/**
 * Every feature that applies to this business's category: the category
 * switch, the business's override (true/false/null) and the result.
 */
const listForBusiness = async (businessId, category) => {
  const categoryList = await listForCategory(category);
  if (categoryList.length === 0) return [];
  const { data, error } = await supabase
    .from('business_features').select('feature, is_enabled, updated_at').eq('business_id', businessId);
  if (error) throw error;
  const overrides = new Map((data || []).map(r => [r.feature, r]));
  return categoryList.map(f => {
    const row = overrides.get(f.feature);
    const override = row ? row.is_enabled : null;
    return {
      feature: f.feature,
      label: f.label,
      description: f.description,
      categoryEnabled: f.isEnabled,
      override,
      isEnabled: override !== null ? override : f.isEnabled,
      overrideUpdatedAt: row?.updated_at || null
    };
  });
};

/** Set (true/false) or remove (null) a business's override. */
const setBusinessOverride = async (businessId, feature, override) => {
  if (override === null) {
    const { error } = await supabase.from('business_features').delete().eq('business_id', businessId).eq('feature', feature);
    if (error) throw error;
    return;
  }
  const { error } = await supabase
    .from('business_features')
    .upsert({ business_id: businessId, feature, is_enabled: override }, { onConflict: 'business_id,feature' });
  if (error) throw error;
};

module.exports = { FEATURES, appliesTo, isEnabled, listForCategory, setEnabled, listForBusiness, setBusinessOverride };
