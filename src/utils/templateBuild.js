// Turns template input into the components we store, and stored templates into
// the payload Meta's create call takes. Pure; validation is
// utils/templateValidation.js.
//
// Stored shape = what Meta lists (and what the sync stores in
// message_templates.meta_components):
//   { type: 'HEADER', format: 'TEXT'|'IMAGE'|'VIDEO'|'DOCUMENT', text?, example?: { header_text: [s] } }
//   { type: 'BODY', text, example?: { body_text: [[s, ...]] } }
//   { type: 'FOOTER', text }
//   { type: 'BUTTONS', buttons: [{ type: 'URL', text, url, example?: [fullUrl] }
//                               | { type: 'PHONE_NUMBER', text, phone_number }
//                               | { type: 'QUICK_REPLY', text }] }
// A media header stores no example: its header_handle only exists at submit.
const { HEADER_TYPES, HEADER_MEDIA_TYPE, checkBodyVariables } = require('./templateValidation');
const { normalizeAction, ACTION_HELP } = require('./templateButtonTap');

/**
 * Components for the create API's input. Shape problems come back as `errors`
 * (a field of the wrong kind); content rules are templateValidation's job.
 * @param {{ header?: Object, bodyText: string, variableSamples?: string[], footerText?: string, buttons?: Array }} input
 * A QUICK_REPLY button may carry `action` (what a tap does, see templateButtonTap.js);
 * it is not part of the components - it comes back as `buttonActions` for
 * message_templates.button_actions, indexed by the button's position.
 * @returns {{ components: Array, errors: string[], buttonActions: Array }}
 */
