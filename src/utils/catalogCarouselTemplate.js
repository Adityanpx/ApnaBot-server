// The "Send catalogue" broadcast's Meta media-card CAROUSEL template, as pure functions (no I/O): its name, the
// components we store and submit, the check that they fit Meta's rules, and the components of one send.
// services/catalogBroadcast.service.js does the I/O; scripts/testCatalogCarouselTemplate.js prints these.
//
// One reusable template per (card count, language, button count), the same for every business and every
// collection selection - the card text, picture and button payloads are all filled in at send time:
//   name   apnabot_catalog_v<TEMPLATE_VERSION>_<cards 2..10>_<lang>_<buttons 1|2>      e.g. apnabot_catalog_v2_3_hi_2
//   body   "Hi {{1}}, our new collection has just arrived. Swipe ... 👇"   ({{1}} = the customer's name)
//   cards  header IMAGE | body "New arrivals in {{1}}. Tap the button below ..." ({{1}} = "title · price") |
//          quick-reply "View designs" [+ "Order"]
// Meta needs the card count fixed when the template is created, the same components on every card, forbids a
// body that starts or ends with a variable, and rejects one with too many variables for its length (subcode
// 2388293, "Params Words Ratio Exceeds Limit") - hence plenty of fixed words around {{1}}; validateSpec checks it.
// TEMPLATE_VERSION is part of the name: bump it when the wording changes, so rows Meta rejected or approved under
// the old wording never clash with (or get reused for) the new one. Only the current version is looked up.
// Languages: only the ones we have reviewed built-in wording for (en, hi, mr); anyone else gets English.
// Button labels are the built-in ones (catalogViewButton / catalogOrderButton), not the owner's custom labels.
const { LIMITS, truncate } = require('./textLimits');
const { getSystemMessage } = require('./systemMessages');
const { checkBodyVariables, BODY_MAX, BUTTON_TEXT_MAX } = require('./templateValidation');
const { cleanValue } = require('./templateValue');
const { LANGUAGE_CATALOG } = require('./languageCatalog');

const TEMPLATE_LANGUAGES = ['en', 'hi', 'mr'];
const FALLBACK_LANGUAGE = 'en';
const MIN_CARDS = 2;
const MAX_CARDS = 10;
const TEMPLATE_VERSION = 2;
const NAME_PREFIX = `apnabot_catalog_v${TEMPLATE_VERSION}_`;
const NAME_PATTERN = new RegExp(`^apnabot_catalog_v${TEMPLATE_VERSION}_(\\d{1,2})_([a-z]{2})_([12])$`);

const CARD_BODY_MAX = 160;                       // Meta: a card body, variables included
// Each starts with fixed words (Meta forbids a leading variable) and ends with fixed words too.
const CARD_BODY = {
  en: 'New arrivals in {{1}}. Tap the button below to see all designs and prices.',
  hi: 'नए डिज़ाइन: {{1}}। सभी डिज़ाइन और कीमत देखने के लिए नीचे बटन दबाएँ।',
  mr: 'नवीन डिझाइन: {{1}}. सर्व डिझाइन आणि किंमत पाहण्यासाठी खाली बटण दाबा.'
};
const NAME_MAX = 60;

// Our best reading of Meta's "Params Words Ratio" rule (the exact threshold is not published): fixed words per
// variable in a body. The rejected "✨ {{1}} ✨" had 0; the wording below has 12+ in a card and 20+ in the greeting.
const MIN_FIXED_WORDS_PER_VARIABLE = 5;

const GREETING = {
  en: 'Hi {{1}}, our new collection has just arrived. Swipe through the cards below and tap the button to see every design with its price 👇',
  hi: 'नमस्ते {{1}}, हमारा नया कलेक्शन आ गया है। नीचे दिए कार्ड स्वाइप करें और हर डिज़ाइन व कीमत देखने के लिए बटन दबाएँ 👇',
  mr: 'नमस्कार {{1}}, आमचे नवीन कलेक्शन आले आहे. खालील कार्ड स्वाइप करा आणि प्रत्येक डिझाइन व किंमत पाहण्यासाठी बटण दाबा 👇'
};
// Used when a customer has no name on file.
const NAME_FALLBACK = { en: 'there', hi: 'जी', mr: 'जी' };
const SAMPLE_NAME = { en: 'Priya', hi: 'प्रिया', mr: 'प्रिया' };
const SAMPLE_CARD_TEXT = 'Red Kurta · ₹999';

