// Every customer-facing text of a bot that can carry a translation, as "slots", so one piece of
// code can find the empty ones for a language, fill them, and tell the apps which were
// machine-filled. Pure - works on raw (snake_case) flow_nodes / flow_edges / businesses rows and
// on the same node / edge objects stored in a category template (flow_snapshots.nodes/edges).
//
// A slot is { id, source, max, get(lang), set(lang, text) }:
//   id      stable name the apps see in `autoTranslated` (e.g. 'label', 'cards.0.body', 'options.1')
//   source  the English text
//   max     WhatsApp's limit for that text, or null (a longer translation is skipped, never cut)
//   get/set read and write the language's text in the row's EXISTING translation JSON, whose
//           shapes this module never changes (an option given as a plain string becomes the
//           {value,label,labelTranslations} object booking.service.js#normalizeOption already reads).
//
// "Auto-translated" marking: a row's auto_translations column holds
//   { "<slot id>": { "<lang>": "<hash of the text that was stored>" } }
// and autoTranslatedOf() reports a slot only while the stored text still hashes to that value, so
// a hand edit clears the mark without any writer having to know about the column.
const crypto = require('crypto');
const { toCamelCase } = require('./caseConvert');
const { LIMITS, edgeLabelLimit } = require('./textLimits');
const { FORM_TITLE_MAX } = require('./formTitle');
const { CARD_BODY_MAX } = require('./carouselPayload');

const textHash = (text) => crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 12);

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const hasText = (v) => typeof v === 'string' && v.trim() !== '';
const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

// Reads / writes translations[lang] on a plain { lang: text } map held in obj[key].
const mapSlot = (obj, key, id, source, max) => ({
  id, source, max,
  get: (lang) => (isObject(obj[key]) ? obj[key][lang] : undefined),
  set: (lang, text) => { obj[key] = { ...(isObject(obj[key]) ? obj[key] : {}), [lang]: text }; }
});

const interactiveBodyMax = (node) => (
  node.node_type === 'reply' && !['buttons', 'list', 'carousel'].includes(node.content_type)
    ? LIMITS.TEXT_BODY
    : LIMITS.INTERACTIVE_BODY
);

/** Slots of one flow_nodes row (or template node). */
const nodeSlots = (node) => {
  const slots = [];
  if (hasText(node.label)) slots.push(mapSlot(node, 'label_translations', 'label', node.label, interactiveBodyMax(node)));
  if (hasText(node.button_text)) slots.push(mapSlot(node, 'button_text_translations', 'buttonText', node.button_text, LIMITS.BUTTON_TITLE));
  if (hasText(node.form_title)) slots.push(mapSlot(node, 'form_title_translations', 'formTitle', node.form_title, FORM_TITLE_MAX));

  if (Array.isArray(node.carousel_cards)) {
    node.carousel_cards.forEach((card, i) => {
      if (isObject(card) && hasText(card.body)) slots.push(mapSlot(card, 'body_translations', `cards.${i}.body`, card.body, CARD_BODY_MAX));
    });
  }

  // A choice question's own options (a computed node has none stored).
  if (!node.is_computed && ['buttons', 'list'].includes(node.content_type) && Array.isArray(node.options)) {
    const max = node.options.length <= LIMITS.MAX_BUTTONS ? LIMITS.BUTTON_TITLE : LIMITS.LIST_ROW_TITLE;
    node.options.forEach((opt, i) => {
      const source = typeof opt === 'string' ? opt : (opt && (opt.label ?? opt.value));
      if (!hasText(source)) return;
      slots.push({
        id: `options.${i}`, source, max,
        get: (lang) => {
          const current = node.options[i];
          return isObject(current) && isObject(current.labelTranslations) ? current.labelTranslations[lang] : undefined;
        },
        set: (lang, text) => {
          const current = node.options[i];
          const base = isObject(current) ? current : { value: current, label: current };
          node.options[i] = { ...base, labelTranslations: { ...(isObject(base.labelTranslations) ? base.labelTranslations : {}), [lang]: text } };
        }
      });
    });
  }
  return slots;
};

