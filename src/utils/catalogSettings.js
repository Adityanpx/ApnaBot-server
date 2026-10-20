// The catalogue settings object (catalogs.settings, jsonb): defaults, merging a PUT patch and validation.
// Pure - the checks that need the database (does the order node exist, does a keyword clash with another
// reply) live in services/catalog.service.js.
//
//   enabled                       master switch (off = the catalogue replies with emptyText)
//   keywords[] / aliases[]        what a customer types; keywords[0] becomes the node's keyword, the rest and
//                                 the aliases its hindi_aliases (matched by the normal keyword matcher,
//                                 Unicode rules included)
//   text(+Translations)           the message above the carousel (<= 1024); null = built-in default
//   viewButtonLabel / orderButtonLabel / showMoreLabel / menuLabel (+Translations)   <= 20; null = built-in
//   photosPerPage 1..10, photoStyle 'plain' | 'order_button'
//   orderAction                   null (no Order buttons) | { type: 'booking_trigger'|'web_form_trigger', nodeId }
//                                 | { type: 'message', text?, textTranslations? }
//   addToMainMenu                 add a row / button to the 'hi' menu node
//   emptyText(+Translations)      sent when the catalogue is off or has nothing to show; null = built-in
const { LIMITS, textLength } = require('./textLimits');
const { normalizeUnicode } = require('./textNormalize');
const { cleanTranslations, cleanText, isObject, isUuid } = require('./catalogValidation');
const { RESERVED_KEYWORDS } = require('../services/languagePicker.service');

const KEYWORD_MIN = 3;
const KEYWORD_MAX = 40;
const MAX_KEYWORDS = 10;
const MAX_ALIASES = 10;
const TEXT_MAX = LIMITS.INTERACTIVE_BODY;
const LABEL_MAX = LIMITS.BUTTON_TITLE;
const PHOTO_STYLES = ['plain', 'order_button'];
const ORDER_TYPES = ['booking_trigger', 'web_form_trigger', 'message'];

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  keywords: ['catalogue'],
  aliases: [],
  text: null, textTranslations: null,
  viewButtonLabel: null, viewButtonLabelTranslations: null,
  orderButtonLabel: null, orderButtonLabelTranslations: null,
  showMoreLabel: null, showMoreLabelTranslations: null,
  menuLabel: null, menuLabelTranslations: null,
  photosPerPage: 10,
  photoStyle: 'plain',
  orderAction: null,
  addToMainMenu: false,
  emptyText: null, emptyTextTranslations: null
});

// [key, max, kind]: kind 'text' (a message) or 'label' (a button title)
const TEXT_FIELDS = [
  ['text', TEXT_MAX], ['viewButtonLabel', LABEL_MAX], ['orderButtonLabel', LABEL_MAX],
  ['showMoreLabel', LABEL_MAX], ['menuLabel', LABEL_MAX], ['emptyText', TEXT_MAX]
];
const ALLOWED_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));

/** Stored settings over the defaults; unknown stored keys are dropped. */
const resolveSettings = (stored) => {
  const out = { ...DEFAULT_SETTINGS, keywords: [...DEFAULT_SETTINGS.keywords], aliases: [] };
  if (isObject(stored)) {
    for (const key of ALLOWED_KEYS) if (stored[key] !== undefined) out[key] = stored[key];
  }
  return out;
};

/** Lower-cased, trimmed, inner spaces collapsed - how a keyword is stored and compared. */
const normalizeWord = (word) => String(word).trim().replace(/\s+/g, ' ').toLowerCase();

const wordList = (raw, name, max) => {
  if (!Array.isArray(raw) || !raw.every(w => typeof w === 'string')) return { error: `${name} must be an array of words.` };
  const words = [];
  for (const entry of raw) {
    const word = normalizeWord(entry);
    if (!word) continue;
    const length = Array.from(word).length;
    if (length < KEYWORD_MIN || length > KEYWORD_MAX) {
      return { error: `Each word in ${name} must be ${KEYWORD_MIN} to ${KEYWORD_MAX} characters ("${word}").` };
    }
    if (RESERVED_KEYWORDS.has(word)) {
      return { error: `"${word}" is already used for something else (greeting, menu, stop or start). Pick another word.` };
    }
    if (!normalizeUnicode(word)) return { error: `"${word}" has no letters or digits to match on.` };
    if (words.includes(word)) return { error: `${name} lists "${word}" more than once.` };
    words.push(word);
  }
  if (words.length > max) return { error: `${name} can have at most ${max} words.` };
  return { value: words };
};