/** The template language a customer's preferred_language gets: itself when we have wording for it, else English. */
const templateLanguageFor = (preferredLanguage) => (TEMPLATE_LANGUAGES.includes(preferredLanguage) ? preferredLanguage : FALLBACK_LANGUAGE);

/** Meta's locale code for one of TEMPLATE_LANGUAGES ('en' -> 'en_US'). */
const metaLanguageOf = (lang) => LANGUAGE_CATALOG[lang].metaTemplate;

const templateName = (cardCount, lang, buttonCount) => `${NAME_PREFIX}${cardCount}_${lang}_${buttonCount}`;

/** { cardCount, lang, buttonCount } of one of our names, or null. */
const parseTemplateName = (name) => {
  const m = NAME_PATTERN.exec(typeof name === 'string' ? name : '');
  return m ? { cardCount: Number(m[1]), lang: m[2], buttonCount: Number(m[3]) } : null;
};

/** The longest "title · price" a card of this language takes: the card limit minus the fixed words. */
const cardTextMax = (lang) => CARD_BODY_MAX - CARD_BODY[lang].replace('{{1}}', '').length;

/** Words (letters / digits in any script; emoji and punctuation are not words) outside the {{n}} variables, per variable. */
const fixedWordsPerVariable = (text) => {
  const variables = (text.match(/\{\{\s*\d+\s*\}\}/g) || []).length;
  const words = text.replace(/\{\{\s*\d+\s*\}\}/g, ' ').split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
  return variables === 0 ? Infinity : words / variables;
};

/** The quick-reply labels on every card: "View designs" and, when the catalogue has an order action, "Order". */
const buttonLabels = (lang, buttonCount) => {
  const labels = [getSystemMessage('catalogViewButton', lang), getSystemMessage('catalogOrderButton', lang)].slice(0, buttonCount);
  return labels.map((label) => truncate(label, LIMITS.BUTTON_TITLE));
};

/** Everything wrong with a template spec, or []. */
const validateSpec = ({ cardCount, lang, buttonCount }) => {
  const errors = [];
  if (!Number.isInteger(cardCount) || cardCount < MIN_CARDS || cardCount > MAX_CARDS) errors.push(`A carousel has ${MIN_CARDS} to ${MAX_CARDS} cards.`);
  if (!TEMPLATE_LANGUAGES.includes(lang)) errors.push(`No catalogue wording for language "${lang}".`);
  if (buttonCount !== 1 && buttonCount !== 2) errors.push('Each card has 1 or 2 buttons.');
  if (errors.length > 0) return errors;

  const greeting = GREETING[lang];
  const cardBody = CARD_BODY[lang];
  if (greeting.length > BODY_MAX) errors.push(`The body can be at most ${BODY_MAX} characters.`);
  errors.push(...checkBodyVariables(greeting).errors, ...checkBodyVariables(cardBody).errors);
  if (checkBodyVariables(greeting).count !== 1 || checkBodyVariables(cardBody).count !== 1) errors.push('The body and the card body each take exactly one variable.');
  if (cardBody.length > CARD_BODY_MAX) errors.push(`A card body can be at most ${CARD_BODY_MAX} characters.`);
  for (const [label, text] of [['body', greeting], ['card body', cardBody]]) {
    if (fixedWordsPerVariable(text) < MIN_FIXED_WORDS_PER_VARIABLE) errors.push(`The ${label} has too many variables for its length - Meta rejects that (Params Words Ratio). Add fixed words around {{1}}.`);
  }
  const labels = buttonLabels(lang, buttonCount);
  if (labels.some((label) => !label || label.length > BUTTON_TEXT_MAX)) errors.push(`Button text is required, at most ${BUTTON_TEXT_MAX} characters.`);
  if (new Set(labels.map((label) => label.toLowerCase())).size !== labels.length) errors.push('Button text must be different from the other buttons.');
  return errors;
};

