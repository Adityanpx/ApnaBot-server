// A customer tapping a template's quick-reply button arrives as a WhatsApp
// message of type 'button' with { payload, text }. This decides what that tap
// means. Pure: no I/O (services/templateButtonTap.service.js loads the template).
//
// Payloads we send are "tpl:<templateId>:<buttonIndex>". A button whose payload
// isn't ours (a template made in WhatsApp Manager, Meta's own "Stop promotions"
// button) carries Meta's default - the button's text.
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

module.exports = { ACTION_TYPES, KEYWORD_MAX, buildTapPayload, parseTapPayload, isOptOutText, isValidAction, decideTap };