const buildComponentsFromInput = ({ header, bodyText, variableSamples, footerText, buttons } = {}) => {
  const errors = [];
  const components = [];
  const buttonActions = [];

  if (header !== undefined && header !== null) {
    const type = header.type;
    if (!HEADER_TYPES.includes(type)) {
      errors.push(`header.type must be one of: ${HEADER_TYPES.join(', ')}`);
    } else if (type === 'TEXT') {
      const component = { type: 'HEADER', format: 'TEXT', text: header.text };
      if (typeof header.textSample === 'string' && header.textSample) component.example = { header_text: [header.textSample] };
      components.push(component);
    } else if (type !== 'NONE') {
      components.push({ type: 'HEADER', format: type });
    }
  }

  const body = { type: 'BODY', text: bodyText };
  if (Array.isArray(variableSamples) && variableSamples.length > 0 && checkBodyVariables(bodyText || '').count > 0) body.example = { body_text: [variableSamples] };
  components.push(body);

  if (footerText !== undefined && footerText !== null && footerText !== '') {
    components.push({ type: 'FOOTER', text: footerText });
  }

  if (buttons !== undefined && buttons !== null) {
    if (!Array.isArray(buttons)) {
      errors.push('buttons must be a list');
    } else if (buttons.length > 0) {
      const stored = [];
      buttons.forEach((b, i) => {
        const label = `Button ${i + 1}`;
        if (!b) {
          errors.push(`${label}: type must be URL, PHONE_NUMBER or QUICK_REPLY.`);
        } else if (b.type === 'QUICK_REPLY') {
          stored.push({ type: 'QUICK_REPLY', text: b.text });
          if (b.action !== undefined && b.action !== null) {
            const action = normalizeAction(b.action);
            if (action) buttonActions.push({ index: i, text: typeof b.text === 'string' ? b.text.trim() : b.text, action });
            else errors.push(`${label}: ${ACTION_HELP}.`);
          }
        } else if (b.type === 'URL') {
          const hasVar = typeof b.url === 'string' && /\{\{/.test(b.url);
          if (b.dynamic && !/\{\{1\}\}$/.test(b.url || '')) {
            errors.push(`${label}: a dynamic URL must end with {{1}}.`);
          } else if (!b.dynamic && hasVar) {
            errors.push(`${label}: this URL has a variable - set dynamic: true and give an example.`);
          }
          const button = { type: 'URL', text: b.text, url: b.url };
          if (b.dynamic && typeof b.example === 'string') button.example = [b.example];
          stored.push(button);
        } else if (b.type === 'PHONE_NUMBER') {
          stored.push({ type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone });
        } else {
          errors.push(`${label}: type must be URL, PHONE_NUMBER or QUICK_REPLY.`);
        }
      });
      components.push({ type: 'BUTTONS', buttons: stored });
    }
  }
  return { components, errors, buttonActions };
};

/**
 * The components a template is submitted from: its stored meta_components, or
 * for rows made before those existed (legacy drafts, the demo reminder
 * template) the header / body its columns amount to. Rebuilt field by field so
 * nothing Meta only returns (ids, status, ...) goes back out.
 * @param {Object} row  message_templates row (snake_case)
 * @returns {Array} stored-shape components, media headers without their handle
 */
const componentsForSubmit = (row) => {
  const samples = Array.isArray(row.variable_samples) && row.variable_samples.length > 0 ? row.variable_samples : null;
  const source = Array.isArray(row.meta_components)
    ? row.meta_components
    : [
      ...(row.header_type && row.header_type !== 'NONE' ? [{ type: 'HEADER', format: row.header_type }] : []),
      { type: 'BODY', text: row.body_text }
    ];

  const out = [];
  for (const c of source) {
    if (!c) continue;
    if (c.type === 'HEADER') {
      const format = String(c.format || '').toUpperCase();
      const header = { type: 'HEADER', format };
      if (format === 'TEXT') {
        header.text = c.text;
        if (c.example && Array.isArray(c.example.header_text)) header.example = { header_text: c.example.header_text };
      }
      out.push(header);
    } else if (c.type === 'BODY') {
      const body = { type: 'BODY', text: c.text };
      if (c.example && Array.isArray(c.example.body_text)) body.example = { body_text: c.example.body_text };
      else if (samples && checkBodyVariables(c.text || '').count > 0) body.example = { body_text: [samples] };
      out.push(body);
    } else if (c.type === 'FOOTER') {
      out.push({ type: 'FOOTER', text: c.text });
    } else if (c.type === 'BUTTONS') {
      out.push({
        type: 'BUTTONS',
        buttons: (c.buttons || []).map((b) => {
          if (b && b.type === 'URL') {
            return { type: 'URL', text: b.text, url: b.url, ...(Array.isArray(b.example) ? { example: b.example } : {}) };
          }
          if (b && b.type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number };
          if (b && b.type === 'QUICK_REPLY') return { type: 'QUICK_REPLY', text: b.text };
          return b;
        })
      });
    }
  }
  // Meta wants header, body, footer, buttons in that order.
  const rank = { HEADER: 0, BODY: 1, FOOTER: 2, BUTTONS: 3 };
  return out.sort((a, b) => rank[a.type] - rank[b.type]);
};

/** The media header's format when the submit needs an upload (IMAGE / VIDEO / DOCUMENT), else null. */
const mediaHeaderFormatOf = (components) => {
  const header = components.find((c) => c.type === 'HEADER');
  return header && HEADER_MEDIA_TYPE[header.format] ? header.format : null;
};

/**
 * Meta's POST /{waba}/message_templates body.
 * @param {Object} row  message_templates row (snake_case)
 * @param {{ headerHandle?: string }} [options]  from the resumable upload; required for media headers
 */
const buildMetaCreatePayload = (row, { headerHandle } = {}) => {
  const components = componentsForSubmit(row).map((c) => {
    if (c.type === 'HEADER' && HEADER_MEDIA_TYPE[c.format]) {
      if (!headerHandle) throw new Error(`A ${c.format} header needs an uploaded header_handle`);
      return { type: 'HEADER', format: c.format, example: { header_handle: [headerHandle] } };
    }
    return c;
  });
  return { name: row.name, category: row.category, language: row.language, components };
};

module.exports = {
  buildComponentsFromInput,
  componentsForSubmit,
  mediaHeaderFormatOf,
  buildMetaCreatePayload
};
