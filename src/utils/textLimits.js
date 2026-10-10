// Single source of truth for the WhatsApp text limits the flow editor and the
// senders care about. The numbers live in flowSpec.js's LIMITS (also used by
// the AI-flow validators); this adds the pieces they don't have: the
// list-button label, the length convention, a safe truncate for send time, and
// the write-time checks for edge copy and button text.
//
// Length convention is the existing one everywhere else in the server:
// value.trim().length (UTF-16 units). No requires outside utils, so it loads
// in tests without any config.
const { LIMITS: FLOW_LIMITS } = require('./flowSpec');

const LIMITS = {
  ...FLOW_LIMITS,
  LIST_BUTTON_LABEL: FLOW_LIMITS.BUTTON_TITLE
};

const textLength = (value) => (typeof value === 'string' ? value.trim().length : 0);

const graphemeSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

/**
 * Cuts `value` to at most `max` UTF-16 units without splitting a character:
 * whole graphemes where Intl.Segmenter is available, whole code points
 * otherwise (and for a single grapheme longer than `max`). Unlike the .slice
 * it replaces, it never leaves half of a surrogate pair at the end.
 */
const truncate = (value, max) => {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= max) return text;

  const pieces = graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(text), (s) => s.segment)
    : Array.from(text);
  let out = '';
  for (const piece of pieces) {
    if (out.length + piece.length > max) break;
    out += piece;
  }
  if (out === '') {
    for (const point of Array.from(text)) {
      if (out.length + point.length > max) break;
      out += point;
    }
    out = out.replace(/‍$/, '');
  }
  return out;
};

/** Max row title for the edges leaving a reply node: 24 for a list, 20 for buttons, none otherwise. */
const edgeLabelLimit = (parentNodeType, parentContentType) => {
  if (parentNodeType !== 'reply') return null;
  if (parentContentType === 'list') return LIMITS.LIST_ROW_TITLE;
  if (parentContentType === 'buttons') return LIMITS.BUTTON_TITLE;
  return null;
};

const sameValue = (a, b) => (a ?? null) === (b ?? null);

const checkText = (value, existing, max, fieldLabel) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return `${fieldLabel} must be a string.`;
  if (sameValue(value, existing)) return null;
  if (max !== null && textLength(value) > max) return `${fieldLabel} must be ${max} characters or less.`;
  return null;
};

// Shape errors (not an object, bad language code, non-string value) stay with
// validateTranslationsMap; this only enforces the length, and only for values
// that differ from what is stored.
const checkTranslationLengths = (translations, existing, max, fieldLabel) => {
  if (max === null || !translations || typeof translations !== 'object' || Array.isArray(translations)) return null;
  for (const [code, value] of Object.entries(translations)) {
    if (typeof value !== 'string') continue;
    if (existing && sameValue(value, existing[code])) continue;
    if (textLength(value) > max) return `${fieldLabel} for language "${code}" must be ${max} characters or less.`;
  }
  return null;
};

/**
 * Write-time check for an edge's row copy. `existingEdge` is the stored
 * (snake_case) row, or null for a new edge: a field is only checked when it is
 * new or differs from the stored value, so a legacy over-limit row still saves
 * untouched. Description is limited to 72 whatever the parent is (a button
 * parent ignores it at send time). `prefix` is prepended to field names
 * (e.g. "edges[2].").
 */
const validateEdgeCopy = ({ parentNodeType, parentContentType, label, labelTranslations, description, descriptionTranslations }, existingEdge, prefix = '') => {
  const labelMax = edgeLabelLimit(parentNodeType, parentContentType);
  const descriptionMax = LIMITS.LIST_ROW_DESCRIPTION;
  return (
    checkText(label, existingEdge?.label, labelMax, `${prefix}label`) ||
    checkTranslationLengths(labelTranslations, existingEdge?.label_translations, labelMax, `${prefix}labelTranslations`) ||
    checkText(description, existingEdge?.description, descriptionMax, `${prefix}description`) ||
    checkTranslationLengths(descriptionTranslations, existingEdge?.description_translations, descriptionMax, `${prefix}descriptionTranslations`)
  );
};

/** Write-time check for a reply node's button_text (and its translations), same changed-only rule. */
const validateButtonText = ({ buttonText, buttonTextTranslations }, existingNode, prefix = '') => (
  checkText(buttonText, existingNode?.button_text, LIMITS.BUTTON_TITLE, `${prefix}buttonText`) ||
  checkTranslationLengths(buttonTextTranslations, existingNode?.button_text_translations, LIMITS.BUTTON_TITLE, `${prefix}buttonTextTranslations`)
);

module.exports = { LIMITS, textLength, truncate, edgeLabelLimit, validateEdgeCopy, validateButtonText };
