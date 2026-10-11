// A web form's optional "form name" (flow_nodes.form_title / form_title_translations, only on
// reply_kind 'web_form_trigger'): shown as the public form page's title and snapshotted on the
// booking (bookings.form_title). Pure — no I/O. Write-side validation lives in
// flowGraph.service.js#prepareFormTitleWrite; Bot Builder forms keep their own titles
// (coachingBotSettings.js#formTitleForKeyword) and take precedence over these.
const FORM_TITLE_MAX = 60;

const clean = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/**
 * The node's form name for a customer: their language's version when it has one, else the
 * English title, else null. languageCode null/'en' = English.
 * @param {{ form_title?: string|null, form_title_translations?: Object|null }|null} node flow_nodes row
 * @param {string|null} [languageCode]
 * @returns {string|null}
 */
const localizedFormTitle = (node, languageCode = null) => {
  if (!node) return null;
  const translations = node.form_title_translations;
  const translated = languageCode && languageCode !== 'en' && translations && typeof translations === 'object'
    ? clean(translations[languageCode])
    : null;
  return translated || clean(node.form_title);
};

/** The English form name saved on the booking at submit, or null. */
const bookingFormTitle = (node) => clean(node && node.form_title);

module.exports = { FORM_TITLE_MAX, localizedFormTitle, bookingFormTitle };
