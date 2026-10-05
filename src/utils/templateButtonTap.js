// A customer tapping a template's quick-reply button arrives as a WhatsApp
// message of type 'button' with { payload, text }. This decides what that tap
// means. Pure: no I/O (services/templateButtonTap.service.js loads the template).
//
// Payloads we send are "tpl:<templateId>:<buttonIndex>". A button whose payload
// isn't ours (a template made in WhatsApp Manager, Meta's own "Stop promotions"
// button) carries Meta's default - the button's text.
const { buttonsOf } = require('./templateMapping');

const TAP_PAYLOAD_PATTERN = /^tpl:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,2})$/i;

const ACTION_TYPES = ['keyword', 'node', 'menu', 'optout'];
const KEYWORD_MAX = 100;

// Typed words that already mean STOP (webhook.controller.js STOP_KEYWORDS) plus
// the labels Meta / other tools put on an opt-out button.
const OPT_OUT_TEXTS = new Set(['stop', 'unsubscribe', 'stop promotions', 'stop promotion', 'opt out']);

/** @returns {string} the payload sent with a template's quick-reply button */
const buildTapPayload = (templateId, index) => `tpl:${templateId}:${index}`;

/** @returns {{ templateId: string, index: number }|null} null when the payload isn't one of ours */
const parseTapPayload = (payload) => {
  const match = TAP_PAYLOAD_PATTERN.exec(typeof payload === 'string' ? payload : '');
  return match ? { templateId: match[1].toLowerCase(), index: Number(match[2]) } : null;
};

const normalize = (text) => String(text === null || text === undefined ? '' : text)
  .trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!\s]+$/, '');

/** Does this typed / button text mean "stop messaging me"? */
const isOptOutText = (text) => OPT_OUT_TEXTS.has(normalize(text));

/**
 * Is `action` a well-formed button action? (Whether a node id really belongs to
 * the business is the caller's check.)
 * @returns {boolean}
 */
const isValidAction = (action) => {
  if (!action || typeof action !== 'object' || !ACTION_TYPES.includes(action.type)) return false;
  if (action.type === 'keyword') {
    return typeof action.keyword === 'string' && action.keyword.trim().length > 0 && action.keyword.length <= KEYWORD_MAX;
  }
  if (action.type === 'node') return typeof action.nodeId === 'string' && action.nodeId.length > 0;
  return true;
};

const ACTION_HELP = 'action must be { type: "keyword", keyword }, { type: "node", nodeId }, { type: "menu" } or { type: "optout" }';

/** A valid action cut down to its known fields (keyword trimmed), or null. */
const normalizeAction = (action) => {
  if (!isValidAction(action)) return null;
  if (action.type === 'keyword') return { type: 'keyword', keyword: action.keyword.trim() };
  if (action.type === 'node') return { type: 'node', nodeId: action.nodeId };
  return { type: action.type };
};

/**
 * The button_actions value for a template from owner input
 * [{ index, action }]: each index must be one of the template's QUICK_REPLY
 * buttons; the button's current text is stored with it (a tap only uses an
 * entry whose text still matches). A null / missing action removes that
 * button's action. Whether a node id belongs to the business is the caller's
 * check (templateButtonTap.service.js#checkActionNodes).
 * @param {Object} template  message_templates row (snake_case)
 * @param {Array<{ index: number, action?: Object|null }>} input
 * @returns {{ buttonActions?: Array, error?: string }}
 */
const buildButtonActions = (template, input) => {
  if (!Array.isArray(input)) return { error: 'actions must be a list of { index, action }' };
  const buttons = buttonsOf(template);
  const seen = new Set();
  const buttonActions = [];
  for (const entry of input) {
    const index = entry && entry.index;
    const button = Number.isInteger(index) ? buttons.find(b => b.index === index) : null;
    if (!button || button.type !== 'QUICK_REPLY') {
      return { error: 'index ' + JSON.stringify(index) + ' is not a quick-reply button of this template' };
    }
    if (seen.has(index)) return { error: 'button ' + index + ' has more than one entry' };
    seen.add(index);
    if (entry.action === null || entry.action === undefined) continue;
    const action = normalizeAction(entry.action);
    if (!action) return { error: 'Button ' + index + ': ' + ACTION_HELP };
    buttonActions.push({ index, text: button.text, action });
  }
  return { buttonActions: buttonActions.sort((a, b) => a.index - b.index) };
};

/**
 * What a tap means.
 * @param {{ button: { payload?: string, text?: string }, template?: { button_actions?: Array }|null }} input
 *   template = the message_templates row the payload names, already scoped to
 *   this business (null when absent, other business's, or not loadable)
 * @returns {{ kind: 'optout' } | { kind: 'action', action: Object } | { kind: 'text', text: string } | null}
 *   null = nothing to act on (no label, no payload)
 */
const decideTap = ({ button, template = null }) => {
  const payload = button && typeof button.payload === 'string' ? button.payload : '';
  const text = button && typeof button.text === 'string' ? button.text.trim() : '';
  const parsed = parseTapPayload(payload);

  if (parsed && template && Array.isArray(template.button_actions)) {
    const entry = template.button_actions.find(e => e && e.index === parsed.index && typeof e.text === 'string' && e.text.trim() === text);
    if (entry && isValidAction(entry.action)) {
      return entry.action.type === 'optout' ? { kind: 'optout' } : { kind: 'action', action: entry.action };
    }
  }

  // No usable action: judge it by what the customer read on the button. Our own
  // payload is an opaque id; anyone else's is Meta's default (the text).
  if (isOptOutText(text) || (!parsed && isOptOutText(payload))) return { kind: 'optout' };
  const typed = text || (parsed ? '' : payload.trim());
  return typed ? { kind: 'text', text: typed } : null;
};

module.exports = {
  ACTION_TYPES, ACTION_HELP, KEYWORD_MAX, buildTapPayload, parseTapPayload, isOptOutText, isValidAction, normalizeAction, buildButtonActions, decideTap
};
