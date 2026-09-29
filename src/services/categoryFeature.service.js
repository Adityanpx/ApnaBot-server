// Super Admin on/off feature switches per business category
// (category_features, 20260929140000_category_features.sql). No row = off.
// Not to be confused with config/categoryFeatures.js, which holds per-
// category DEFAULT values for business_travel_settings columns.
const supabase = require('../config/supabase');

// Every switchable feature, with the categories it applies to. The DB check
// constraint (category_features.feature) must list the same keys.
const FEATURES = {
  bot_builder: {
    label: 'Bot Builder & Courses',
    description: 'Lets these businesses manage their courses and build their WhatsApp bot from settings (Courses and Bot Builder pages).',
    categories: ['coaching']
  }
};

/**
 * Whether `feature` is switched on for `category`. Read on every call (no
 * cache) so a Super Admin toggle applies immediately on every server
 * instance; callers are dashboard-frequency routes, not the webhook.
 */
const isEnabled = async (category, feature) => {
  if (!FEATURES[feature] || !FEATURES[feature].categories.includes(category)) return false;
  const { data, error } = await supabase
    .from('category_features').select('is_enabled')
    .eq('category', category).eq('feature', feature).maybeSingle();
  if (error) throw error;
  return !!data?.is_enabled;
};

/** Every feature that applies to `category`, with its current state. */
const listForCategory = async (category) => {
  const applicable = Object.entries(FEATURES).filter(([, f]) => f.categories.includes(category));
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

module.exports = { FEATURES, isEnabled, listForCategory, setEnabled };