const cardComponents = (lang, buttonCount, headerHandle) => [
  { type: 'HEADER', format: 'IMAGE', ...(headerHandle !== undefined ? { example: { header_handle: [headerHandle] } } : {}) },
  { type: 'BODY', text: CARD_BODY[lang], example: { body_text: [[SAMPLE_CARD_TEXT]] } },
  { type: 'BUTTONS', buttons: buttonLabels(lang, buttonCount).map((text) => ({ type: 'QUICK_REPLY', text })) }
];

/**
 * The components as ApnaBot stores them (message_templates.meta_components): what Meta lists back, minus the
 * per-card sample handles, which only exist at submit.
 */
const buildStoredComponents = ({ cardCount, lang, buttonCount }) => [
  { type: 'BODY', text: GREETING[lang], example: { body_text: [[SAMPLE_NAME[lang]]] } },
  { type: 'CAROUSEL', cards: Array.from({ length: cardCount }, () => ({ components: cardComponents(lang, buttonCount) })) }
];

/**
 * Meta's POST /{waba}/message_templates body.
 * @param {{ cardCount: number, lang: string, buttonCount: number, headerHandles: string[] }} args  one sample
 *   header_handle (resumable upload) per card
 */
const buildCreatePayload = ({ cardCount, lang, buttonCount, headerHandles }) => {
  if (!Array.isArray(headerHandles) || headerHandles.length !== cardCount) {
    throw new Error(`A ${cardCount}-card template needs ${cardCount} sample header handles`);
  }
  return {
    name: templateName(cardCount, lang, buttonCount),
    category: 'MARKETING',
    language: metaLanguageOf(lang),
    components: [
      { type: 'BODY', text: GREETING[lang], example: { body_text: [[SAMPLE_NAME[lang]]] } },
      { type: 'CAROUSEL', cards: headerHandles.map((handle) => ({ components: cardComponents(lang, buttonCount, handle) })) }
    ]
  };
};

/** The one card-body variable: "title · price", one line, no formatting marks, short enough for the card. */
const cardText = (title, priceLabel, lang = FALLBACK_LANGUAGE) => {
  const parts = [title, priceLabel].map((v) => cleanValue(v).replace(/[*_~`]/g, '')).filter(Boolean);
  // Only the value is cut, never the template's fixed words.
  return truncate(parts.join(' · '), cardTextMax(TEMPLATE_LANGUAGES.includes(lang) ? lang : FALLBACK_LANGUAGE)).trim();
};

/** The customer-name variable, with the language's fallback when there is no name. */
const greetingName = (name, lang) => truncate(cleanValue(name), NAME_MAX) || NAME_FALLBACK[lang] || NAME_FALLBACK[FALLBACK_LANGUAGE];

/**
 * The `components` of one template send (POST /{phone}/messages, type template).
 * @param {Object} args
 * @param {string} args.lang           'en' | 'hi' | 'mr'
 * @param {string|null} args.customerName
 * @param {Object[]} args.cards        [{ mediaId, text, payloads: [view, order?] }] in card order, every card the
 *   same number of payloads; `mediaId` = a media id from POST /{phone}/media
 */
const buildSendComponents = ({ lang, customerName, cards }) => [
  { type: 'body', parameters: [{ type: 'text', text: greetingName(customerName, lang) }] },
  {
    type: 'carousel',
    cards: cards.map((card, cardIndex) => ({
      card_index: cardIndex,
      components: [
        { type: 'header', parameters: [{ type: 'image', image: { id: card.mediaId } }] },
        { type: 'body', parameters: [{ type: 'text', text: card.text }] },
        ...card.payloads.map((payload, index) => ({
          type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload }]
        }))
      ]
    }))
  }
];

module.exports = {
  TEMPLATE_LANGUAGES, FALLBACK_LANGUAGE, MIN_CARDS, MAX_CARDS, TEMPLATE_VERSION, MIN_FIXED_WORDS_PER_VARIABLE,
  GREETING, NAME_FALLBACK, SAMPLE_NAME, CARD_BODY,
  templateLanguageFor, metaLanguageOf, templateName, parseTemplateName, cardTextMax, fixedWordsPerVariable, buttonLabels, validateSpec,
  buildStoredComponents, buildCreatePayload, cardText, greetingName, buildSendComponents
};
