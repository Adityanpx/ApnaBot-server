// Write-path validation for catalogue collections and items (request camelCase in, snake_case columns
// out). Pure - no database - so it loads in tests without any config. The database re-checks the lengths
// (20261026120000_catalog.sql); these give the owner a readable message first.
const { isValidLanguageCode } = require('./languageCatalog');
const { textLength } = require('./textLimits');
const { UUID_RE } = require('./catalogIds');

const TITLE_MAX = 60;
const BODY_MAX = 160;
const BODY_MAX_LINE_BREAKS = 2;
const PRICE_LABEL_MAX = 30;
const DESIGN_NO_MAX = 40;
const PRICE_TEXT_MAX = 40;
const CAPTION_MAX = 500;
const MAX_ITEMS_PER_COLLECTION = 100;
const MAX_ITEMS_PER_REQUEST = 50;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const lineBreaks = (text) => (String(text).match(/\n/g) || []).length;

/**
 * { value } with the cleaned { <code>: text } map (blank entries dropped, null when empty) or { error }.
 * `check(text)` returns an error suffix for a bad text, or null.
 */
const cleanTranslations = (raw, name, max, { lineBreakLimit = null } = {}) => {
  if (raw === null || raw === undefined) return { value: null };
  if (!isObject(raw)) return { error: `${name} must be an object of { <language code>: text }.` };
  const out = {};
  for (const [code, text] of Object.entries(raw)) {
    if (!isValidLanguageCode(code)) return { error: `${name} has an invalid language code "${code}".` };
    if (typeof text !== 'string') return { error: `${name}.${code} must be a string.` };
    const trimmed = text.trim();
    if (textLength(trimmed) > max) return { error: `${name}.${code} must be ${max} characters or less.` };
    if (lineBreakLimit !== null && lineBreaks(trimmed) > lineBreakLimit) {
      return { error: `${name}.${code} can have at most ${lineBreakLimit} line breaks.` };
    }
    if (trimmed) out[code] = trimmed;
  }
  return { value: Object.keys(out).length > 0 ? out : null };
};

/** A text column: undefined = not supplied, null / '' = clear. { value } (string|null) or { error }. */
const cleanText = (raw, name, max, { lineBreakLimit = null } = {}) => {
  if (raw === null) return { value: null };
  if (typeof raw !== 'string') return { error: `${name} must be a string.` };
  const trimmed = raw.trim();
  if (textLength(trimmed) > max) return { error: `${name} must be ${max} characters or less.` };
  if (lineBreakLimit !== null && lineBreaks(trimmed) > lineBreakLimit) {
    return { error: `${name} can have at most ${lineBreakLimit} line breaks.` };
  }
  return { value: trimmed === '' ? null : trimmed };
};

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/**
 * @param {Object} input  request body (camelCase)
 * @param {{ partial: boolean }} opts  partial = update (only supplied keys), else create (title required)
 * @returns {{ value: Object } | { error: string }}  value = snake_case columns for the supplied keys
 */
const validateCollectionInput = (input, { partial }) => {
  if (!isObject(input)) return { error: 'Request body must be an object.' };
  const value = {};

  if (has(input, 'title') || !partial) {
    const title = cleanText(input.title === undefined ? null : input.title, 'title', TITLE_MAX);
    if (title.error) return { error: title.error };
    if (!title.value) return { error: 'title is required.' };
    value.title = title.value;
  }
  const texts = [
    ['body', 'body', BODY_MAX, { lineBreakLimit: BODY_MAX_LINE_BREAKS }],
    ['priceLabel', 'price_label', PRICE_LABEL_MAX, {}]
  ];
  for (const [key, column, max, opts] of texts) {
    if (!has(input, key)) continue;
    const cleaned = cleanText(input[key], key, max, opts);
    if (cleaned.error) return { error: cleaned.error };
    value[column] = cleaned.value;
  }
  const maps = [
    ['titleTranslations', 'title_translations', TITLE_MAX, {}],
    ['bodyTranslations', 'body_translations', BODY_MAX, { lineBreakLimit: BODY_MAX_LINE_BREAKS }],
    ['priceLabelTranslations', 'price_label_translations', PRICE_LABEL_MAX, {}]
  ];
  for (const [key, column, max, opts] of maps) {
    if (!has(input, key)) continue;
    const cleaned = cleanTranslations(input[key], key, max, opts);
    if (cleaned.error) return { error: cleaned.error };
    value[column] = cleaned.value;
  }
  if (has(input, 'coverMediaId')) {
    if (input.coverMediaId !== null && !isUuid(input.coverMediaId)) return { error: 'coverMediaId must be a media library id or null.' };
    value.cover_media_id = input.coverMediaId;
  }
  if (has(input, 'isActive')) {
    if (typeof input.isActive !== 'boolean') return { error: 'isActive must be true or false.' };
    value.is_active = input.isActive;
  }
  return { value };
};

/** Same contract for an item. create requires mediaId. */
const validateItemInput = (input, { partial }) => {
  if (!isObject(input)) return { error: 'Each item must be an object.' };
  const value = {};
  if (has(input, 'mediaId') || !partial) {
    if (!isUuid(input.mediaId)) return { error: 'mediaId must be a media library id.' };
    value.media_id = input.mediaId;
  }
  const texts = [
    ['designNo', 'design_no', DESIGN_NO_MAX],
    ['priceText', 'price_text', PRICE_TEXT_MAX],
    ['caption', 'caption', CAPTION_MAX]
  ];
  for (const [key, column, max] of texts) {
    if (!has(input, key)) continue;
    const cleaned = cleanText(input[key], key, max);
    if (cleaned.error) return { error: cleaned.error };
    value[column] = cleaned.value;
  }
  if (has(input, 'captionTranslations')) {
    const cleaned = cleanTranslations(input.captionTranslations, 'captionTranslations', CAPTION_MAX);
    if (cleaned.error) return { error: cleaned.error };
    value.caption_translations = cleaned.value;
  }
  return { value };
};

module.exports = {
  TITLE_MAX, BODY_MAX, BODY_MAX_LINE_BREAKS, PRICE_LABEL_MAX, DESIGN_NO_MAX, PRICE_TEXT_MAX, CAPTION_MAX,
  MAX_ITEMS_PER_COLLECTION, MAX_ITEMS_PER_REQUEST,
  isObject, isUuid, cleanTranslations, cleanText, validateCollectionInput, validateItemInput
};