/** Slots of one flow_edges row; `parentNode` is its from-node (decides the title limit). */
const edgeSlots = (edge, parentNode) => {
  const slots = [];
  const labelMax = parentNode ? edgeLabelLimit(parentNode.node_type, parentNode.content_type) : null;
  if (hasText(edge.label)) slots.push(mapSlot(edge, 'label_translations', 'label', edge.label, labelMax));
  if (hasText(edge.description)) slots.push(mapSlot(edge, 'description_translations', 'description', edge.description, LIMITS.LIST_ROW_DESCRIPTION));
  return slots;
};

const BUSINESS_TEXTS = [
  ['welcome_message', 'welcomeMessage'], ['stop_message', 'stopMessage'],
  ['start_message', 'startMessage'], ['cancel_message', 'cancelMessage']
];

/** Slots of the businesses row: the four owner messages and the booking form (flow_fields) labels / options. */
const businessSlots = (business) => {
  const slots = [];
  for (const [column, id] of BUSINESS_TEXTS) {
    if (hasText(business[column])) slots.push(mapSlot(business, `${column}_translations`, id, business[column], LIMITS.TEXT_BODY));
  }
  if (Array.isArray(business.flow_fields)) {
    business.flow_fields.forEach((field) => {
      if (!isObject(field) || !hasText(field.name)) return;
      if (hasText(field.label)) slots.push(mapSlot(field, 'labelTranslations', `fields.${field.name}.label`, field.label, LIMITS.INTERACTIVE_BODY));
      const choice = ['dropdown', 'radio'].includes(field.type) && !field.source && Array.isArray(field.options);
      if (choice) {
        field.options.forEach((option) => {
          if (!hasText(option)) return;
          slots.push({
            id: `fields.${field.name}.options.${option}`, source: option, max: LIMITS.LIST_ROW_TITLE,
            get: (lang) => (isObject(field.optionTranslations) && isObject(field.optionTranslations[lang]) ? field.optionTranslations[lang][option] : undefined),
            set: (lang, text) => {
              const all = isObject(field.optionTranslations) ? field.optionTranslations : {};
              field.optionTranslations = { ...all, [lang]: { ...(isObject(all[lang]) ? all[lang] : {}), [option]: text } };
            }
          });
        });
      }
    });
  }
  return slots;
};

// ---- Catalogue (catalogs.settings, catalog_collections, catalog_items) ----
const CATALOG_SETTING_TEXTS = [
  ['text', LIMITS.INTERACTIVE_BODY], ['emptyText', LIMITS.INTERACTIVE_BODY],
  ['viewButtonLabel', LIMITS.BUTTON_TITLE], ['orderButtonLabel', LIMITS.BUTTON_TITLE],
  ['showMoreLabel', LIMITS.BUTTON_TITLE], ['menuLabel', LIMITS.BUTTON_TITLE]
];

/** Slots of a catalogs row: the owner's texts and labels in settings (a text never set has nothing to translate). */
const catalogSettingsSlots = (row) => {
  const settings = isObject(row.settings) ? row.settings : {};
  const slots = [];
  for (const [key, max] of CATALOG_SETTING_TEXTS) {
    if (hasText(settings[key])) slots.push(mapSlot(settings, `${key}Translations`, key, settings[key], max));
  }
  const action = settings.orderAction;
  if (isObject(action) && action.type === 'message' && hasText(action.text)) {
    slots.push(mapSlot(action, 'textTranslations', 'orderAction.text', action.text, LIMITS.INTERACTIVE_BODY));
  }
  return slots;
};

