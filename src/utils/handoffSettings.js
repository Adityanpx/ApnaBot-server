// Settings of the human-needed alert (business_handoff_settings, GET/PUT /api/business/handoff-settings).
// Pure: no I/O.
//
// API shape (camelCase), exactly:
//   { enabled: bool, keywords: string[], unmatchedThreshold: 0-10,
//     replyText: string, replyTextTranslations: { <lang>: string },
//     closedText: string, closedTextTranslations: { <lang>: string },
//     pauseBotMinutes: 0-10080, reminderMinutes: 0-1440, autoResumeBot: bool,
//     mediaReplyMode: 'default' | 'thank_and_alert',
//     mediaReplyText: string, mediaReplyTextTranslations: { <lang>: string },
//     hours: { mon: [{ open: 'HH:mm', close: 'HH:mm' }], ... } | null }
// GET always returns `keywords` as the list in effect (the defaults when the row stores none).
// PUT takes any subset; `keywords: null` goes back to the defaults.
// mediaReplyMode is the "When a customer sends a photo, PDF or document" setting: 'default' keeps the
// "I can only read text" reply; 'thank_and_alert' thanks the customer (mediaReplyText, '' = the built-in
// text), raises the handoff with reason 'media' and stores the customer's documents in the chat. It works
// with `enabled` false: the keyword / unmatched triggers stay off.
const { HANDOFF_MAX_WORDS } = require('./handoffMatch');
const { validateHours } = require('./handoffHours');
const { isValidLanguageCode } = require('./languageCatalog');

// Phrases, matched as whole words in a message of at most HANDOFF_MAX_WORDS words. Roman-script
// equivalents are kept so a customer typing Hindi / Marathi in English letters is also heard.
const DEFAULT_KEYWORDS = [
  'talk to', 'speak to', 'call me', 'agent', 'human', 'owner', 'customer care',
  'बात करनी है', 'बात करना', 'बोलायचं आहे', 'बोलायचे आहे', 'मालक',
  'baat karni', 'baat karna', 'bolaycha', 'malak'
];

const TEXT_MAX = 1000;
const MEDIA_REPLY_MODES = ['default', 'thank_and_alert'];
const KEYWORDS_MAX = 50;
const KEYWORD_MAX_CHARS = 60;

const DEFAULTS = {
  enabled: false,
  keywords: null,
  unmatchedThreshold: 3,
  replyText: '',
  replyTextTranslations: {},
  closedText: '',
  closedTextTranslations: {},
  pauseBotMinutes: 0,
  reminderMinutes: 15,
  autoResumeBot: false,
  mediaReplyMode: 'default',
  mediaReplyText: '',
  mediaReplyTextTranslations: {},
  hours: null
};

const FIELDS = Object.keys(DEFAULTS);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A business_handoff_settings row -> the settings object (keywords left null when the row stores none). */
const fromRow = (row) => ({
  enabled: row.enabled === true,
  keywords: Array.isArray(row.keywords) ? row.keywords : null,
  unmatchedThreshold: row.unmatched_threshold ?? DEFAULTS.unmatchedThreshold,
  replyText: row.reply_text || '',
  replyTextTranslations: isPlainObject(row.reply_text_translations) ? row.reply_text_translations : {},
  closedText: row.closed_text || '',
  closedTextTranslations: isPlainObject(row.closed_text_translations) ? row.closed_text_translations : {},
  pauseBotMinutes: row.pause_bot_minutes ?? DEFAULTS.pauseBotMinutes,
  reminderMinutes: row.reminder_minutes ?? DEFAULTS.reminderMinutes,
  autoResumeBot: row.auto_resume_bot === true,
  mediaReplyMode: MEDIA_REPLY_MODES.includes(row.media_reply_mode) ? row.media_reply_mode : DEFAULTS.mediaReplyMode,
  mediaReplyText: row.media_reply_text || '',
  mediaReplyTextTranslations: isPlainObject(row.media_reply_text_translations) ? row.media_reply_text_translations : {},
  hours: isPlainObject(row.hours) ? row.hours : null
});

/** Settings object -> columns for an upsert. */
const toRow = (settings) => ({
  enabled: settings.enabled,
  keywords: settings.keywords,
  unmatched_threshold: settings.unmatchedThreshold,
  reply_text: settings.replyText,
  reply_text_translations: settings.replyTextTranslations,
  closed_text: settings.closedText,
  closed_text_translations: settings.closedTextTranslations,
  pause_bot_minutes: settings.pauseBotMinutes,
  reminder_minutes: settings.reminderMinutes,
  auto_resume_bot: settings.autoResumeBot,
  media_reply_mode: settings.mediaReplyMode,
  media_reply_text: settings.mediaReplyText,
  media_reply_text_translations: settings.mediaReplyTextTranslations,
  hours: settings.hours
});

/** The keyword list in effect. */
const effectiveKeywords = (settings) => (Array.isArray(settings.keywords) ? settings.keywords : DEFAULT_KEYWORDS);

