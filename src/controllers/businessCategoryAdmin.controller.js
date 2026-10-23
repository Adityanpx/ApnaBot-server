const businessCategoryService = require('../services/businessCategory.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * GET /api/admin/business-categories
 * All categories, enabled or not — SuperAdmin management UI.
 */
const getCategories = async (req, res, next) => {
  try {
    const categories = await businessCategoryService.getAllCategories();
    return successResponse(res, 200, { categories });
  } catch (error) {
    logger.error('Error in getCategories:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/business-categories/:value/toggle
 * Body: { isEnabled }
 */
const toggleCategory = async (req, res, next) => {
  try {
    const { value } = req.params;
    const { isEnabled } = req.body;

    if (typeof isEnabled !== 'boolean') {
      return errorResponse(res, 400, 'isEnabled must be a boolean');
    }

    const categories = await businessCategoryService.getAllCategories();
    const exists = categories.some((category) => category.value === value);
    if (!exists) {
      return errorResponse(res, 404, `Category "${value}" not found`);
    }

    const updated = await businessCategoryService.setCategoryEnabled(value, isEnabled);
    return successResponse(res, 200, updated, `Category "${value}" ${isEnabled ? 'enabled' : 'disabled'}`);
  } catch (error) {
    logger.error('Error in toggleCategory:', error);
    next(error);
  }
};

const VALUE_PATTERN = /^[a-z][a-z0-9_]{2,39}$/;
const LABEL_MAX = 40;
const EMOJI_MAX = 8;
const ICON_MAX = 40;
const DISPLAY_ORDER_MAX = 100000;
const DISPLAY_ORDER_STEP = 10;
const TRANSLATION_LANGUAGES = ['hi', 'mr'];
const PG_UNIQUE_VIOLATION = '23505';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validates the body of POST / and PUT /:value (value itself is checked by the callers).
 * `isCreate` makes label required. Unknown keys are ignored; every known key present must be valid.
 * Emoji length counts characters (code points), not UTF-16 units, so a flag or skin-tone emoji is one.
 * Empty translations are dropped so clients fall back to `label` for that language.
 * @returns {{ error: string }|{ fields: Object }}
 */
const validateCategoryFields = (body, { isCreate }) => {
  const fields = {};

  if (body.label !== undefined || isCreate) {
    if (typeof body.label !== 'string' || !body.label.trim()) return { error: 'label is required' };
    if (body.label.trim().length > LABEL_MAX) return { error: `label must be ${LABEL_MAX} characters or less` };
    fields.label = body.label.trim();
  }

  if (body.emoji !== undefined) {
    if (typeof body.emoji !== 'string') return { error: 'emoji must be a string' };
    if (Array.from(body.emoji.trim()).length > EMOJI_MAX) return { error: `emoji must be ${EMOJI_MAX} characters or less` };
    fields.emoji = body.emoji.trim();
  }

  // Length only: the icon column holds a lucide icon name for most rows but a raw emoji for older ones
  // (e.g. hotel), and the admin UI echoes the stored value back on edit.
  if (body.icon !== undefined) {
    if (typeof body.icon !== 'string') return { error: 'icon must be a string' };
    if (body.icon.trim().length > ICON_MAX) return { error: `icon must be ${ICON_MAX} characters or less` };
    fields.icon = body.icon.trim();
  }

  if (body.labelTranslations !== undefined) {
    if (!isPlainObject(body.labelTranslations)) return { error: 'labelTranslations must be an object like {"hi": "...", "mr": "..."}' };
    const translations = {};
    for (const [language, text] of Object.entries(body.labelTranslations)) {
      if (!TRANSLATION_LANGUAGES.includes(language)) {
        return { error: `labelTranslations may only have: ${TRANSLATION_LANGUAGES.join(', ')} (got "${language}")` };
      }
      if (typeof text !== 'string') return { error: `labelTranslations.${language} must be a string` };
      if (text.trim().length > LABEL_MAX) return { error: `labelTranslations.${language} must be ${LABEL_MAX} characters or less` };
      if (text.trim()) translations[language] = text.trim();
    }
    fields.labelTranslations = translations;
  }

  if (body.displayOrder !== undefined) {
    if (!Number.isInteger(body.displayOrder) || body.displayOrder < 0 || body.displayOrder > DISPLAY_ORDER_MAX) {
      return { error: `displayOrder must be an integer between 0 and ${DISPLAY_ORDER_MAX}` };
    }
    fields.displayOrder = body.displayOrder;
  }

  if (body.isEnabled !== undefined) {
    if (typeof body.isEnabled !== 'boolean') return { error: 'isEnabled must be a boolean' };
    fields.isEnabled = body.isEnabled;
  }

  return { fields };
};

/**
 * POST /api/admin/business-categories
 * Body: { value, label, labelTranslations?, emoji?, icon?, displayOrder?, isEnabled? }
 * A category is just this row (no migration / deploy). isEnabled defaults to false so a half-made
 * category never shows at signup; displayOrder defaults to after the last existing category.
 */
const createCategory = async (req, res, next) => {
  try {
    const { value } = req.body;
    if (typeof value !== 'string' || !VALUE_PATTERN.test(value)) {
      return errorResponse(res, 400, 'value must be 3-40 characters: lowercase letters, digits and underscores, starting with a letter');
    }

    const checked = validateCategoryFields(req.body, { isCreate: true });
    if (checked.error) return errorResponse(res, 400, checked.error);

    const categories = await businessCategoryService.getAllCategories();
    if (categories.some((category) => category.value === value)) {
      return errorResponse(res, 409, `Category "${value}" already exists`);
    }

    const fields = { isEnabled: false, ...checked.fields };
    if (fields.displayOrder === undefined) {
      fields.displayOrder = Math.max(0, ...categories.map((category) => category.displayOrder || 0)) + DISPLAY_ORDER_STEP;
    }

    let created;
    try {
      created = await businessCategoryService.createCategory(value, fields);
    } catch (insertError) {
      // Two concurrent creates can both pass the existence check above; the loser hits the primary key.
      if (insertError && insertError.code === PG_UNIQUE_VIOLATION) {
        return errorResponse(res, 409, `Category "${value}" already exists`);
      }
      throw insertError;
    }
    return successResponse(res, 201, created, `Category "${value}" created`);
  } catch (error) {
    logger.error('Error in createCategory:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/business-categories/:value
 * Body: any of { label, labelTranslations, emoji, icon, displayOrder, isEnabled }. `value` is the key other
 * tables reference and cannot be changed (a body.value that differs from the URL is rejected).
 */
const updateCategory = async (req, res, next) => {
  try {
    const { value } = req.params;
    if (req.body.value !== undefined && req.body.value !== value) {
      return errorResponse(res, 400, 'value cannot be changed');
    }

    const checked = validateCategoryFields(req.body, { isCreate: false });
    if (checked.error) return errorResponse(res, 400, checked.error);
    if (Object.keys(checked.fields).length === 0) {
      return errorResponse(res, 400, 'Nothing to update: send at least one of label, labelTranslations, emoji, icon, displayOrder, isEnabled');
    }

    const categories = await businessCategoryService.getAllCategories();
    if (!categories.some((category) => category.value === value)) {
      return errorResponse(res, 404, `Category "${value}" not found`);
    }

    const updated = await businessCategoryService.updateCategory(value, checked.fields);
    return successResponse(res, 200, updated, `Category "${value}" updated`);
  } catch (error) {
    logger.error('Error in updateCategory:', error);
    next(error);
  }
};

module.exports = { getCategories, toggleCategory, createCategory, updateCategory };
