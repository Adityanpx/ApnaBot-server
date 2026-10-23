const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const logger = require('../utils/logger');

/**
 * All business_categories rows, ordered for display (SuperAdmin category
 * management + categoryTemplate.controller.js's isKnownCategory check).
 */
const getAllCategories = async () => {
  try {
    const { data, error } = await supabase
      .from('business_categories')
      .select('*')
      .order('display_order', { ascending: true });
    if (error) throw error;

    return (data || []).map(toCamelCase);
  } catch (error) {
    logger.error('Error in getAllCategories:', error);
    throw error;
  }
};

/**
 * Categories currently offered at signup (business.controller.js#createBusiness
 * validation source, and the public /api/business-categories endpoint).
 */
const getEnabledCategories = async () => {
  try {
    const { data, error } = await supabase
      .from('business_categories')
      .select('*')
      .eq('is_enabled', true)
      .order('display_order', { ascending: true });
    if (error) throw error;

    return (data || []).map(toCamelCase);
  } catch (error) {
    logger.error('Error in getEnabledCategories:', error);
    throw error;
  }
};

/**
 * True only if value exists AND is enabled — used to gate business creation.
 */
const isEnabledCategory = async (value) => {
  try {
    const { data, error } = await supabase
      .from('business_categories')
      .select('value')
      .eq('value', value)
      .eq('is_enabled', true)
      .maybeSingle();
    if (error) throw error;

    return !!data;
  } catch (error) {
    logger.error('Error in isEnabledCategory:', error);
    throw error;
  }
};

/**
 * True if value exists at all, enabled or not — used by category-template
 * cloning, where SuperAdmin should be able to build a template for a
 * category before turning it on for signup.
 */
const isKnownCategory = async (value) => {
  try {
    const { data, error } = await supabase
      .from('business_categories')
      .select('value')
      .eq('value', value)
      .maybeSingle();
    if (error) throw error;

    return !!data;
  } catch (error) {
    logger.error('Error in isKnownCategory:', error);
    throw error;
  }
};

/**
 * SuperAdmin toggle — enable/disable a category for signup without touching
 * the database schema or code.
 */
const setCategoryEnabled = async (value, isEnabled) => {
  try {
    const { data, error } = await supabase
      .from('business_categories')
      .update({ is_enabled: isEnabled, updated_at: new Date().toISOString() })
      .eq('value', value)
      .select('*')
      .single();
    if (error) throw error;

    return toCamelCase(data);
  } catch (error) {
    logger.error('Error in setCategoryEnabled:', error);
    throw error;
  }
};

// camelCase API field -> business_categories column (only the fields SuperAdmin may set; `value` is
// written once, on create).
const CATEGORY_COLUMNS = {
  label: 'label',
  labelTranslations: 'label_translations',
  emoji: 'emoji',
  icon: 'icon',
  displayOrder: 'display_order',
  isEnabled: 'is_enabled'
};

const toCategoryRow = (fields) => {
  const row = {};
  for (const [key, column] of Object.entries(CATEGORY_COLUMNS)) {
    if (fields[key] !== undefined) row[column] = fields[key];
  }
  return row;
};

/**
 * SuperAdmin: add a category. A new category is just this row — the foreign keys from businesses /
 * flow_snapshots / category_whatsapp_flows / node_library_entries make it usable everywhere at once.
 * `fields` is already validated (businessCategoryAdmin.controller.js).
 */
const createCategory = async (value, fields) => {
  try {
    const { data, error } = await supabase
      .from('business_categories')
      .insert({ value, ...toCategoryRow(fields) })
      .select('*')
      .single();
    if (error) throw error;

    return toCamelCase(data);
  } catch (error) {
    logger.error('Error in createCategory:', error);
    throw error;
  }
};

/**
 * SuperAdmin: edit a category's display data / enabled flag. `value` is the primary key other tables
 * reference, so it is never changed here.
 */
const updateCategory = async (value, fields) => {
  try {
    const { data, error } = await supabase
      .from('business_categories')
      .update({ ...toCategoryRow(fields), updated_at: new Date().toISOString() })
      .eq('value', value)
      .select('*')
      .single();
    if (error) throw error;

    return toCamelCase(data);
  } catch (error) {
    logger.error('Error in updateCategory:', error);
    throw error;
  }
};

module.exports = {
  getAllCategories,
  getEnabledCategories,
  isEnabledCategory,
  isKnownCategory,
  setCategoryEnabled,
  createCategory,
  updateCategory
};
