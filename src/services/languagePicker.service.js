// Language picker settings and message building. Pure (no DB, no sending): the
// webhook's sendLanguagePicker does the sending, business.controller.js the saving.
//
// Settings live in businesses.language_picker (jsonb, NULL = defaults):
//   { prompt?: string, promptTranslations?: { <code>: string }, mode?: 'first_message'|'off',
//     changeKeyword?: string }
//   mode 'first_message' (the default) asks a customer with no language on their first message;
//   'off' never asks automatically - the customer gets the first enabled language - but the
//   change keyword still opens the picker.
const { LANGUAGE_CATALOG, isValidLanguageCode } = require('../utils/languageCatalog');
const { LIMITS, truncate } = require('../utils/textLimits');
const { getReviewedMessage } = require('../utils/systemMessages');

const PICKER_MODES = ['first_message', 'off'];
const DEFAULT_MODE = 'first_message';
const PROMPT_MAX = 500;
const CHANGE_KEYWORD_MAX = 30;

// Always opens the picker, whatever the owner chose as their own keyword.
const BUILT_IN_CHANGE_KEYWORDS = ['language', 'भाषा', 'bhasha'];
// Words the webhook already handles (greeting, escape, stop/start): an owner keyword equal to
// one would never reach the picker, so it is refused when saved.
const RESERVED_KEYWORDS = new Set([
  'hi', 'hello', 'hey', 'hii', 'hlo', 'namaste', 'start', 'menu', 'cancel', 'exit', 'restart', 'stop', 'unsubscribe'
]);

// "Choose your language" per language, for the built-in prompt. Machine-assisted wording
// for gu/kn/ta/te/ml/bn/pa/or: have a native speaker check before relying on it.
const CHOOSE_LANGUAGE_LINE = {
  en: 'Choose your language',
  hi: 'अपनी भाषा चुनें',
  mr: 'तुमची भाषा निवडा',
  gu: 'તમારી ભાષા પસંદ કરો',
  kn: 'ನಿಮ್ಮ ಭಾಷೆಯನ್ನು ಆಯ್ಕೆಮಾಡಿ',
  ta: 'உங்கள் மொழியைத் தேர்ந்தெடுக்கவும்',
  te: 'మీ భాషను ఎంచుకోండి',
  ml: 'നിങ്ങളുടെ ഭാഷ തിരഞ്ഞെടുക്കുക',
  bn: 'আপনার ভাষা নির্বাচন করুন',
  pa: 'ਆਪਣੀ ਭਾਸ਼ਾ ਚੁਣੋ',
  or: 'ଆପଣଙ୍କ ଭାଷା ବାଛନ୍ତୁ'
};

// The line every en/hi/mr business has always sent. Kept byte-identical for them (the
// webhook golden file pins it) - only a business with another language gets the composed line.
const LEGACY_PROMPT_LINE = 'Choose your language / अपनी भाषा चुनें';
const LIST_BUTTON_LABEL = 'Language';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Stored value -> { prompt, promptTranslations, mode, changeKeyword } with defaults filled. Never throws. */
const resolveSettings = (raw) => {
  const s = isObject(raw) ? raw : {};
  return {
    prompt: typeof s.prompt === 'string' && s.prompt.trim() ? s.prompt.trim() : null,
    promptTranslations: isObject(s.promptTranslations) ? s.promptTranslations : {},
    mode: PICKER_MODES.includes(s.mode) ? s.mode : DEFAULT_MODE,
    changeKeyword: typeof s.changeKeyword === 'string' && s.changeKeyword.trim() ? s.changeKeyword.trim().toLowerCase() : null
  };
};

/** Lower-cased words that re-open the picker for this business. */
const changeKeywordSet = (raw) => {
  const { changeKeyword } = resolveSettings(raw);
  return new Set(changeKeyword ? [...BUILT_IN_CHANGE_KEYWORDS, changeKeyword] : BUILT_IN_CHANGE_KEYWORDS);
};

