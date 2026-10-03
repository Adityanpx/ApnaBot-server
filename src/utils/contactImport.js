// Contact import — the pure parts (contactImport.service.js does the I/O):
// table shape, column detection / mapping, name building, row
// classification, Google Sheet URL parsing and the redirect guard.
//
// A table is { headers: string[], rows: string[][] } — the first non-empty
// row of the file is the header row; every cell is a string.
// A mapping picks columns by index:
//   { phoneColumn, nameColumn, firstNameColumn, lastNameColumn }
// phoneColumn is required; the name comes from nameColumn, or from
// firstNameColumn + lastNameColumn ("Rahul" + "Patil" → "Rahul Patil") when
// there's no full-name column. Any of the name columns may be null.

const { normalizePhone } = require('./phone');

const MAX_ROWS = 5000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SAMPLE_ROWS = 20;
const NAME_MAX_LENGTH = 100;

// Header text → comparable key: lowercase, letters and digits only
// ("Phone Number" / "phone_number" / "PHONE-NUMBER" → "phonenumber").
const headerKey = (header) => String(header || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// In priority order — the first header that matches wins.
const NAME_HEADERS = ['name', 'fullname', 'customername', 'contactname', 'customer'];
const PHONE_HEADERS = [
  'phone', 'mobile', 'whatsapp', 'phonenumber', 'mobilenumber', 'whatsappnumber',
  'contactnumber', 'mobileno', 'phoneno', 'contact', 'number'
];
const FIRST_NAME_HEADERS = ['firstname', 'first', 'fname', 'givenname'];
const LAST_NAME_HEADERS = ['lastname', 'last', 'lname', 'surname'];

const MAPPING_KEYS = ['phoneColumn', 'nameColumn', 'firstNameColumn', 'lastNameColumn'];

/** Index of the first header (by priority list) that matches, or null. */
const findColumn = (keys, candidates) => {
  for (const candidate of candidates) {
    const index = keys.indexOf(candidate);
    if (index !== -1) return index;
  }
  return null;
};

/** The detected mapping for these headers (any column may be null). */
const detectMapping = (headers) => {
  const keys = headers.map(headerKey);
  const nameColumn = findColumn(keys, NAME_HEADERS);
  return {
    phoneColumn: findColumn(keys, PHONE_HEADERS),
    nameColumn,
    // First + last only when there's no full-name column.
    firstNameColumn: nameColumn === null ? findColumn(keys, FIRST_NAME_HEADERS) : null,
    lastNameColumn: nameColumn === null ? findColumn(keys, LAST_NAME_HEADERS) : null
  };
};

/**
 * Checks a mapping from a request (or the detected one) against the table.
 * @returns {{ mapping: Object } | { error: string }}
 */
const validateMapping = (input, headerCount) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'mapping must be an object' };
  const mapping = {};
  for (const key of MAPPING_KEYS) {
    const value = input[key];
    if (value === undefined || value === null) {
      mapping[key] = null;
      continue;
    }
    if (!Number.isInteger(value) || value < 0 || value >= headerCount) {
      return { error: `mapping.${key} must be a column number from 0 to ${headerCount - 1}, or null` };
    }
    mapping[key] = value;
  }
  if (mapping.phoneColumn === null) return { error: 'Choose the column that has the phone numbers (mapping.phoneColumn)' };
  const used = MAPPING_KEYS.map(k => mapping[k]).filter(v => v !== null);
  if (new Set(used).size !== used.length) return { error: 'Each column can be used only once in the mapping' };
  if (mapping.nameColumn !== null && (mapping.firstNameColumn !== null || mapping.lastNameColumn !== null)) {
    return { error: 'Use either a full-name column or first/last-name columns, not both' };
  }
  return { mapping };
};

/** Trimmed, single-spaced, control characters removed. */
const cleanText = (value) => String(value === null || value === undefined ? '' : value)
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** The row's name under this mapping, or null. */
const nameFromRow = (row, mapping) => {
  let name;
  if (mapping.nameColumn !== null) {
    name = cleanText(row[mapping.nameColumn]);
  } else {
    const first = mapping.firstNameColumn !== null ? cleanText(row[mapping.firstNameColumn]) : '';
    const last = mapping.lastNameColumn !== null ? cleanText(row[mapping.lastNameColumn]) : '';
    name = [first, last].filter(Boolean).join(' ');
  }
  return name ? name.slice(0, NAME_MAX_LENGTH) : null;
};

const isEmptyRow = (row) => !row || row.every(cell => cleanText(cell) === '');

/**
 * Raw rows (arrays of cell values) → table. The first non-empty row is the
 * header row; fully empty rows are dropped; every cell becomes a string;
 * short rows are padded to the header width.
 * @returns {{ headers: string[], rows: string[][] } | { error: string }}
 */
