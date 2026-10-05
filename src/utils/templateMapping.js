// What a stored message_templates row needs filled when it is sent, and the
// shared check that a variable mapping supplies exactly that. Pure.
//
// A mapping is a list of entries. Body entries are the original shape
// ({position, source, value?} for broadcasts, positional {source, value?,
// fallback?} for follow-ups) and have no `target`. Two optional additions:
//   target 'header'                      the TEXT header's {{1}}
//   target 'button' + buttonIndex        a dynamic URL button's {{1}} suffix
//                                        (buttonIndex = position in Meta's BUTTONS list)
// Used by broadcast.controller.js / broadcast.worker.js (broadcasts.variable_mapping)
// and utils/followup.js (followup_automations.template_variable_mapping).

const POSITIONAL = /\{\{\s*\d+\s*\}\}/g;
const NAMED = /\{\{\s*[a-z_][a-z0-9_]*\s*\}\}/gi;

const TARGETS = ['body', 'header', 'button'];
// Sources a button suffix may use: a fixed value, or the booking's code
// (booking follow-ups only — the caller enforces that part).
const BUTTON_SOURCES = ['static', 'booking.code'];

const distinct = (text, re) => new Set(((text || '').match(re) || []).map(m => m.replace(/\D/g, ''))).size;
const countPositional = (text) => distinct(text, POSITIONAL);
const countNamed = (text) => new Set(((text || '').match(NAMED) || []).map(m => m.replace(/[{}\s]/g, '').toLowerCase())).size;

/**
 * The template's Meta components: as last synced (meta_components), else what
 * an app-created template (never synced) amounts to — its header + body.
 */
const componentsOf = (template) => {
  if (template && Array.isArray(template.meta_components)) return template.meta_components;
  const out = [];
  if (template && template.header_type && template.header_type !== 'NONE') out.push({ type: 'HEADER', format: template.header_type });
  if (template && template.body_text) out.push({ type: 'BODY', text: template.body_text });
  return out;
};

const componentOfType = (template, type) => componentsOf(template).find(c => c && c.type === type) || null;

/** 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION' | ... or null when there's no header. */
const headerFormatOf = (template) => {
  const header = componentOfType(template, 'HEADER');
  return header && typeof header.format === 'string' ? header.format.toUpperCase() : null;
};

/** Button type → what we call it. Only URL and PHONE_NUMBER can be sent. */
const buttonsOf = (template) => {
  const component = componentOfType(template, 'BUTTONS');
  const list = component && Array.isArray(component.buttons) ? component.buttons : [];
  return list.map((b, index) => {
    const type = b && typeof b.type === 'string' ? b.type.toUpperCase() : 'UNKNOWN';
    const url = type === 'URL' && typeof b.url === 'string' ? b.url : null;
    return {
      index,
      type,
      text: b && typeof b.text === 'string' ? b.text : '',
      url,
      urlVariables: url ? countPositional(url) + countNamed(url) : 0,
      dynamic: !!url && countPositional(url) > 0
    };
  });
};

/**
 * What a send must fill:
 *   body     number of {{n}} in the body
 *   header   0 or 1 — a TEXT header with a {{1}}
 *   buttons  indexes of the dynamic URL buttons (each takes one suffix)
 */
const requiredParams = (template) => {
  const body = componentOfType(template, 'BODY');
  const header = componentOfType(template, 'HEADER');
  const headerVars = header && headerFormatOf(template) === 'TEXT' ? countPositional(header.text) : 0;
  return {
    body: countPositional(body ? body.text : (template && template.body_text)),
    header: headerVars > 0 ? 1 : 0,
    buttons: buttonsOf(template).filter(b => b.dynamic).map(b => b.index)
  };
};

const targetOf = (entry) => (entry && entry.target) || 'body';

/** Entries grouped by target, original order kept; `unknown` = entries with a target we don't know. */
const splitMapping = (mapping) => {
  const out = { body: [], header: [], button: [], unknown: [] };
  for (const entry of Array.isArray(mapping) ? mapping : []) {
    const target = targetOf(entry);
    (TARGETS.includes(target) ? out[target] : out.unknown).push(entry);
  }
  return out;
};

/**
 * Does `mapping` supply exactly the header / button params this template needs?
 * Body entries are counted only when `checkBody` (callers that already have
 * their own, older body check leave it off, so templates with no header or
 * button params validate exactly as before).
 * @returns {string|null} an owner-readable error, or null
 */
const checkParamCounts = (mapping, template, { checkBody = true } = {}) => {
  const need = requiredParams(template);
  const parts = splitMapping(mapping);
  if (parts.unknown.length > 0) return `variable mapping target must be one of: ${TARGETS.join(', ')}`;
  if (checkBody && parts.body.length !== need.body) {
    return `This template has ${need.body} body variable(s) but the mapping has ${parts.body.length}`;
  }
  if (parts.header.length !== need.header) {
    return need.header
      ? 'This template\'s header has a variable that needs a mapping entry with target "header"'
      : 'This template has no header variable — remove the mapping entry with target "header"';
  }
  const seen = new Set();
  for (const entry of parts.button) {
    const i = entry.buttonIndex;
    if (!Number.isInteger(i) || !need.buttons.includes(i)) {
      return `buttonIndex ${JSON.stringify(i)} is not a URL button with a variable (valid: ${need.buttons.length ? need.buttons.join(', ') : 'none'})`;
    }
    if (seen.has(i)) return `button ${i} has more than one mapping entry`;
    seen.add(i);
  }
  const missing = need.buttons.filter(i => !seen.has(i));
  if (missing.length > 0) return `URL button ${missing.join(', ')} has a variable that needs a mapping entry with target "button" and buttonIndex`;
  return null;
};

module.exports = {
  TARGETS,
  BUTTON_SOURCES,
  countPositional,
  countNamed,
  componentsOf,
  componentOfType,
  headerFormatOf,
  buttonsOf,
  requiredParams,
  targetOf,
  splitMapping,
  checkParamCounts
};
