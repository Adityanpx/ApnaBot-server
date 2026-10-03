// Run: node --test src/services/contactImport.service.test.js
// contactImport.service against an in-memory stand-in for Supabase (the RPCs
// are recorded and answered by the test) and a fake axios for the Google
// Sheet fetch — nothing is written or fetched for real. The XLSX case builds
// a real .xlsx in memory (fflate, which read-excel-file itself depends on).
const test = require('node:test');
const assert = require('node:assert/strict');

const NOW = new Date('2026-10-04T06:30:00Z');
const DAY = 24 * 60 * 60 * 1000;
const BIZ = 'b1';
const GROUP = '11111111-1111-4111-8111-111111111111';
const OWNER = { userId: 'u-owner', role: 'owner' };

let db; let rpcCalls; let rpcAnswers; let http;

// ── In-memory Supabase ──
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const from = (table) => {
  const filters = []; let op = 'select'; let payload;
  const matching = () => db[table].filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'insert') {
      const row = { id: `00000000-0000-4000-8000-${String(db[table].length + 1).padStart(12, '0')}`, created_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(), ...payload };
      db[table].push(row);
      return { data: [row], error: null };
    }
    if (op === 'delete') {
      const hit = matching(); db[table] = db[table].filter(r => !hit.includes(r));
      return { data: hit, error: null };
    }
    return { data: matching(), error: null };
  };
  const q = {
    select: () => q,
    insert: (p) => { op = 'insert'; payload = p; return q; },
    delete: () => { op = 'delete'; return q; },
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
    lt: (c, v) => { filters.push(r => r[c] != null && cmp(r[c], v) < 0); return q; },
    order: () => q,
    limit: () => q,
    maybeSingle: async () => { const r = run(); return { data: r.data[0] || null, error: null }; },
    single: async () => { const r = run(); return { data: r.data[0], error: null }; },
    then: (resolve, reject) => { try { resolve(run()); } catch (e) { reject(e); } }
  };
  return q;
};
const rpc = async (name, args) => {
  rpcCalls.push({ name, args });
  return { data: rpcAnswers[name](args), error: null };
};

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/supabase', { from, rpc });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('axios', { get: async (url, opts) => http(url, opts) });
const svc = require('./contactImport.service');

const reset = () => {
  db = {
    customers: [{ id: 'c-existing', business_id: BIZ, whatsapp_number: '919123456789', name: 'Ravi', opted_in: false }],
    contact_import_previews: [],
    import_batches: []
  };
  rpcCalls = [];
  rpcAnswers = {
    import_contacts: (args) => ({
      batchId: 'batch-1', groupId: args.p_group_id,
      createdCount: args.p_rows.filter(r => r.phone !== '919123456789').length,
      existingCount: args.p_rows.filter(r => r.phone === '919123456789').length,
      existingAddedToGroupCount: args.p_group_id ? 1 : 0
    }),
    undo_import_batch: () => ({ deletedCount: 4, keptCount: 1, membershipsRemoved: 6 })
  };
  http = async () => { throw new Error('no http in this test'); };
};

const csvFile = (text, name = 'contacts.csv') => ({ originalname: name, buffer: Buffer.from(text, 'utf8'), size: text.length });

// 10 rows: 3 invalid, 1 existing customer, 1 duplicate in the file, 5 new.
const SAMPLE_CSV = [
  'Name,Mobile,City',
  'Asha,98765 43210,Pune',
  'Ravi,+91 91234 56789,Pune',      // existing customer
  'Meena,2226543210,Mumbai',        // landline
  'Asha again,09876543210,Pune',    // duplicate of row 2
  'Kiran,9.19876E+11,Nashik',       // Excel scientific notation
  'Neha,,Pune',                     // empty
  'Sunil,7000000001,Pune',
  'Priya,7000000002,Pune',
  'Om,7000000003,Pune',
  'Joy,7000000004,Pune'
].join('\n');

// ── Preview ──