/** Is `text` (a plain customer message) one of the business's change-language keywords? */
const isChangeKeyword = (text, raw) => changeKeywordSet(raw).has(String(text || '').trim().toLowerCase());

/**
 * Validates a PUT /api/business/language-settings body (partial: only the keys sent).
 * @returns {{ error: string }|{ value: Object }} value = the full object to store
 */
const validateSettingsInput = (body, existingRaw, enabledLanguages) => {
  if (!isObject(body)) return { error: 'Request body must be an object.' };
  const next = { ...(isObject(existingRaw) ? existingRaw : {}) };

  if (body.mode !== undefined) {
    if (body.mode === null) delete next.mode;
    else if (!PICKER_MODES.includes(body.mode)) return { error: `mode must be one of: ${PICKER_MODES.join(', ')}.` };
    else next.mode = body.mode;
  }

  if (body.prompt !== undefined) {
    if (body.prompt === null || body.prompt === '') delete next.prompt;
    else if (typeof body.prompt !== 'string') return { error: 'prompt must be a string.' };
    else if (body.prompt.trim().length > PROMPT_MAX) return { error: `prompt must be ${PROMPT_MAX} characters or less.` };
    else next.prompt = body.prompt.trim();
  }

  if (body.promptTranslations !== undefined) {
    if (body.promptTranslations === null) delete next.promptTranslations;
    else {
      if (!isObject(body.promptTranslations)) return { error: 'promptTranslations must be an object.' };
      const clean = {};
      for (const [code, text] of Object.entries(body.promptTranslations)) {
        if (code === 'en' || !isValidLanguageCode(code)) return { error: `promptTranslations has an invalid language code "${code}".` };
        if (Array.isArray(enabledLanguages) && !enabledLanguages.includes(code)) return { error: `promptTranslations: "${code}" is not an enabled language.` };
        if (typeof text !== 'string') return { error: 'promptTranslations values must be strings.' };
        if (text.trim().length > PROMPT_MAX) return { error: `promptTranslations for "${code}" must be ${PROMPT_MAX} characters or less.` };
        if (text.trim()) clean[code] = text.trim();
      }
      if (Object.keys(clean).length > 0) next.promptTranslations = clean; else delete next.promptTranslations;
    }
  }

  if (body.changeKeyword !== undefined) {
    if (body.changeKeyword === null || body.changeKeyword === '') delete next.changeKeyword;
    else if (typeof body.changeKeyword !== 'string') return { error: 'changeKeyword must be a string.' };
    else {
      const keyword = body.changeKeyword.trim().toLowerCase();
      if (keyword.length > CHANGE_KEYWORD_MAX) return { error: `changeKeyword must be ${CHANGE_KEYWORD_MAX} characters or less.` };
      if (/\s/.test(keyword)) return { error: 'changeKeyword must be a single word.' };
      if (RESERVED_KEYWORDS.has(keyword)) return { error: `"${keyword}" is already used for something else (greeting, menu, stop or start). Pick another word.` };
      next.changeKeyword = keyword;
    }
  }

  return { value: Object.keys(next).length > 0 ? next : null };
};

/** The built-in prompt line for the languages a business offers. */
const defaultPromptLine = (enabledLanguages) => {
  const codes = Array.isArray(enabledLanguages) && enabledLanguages.length ? enabledLanguages : ['en'];
  if (codes.every((c) => c === 'en' || c === 'hi' || c === 'mr')) return LEGACY_PROMPT_LINE;
  // A native-reviewed line (src/i18n, via the review CSV) wins over the machine-assisted one above.
  const lineFor = (c) => getReviewedMessage('chooseLanguageLine', c) || CHOOSE_LANGUAGE_LINE[c];
  const others = codes.filter((c) => c !== 'en' && lineFor(c));
  return [CHOOSE_LANGUAGE_LINE.en, ...others.map(lineFor)].join(' / ');
};

