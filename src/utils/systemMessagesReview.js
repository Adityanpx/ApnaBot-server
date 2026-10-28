// Pure helpers behind scripts/exportSystemMessagesForReview.js and
// scripts/importReviewedSystemMessages.js: the review CSV (build / parse), the placeholder check,
// and the static per-language module that utils/systemMessages.js loads. No DB, no network.
const { parse: parseCsvSync } = require('csv-parse/sync');
const { placeholdersOf, isFaithful } = require('./translateProtect');

// The 8 languages that have no hand-written system messages yet (hi / mr live in systemMessages.js).
const REVIEW_LANGUAGES = ['gu', 'kn', 'ta', 'te', 'ml', 'bn', 'pa', 'or'];
// Never translated in a system message: brand and payment names, and the words a customer must type
// (menu / STOP / START), which the bot matches exactly.
const PROTECTED_TERMS = ['ApnaBot', 'WhatsApp', 'UPI', 'OTP', 'Razorpay', 'menu', 'STOP', 'START'];
const CSV_COLUMNS =['key', 'english', 'machine_translation', 'reviewed_translation', 'notes'];

const csvField = (value) => {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** rows: [{ key, english, machine_translation?, reviewed_translation?, notes? }] -> CSV text (no BOM). */
const buildCsv = (rows) => [CSV_COLUMNS, ...rows.map((r) => CSV_COLUMNS.map((c) => r[c]))]
  .map((line) => line.map(csvField).join(','))
  .join('\r\n') + '\r\n';

/** CSV text -> [{ key, english, machine_translation, reviewed_translation, notes }]. Throws on a missing column. */
const parseCsv = (text) => {
  const records = parseCsvSync(String(text), { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true });
  const header = records.length ? Object.keys(records[0]) : null;
  if (header) {
    const missing = CSV_COLUMNS.filter((c) => !header.includes(c));
    if (missing.length) throw new Error(`CSV is missing column(s): ${missing.join(', ')}`);
  }
  return records.map((r) => ({
    key: String(r.key || '').trim(),
    english: String(r.english || ''),
    machine_translation: String(r.machine_translation || ''),
    reviewed_translation: String(r.reviewed_translation || '').replace(/\r\n/g, '\n').trim(),
    notes: String(r.notes || '')
  }));
};

/** { ok: true } when `translated` has exactly the English {{placeholders}} (as a multiset). */
const checkPlaceholders = (english, translated) => {
  const a = placeholdersOf(english).sort();
  const b = placeholdersOf(translated).sort();
  if (a.length === b.length && a.every((p, i) => p === b[i])) return { ok: true };
  return { ok: false, reason: `placeholders differ: English has [${a.join(' ')}], translation has [${b.join(' ')}]` };
};

/** null when `translated` contains every PROTECTED_TERMS word exactly as often as `english` does, else why not. */
const checkProtectedTerms = (english, translated) => {
  const count = (text, term) => String(text).split(term).length - 1;
  for (const term of PROTECTED_TERMS) {
    if (count(english, term) !== count(translated, term)) return `"${term}" was translated or lost: it must stay exactly as typed`;
  }
  return null;
};

/** What the exporter writes in `notes` for a row. */
const exportNotes = (english, problem) => {
  const notes = [];
  const ph = placeholdersOf(english);
  if (ph.length) notes.push(`Keep unchanged: ${[...new Set(ph)].join(' ')}`);
  if (/\*[^*\n]+\*/.test(english)) notes.push('*bold* markers must stay around the same words');
  if (/\n/.test(english)) notes.push('Keep the line breaks');
  if (problem) notes.push(`Machine translation unavailable: ${problem}`);
  return notes.join('; ');
};

/**
 * Reviewed CSV rows -> what to write. Rows with an empty reviewed_translation (or `column`) are skipped; a row
 * whose key is unknown or whose placeholders differ from English is rejected (and listed); other
 * formatting differences are only warned about.
 * @param {Object} englishByKey  key -> English text
 * @param {string} [column]  CSV column holding the text: 'reviewed_translation' (default) or 'machine_translation'
 * @returns {{ accepted: Object<string,string>, rejected: {key:string, reason:string}[], warnings: {key:string, reason:string}[], skippedEmpty: number }}
 */
const validateReviewed = (rows, englishByKey, column = 'reviewed_translation') => {
  const accepted = {};
  const rejected = [];
  const warnings = [];
  let skippedEmpty = 0;
  for (const row of rows) {
    const text = row[column];
    if (!text) { skippedEmpty += 1; continue; }
    const english = englishByKey[row.key];
    if (english === undefined) { rejected.push({ key: row.key, reason: 'unknown key' }); continue; }
    if (Object.prototype.hasOwnProperty.call(accepted, row.key)) { rejected.push({ key: row.key, reason: 'duplicate key in the CSV' }); continue; }
    const ph = checkPlaceholders(english, text);
    if (!ph.ok) { rejected.push({ key: row.key, reason: ph.reason }); continue; }
    const format = isFaithful(english, text);
    if (format) warnings.push({ key: row.key, reason: format });
    accepted[row.key] = text;
  }
  return { accepted, rejected, warnings, skippedEmpty };
};

/**
 * Source of src/i18n/systemMessages.<lang>.js (source 'reviewed') or systemMessages.<lang>.machine.js
 * (source 'machine'): keys in `keyOrder` first, then any others.
 */
const buildLangModule = (lang, messages, keyOrder, source = 'reviewed') => {
  const ordered = {};
  for (const key of [...keyOrder, ...Object.keys(messages)]) {
    if (Object.prototype.hasOwnProperty.call(messages, key)) ordered[key] = messages[key];
  }
  const header = source === 'machine'
    ? `// MACHINE-TRANSLATED system messages for '${lang}' (Azure Translator) - NOT native-reviewed. GENERATED by\n`
      + '// scripts/importReviewedSystemMessages.js --source=machine from docs/translations-review/. A native-reviewed key in\n'
      + `// systemMessages.${lang}.js overrides the same key here; remove keys from this file as they get reviewed.\n`
    : `// Native-reviewed system messages for '${lang}'. GENERATED by scripts/importReviewedSystemMessages.js\n`
      + '// from docs/translations-review/ - re-run that script instead of editing by hand.\n';
  return header
    + '// Keys missing here fall back to English (utils/systemMessages.js).\n'
    + `module.exports = ${JSON.stringify(ordered, null, 2)};\n`;
};

module.exports = {
  REVIEW_LANGUAGES, PROTECTED_TERMS, CSV_COLUMNS, buildCsv, parseCsv, checkPlaceholders, checkProtectedTerms, exportNotes, validateReviewed, buildLangModule
};
