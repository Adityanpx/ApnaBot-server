// Can ApnaBot's sender send this template? One answer, computed from the
// stored message_templates row, used when the template is synced, when header
// media is attached, and again at send time (broadcast send, follow-up sweep,
// windowAwareSend) so a template that changed since it was stored is skipped
// with a reason instead of being sent as something Meta rejects.
//
//   unsupported_named_params  parameter_format NAMED ({{name}} variables)
//   unsupported_component     a button we can't send (QUICK_REPLY, COPY_CODE, FLOW,
//                             CATALOG, OTP, ...), a URL with several variables, a
//                             TEXT header with several variables, a LOCATION /
//                             unknown header, or any component but header / body /
//                             footer / buttons
//   needs_header_media        IMAGE / VIDEO / DOCUMENT header with no media of the
//                             right type attached
//   ok                        everything else: body variables, one TEXT header
//                             variable, static or dynamic URL buttons, phone
//                             buttons (FOOTER and a variable-free header are
//                             added by Meta — nothing to send)
// Checked in that order when several apply. Pure.
const { componentsOf, componentOfType, headerFormatOf, buttonsOf, countPositional, countNamed } = require('./templateMapping');

const SENDABLE_BUTTON_TYPES = ['URL', 'PHONE_NUMBER'];

// File extension (as r2.uploadImage writes it: the mimetype's subtype) each
// header format can be sent from. An unknown / missing extension isn't judged.
const EXTENSIONS_BY_FORMAT = {
  IMAGE: ['jpg', 'jpeg', 'png'],
  VIDEO: ['mp4'],
  DOCUMENT: ['pdf']
};

const extensionOf = (url) => {
  const m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(typeof url === 'string' ? url : '');
  return m ? m[1].toLowerCase() : null;
};

/**
 * The media link a send uses for this template's header, or null.
 * header_media_url first; header_image_url is the fallback for IMAGE headers
 * (templates made in ApnaBot before header media existed).
 */
const headerMediaLinkOf = (template) => {
  if (!template) return null;
  const format = headerFormatOf(template) || template.header_type;
  if (template.header_media_url) return template.header_media_url;
  if (format === 'IMAGE' && template.header_image_url) return template.header_image_url;
  return null;
};

/** Is `url` plausibly a `format` file (by extension)? Unknown extensions pass. */
const mediaMatchesFormat = (url, format) => {
  const ext = extensionOf(url);
  return !ext || (EXTENSIONS_BY_FORMAT[format] || []).includes(ext);
};

/**
 * @param {Object} template  message_templates row (snake_case): meta_components,
 *   parameter_format (optional), header_type, body_text, header_media_url, header_image_url
 * @returns {'ok'|'needs_header_media'|'unsupported_named_params'|'unsupported_component'}
 */
const computeSendSupport = (template) => {
  const body = componentOfType(template, 'BODY');
  const named = String((template && template.parameter_format) || '').toUpperCase() === 'NAMED'
    || countNamed(body && body.text) > 0;
  if (named) return 'unsupported_named_params';

  if (componentsOf(template).some(c => c && !['HEADER', 'BODY', 'FOOTER', 'BUTTONS'].includes(c.type))) return 'unsupported_component';

  for (const button of buttonsOf(template)) {
    if (!SENDABLE_BUTTON_TYPES.includes(button.type)) return 'unsupported_component';
    if (button.type === 'URL' && (!button.url || button.urlVariables > 1)) return 'unsupported_component';
  }

  const header = componentOfType(template, 'HEADER');
  if (header) {
    const format = headerFormatOf(template);
    if (format === 'TEXT') {
      if (countNamed(header.text) > 0 || countPositional(header.text) > 1) return 'unsupported_component';
    } else if (format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT') {
      const link = headerMediaLinkOf(template);
      if (!link || !mediaMatchesFormat(link, format)) return 'needs_header_media';
    } else {
      return 'unsupported_component';
    }
  }
  return 'ok';
};

module.exports = { computeSendSupport, headerMediaLinkOf, mediaMatchesFormat, extensionOf, EXTENSIONS_BY_FORMAT };
