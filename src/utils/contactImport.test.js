// Run: node --test src/utils/contactImport.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const ci = require('./contactImport');

// ── Column detection ──

test('detects name / phone headers whatever the case, spaces or underscores', () => {
  assert.deepEqual(ci.detectMapping(['Name', 'Mobile']), { phoneColumn: 1, nameColumn: 0, firstNameColumn: null, lastNameColumn: null });
  assert.deepEqual(ci.detectMapping(['FULL_NAME', 'Phone Number', 'City']), { phoneColumn: 1, nameColumn: 0, firstNameColumn: null, lastNameColumn: null });
  assert.deepEqual(ci.detectMapping(['city', 'customer name', 'whatsapp']).nameColumn, 1);
  assert.deepEqual(ci.detectMapping(['Contact Name', 'Contact']), { phoneColumn: 1, nameColumn: 0, firstNameColumn: null, lastNameColumn: null });
  assert.equal(ci.detectMapping(['Customer', 'Number']).nameColumn, 0);
  assert.equal(ci.detectMapping(['Customer', 'Number']).phoneColumn, 1);
  assert.equal(ci.detectMapping([' phone ', 'x']).phoneColumn, 0);
});

test('priority: "name" beats "customer", "phone" beats "contact"', () => {
  const m = ci.detectMapping(['Customer', 'Contact', 'Name', 'Phone']);
  assert.equal(m.nameColumn, 2);
  assert.equal(m.phoneColumn, 3);
});

test('first + last name columns are used only when there is no full-name column', () => {
  assert.deepEqual(ci.detectMapping(['First Name', 'Last Name', 'Mobile']), { phoneColumn: 2, nameColumn: null, firstNameColumn: 0, lastNameColumn: 1 });
  assert.deepEqual(ci.detectMapping(['first_name', 'surname', 'phone']), { phoneColumn: 2, nameColumn: null, firstNameColumn: 0, lastNameColumn: 1 });
  assert.deepEqual(ci.detectMapping(['Name', 'First Name', 'Last Name', 'Mobile']), { phoneColumn: 3, nameColumn: 0, firstNameColumn: null, lastNameColumn: null });
});

test('nothing recognisable → all null (the owner picks on the preview screen)', () => {
  assert.deepEqual(ci.detectMapping(['A', 'B']), { phoneColumn: null, nameColumn: null, firstNameColumn: null, lastNameColumn: null });
});

test('mapping override: validated against the table', () => {
  assert.deepEqual(ci.validateMapping({ phoneColumn: 2, nameColumn: 0 }, 3).mapping, { phoneColumn: 2, nameColumn: 0, firstNameColumn: null, lastNameColumn: null });
  assert.match(ci.validateMapping({ nameColumn: 0 }, 3).error, /phone numbers/);
  assert.match(ci.validateMapping({ phoneColumn: 3 }, 3).error, /from 0 to 2/);
  assert.match(ci.validateMapping({ phoneColumn: '1' }, 3).error, /column number/);
  assert.match(ci.validateMapping({ phoneColumn: 1, nameColumn: 1 }, 3).error, /only once/);
  assert.match(ci.validateMapping({ phoneColumn: 2, nameColumn: 0, firstNameColumn: 1 }, 3).error, /either a full-name/);
  assert.match(ci.validateMapping(null, 3).error, /must be an object/);
});

test('names: trimmed, single-spaced, first + last combined, capped at 100', () => {
  const full = { phoneColumn: 1, nameColumn: 0, firstNameColumn: null, lastNameColumn: null };
  const split = { phoneColumn: 2, nameColumn: null, firstNameColumn: 0, lastNameColumn: 1 };
  assert.equal(ci.nameFromRow(['  Rahul   Patil ', '1'], full), 'Rahul Patil');
  assert.equal(ci.nameFromRow(['', '1'], full), null);
  assert.equal(ci.nameFromRow(['Rahul', 'Patil', '1'], split), 'Rahul Patil');
  assert.equal(ci.nameFromRow(['Rahul', '', '1'], split), 'Rahul');
  assert.equal(ci.nameFromRow(['', 'Patil', '1'], split), 'Patil');
  assert.equal(ci.nameFromRow(['Ra\u0000hul\tP', '1'], full), 'Ra hul P');
  assert.equal(ci.nameFromRow(['x'.repeat(150), '1'], full).length, 100);
  assert.equal(ci.nameFromRow(['9876543210'], { phoneColumn: 0, nameColumn: null, firstNameColumn: null, lastNameColumn: null }), null);
});

