// Shared CSV writing. csvCell is what storageCleanup.service.js used to carry privately; it now also
// neutralises spreadsheet formula injection (Excel / Sheets run a cell that starts with = + - @).

const FORMULA_START = /^[=+\-@\t\r]/;
// A phone / plain number (digits, optional leading +, spaces, hyphens, brackets) is not a formula. A leading '
// would show up literally in the CSV file (it only hides in a typed cell), so such a cell is left as it is.
const PHONE_OR_NUMBER = /^\+?[0-9][0-9 ()-]*$/;

/**
 * One CSV cell. null/undefined -> empty; objects -> JSON. A text cell that starts with = + - @ tab or CR
 * gets a leading apostrophe so a spreadsheet shows it as text instead of evaluating it, unless the whole
 * cell is a phone / plain number. Numbers and booleans are never text from user input, so a negative
 * number keeps its minus sign.
 */
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const isTyped = typeof v === 'number' || typeof v === 'boolean';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (!isTyped && FORMULA_START.test(s) && !PHONE_OR_NUMBER.test(s)) s = `'${s}`;
  return /[",\n\r\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Header line plus one line per row. `columns` is [{ key, header }]; text ends with a newline. */
const toCsv = (columns, rows) => {
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c.key])).join(','));
  return `${lines.join('\n')}\n`;
};

module.exports = { csvCell, toCsv };
