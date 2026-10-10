// The one place a value is cleaned before it goes into outgoing text.
// WhatsApp bolds *text* only when there is no space just inside the asterisks,
// and Meta rejects template parameters holding newlines, tabs or 4+ spaces,
// so a stray space in a business or customer name breaks a message.
// Pure: no I/O.

/**
 * A value ready to drop into text. null / undefined read as ''.
 * Default: every run of whitespace (spaces, tabs, newlines) becomes one space
 * and the ends are trimmed. `multiline: true` trims the ends only, for
 * free text whose inner line breaks matter (address, business hours).
 * @param {*} value
 * @param {{ multiline?: boolean }} [options]
 * @returns {string}
 */
const cleanValue = (value, { multiline = false } = {}) => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return multiline ? text.trim() : text.replace(/\s+/g, ' ').trim();
};

/**
 * Fills {{name}} marks in one pass. Each value is cleaned (see cleanValue)
 * unless `clean: false` (the caller cleaned it already, e.g. multiline text).
 * A mark with no entry in `vars` is left as written, and a value is never
 * scanned for marks or read for `$` patterns.
 * @param {string} text
 * @param {Object} vars
 * @param {{ clean?: boolean }} [options]
 * @returns {string}
 */
const fillPlaceholders = (text, vars, { clean = true } = {}) => (vars
  ? text.replace(/\{\{(\w+)\}\}/g, (mark, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return mark;
    return clean ? cleanValue(vars[name]) : String(vars[name]);
  })
  : text);

module.exports = { cleanValue, fillPlaceholders };