/**
 * Merges `patch` (camelCase, any subset of the settings keys) into `current` and validates the result.
 * @returns {{ settings: Object } | { error: string }}
 */
const mergeSettings = (current, patch) => {
  if (!isObject(patch)) return { error: 'Request body must be an object.' };
  const next = resolveSettings(current);

  for (const key of Object.keys(patch)) {
    if (!ALLOWED_KEYS.has(key)) return { error: `Unknown setting "${key}".` };
  }

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') return { error: 'enabled must be true or false.' };
    next.enabled = patch.enabled;
  }
  if (patch.addToMainMenu !== undefined) {
    if (typeof patch.addToMainMenu !== 'boolean') return { error: 'addToMainMenu must be true or false.' };
    next.addToMainMenu = patch.addToMainMenu;
  }
  if (patch.photosPerPage !== undefined) {
    if (!Number.isInteger(patch.photosPerPage) || patch.photosPerPage < 1 || patch.photosPerPage > 10) {
      return { error: 'photosPerPage must be a whole number from 1 to 10.' };
    }
    next.photosPerPage = patch.photosPerPage;
  }
  if (patch.photoStyle !== undefined) {
    if (!PHOTO_STYLES.includes(patch.photoStyle)) return { error: `photoStyle must be one of: ${PHOTO_STYLES.join(', ')}.` };
    next.photoStyle = patch.photoStyle;
  }

  if (patch.keywords !== undefined) {
    const list = wordList(patch.keywords, 'keywords', MAX_KEYWORDS);
    if (list.error) return { error: list.error };
    next.keywords = list.value;
  }
  if (patch.aliases !== undefined) {
    const list = wordList(patch.aliases, 'aliases', MAX_ALIASES);
    if (list.error) return { error: list.error };
    next.aliases = list.value;
  }
  if (next.keywords.length < 1) return { error: 'Add at least one keyword (for example "catalogue").' };
  const clash = next.aliases.find(a => next.keywords.includes(a));
  if (clash) return { error: `"${clash}" is both a keyword and an alias.` };

  for (const [key, max] of TEXT_FIELDS) {
    if (patch[key] !== undefined) {
      const cleaned = cleanText(patch[key], key, max);
      if (cleaned.error) return { error: cleaned.error };
      next[key] = cleaned.value;
    }
    const translationsKey = `${key}Translations`;
    if (patch[translationsKey] !== undefined) {
      const cleaned = cleanTranslations(patch[translationsKey], translationsKey, max);
      if (cleaned.error) return { error: cleaned.error };
      next[translationsKey] = cleaned.value;
    }
  }

  if (patch.orderAction !== undefined) {
    const action = checkOrderAction(patch.orderAction);
    if (action.error) return { error: action.error };
    next.orderAction = action.value;
  }
  return { settings: next };
};

const checkOrderAction = (raw) => {
  if (raw === null) return { value: null };
  if (!isObject(raw)) return { error: 'orderAction must be an object or null.' };
  if (!ORDER_TYPES.includes(raw.type)) return { error: `orderAction.type must be one of: ${ORDER_TYPES.join(', ')}.` };
  if (raw.type === 'message') {
    const text = raw.text === undefined ? { value: null } : cleanText(raw.text, 'orderAction.text', TEXT_MAX);
    if (text.error) return { error: text.error };
    const translations = cleanTranslations(raw.textTranslations, 'orderAction.textTranslations', TEXT_MAX);
    if (translations.error) return { error: translations.error };
    return { value: { type: 'message', text: text.value, textTranslations: translations.value } };
  }
  if (!isUuid(raw.nodeId)) return { error: `orderAction.nodeId must be the id of a ${raw.type} reply node.` };
  return { value: { type: raw.type, nodeId: raw.nodeId.toLowerCase() } };
};

/** The words the node matches on: keywords[0] is the node keyword, everything else its aliases. */
const nodeWords = (settings) => ({
  keyword: settings.keywords[0],
  hindiAliases: [...settings.keywords.slice(1), ...settings.aliases]
});

module.exports = {
  DEFAULT_SETTINGS, KEYWORD_MIN, KEYWORD_MAX, MAX_KEYWORDS, MAX_ALIASES, PHOTO_STYLES, ORDER_TYPES,
  resolveSettings, mergeSettings, normalizeWord, nodeWords, textLength
};