/** The GET body: every field, with the keywords in effect. */
const toApi = (settings) => ({ ...settings, keywords: effectiveKeywords(settings) });

const validateInt = (body, key, min, max, bad) => {
  const value = body[key];
  if (!Number.isInteger(value) || value < min || value > max) return bad(key, `must be a whole number from ${min} to ${max}`);
  return null;
};

const validateTranslations = (value, key, enabledLanguages, bad) => {
  if (!isPlainObject(value)) return bad(key, 'must be an object of { language: text }');
  const clean = {};
  for (const [lang, text] of Object.entries(value)) {
    if (!isValidLanguageCode(lang) || !enabledLanguages.includes(lang)) return bad(`${key}.${lang}`, 'not one of this business\'s enabled languages');
    if (typeof text !== 'string') return bad(`${key}.${lang}`, 'must be text');
    if (text.length > TEXT_MAX) return bad(`${key}.${lang}`, `at most ${TEXT_MAX} characters`);
    clean[lang] = text.trim();
  }
  return clean;
};

/**
 * Validates a PUT body. Unknown keys and wrong types are errors, and the error names the field.
 * Missing keys are fine (the caller merges onto the stored settings).
 * @param {object} body
 * @param {{enabledLanguages?: string[]}} [business] translations are limited to its enabled languages
 * @returns {{ok: true, patch: object}|{ok: false, field: string, error: string}}
 */
const validateSettingsInput = (body, business = {}) => {
  const bad = (field, error) => ({ ok: false, field, error: `${field}: ${error}` });
  if (!isPlainObject(body)) return bad('body', 'must be an object');
  for (const key of Object.keys(body)) {
    if (!FIELDS.includes(key)) return bad(key, 'unknown setting');
  }
  const enabledLanguages = Array.isArray(business.enabledLanguages) && business.enabledLanguages.length > 0 ? business.enabledLanguages : ['en'];
  const patch = {};

  for (const key of ['enabled', 'autoResumeBot']) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') return bad(key, 'must be true or false');
    patch[key] = body[key];
  }

  if (body.keywords !== undefined) {
    if (body.keywords === null) {
      patch.keywords = null;
    } else {
      if (!Array.isArray(body.keywords)) return bad('keywords', 'must be a list of phrases, or null for the defaults');
      if (body.keywords.length > KEYWORDS_MAX) return bad('keywords', `at most ${KEYWORDS_MAX} phrases`);
      const seen = new Set();
      const clean = [];
      for (let i = 0; i < body.keywords.length; i += 1) {
        const phrase = body.keywords[i];
        if (typeof phrase !== 'string' || phrase.trim() === '') return bad(`keywords[${i}]`, 'must be non-empty text');
        const trimmed = phrase.trim().replace(/\s+/g, ' ');
        if (trimmed.length > KEYWORD_MAX_CHARS) return bad(`keywords[${i}]`, `at most ${KEYWORD_MAX_CHARS} characters`);
        if (trimmed.split(' ').length > HANDOFF_MAX_WORDS) return bad(`keywords[${i}]`, `at most ${HANDOFF_MAX_WORDS} words (a longer phrase could never match)`);
        if (!seen.has(trimmed.toLowerCase())) { seen.add(trimmed.toLowerCase()); clean.push(trimmed); }
      }
      patch.keywords = clean;
    }
  }

  const ranges = { unmatchedThreshold: [0, 10], pauseBotMinutes: [0, 10080], reminderMinutes: [0, 1440] };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (body[key] === undefined) continue;
    const problem = validateInt(body, key, min, max, bad);
    if (problem) return problem;
    patch[key] = body[key];
  }

  if (body.mediaReplyMode !== undefined) {
    if (!MEDIA_REPLY_MODES.includes(body.mediaReplyMode)) return bad('mediaReplyMode', `must be one of: ${MEDIA_REPLY_MODES.join(', ')}`);
    patch.mediaReplyMode = body.mediaReplyMode;
  }

  for (const key of ['replyText', 'closedText', 'mediaReplyText']) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'string') return bad(key, 'must be text');
    if (body[key].length > TEXT_MAX) return bad(key, `at most ${TEXT_MAX} characters`);
    patch[key] = body[key].trim();
  }
  for (const key of ['replyTextTranslations', 'closedTextTranslations', 'mediaReplyTextTranslations']) {
    if (body[key] === undefined) continue;
    const clean = validateTranslations(body[key], key, enabledLanguages, bad);
    if (clean.ok === false) return clean;
    patch[key] = clean;
  }

  if (body.hours !== undefined) {
    const checked = validateHours(body.hours);
    if (!checked.ok) return checked;
    patch.hours = checked.hours;
  }
  return { ok: true, patch };
};

module.exports = {
  DEFAULT_KEYWORDS, DEFAULTS, FIELDS, MEDIA_REPLY_MODES,
  fromRow, toRow, toApi, effectiveKeywords, validateSettingsInput
};