// ── Table shape ──

test('table: first non-empty row is the header, empty rows dropped, cells become strings', () => {
  const t = ci.toTable([[], ['', ''], ['Name', 'Mobile'], ['Asha', 9876543210], ['', ''], ['Ravi']]);
  assert.deepEqual(t.headers, ['Name', 'Mobile']);
  assert.deepEqual(t.rows, [['Asha', '9876543210'], ['Ravi', '']]);
});

test('table: blank headers get a placeholder; extra cells widen the table', () => {
  const t = ci.toTable([['Name', ''], ['Asha', '98', 'extra']]);
  assert.deepEqual(t.headers, ['Name', 'Column 2', 'Column 3']);
  assert.deepEqual(t.rows, [['Asha', '98', 'extra']]);
});

test('table: dates become YYYY-MM-DD', () => {
  assert.deepEqual(ci.toTable([['d'], [new Date('2026-10-04T00:00:00Z')]]).rows, [['2026-10-04']]);
});

test('table: empty file, header only, and the 5,000-row limit', () => {
  assert.match(ci.toTable([]).error, /empty/);
  assert.match(ci.toTable([['Name', 'Mobile']]).error, /no contacts/);
  const big = [['Mobile'], ...Array.from({ length: 5001 }, (_, i) => [String(9000000000 + i)])];
  assert.match(ci.toTable(big).error, /5,001 rows; the limit is 5,000/);
  assert.equal(ci.toTable(big.slice(0, 5001)).rows.length, 5000);
});

// ── Classification ──

test('rows: new / existing / invalid (with reason) / duplicate-in-file; first occurrence wins', () => {
  const mapping = { phoneColumn: 1, nameColumn: 0, firstNameColumn: null, lastNameColumn: null };
  const rows = [
    ['Asha', '98765 43210'],      // new
    ['Ravi', '+91 9123456789'],   // existing
    ['Meena', '2226543210'],      // landline
    ['Asha again', '09876543210'],// same number as row 1 → duplicate
    ['Kiran', '9.19876E+11'],     // Excel
    ['', '7000000000'],           // new, no name
    ['Neha', '']                  // empty
  ];
  const { rows: out, counts } = ci.classifyRows(rows, mapping, new Set(['919123456789']));
  assert.deepEqual(counts, { total: 7, new: 2, existing: 1, invalid: 3, duplicate: 1 });
  assert.deepEqual(out.map(r => [r.rowNumber, r.status, r.reason]), [
    [2, 'new', null], [3, 'existing', null], [4, 'invalid', 'landline'], [5, 'duplicate', null],
    [6, 'invalid', 'scientific_notation'], [7, 'new', null], [8, 'invalid', 'empty']
  ]);
  assert.deepEqual(out[0], { rowNumber: 2, name: 'Asha', phone: '919876543210', status: 'new', reason: null });
  assert.equal(out[5].name, null);
});

test('a duplicate of an existing customer counts once as existing, then as duplicate', () => {
  const mapping = { phoneColumn: 0, nameColumn: null, firstNameColumn: null, lastNameColumn: null };
  const { counts } = ci.classifyRows([['9123456789'], ['+919123456789']], mapping, new Set(['919123456789']));
  assert.deepEqual(counts, { total: 2, new: 0, existing: 1, invalid: 0, duplicate: 1 });
});

