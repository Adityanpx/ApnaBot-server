/**
 * Look up a translated field on a record, falling back to the original
 * untranslated column when the translation is missing or no language is
 * known yet. Checks the camelCase translations key first (how businessDoc
 * is shaped by the time it reaches webhook.controller.js, per the
 * toCamelCase convention) and falls back to the snake_case key so this
 * also works against a raw Supabase row.
 * @param {Object} record
 * @param {string} field - e.g. 'welcomeMessage'
 * @param {string|null|undefined} languageCode
 */
const getLocalizedText = (record, field, languageCode) => {
  if (!record) return undefined;
  if (languageCode) {
    const translations = record[`${field}Translations`] ?? record[`${field}_translations`];
    const translated = translations?.[languageCode];
    if (translated !== undefined && translated !== null && String(translated).trim() !== '') {
      return translated;
    }
  }
  return record[field];
};

const DEFAULT_LIST_BUTTON_LABEL = 'Choose';

/**
 * Label of the button that opens a reply node's list message: the node's own
 * button_text in the customer's language, or "Choose" when it is empty or the
 * node is not a list (button_text keeps its web-form meaning on other nodes).
 */
const getListButtonLabel = (node, languageCode) => {
  if (node?.contentType !== 'list') return DEFAULT_LIST_BUTTON_LABEL;
  const label = getLocalizedText(node, 'buttonText', languageCode);
  return typeof label === 'string' && label.trim() ? label.trim() : DEFAULT_LIST_BUTTON_LABEL;
};

module.exports = { getLocalizedText, getListButtonLabel };
