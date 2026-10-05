// The one place that turns a message_templates row + values into the
// `components` array of a Meta template send (POST /messages, type 'template').
// Pure: no I/O. Used by the broadcast controller + worker and
// windowAwareSend.service.js (follow-ups, demo reminders).
//
// Step A scope: body variables + the IMAGE header, exactly as the senders
// built them before. `header` / `buttons` are reserved for header variables
// and URL buttons and are not read yet.

/**
 * Body component for already-resolved {{1}}..{{n}} values, or [] when there
 * are none (Meta rejects an empty body component).
 * @param {Array<string|number>} values
 */
const buildBodyComponents = (values) => (values && values.length > 0
  ? [{ type: 'body', parameters: values.map((v) => ({ type: 'text', text: String(v) })) }]
  : []);

/**
 * @param {Object} template  message_templates row (snake_case): header_type, header_image_url
 * @param {{ body?: Array<string|number>, header?: *, buttons?: * }} [values]
 * @param {{ link?: string }} [media]  header media override; defaults to the template's own
 * @returns {Array} Meta send `components`
 */
const buildTemplateComponents = (template, { body } = {}, media = null) => {
  const components = buildBodyComponents(body);
  if (template && template.header_type === 'IMAGE') {
    const link = media && media.link !== undefined ? media.link : template.header_image_url;
    components.unshift({ type: 'header', parameters: [{ type: 'image', image: { link } }] });
  }
  return components;
};

module.exports = { buildTemplateComponents, buildBodyComponents };