test('validNumbers: distinct normalized numbers only', () => {
  const mapping = { phoneColumn: 0, nameColumn: null, firstNameColumn: null, lastNameColumn: null };
  assert.deepEqual(ci.validNumbers([['9876543210'], ['09876543210'], ['bad'], ['7000000000']], mapping), ['919876543210', '917000000000']);
});

// ── Google Sheets ──

const ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';

test('sheet links: id and gid extracted from the usual share / edit links', () => {
  assert.deepEqual(ci.parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`), { sheetId: ID, gid: null });
  assert.deepEqual(ci.parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=123456`), { sheetId: ID, gid: '123456' });
  assert.deepEqual(ci.parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit?gid=42#gid=42`), { sheetId: ID, gid: '42' });
  assert.deepEqual(ci.parseSheetUrl(`  https://docs.google.com/spreadsheets/d/${ID}  `), { sheetId: ID, gid: null });
  assert.deepEqual(ci.parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=1;evil`), { sheetId: ID, gid: '1' });
});

test('sheet links: anything that isn\'t a docs.google.com spreadsheet is refused', () => {
  assert.match(ci.parseSheetUrl('').error, /required/);
  assert.match(ci.parseSheetUrl('not a url').error, /doesn't look like a link/);
  assert.match(ci.parseSheetUrl(`http://docs.google.com/spreadsheets/d/${ID}`).error, /Only Google Sheets/);
  assert.match(ci.parseSheetUrl(`https://docs.google.com.evil.com/spreadsheets/d/${ID}`).error, /Only Google Sheets/);
  assert.match(ci.parseSheetUrl(`https://evil.com/?u=https://docs.google.com/spreadsheets/d/${ID}`).error, /Only Google Sheets/);
  assert.match(ci.parseSheetUrl(`https://docs.google.com/document/d/${ID}/edit`).error, /Only Google Sheets/);
  assert.match(ci.parseSheetUrl('https://docs.google.com/spreadsheets/d/e/2PACX-1vabc/pub?output=csv').error, /Publish to web/);
  assert.match(ci.parseSheetUrl('https://docs.google.com/spreadsheets/d/short/edit').error, /incomplete/);
  assert.match(ci.parseSheetUrl(`https://user:pw@docs.google.com.attacker.net/spreadsheets/d/${ID}`).error, /Only Google Sheets/);
});

test('export URL is built from the id / gid only', () => {
  assert.equal(ci.buildSheetExportUrl({ sheetId: ID, gid: null }), `https://docs.google.com/spreadsheets/d/${ID}/export?format=csv`);
  assert.equal(ci.buildSheetExportUrl({ sheetId: ID, gid: '7' }), `https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=7`);
});

test('SSRF guard: redirects only to docs.google.com / *.googleusercontent.com over https', () => {
  assert.equal(ci.isAllowedSheetRedirect('https://doc-08-4o-sheets.googleusercontent.com/export/x'), true);
  assert.equal(ci.isAllowedSheetRedirect('https://docs.google.com/spreadsheets/d/x/export?format=csv'), true);
  assert.equal(ci.isAllowedSheetRedirect('http://doc-08.googleusercontent.com/x'), false);
  assert.equal(ci.isAllowedSheetRedirect('https://accounts.google.com/ServiceLogin'), false);
  assert.equal(ci.isAllowedSheetRedirect('https://googleusercontent.com.evil.com/x'), false);
  assert.equal(ci.isAllowedSheetRedirect('https://169.254.169.254/latest/meta-data'), false);
  assert.equal(ci.isAllowedSheetRedirect('/relative/path'), false);
});

test('file types: CSV / XLSX accepted, old .xls refused with a clear message', () => {
  assert.deepEqual(ci.sourceFromFileName('Contacts.CSV'), { source: 'csv' });
  assert.deepEqual(ci.sourceFromFileName('list.xlsx'), { source: 'xlsx' });
  assert.match(ci.sourceFromFileName('old.xls').error, /\.xls\) files aren't supported/);
  assert.match(ci.sourceFromFileName('photo.png').error, /CSV or Excel/);
});