/**
 * The picker message for a business.
 * @param {Object} args
 * @param {string[]} args.enabledLanguages  2-4 codes, 'en' first
 * @param {Object|null} args.rawSettings    businesses.language_picker
 * @param {string|null} args.welcomeMessage the English welcome message (prefix of the default prompt)
 * @param {string|null} args.customerLanguage the customer's current language, when re-opening
 * @returns {{ text: string, needsTemplating: true, buttons?: Array, listOptions?: Array, listButtonLabel?: string }}
 *   text still holds {{placeholders}}; the caller templates it (applyMessageTemplate).
 */
const buildPicker = ({ enabledLanguages, rawSettings, welcomeMessage, customerLanguage }) => {
  const settings = resolveSettings(rawSettings);
  const codes = enabledLanguages;

  const customPrompt = (customerLanguage && settings.promptTranslations[customerLanguage]) || settings.prompt;
  let text;
  if (customPrompt) text = customPrompt;
  else {
    const line = defaultPromptLine(codes);
    text = welcomeMessage ? `${welcomeMessage}\n\n${line}` : line;
  }

  const options = codes.map((code) => ({
    title: truncate(LANGUAGE_CATALOG[code]?.name || code, LIMITS.BUTTON_TITLE),
    nextKeyword: `lang_${code}`
  }));

  // WhatsApp allows 3 reply buttons; a 4th language needs a list. Unreachable while the language
  // cap is 3 (en + 2): kept, with its tests, in case the cap is raised again.
  if (codes.length > LIMITS.MAX_BUTTONS) {
    return {
      text,
      listButtonLabel: LIST_BUTTON_LABEL,
      listOptions: options.map((o) => ({ label: truncate(o.title, LIMITS.LIST_ROW_TITLE), nextKeyword: o.nextKeyword }))
    };
  }
  return { text, buttons: options };
};

/**
 * The "Language" node the canvas draws at the start of the flow. It is NOT a flow_nodes row (so the
 * booking / matching engine, snapshots and the canvas save never see it): it is built from the
 * business's settings, and edited through PUT /api/business (enabledLanguages) and
 * PUT /api/business/language-settings (picker).
 * @param {Object} business camelCase business row (enabledLanguages, languagePicker)
 */
const buildLanguageNode = (business) => {
  const enabledLanguages = Array.isArray(business && business.enabledLanguages) && business.enabledLanguages.length
    ? business.enabledLanguages : ['en'];
  const settings = resolveSettings(business && business.languagePicker);
  return {
    id: 'language',
    type: 'language',
    enabledLanguages,
    languages: enabledLanguages.map((code) => ({
      code,
      name: LANGUAGE_CATALOG[code] ? LANGUAGE_CATALOG[code].name : code,
      englishName: LANGUAGE_CATALOG[code] ? LANGUAGE_CATALOG[code].englishName : code
    })),
    // What a customer with no language yet is shown: nothing for one language, buttons for 2-3, a list for 4.
    pickerKind: enabledLanguages.length <= 1 ? 'none' : enabledLanguages.length <= LIMITS.MAX_BUTTONS ? 'buttons' : 'list',
    picker: {
      mode: settings.mode,
      prompt: settings.prompt,
      promptTranslations: settings.promptTranslations,
      changeKeyword: settings.changeKeyword,
      defaultPrompt: defaultPromptLine(enabledLanguages),
      builtInKeywords: BUILT_IN_CHANGE_KEYWORDS
    }
  };
};

module.exports = {
  buildLanguageNode,
  PICKER_MODES,
  DEFAULT_MODE,
  BUILT_IN_CHANGE_KEYWORDS,
  RESERVED_KEYWORDS,
  LEGACY_PROMPT_LINE,
  resolveSettings,
  changeKeywordSet,
  isChangeKeyword,
  validateSettingsInput,
  defaultPromptLine,
  buildPicker
};
