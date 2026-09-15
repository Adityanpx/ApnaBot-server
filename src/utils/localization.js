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

module.exports = { getLocalizedText };
