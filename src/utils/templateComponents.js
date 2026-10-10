// The one place that turns a message_templates row + values into the
// `components` array of a Meta template send (POST /messages, type 'template').
// Pure: no I/O. Used by the broadcast controller + worker and
// windowAwareSend.service.js (follow-ups, demo reminders).
//
// Order is header, body, buttons (what Meta documents). Quick-reply buttons go
// out with the payload "tpl:<templateId>:<buttonIndex>" that inbound button
// routing decodes (utils/templateButtonTap.js).
const { headerMediaLinkOf } = require('./templateSendSupport');
const { buttonsOf } = require('./templateMapping');
const { buildTapPayload } = require('./templateButtonTap');
const { cleanValue } = require('./templateValue');

const MEDIA_HEADER_TYPES = { IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document' };

// Meta rejects newlines, tabs and 4+ consecutive spaces in a parameter, so
// every text value is cleaned here, whatever path built it.
const textParams = (values) => values.map((v) => ({ type: 'text', text: cleanValue(v) }));

/**
 * Body component for already-resolved {{1}}..{{n}} values, or [] when there
 * are none (Meta rejects an empty body component).
 * @param {Array<string|number>} values
 */
const buildBodyComponents = (values) => (values && values.length > 0
  ? [{ type: 'body', parameters: textParams(values) }]
  : []);

/**
 * Header component for the template's media header, or null. `media` can
 * override the stored link / filename.
 */
const buildMediaHeader = (template, media) => {
  const kind = template && MEDIA_HEADER_TYPES[template.header_type];
  if (!kind) return null;
  const link = media && media.link !== undefined ? media.link : headerMediaLinkOf(template);
  const filename = media && media.filename !== undefined ? media.filename : template.header_media_filename;
  const payload = kind === 'document' && filename ? { link, filename } : { link };
  return { type: 'header', parameters: [{ type: kind, [kind]: payload }] };
};

/** One button component per dynamic URL suffix, in index order. */
const buildButtonComponents = (buttons) => Object.keys(buttons || {})
  .map(Number)
  .sort((a, b) => a - b)
  .map((index) => ({
    type: 'button',
    sub_type: 'url',
    index: String(index),
    parameters: [{ type: 'text', text: cleanValue(buttons[index], { multiline: true }) }]
  }));

/**
 * One quick_reply button component per QUICK_REPLY button of the template, in
 * index order. [] when the row has no id (nothing to put in the payload) or no
 * quick-reply buttons.
 * @param {Object} template  message_templates row (snake_case): id, meta_components
 */
const buildQuickReplyComponents = (template) => (template && template.id
  ? buttonsOf(template).filter(b => b.type === 'QUICK_REPLY').map(b => ({
    type: 'button',
    sub_type: 'quick_reply',
    index: String(b.index),
    parameters: [{ type: 'payload', payload: buildTapPayload(template.id, b.index) }]
  }))
  : []);

/**
 * @param {Object} template  message_templates row (snake_case): id, header_type,
 *   header_media_url / header_image_url / header_media_filename
 * @param {{ body?: Array<string|number>, header?: Array<string|number>, buttons?: Object<number, string> }} [values]
 *   body: {{1}}..{{n}}; header: the TEXT header's {{1}} (one value);
 *   buttons: { [buttonIndex]: suffix } for dynamic URL buttons;
 *   quickReplies: ready-made quick_reply components (buildQuickReplyComponents) for
 *   a caller that has no template row, else they're derived from `template`
 * @param {{ link?: string, filename?: string }} [media]  override for the media header
 * @returns {Array} Meta send `components`
 */
const buildTemplateComponents = (template, { body, header, buttons, quickReplies } = {}, media = null) => {
  const components = [];
  if (template && template.header_type === 'TEXT') {
    if (header && header.length > 0) components.push({ type: 'header', parameters: textParams(header) });
  } else {
    const mediaHeader = buildMediaHeader(template, media);
    if (mediaHeader) components.push(mediaHeader);
  }
  const buttonComponents = [...buildButtonComponents(buttons), ...(quickReplies || buildQuickReplyComponents(template))]
    .sort((a, b) => Number(a.index) - Number(b.index));
  components.push(...buildBodyComponents(body), ...buttonComponents);
  return components;
};

/** The media header as the chat shows it: { type: 'image'|'video'|'document', link }, or null. */
const headerMediaOf = (template) => {
  const kind = template && MEDIA_HEADER_TYPES[template.header_type];
  const link = kind ? headerMediaLinkOf(template) : null;
  return kind && link ? { type: kind, link } : null;
};

module.exports = { buildTemplateComponents, buildBodyComponents, buildButtonComponents, buildQuickReplyComponents, headerMediaOf };