test('preview: CSV → detected columns, counts, samples; parsed rows kept under a token', async () => {
  reset();
  const out = await svc.preview(BIZ, 'u-owner', { file: csvFile(SAMPLE_CSV) });
  assert.deepEqual(out.headers, ['Name', 'Mobile', 'City']);
  assert.deepEqual(out.mapping, { phoneColumn: 1, nameColumn: 0, firstNameColumn: null, lastNameColumn: null });
  assert.deepEqual(out.counts, { total: 10, new: 5, existing: 1, invalid: 3, duplicate: 1 });
  assert.equal(out.sampleRows.length, 10);
  assert.deepEqual(out.sampleRows[0], { rowNumber: 2, name: 'Asha', phone: '919876543210', status: 'new', reason: null, cells: ['Asha', '98765 43210', 'Pune'] });
  assert.deepEqual(out.invalidRows.map(r => [r.rowNumber, r.reason]), [[4, 'landline'], [6, 'scientific_notation'], [7, 'empty']]);
  assert.equal(db.contact_import_previews.length, 1);
  assert.equal(out.previewToken, db.contact_import_previews[0].id);
  assert.equal(db.customers.length, 1); // nothing imported yet
});

test('preview: BOM, semicolons and first + last name columns', async () => {
  reset();
  const out = await svc.preview(BIZ, 'u', { file: csvFile('﻿First Name;Last Name;WhatsApp\nRahul;Patil;9876543210\n') });
  assert.deepEqual(out.mapping, { phoneColumn: 2, nameColumn: null, firstNameColumn: 0, lastNameColumn: 1 });
  assert.equal(out.sampleRows[0].name, 'Rahul Patil');
});

test('preview: no phone column recognised → counts null, raw sample rows, owner picks via recount', async () => {
  reset();
  const out = await svc.preview(BIZ, 'u', { file: csvFile('Who,Digits\nAsha,9876543210\n') });
  assert.equal(out.counts, null);
  assert.deepEqual(out.sampleRows[0].cells, ['Asha', '9876543210']);
  const again = await svc.recount(BIZ, out.previewToken, { mapping: { phoneColumn: 1, nameColumn: 0 } });
  assert.deepEqual(again.counts, { total: 1, new: 1, existing: 0, invalid: 0, duplicate: 0 });
  assert.equal(again.sampleRows[0].name, 'Asha');
});

