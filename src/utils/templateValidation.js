// Shared validation for templates ApnaBot creates and submits to Meta. Pure.
// The same checks run when a draft is created (POST /api/message-templates)
// and again when it is submitted (services/templateSubmit.service.js), so a
// template that passes here is one Meta's format rules won't bounce. Meta still
// has the final say (content policy, variable-to-text ratio, ...).
const { extensionOf, EXTENSIONS_BY_FORMAT } = require('./templateSendSupport');

const TEMPLATE_NAME_REGEX = /^[a-z0-9_]+$/;
const TEMPLATE_NAME_MAX = 512;
const CATEGORIES = ['MARKETING', 'UTILITY'];
const LANGUAGES = ['en_US', 'hi', 'mr'];
const HEADER_TYPES = ['NONE', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'];

const BODY_MAX = 1024;
const HEADER_TEXT_MAX = 60;
const FOOTER_MAX = 60;
const BUTTON_TEXT_MAX = 25;
const BUTTONS_MAX = 3;
const URL_BUTTONS_MAX = 2;
const PHONE_BUTTONS_MAX = 1;
const URL_MAX = 2000;

// business_media.media_type each header format takes, and the size cap WhatsApp
// puts on it.
const HEADER_MEDIA_TYPE = { IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document' };
const HEADER_MEDIA_MAX_BYTES = { IMAGE: 5 * 1024 * 1024, VIDEO: 16 * 1024 * 1024, DOCUMENT: 10 * 1024 * 1024 };
const HEADER_MEDIA_LABEL = { IMAGE: 'a JPG or PNG image', VIDEO: 'an MP4 video', DOCUMENT: 'a PDF' };

const URL_SHORTENERS = [
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly',
  'cutt.ly', 'shorturl.at', 't.ly', 'rb.gy', 'tiny.cc', 'bl.ink', 'lnkd.in', 'v.gd'
];

const E164 = /^\+[1-9]\d{6,14}$/;
const VARIABLE = /\{\{\s*(\d+)\s*\}\}/g;

const variableNumbers = (text) => [...String(text || '').matchAll(VARIABLE)].map((m) => Number(m[1]));

/** Is this a lowercase_snake_case name Meta takes? @returns {string|null} error */
const validateName = (name) => {
  if (typeof name !== 'string' || !name) return 'name is required';
  if (!TEMPLATE_NAME_REGEX.test(name)) return 'name must be lowercase_snake_case, alphanumeric characters and underscores only';
  if (name.length > TEMPLATE_NAME_MAX) return `name can be at most ${TEMPLATE_NAME_MAX} characters`;
  return null;
};

const validateCategory = (category) => (CATEGORIES.includes(category) ? null : `category must be one of: ${CATEGORIES.join(', ')}`);
const validateLanguage = (language) => (LANGUAGES.includes(language) ? null : `language must be one of: ${LANGUAGES.join(', ')}`);

/**
 * Body variables must be {{1}}..{{n}} in sequence, not at the very start or end
 * of the text, and not directly next to each other.
 */
const checkBodyVariables = (text) => {
  const numbers = variableNumbers(text);
  if (numbers.length === 0) return { count: 0, errors: [] };
  const errors = [];
  const distinct = [...new Set(numbers)].sort((a, b) => a - b);
  if (!distinct.every((n, i) => n === i + 1)) {
    errors.push(`Body variables must be numbered {{1}}, {{2}}, ... in order with no gaps (found ${distinct.map((n) => `{{${n}}}`).join(', ')}).`);
  }
  const trimmed = text.trim();
  if (/^\{\{\s*\d+\s*\}\}/.test(trimmed)) errors.push('The body cannot start with a variable - add some text before {{1}}.');
  if (/\{\{\s*\d+\s*\}\}$/.test(trimmed)) errors.push('The body cannot end with a variable - add some text after the last variable.');
  if (/\}\}\{\{/.test(text)) {
    errors.push('Variables cannot be directly next to each other - put text between them.');
  }
  return { count: distinct.length, errors };
};

/** @returns {string|null} error for a button URL (https, no shortener, optional single trailing {{1}}) */
const checkButtonUrl = (url) => {
  if (typeof url !== 'string' || !url.trim()) return 'url is required';
  if (url.length > URL_MAX) return `url can be at most ${URL_MAX} characters`;
  if (!/^https:\/\//i.test(url)) return 'url must start with https://';
  const vars = variableNumbers(url);
  const hasDynamic = vars.length > 0;
  if (hasDynamic && (vars.length !== 1 || vars[0] !== 1 || !/\{\{1\}\}$/.test(url))) {
    return 'A dynamic URL can have only one variable, {{1}}, at the very end of the URL';
  }
  const staticPart = hasDynamic ? url.replace(/\{\{1\}\}$/, '') : url;
  if (/[{}]/.test(staticPart)) return 'url contains stray { or } characters';
  let host;
  try {
    host = new URL(staticPart || url).hostname.toLowerCase();
  } catch {
    return 'url is not a valid web address';
  }
  if (!host.includes('.')) return 'url is not a valid web address';
  if (URL_SHORTENERS.some((s) => host === s || host.endsWith(`.${s}`))) {
    return `URL shorteners (${host}) are not allowed in template buttons - use the full link`;
  }
  return null;
};

/**
 * Validate a stored-shape components array (the same shape Meta lists:
 * HEADER / BODY / FOOTER / BUTTONS). Collects every problem.
 * @param {Array} components
 * @param {{ requireExamples?: boolean }} [options]  true at submit time: every
 *   variable needs a sample value (drafts may still be missing them)
 * @returns {string[]} error messages, empty when valid
 */
const validateComponents = (components, { requireExamples = false } = {}) => {
  const errors = [];
  const list = Array.isArray(components) ? components : [];
  const body = list.find((c) => c && c.type === 'BODY');
  const header = list.find((c) => c && c.type === 'HEADER');
  const footer = list.find((c) => c && c.type === 'FOOTER');
  const buttonsComponent = list.find((c) => c && c.type === 'BUTTONS');

  // body
  if (!body || typeof body.text !== 'string' || !body.text.trim()) {
    errors.push('bodyText is required');
  } else {
    if (body.text.length > BODY_MAX) errors.push(`The body can be at most ${BODY_MAX} characters.`);
    const { count, errors: varErrors } = checkBodyVariables(body.text);
    errors.push(...varErrors);
    if (count > 0 && (requireExamples || body.example)) {
      const samples = body.example && Array.isArray(body.example.body_text) ? body.example.body_text[0] : null;
      if (!Array.isArray(samples) || samples.length !== count || samples.some((s) => typeof s !== 'string' || !s.trim())) {
        const placeholders = Array.from({ length: count }, (_, i) => `{{${i + 1}}}`).join(', ');
        errors.push(`This template has ${count} variables (${placeholders}) - provide exactly ${count} sample values.`);
      }
    }
  }

  // header
  if (header) {
    const format = String(header.format || '').toUpperCase();
    if (format === 'TEXT') {
      const text = typeof header.text === 'string' ? header.text : '';
      if (!text.trim()) errors.push('A text header needs text.');
      if (text.length > HEADER_TEXT_MAX) errors.push(`A text header can be at most ${HEADER_TEXT_MAX} characters.`);
      const vars = variableNumbers(text);
      if (vars.length > 1 || (vars.length === 1 && vars[0] !== 1)) errors.push('A text header can have at most one variable, {{1}}.');
      if (vars.length === 1 && requireExamples) {
        const sample = header.example && Array.isArray(header.example.header_text) ? header.example.header_text[0] : null;
        if (typeof sample !== 'string' || !sample.trim()) errors.push('Add a sample value for the header variable {{1}}.');
      }
    } else if (!HEADER_MEDIA_TYPE[format]) {
      errors.push('header type must be one of: NONE, TEXT, IMAGE, VIDEO, DOCUMENT.');
    }
  }

  // footer
  if (footer) {
    const text = typeof footer.text === 'string' ? footer.text : '';
    if (!text.trim()) errors.push('The footer cannot be empty.');
    if (text.length > FOOTER_MAX) errors.push(`The footer can be at most ${FOOTER_MAX} characters.`);
    if (/\{\{|\}\}/.test(text)) errors.push('The footer cannot contain variables.');
  }

  // buttons
  if (buttonsComponent) {
    const buttons = Array.isArray(buttonsComponent.buttons) ? buttonsComponent.buttons : [];
    if (buttons.length === 0) errors.push('Add at least one button or remove the buttons section.');
    if (buttons.length > BUTTONS_MAX) errors.push(`A template can have at most ${BUTTONS_MAX} buttons.`);
    const urlCount = buttons.filter((b) => b && b.type === 'URL').length;
    const phoneCount = buttons.filter((b) => b && b.type === 'PHONE_NUMBER').length;
    if (urlCount > URL_BUTTONS_MAX) errors.push(`A template can have at most ${URL_BUTTONS_MAX} URL buttons.`);
    if (phoneCount > PHONE_BUTTONS_MAX) errors.push(`A template can have at most ${PHONE_BUTTONS_MAX} phone button.`);
    // Meta: quick replies sit together, before or after the URL / phone buttons.
    const quickIndexes = buttons.map((b, i) => (b && b.type === 'QUICK_REPLY' ? i : -1)).filter(i => i !== -1);
    if (quickIndexes.length > 1 && quickIndexes[quickIndexes.length - 1] - quickIndexes[0] + 1 !== quickIndexes.length) {
      errors.push('Quick-reply buttons must be grouped together - put them all before or all after the URL and phone buttons.');
    }
    const seenText = new Set();
    buttons.forEach((b, i) => {
      const label = `Button ${i + 1}`;
      if (!b || !['URL', 'PHONE_NUMBER', 'QUICK_REPLY'].includes(b.type)) {
        errors.push(`${label}: only URL, PHONE_NUMBER and QUICK_REPLY buttons are supported.`);
        return;
      }
      const text = typeof b.text === 'string' ? b.text.trim() : '';
      if (!text) errors.push(`${label}: button text is required.`);
      else if (text.length > BUTTON_TEXT_MAX) errors.push(`${label}: button text can be at most ${BUTTON_TEXT_MAX} characters.`);
      else if (seenText.has(text.toLowerCase())) errors.push(`${label}: button text must be different from the other buttons.`);
      seenText.add(text.toLowerCase());

      if (b.type === 'URL') {
        const urlError = checkButtonUrl(b.url);
        if (urlError) {
          errors.push(`${label}: ${urlError}.`);
        } else if (/\{\{1\}\}$/.test(b.url)) {
          const example = Array.isArray(b.example) ? b.example[0] : null;
          const prefix = b.url.replace(/\{\{1\}\}$/, '');
          if (typeof example !== 'string' || !example.startsWith(prefix) || example.length <= prefix.length) {
            errors.push(`${label}: a dynamic URL needs an example - a full link that starts with ${prefix} and fills in {{1}}.`);
          }
        }
      } else if (b.type === 'PHONE_NUMBER' && (typeof b.phone_number !== 'string' || !E164.test(b.phone_number))) {
        errors.push(`${label}: phone must be in international format, e.g. +919876543210.`);
      }
    });
  }

  return errors;
};

/**
 * Does this business_media row fit a `format` header (IMAGE / VIDEO / DOCUMENT)?
 * Used by PUT :id/header-media, create and the header-upload test script.
 * @returns {string|null} owner-readable error
 */
const validateHeaderMedia = (media, format) => {
  if (!HEADER_MEDIA_TYPE[format]) return 'This template does not have an image, video or document header';
  // business_media keeps no mimetype; r2.uploadImage names the object by it.
  const ext = extensionOf(media.r2_key);
  if (media.media_type !== HEADER_MEDIA_TYPE[format] || (ext && !EXTENSIONS_BY_FORMAT[format].includes(ext))) {
    return `This template's header needs ${HEADER_MEDIA_LABEL[format]}; the file you picked is a different type.`;
  }
  if (Number(media.file_size_bytes) > HEADER_MEDIA_MAX_BYTES[format]) {
    return `A ${format.toLowerCase()} header can be at most ${HEADER_MEDIA_MAX_BYTES[format] / (1024 * 1024)} MB.`;
  }
  return null;
};

module.exports = {
  CATEGORIES,
  LANGUAGES,
  HEADER_TYPES,
  HEADER_MEDIA_TYPE,
  validateName,
  validateCategory,
  validateLanguage,
  checkBodyVariables,
  checkButtonUrl,
  validateComponents,
  validateHeaderMedia
};