/** Slots of a catalog_collections row: title (60), card text (160), price label (30). */
const catalogCollectionSlots = (row) => {
  const slots = [];
  if (hasText(row.title)) slots.push(mapSlot(row, 'title_translations', 'title', row.title, 60));
  if (hasText(row.body)) slots.push(mapSlot(row, 'body_translations', 'body', row.body, CARD_BODY_MAX));
  if (hasText(row.price_label)) slots.push(mapSlot(row, 'price_label_translations', 'priceLabel', row.price_label, 30));
  return slots;
};

/** Slots of a catalog_items row: the caption (design numbers and prices are never translated). */
const catalogItemSlots = (row) => (hasText(row.caption)
  ? [mapSlot(row, 'caption_translations', 'caption', row.caption, 500)] : []);

/** True when the slot has no usable text in `lang` (absent, null or blank) - the only case that gets filled. */
const isMissing = (slot, lang) => !hasText(slot.get(lang));

/** Records, on `row`, that `text` was machine-filled for the slot / language. */
const markAuto = (row, slotId, lang, text) => {
  const marks = isObject(row.auto_translations) ? row.auto_translations : {};
  row.auto_translations = { ...marks, [slotId]: { ...(isObject(marks[slotId]) ? marks[slotId] : {}), [lang]: textHash(text) } };
};

/** { slotId: [lang, ...] } for the slots whose stored text is still the machine's. {} when none. */
const autoTranslatedOf = (row, slots) => {
  const marks = isObject(row.auto_translations) ? row.auto_translations : null;
  if (!marks) return {};
  const out = {};
  for (const slot of slots) {
    const forSlot = marks[slot.id];
    if (!isObject(forSlot)) continue;
    const langs = Object.entries(forSlot)
      .filter(([lang, hash]) => hasText(slot.get(lang)) && textHash(slot.get(lang)) === hash)
      .map(([lang]) => lang);
    if (langs.length > 0) out[slot.id] = langs;
  }
  return out;
};

/** The business row in the snake_case shape businessSlots() reads, from the camelCase object the services return. */
const businessRowFromCamel = (b) => ({
  welcome_message: b.welcomeMessage, welcome_message_translations: b.welcomeMessageTranslations,
  stop_message: b.stopMessage, stop_message_translations: b.stopMessageTranslations,
  start_message: b.startMessage, start_message_translations: b.startMessageTranslations,
  cancel_message: b.cancelMessage, cancel_message_translations: b.cancelMessageTranslations,
  flow_fields: b.flowFields, auto_translations: b.autoTranslations
});

/**
 * A flow_nodes / flow_edges row as the API returns it (camelCase) plus autoTranslated
 * { <slot>: [lang] }; the raw auto_translations bookkeeping column is not exposed. One shape for
 * GET /flow-graph/full and the carousel-bundle response.
 */
const shapeRowForApi = (row, slots) => {
  const out = toCamelCase(row);
  out.autoTranslated = autoTranslatedOf(row, slots);
  delete out.autoTranslations;
  return out;
};
const shapeNodeForApi = (node) => shapeRowForApi(node, nodeSlots(node));
const shapeEdgeForApi = (edge, parentNode) => shapeRowForApi(edge, edgeSlots(edge, parentNode));

/** { <slot>: [lang] } for the catalogue pieces, same contract as the nodes' autoTranslated. */
const shapeSettingsAuto = (row) => autoTranslatedOf(row, catalogSettingsSlots(row));
const shapeCollectionAuto = (row) => autoTranslatedOf(row, catalogCollectionSlots(row));
const shapeItemAuto = (row) => autoTranslatedOf(row, catalogItemSlots(row));

module.exports = {
  shapeNodeForApi, shapeEdgeForApi,
  textHash, clone, nodeSlots, edgeSlots, businessSlots, isMissing, markAuto, autoTranslatedOf, businessRowFromCamel,
  catalogSettingsSlots, catalogCollectionSlots, catalogItemSlots, shapeSettingsAuto, shapeCollectionAuto, shapeItemAuto
};
