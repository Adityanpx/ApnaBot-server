// Single source of truth for the languages a business can offer its customers.
// Fixed, hardcoded catalog - not DB-driven. Adding a language means adding an
// entry here (plus its Azure / Meta codes), not a migration.
//
//   name         native name - what the language picker shows and what
//                webhook.controller.js / backfillInboundInteractiveLabels.js read
//   englishName  for admin screens
//   azure        Azure Translator code (same as our code for all of these;
//                Odia is 'or')
//   metaTemplate Meta message-template locale, or null when Meta has no locale
//                for it (Odia is not on Meta's supported-languages list)
const LANGUAGE_CATALOG = {
  en: { name: 'English', englishName: 'English', azure: 'en', metaTemplate: 'en_US' },
  hi: { name: 'हिंदी', englishName: 'Hindi', azure: 'hi', metaTemplate: 'hi' },
  mr: { name: 'मराठी', englishName: 'Marathi', azure: 'mr', metaTemplate: 'mr' },
  gu: { name: 'ગુજરાતી', englishName: 'Gujarati', azure: 'gu', metaTemplate: 'gu' },
  kn: { name: 'ಕನ್ನಡ', englishName: 'Kannada', azure: 'kn', metaTemplate: 'kn' },
  ta: { name: 'தமிழ்', englishName: 'Tamil', azure: 'ta', metaTemplate: 'ta' },
  te: { name: 'తెలుగు', englishName: 'Telugu', azure: 'te', metaTemplate: 'te' },
  ml: { name: 'മലയാളം', englishName: 'Malayalam', azure: 'ml', metaTemplate: 'ml' },
  bn: { name: 'বাংলা', englishName: 'Bengali', azure: 'bn', metaTemplate: 'bn' },
  pa: { name: 'ਪੰਜਾਬੀ', englishName: 'Punjabi', azure: 'pa', metaTemplate: 'pa' },
  or: { name: 'ଓଡ଼ିଆ', englishName: 'Odia', azure: 'or', metaTemplate: null }
};

const MAX_ENABLED_LANGUAGES = 4; // 'en' + up to 3 more

const isValidLanguageCode = (code) => Object.prototype.hasOwnProperty.call(LANGUAGE_CATALOG, code);

// Language suggested for a business, by Indian state / UT (lowercase key).
// States not listed get DEFAULT_SUGGESTED_LANGUAGES.
const DEFAULT_SUGGESTED_LANGUAGES = ['en', 'hi'];
const STATE_LANGUAGES = {
  'Andhra Pradesh': ['en', 'hi', 'te'],
  'Arunachal Pradesh': ['en', 'hi'],
  'Assam': ['en', 'hi'],
  'Bihar': ['en', 'hi'],
  'Chhattisgarh': ['en', 'hi'],
  'Goa': ['en', 'hi'],
  'Gujarat': ['en', 'hi', 'gu'],
  'Haryana': ['en', 'hi'],
  'Himachal Pradesh': ['en', 'hi'],
  'Jharkhand': ['en', 'hi'],
  'Karnataka': ['en', 'hi', 'kn'],
  'Kerala': ['en', 'ml'],
  'Madhya Pradesh': ['en', 'hi'],
  'Maharashtra': ['en', 'hi', 'mr'],
  'Manipur': ['en', 'hi'],
  'Meghalaya': ['en', 'hi'],
  'Mizoram': ['en', 'hi'],
  'Nagaland': ['en', 'hi'],
  'Odisha': ['en', 'hi', 'or'],
  'Punjab': ['en', 'hi', 'pa'],
  'Rajasthan': ['en', 'hi'],
  'Sikkim': ['en', 'hi'],
  'Tamil Nadu': ['en', 'ta'],
  'Telangana': ['en', 'hi', 'te'],
  'Tripura': ['en', 'hi'],
  'Uttar Pradesh': ['en', 'hi'],
  'Uttarakhand': ['en', 'hi'],
  'West Bengal': ['en', 'hi', 'bn'],
  'Andaman and Nicobar Islands': ['en', 'hi'],
  'Chandigarh': ['en', 'hi'],
  'Dadra and Nagar Haveli and Daman and Diu': ['en', 'hi'],
  'Delhi': ['en', 'hi'],
  'Jammu and Kashmir': ['en', 'hi'],
  'Ladakh': ['en', 'hi'],
  'Lakshadweep': ['en', 'hi'],
  'Puducherry': ['en', 'hi']
};
const STATES = Object.keys(STATE_LANGUAGES);

const normalizeStateKey = (state) => String(state || '').trim().toLowerCase().replace(/\s+/g, ' ');
const STATE_BY_KEY = new Map(STATES.map((s) => [normalizeStateKey(s), s]));

/** The canonical state / UT name for free-typed input, or null when it isn't one. */
const canonicalState = (state) => STATE_BY_KEY.get(normalizeStateKey(state)) || null;

/** Suggested enabledLanguages for a state (unknown / missing -> en, hi). */
const suggestedLanguagesForState = (state) => {
  const canonical = canonicalState(state);
  return [...(canonical ? STATE_LANGUAGES[canonical] : DEFAULT_SUGGESTED_LANGUAGES)];
};

/**
 * Validates an enabledLanguages write. 'en' is always included and first (a
 * list without it is rejected, a misplaced one is moved to the front), at most
 * MAX_ENABLED_LANGUAGES, catalog codes only, no duplicates.
 * @returns {{ error: string }|{ value: string[] }}
 */
const validateEnabledLanguages = (languages) => {
  if (!Array.isArray(languages) || languages.length < 1 || languages.length > MAX_ENABLED_LANGUAGES) {
    return { error: `enabledLanguages must include between 1 and ${MAX_ENABLED_LANGUAGES} languages (English plus up to ${MAX_ENABLED_LANGUAGES - 1} more).` };
  }
  const invalid = languages.filter((code) => !isValidLanguageCode(code));
  if (invalid.length > 0) {
    return { error: `Invalid language code(s): ${invalid.join(', ')}. Must be one of: ${Object.keys(LANGUAGE_CATALOG).join(', ')}` };
  }
  if (new Set(languages).size !== languages.length) {
    return { error: 'enabledLanguages must not contain duplicate language codes.' };
  }
  if (!languages.includes('en')) {
    return { error: 'English cannot be removed from enabled languages.' };
  }
  return { value: ['en', ...languages.filter((code) => code !== 'en')] };
};

/** The catalog as the public list shape ({ code, name, englishName }), en first. */
const catalogList = () => Object.entries(LANGUAGE_CATALOG)
  .map(([code, entry]) => ({ code, name: entry.name, englishName: entry.englishName }));

module.exports = {
  LANGUAGE_CATALOG,
  MAX_ENABLED_LANGUAGES,
  STATES,
  STATE_LANGUAGES,
  DEFAULT_SUGGESTED_LANGUAGES,
  isValidLanguageCode,
  canonicalState,
  suggestedLanguagesForState,
  validateEnabledLanguages,
  catalogList
};