test('preview: a real .xlsx (first sheet; numeric phone cell read as text)', async () => {
  reset();
  const { zipSync, strToU8 } = require('fflate');
  const cell = (ref, v) => (typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`);
  const rows = [['Name', 'Mobile'], ['Rahul Patil', 919876543210], ['Asha', '98765 43210']];
  const sheetXml = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cell(String.fromCharCode(65 + j) + (i + 1), v)).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const xlsx = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml)
  });
  const out = await svc.preview(BIZ, 'u', { file: { originalname: 'list.xlsx', buffer: Buffer.from(xlsx) } });
  assert.equal(out.source, 'xlsx');
  assert.deepEqual(out.sampleRows.map(r => [r.name, r.phone, r.status]), [['Rahul Patil', '919876543210', 'new'], ['Asha', '919876543210', 'duplicate']]);
});

test('preview: broken xlsx, .xls, empty file and nothing sent are clear 400s', async () => {
  reset();
  assert.match((await svc.preview(BIZ, 'u', { file: { originalname: 'x.xlsx', buffer: Buffer.from('not a zip') } })).error, /Couldn't read this Excel file/);
  assert.match((await svc.preview(BIZ, 'u', { file: csvFile('a', 'old.xls') })).error, /\.xls\) files aren't supported/);
  assert.match((await svc.preview(BIZ, 'u', { file: csvFile('') })).error, /empty/);
  assert.match((await svc.preview(BIZ, 'u', { file: csvFile('Name,Mobile\n') })).error, /no contacts/);
  assert.match((await svc.preview(BIZ, 'u', {})).error, /Upload a CSV/);
  assert.equal(db.contact_import_previews.length, 0);
});

test('preview: expired previews are cleaned up on the next preview', async () => {
  reset();
  db.contact_import_previews.push({ id: 'old', business_id: 'other', expires_at: new Date(Date.now() - 1000).toISOString() });
  db.contact_import_previews.push({ id: 'live', business_id: 'other', expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  await svc.preview(BIZ, 'u', { file: csvFile('Mobile\n9876543210\n') });
  assert.deepEqual(db.contact_import_previews.map(p => p.id).filter(id => id === 'old' || id === 'live'), ['live']);
});

// ── Google Sheet ──

const SHEET = 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=5';
const csvResponse = (text) => ({ status: 200, headers: { 'content-type': 'text/csv' }, data: Buffer.from(text) });

test('sheet: public sheet → 307 to googleusercontent → CSV; we fetch only the export URL we built', async () => {
  reset();
  const urls = [];
  http = async (url, opts) => {
    urls.push(url);
    assert.equal(opts.maxRedirects, 0);
    assert.equal(opts.timeout, 15000);
    assert.equal(opts.maxContentLength, 5 * 1024 * 1024);
    if (url.startsWith('https://docs.google.com/')) return { status: 307, headers: { location: 'https://doc-08-4o-sheets.googleusercontent.com/export/abc?format=csv' } };
    return csvResponse('Name,Phone\nAsha,9876543210\n');
  };
  const out = await svc.preview(BIZ, 'u', { sheetUrl: SHEET });
  assert.deepEqual(urls, [
    'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/export?format=csv&gid=5',
    'https://doc-08-4o-sheets.googleusercontent.com/export/abc?format=csv'
  ]);
  assert.equal(out.source, 'gsheet');
  assert.equal(out.sheetUrl, SHEET);
  assert.deepEqual(out.counts, { total: 1, new: 1, existing: 0, invalid: 0, duplicate: 0 });
});

test('sheet: private (sign-in redirect / HTML page / 401 / 403) and missing (404) give clear errors', async () => {
  reset();
  const cases = [
    [{ status: 302, headers: { location: 'https://accounts.google.com/ServiceLogin?continue=x' } }, /isn't shared publicly/],
    [{ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, data: Buffer.from('<html>') }, /isn't shared publicly/],
    [{ status: 401, headers: {} }, /isn't shared publicly/],
    [{ status: 403, headers: {} }, /isn't shared publicly/],
    [{ status: 404, headers: { 'content-type': 'text/html' } }, /not found/]
  ];
  for (const [response, message] of cases) {
    http = async () => response;
    const out = await svc.preview(BIZ, 'u', { sheetUrl: SHEET });
    assert.equal(out.status, 400);
    assert.match(out.error, message);
  }
});

test('sheet SSRF guard: a redirect anywhere else is not followed', async () => {
  reset();
  const urls = [];
  http = async (url) => {
    urls.push(url);
    return { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } };
  };
  const out = await svc.preview(BIZ, 'u', { sheetUrl: SHEET });
  assert.equal(out.status, 400);
  assert.equal(urls.length, 1);
});

test('sheet: too many redirects, too large, timeout, and a non-Google link', async () => {
  reset();
  http = async () => ({ status: 307, headers: { location: 'https://docs.google.com/spreadsheets/d/x/export?format=csv' } });
  assert.match((await svc.preview(BIZ, 'u', { sheetUrl: SHEET })).error, /too many times/);
  http = async () => { throw new Error('maxContentLength size of 5242880 exceeded'); };
  assert.match((await svc.preview(BIZ, 'u', { sheetUrl: SHEET })).error, /larger than 5 MB/);
  http = async () => { const e = new Error('timeout'); e.code = 'ECONNABORTED'; throw e; };
  assert.equal((await svc.preview(BIZ, 'u', { sheetUrl: SHEET })).status, 504);
  http = async () => { throw new Error('must not fetch'); };
  assert.match((await svc.preview(BIZ, 'u', { sheetUrl: 'https://example.com/list.csv' })).error, /Only Google Sheets/);
});

// ── Commit ──

const previewToken = async () => (await svc.preview(BIZ, 'u-owner', { file: csvFile(SAMPLE_CSV) })).previewToken;

test('commit: only valid, unique rows go to the RPC; invalid / duplicate are counted; preview is used up', async () => {
  reset();
  const token = await previewToken();
  const out = await svc.commit(BIZ, OWNER, { previewToken: token, newGroupName: '  Diwali  list ' });
  const [call] = rpcCalls;
  assert.equal(call.name, 'import_contacts');
  assert.deepEqual(call.args.p_rows, [
    { phone: '919876543210', name: 'Asha' },
    { phone: '919123456789', name: 'Ravi' },
    { phone: '917000000001', name: 'Sunil' },
    { phone: '917000000002', name: 'Priya' },
    { phone: '917000000003', name: 'Om' },
    { phone: '917000000004', name: 'Joy' }
  ]);
  assert.equal(call.args.p_total_rows, 10);
  assert.equal(call.args.p_invalid_count, 3);
  assert.equal(call.args.p_duplicate_count, 1);
  assert.equal(call.args.p_new_group_name, 'Diwali list');
  assert.equal(call.args.p_group_id, null);
  assert.equal(call.args.p_opt_in_attested, false);
  assert.equal(call.args.p_attested_by, null);
  assert.equal(call.args.p_source, 'csv');
  assert.equal(call.args.p_file_name, 'contacts.csv');
  assert.deepEqual(out.batch, {
    id: 'batch-1', groupId: null, totalRows: 10, createdCount: 5, existingCount: 1,
    existingAddedToGroupCount: 0, invalidCount: 3, duplicateInFileCount: 1, optInAttested: false
  });
  assert.equal(db.contact_import_previews.length, 0);
  assert.match((await svc.commit(BIZ, OWNER, { previewToken: token })).error, /expired or was already used/);
});

test('commit: a mapping override is applied; an invalid one is refused', async () => {
  reset();
  const token = await previewToken();
  assert.match((await svc.commit(BIZ, OWNER, { previewToken: token, mapping: { phoneColumn: 9 } })).error, /from 0 to 2/);
  await svc.commit(BIZ, OWNER, { previewToken: token, mapping: { phoneColumn: 1, nameColumn: 2 } });
  assert.equal(rpcCalls[0].args.p_rows[0].name, 'Pune');
});

test('commit: attestation needs the explicit confirmation flag and the owner', async () => {
  reset();
  const token = await previewToken();
  const noConfirm = await svc.commit(BIZ, OWNER, { previewToken: token, optInAttested: true });
  assert.equal(noConfirm.status, 400);
  assert.match(noConfirm.error, /attestationConfirmed/);
  const notOwner = await svc.commit(BIZ, { userId: 'u-admin', role: 'superadmin' }, { previewToken: token, optInAttested: true, attestationConfirmed: true });
  assert.equal(notOwner.status, 403);
  assert.match(notOwner.error, /Only the business owner/);
  assert.equal((await svc.commit(BIZ, OWNER, { previewToken: token, optInAttested: 'yes', attestationConfirmed: true })).status, 400);
  assert.equal(rpcCalls.length, 0);

  const ok = await svc.commit(BIZ, OWNER, { previewToken: token, optInAttested: true, attestationConfirmed: true });
  assert.equal(ok.batch.optInAttested, true);
  assert.equal(rpcCalls[0].args.p_opt_in_attested, true);
  assert.equal(rpcCalls[0].args.p_attested_by, 'u-owner');
});

test('commit: a non-owner can still import without attesting', async () => {
  reset();
  const out = await svc.commit(BIZ, { userId: 'u-admin', role: 'superadmin' }, { previewToken: await previewToken() });
  assert.equal(out.batch.optInAttested, false);
});

test('commit: group choice — existing id or new name, not both; RPC group errors mapped', async () => {
  reset();
  const token = await previewToken();
  assert.match((await svc.commit(BIZ, OWNER, { previewToken: token, groupId: GROUP, newGroupName: 'x' })).error, /not both/);
  assert.match((await svc.commit(BIZ, OWNER, { previewToken: token, groupId: 'nope' })).error, /groupId must be a group id/);
  assert.match((await svc.commit(BIZ, OWNER, { previewToken: token, newGroupName: 'x'.repeat(61) })).error, /at most 60/);
  rpcAnswers.import_contacts = () => ({ error: 'group_not_found' });
  assert.equal((await svc.commit(BIZ, OWNER, { previewToken: token, groupId: GROUP })).status, 404);
  rpcAnswers.import_contacts = () => ({ error: 'group_name_taken' });
  assert.equal((await svc.commit(BIZ, OWNER, { previewToken: token, newGroupName: 'VIP' })).status, 409);
  assert.equal(db.contact_import_previews.length, 1); // a failed commit keeps the preview for a retry
});

test('commit: preview expiry, another business\'s token, garbage token', async () => {
  reset();
  const token = await previewToken();
  assert.equal((await svc.commit('other-business', OWNER, { previewToken: token })).status, 404);
  db.contact_import_previews[0].expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await svc.commit(BIZ, OWNER, { previewToken: token })).status, 404);
  assert.equal(db.contact_import_previews.length, 0); // the expired one is deleted on sight
  assert.equal((await svc.commit(BIZ, OWNER, { previewToken: 'not-a-uuid' })).status, 404);
  assert.equal(rpcCalls.length, 0);
});

test('commit: a file with no valid numbers is refused before the RPC', async () => {
  reset();
  const { previewToken: token } = await svc.preview(BIZ, 'u', { file: csvFile('Mobile\nabc\n2226543210\n') });
  assert.match((await svc.commit(BIZ, OWNER, { previewToken: token })).error, /No valid phone numbers/);
  assert.equal(rpcCalls.length, 0);
});

// ── Undo ──

const batch = (over = {}) => ({ id: '22222222-2222-4222-8222-222222222222', business_id: BIZ, created_at: new Date(NOW.getTime() - DAY).toISOString(), undone_at: null, ...over });

test('undo: within 7 days → RPC; deleted / kept / memberships counts returned', async () => {
  reset();
  db.import_batches.push(batch());
  const out = await svc.undo(BIZ, batch().id, NOW);
  assert.deepEqual(out, { deletedCount: 4, keptCount: 1, membershipsRemoved: 6 });
  assert.deepEqual(rpcCalls[0], { name: 'undo_import_batch', args: { p_business_id: BIZ, p_batch_id: batch().id } });
});

test('undo: the 7-day window (to the millisecond), already undone, other business, unknown id', async () => {
  reset();
  db.import_batches.push(batch({ created_at: new Date(NOW.getTime() - 7 * DAY + 1).toISOString() }));
  assert.ok(!(await svc.undo(BIZ, batch().id, NOW)).error);

  reset();
  db.import_batches.push(batch({ created_at: new Date(NOW.getTime() - 7 * DAY).toISOString() }));
  const late = await svc.undo(BIZ, batch().id, NOW);
  assert.equal(late.status, 400);
  assert.match(late.error, /within 7 days.*imported on 27 Sept 2026/);

  reset();
  db.import_batches.push(batch({ undone_at: NOW.toISOString() }));
  assert.match((await svc.undo(BIZ, batch().id, NOW)).error, /already undone/);
  assert.equal((await svc.undo('other-business', batch().id, NOW)).status, 404);
  assert.equal((await svc.undo(BIZ, 'nope', NOW)).status, 404);
  assert.equal(rpcCalls.length, 0);
});

test('undo: the RPC\'s own checks (lost race) are mapped too', async () => {
  reset();
  db.import_batches.push(batch());
  rpcAnswers.undo_import_batch = () => ({ error: 'already_undone' });
  assert.match((await svc.undo(BIZ, batch().id, NOW)).error, /already undone/);
  rpcAnswers.undo_import_batch = () => ({ error: 'window_closed' });
  assert.match((await svc.undo(BIZ, batch().id, NOW)).error, /within 7 days/);
});

test('batch list: canUndo / undoDeadline per batch', () => {
  assert.deepEqual(svc.undoState(batch(), NOW), { canUndo: true, undoDeadline: new Date(NOW.getTime() + 6 * DAY).toISOString() });
  assert.equal(svc.undoState(batch({ undone_at: NOW.toISOString() }), NOW).canUndo, false);
  assert.equal(svc.undoState(batch({ created_at: new Date(NOW.getTime() - 8 * DAY).toISOString() }), NOW).canUndo, false);
});