const toTable = (rawRows) => {
  const rows = (rawRows || []).map(r => (Array.isArray(r) ? r : []).map(cellToString)).filter(r => !isEmptyRow(r));
  if (rows.length === 0) return { error: 'The file is empty' };
  const [headerRow, ...dataRows] = rows;
  const width = Math.max(headerRow.length, ...dataRows.map(r => r.length));
  const headers = Array.from({ length: width }, (_, i) => cleanText(headerRow[i]) || `Column ${i + 1}`);
  if (dataRows.length === 0) return { error: 'The file has a header row but no contacts' };
  if (dataRows.length > MAX_ROWS) {
    return { error: `The file has ${dataRows.length.toLocaleString('en-IN')} rows; the limit is ${MAX_ROWS.toLocaleString('en-IN')} per import. Split it into smaller files.` };
  }
  return { headers, rows: dataRows.map(r => Array.from({ length: width }, (_, i) => r[i] || '')) };
};

/** A parsed cell → string. Dates become YYYY-MM-DD. */
function cellToString(cell) {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? '' : cell.toISOString().slice(0, 10);
  return String(cell);
}

/**
 * Classifies every row: 'invalid' (bad phone, with reason), 'duplicate' (the
 * number already appeared higher up in the file — the first one wins),
 * 'existing' (already a customer) or 'new'.
 * @param {string[][]} rows
 * @param {Object} mapping            a validated mapping
 * @param {Set<string>} existingNumbers  whatsapp_numbers already in customers
 */
const classifyRows = (rows, mapping, existingNumbers) => {
  const seen = new Set();
  const counts = { total: rows.length, new: 0, existing: 0, invalid: 0, duplicate: 0 };
  const classified = rows.map((row, i) => {
    const rowNumber = i + 2; // row 1 is the header
    const name = nameFromRow(row, mapping);
    const result = normalizePhone(row[mapping.phoneColumn]);
    let status;
    if (result.reason) status = 'invalid';
    else if (seen.has(result.phone)) status = 'duplicate';
    else status = existingNumbers.has(result.phone) ? 'existing' : 'new';
    if (result.phone) seen.add(result.phone);
    counts[status] += 1;
    return { rowNumber, name, phone: result.phone || null, status, reason: result.reason || null };
  });
  return { rows: classified, counts };
};

/** Every distinct valid number in the rows (for the existing-customer lookup). */
const validNumbers = (rows, mapping) => {
  const numbers = new Set();
  for (const row of rows) {
    const { phone } = normalizePhone(row[mapping.phoneColumn]);
    if (phone) numbers.add(phone);
  }
  return [...numbers];
};

// ── Google Sheets ──

const SHEET_ID = /^[A-Za-z0-9_-]{20,}$/;

/**
 * A Google Sheets link → { sheetId, gid } (gid null = first tab), or { error }.
 * Only docs.google.com/spreadsheets/d/<id>/... links; we never fetch the URL
 * as given — buildSheetExportUrl makes the one we fetch.
 */
const parseSheetUrl = (input) => {
  if (typeof input !== 'string' || !input.trim()) return { error: 'sheetUrl is required' };
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return { error: 'That doesn\'t look like a link. Paste the Google Sheet\'s share link.' };
  }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') {
    return { error: 'Only Google Sheets links (https://docs.google.com/spreadsheets/...) can be imported' };
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'spreadsheets' || parts[1] !== 'd' || !parts[2]) {
    return { error: 'Only Google Sheets links (https://docs.google.com/spreadsheets/...) can be imported' };
  }
  if (parts[2] === 'e') {
    return { error: 'This is a "Publish to web" link. Use the sheet\'s normal share link instead (Share → Anyone with the link → Viewer → Copy link).' };
  }
  if (!SHEET_ID.test(parts[2])) return { error: 'This Google Sheets link is incomplete — copy it again from Share → Copy link' };
  const gidText = url.searchParams.get('gid') || (/(?:^|[#&])gid=(\d+)/.exec(url.hash) || [])[1] || null;
  const gid = gidText !== null && /^\d+$/.test(gidText) ? gidText : null;
  return { sheetId: parts[2], gid };
};

/** The CSV export URL we fetch — built from the id/gid, never the user's string. */
const buildSheetExportUrl = ({ sheetId, gid }) =>
  `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=csv${gid ? `&gid=${gid}` : ''}`;

/** Redirects are followed only to Google's own sheet hosts, over https. */
const isAllowedSheetRedirect = (location) => {
  let url;
  try {
    url = new URL(location);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return url.hostname === 'docs.google.com' || url.hostname.endsWith('.googleusercontent.com');
};

/** Upload filename → 'csv' | 'xlsx', or { error } (old .xls / anything else). */
const sourceFromFileName = (fileName) => {
  const lower = String(fileName || '').toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) return { source: 'csv' };
  if (lower.endsWith('.xlsx')) return { source: 'xlsx' };
  if (lower.endsWith('.xls')) return { error: 'Old Excel (.xls) files aren\'t supported. In Excel, use File → Save As → .xlsx or CSV, then upload again.' };
  return { error: 'Upload a CSV or Excel (.xlsx) file' };
};

module.exports = {
  MAX_ROWS,
  MAX_FILE_BYTES,
  SAMPLE_ROWS,
  NAME_MAX_LENGTH,
  headerKey,
  detectMapping,
  validateMapping,
  nameFromRow,
  toTable,
  classifyRows,
  validNumbers,
  parseSheetUrl,
  buildSheetExportUrl,
  isAllowedSheetRedirect,
  sourceFromFileName
};
