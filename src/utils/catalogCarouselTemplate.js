// The "Send catalogue" broadcast's Meta media-card CAROUSEL template, as pure functions (no I/O): its name, the
// components we store and submit, the check that they fit Meta's rules, and the components of one send.
// services/catalogBroadcast.service.js does the I/O; scripts/testCatalogCarouselTemplate.js prints these.
//
// One reusable template per (card count, language, button count), the same for every business and every
// collection selection - the card text, picture and button payloads are all filled in at send time:
//   name   apnabot_catalog_<cards 2..10>_<lang>_<buttons 1|2>      e.g. apnabot_catalog_3_hi_2
//   body   "Hi {{1}}, our new collection is here 👇"   ({{1}} = the customer's name)
//   cards  header IMAGE | body "✨ {{1}} ✨" ({{1}} = "title · price") | quick-reply "View designs" [+ "Order"]
// Meta needs the card count fixed when the template is created, the same components on every card, and
// forbids a body that starts or ends with a variable - hence the fixed words around {{1}}.
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
const NAME_PREFIX = 'apnabot_catalog_';
const NAME_PATTERN = /^apnabot_catalog_(\d{1,2})_([a-z]{2})_([12])$/;

const CARD_BODY_MAX = 160;                       // Meta: a card body, variables included
const CARD_BODY = '✨ {{1}} ✨';
const CARD_BODY_FIXED_LENGTH = CARD_BODY.replace('{{1}}', '').length;
const CARD_TEXT_MAX = CARD_BODY_MAX - CARD_BODY_FIXED_LENGTH;
const NAME_MAX = 60;

const GREETING = {
  en: 'Hi {{1}}, our new collection is here 👇',
  hi: 'नमस्ते {{1}}, हमारा नया कलेक्शन आ गया है 👇',
  mr: 'नमस्कार {{1}}, आमचे नवीन कलेक्शन आले आहे 👇'
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
  if (greeting.length > BODY_MAX) errors.push(`The body can be at most ${BODY_MAX} characters.`);
  errors.push(...checkBodyVariables(greeting).errors, ...checkBodyVariables(CARD_BODY).errors);
  if (checkBodyVariables(greeting).count !== 1 || checkBodyVariables(CARD_BODY).count !== 1) errors.push('The body and the card body each take exactly one variable.');
  if (CARD_BODY.length > CARD_BODY_MAX) errors.push(`A card body can be at most ${CARD_BODY_MAX} characters.`);
  const labels = buttonLabels(lang, buttonCount);
  if (labels.some((label) => !label || label.length > BUTTON_TEXT_MAX)) errors.push(`Button text is required, at most ${BUTTON_TEXT_MAX} characters.`);
  if (new Set(labels.map((label) => label.toLowerCase())).size !== labels.length) errors.push('Button text must be different from the other buttons.');
  return errors;
};

const cardComponents = (lang, buttonCount, headerHandle) => [
  { type: 'HEADER', format: 'IMAGE', ...(headerHandle !== undefined ? { example: { header_handle: [headerHandle] } } : {}) },
  { type: 'BODY', text: CARD_BODY, example: { body_text: [[SAMPLE_CARD_TEXT]] } },
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
const cardText = (title, priceLabel) => {
  const parts = [title, priceLabel].map((v) => cleanValue(v).replace(/[*_~`]/g, '')).filter(Boolean);
  return truncate(parts.join(' · '), CARD_TEXT_MAX).trim();
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
  TEMPLATE_LANGUAGES, FALLBACK_LANGUAGE, MIN_CARDS, MAX_CARDS, GREETING, NAME_FALLBACK, SAMPLE_NAME, CARD_BODY, CARD_TEXT_MAX,
  templateLanguageFor, metaLanguageOf, templateName, parseTemplateName, buttonLabels, validateSpec,
  buildStoredComponents, buildCreatePayload, cardText, greetingName, buildSendComponents
};
