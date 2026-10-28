// Guards an active booking session against interactive taps that are not answers to the current question
// (an older welcome message's list row, a catalogue button, a template button). Used by webhook.controller.js
// Step 12 and flowGraphPreview.controller.js so the real bot and the preview behave the same.
const { UUID_RE } = require('./catalogIds');
const { getSystemMessage } = require('./systemMessages');

// Field types whose answer IS a tap. Everything else (text, textarea, location_request, ...) takes typed text.
const CHOICE_FIELD_TYPES = new Set(['buttons', 'list', 'vehicle_carousel']);

const isChoiceFieldType = (fieldType) => CHOICE_FIELD_TYPES.has(fieldType);

// A flow_edges id / flow_nodes id, "{node_id}:{index|other}", or a system tap id (lang_ / optin_ / cat:).
// Deliberately uuid-anchored: a bare "{x}:{n}" shape would also catch a typed "10:30".
const SYSTEM_ID_PREFIXES = ['lang_', 'optin_', 'cat:'];
const isInternalId = (value) => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (SYSTEM_ID_PREFIXES.some(prefix => trimmed.startsWith(prefix))) return true;
  const colonIdx = trimmed.indexOf(':');
  return UUID_RE.test(colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx));
};

/** The booking question with the hint above it: "type your answer" for a typed question, "tap an option" for a choice. */
const withTapHint = (label, languageCode, fieldType) => {
  const hint = getSystemMessage(isChoiceFieldType(fieldType) ? 'bookingTapHintChoice' : 'bookingTapHintText', languageCode);
  return label ? `${hint}\n\n${label}` : hint;
};

module.exports = { isChoiceFieldType, isInternalId, withTapHint };
