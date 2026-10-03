// Contact import (CSV / XLSX / public Google Sheet) for
// contactImport.controller.js:
//
//   preview  parse the file / sheet, detect the name + phone columns, count
//            new / existing / invalid / duplicate rows, and keep the parsed
//            table in contact_import_previews (30 min) under a preview token.
//   recount  the same counts for a different column mapping.
//   commit   re-classify the stored rows against current customers and save
//            them through the import_contacts RPC — one transaction: every
//            new customer, the group, the memberships and the batch row, or
//            nothing. Existing customers are never changed (only added to
//            the group). New customers are opted in only when the owner
//            attested consent.
//   undo     within 7 days: the undo_import_batch RPC deletes the customers
//            this batch created that never messaged / booked, and removes the
//            memberships it added.
//
// The pure parts (columns, names, classification, sheet URLs) are in
// utils/contactImport.js; phone rules in utils/phone.js.

const axios = require('axios');
const { parse: parseCsvSync } = require('csv-parse/sync');
const { readSheet } = require('read-excel-file/node');
const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const logger = require('../utils/logger');
const contactGroupService = require('./contactGroup.service');
const {
  MAX_FILE_BYTES, SAMPLE_ROWS, detectMapping, validateMapping, toTable, classifyRows,
  validNumbers, parseSheetUrl, buildSheetExportUrl, isAllowedSheetRedirect, sourceFromFileName
} = require('../utils/contactImport');

const FEATURE = 'contact_import';
const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SHEET_TIMEOUT_MS = 15 * 1000;
const SHEET_MAX_REDIRECTS = 3;
const ID_CHUNK = 500; // keeps each `in (...)` filter a sensible URL length
const BATCH_LIST_LIMIT = 50;

const SHEET_PRIVATE = 'This Google Sheet isn\'t shared publicly. In Google Sheets, click Share → General access → "Anyone with the link" (Viewer), then try again.';
const SHEET_NOT_FOUND = 'Google Sheet not found. Check the link — copy it again from Share → Copy link.';
const PREVIEW_GONE = 'This preview has expired or was already used. Upload the file again.';
const BATCH_COLUMNS = 'id, source, file_name, sheet_url, total_rows, created_count, existing_count, existing_added_to_group_count, invalid_count, duplicate_in_file_count, group_id, opt_in_attested, attested_by, created_by, created_at, undone_at, undone_deleted_count, undone_kept_count';

// ── Reading the input ──

/** CSV bytes → raw rows. Comma, semicolon or tab separated; BOM stripped. */
const parseCsv = (buffer) => {
  try {
    return { rawRows: parseCsvSync(buffer, {
      bom: true,
      delimiter: [',', ';', '\t'],
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true
    }) };
  } catch (error) {
    logger.warn(`Contact import: CSV parse failed: ${error.message}`);
    return { status: 400, error: 'Couldn\'t read this CSV file. Check that it is a plain CSV (comma-separated) file.' };
  }
};

/**
 * XLSX bytes → raw rows of the first sheet. Numbers are kept as the stored
 * text (parseNumber), so a phone typed as a number never goes through a float.
 */
const parseXlsx = async (buffer) => {
  try {
    return { rawRows: await readSheet(buffer, 1, { parseNumber: (text) => text }) };
  } catch (error) {
    logger.warn(`Contact import: XLSX parse failed: ${error.message}`);
    return { status: 400, error: 'Couldn\'t read this Excel file. Save it again as .xlsx (or CSV) and upload it.' };
  }
};

/**
 * The public CSV export of a Google Sheet. Fetches only the URL we build
 * from the sheet id / gid, follows at most SHEET_MAX_REDIRECTS redirects and
 * only to docs.google.com / *.googleusercontent.com (a public sheet answers
 * 307 → googleusercontent.com). A sign-in redirect, an HTML page or
 * 401/403 means the sheet isn't public.
 */
const fetchSheetCsv = async (sheet) => {
  let url = buildSheetExportUrl(sheet);
  for (let hop = 0; hop <= SHEET_MAX_REDIRECTS; hop++) {
    let response;
    try {
      response = await axios.get(url, {
        maxRedirects: 0,
        timeout: SHEET_TIMEOUT_MS,
        responseType: 'arraybuffer',
        maxContentLength: MAX_FILE_BYTES,
        validateStatus: () => true
      });
    } catch (error) {
      if (/maxContentLength/i.test(error.message || '')) {
        return { status: 400, error: 'This Google Sheet is larger than 5 MB. Split it into smaller sheets.' };
      }
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        return { status: 504, error: 'Google Sheets took too long to respond. Try again in a minute.' };
      }
      logger.error(`Contact import: Google Sheet fetch failed: ${error.message}`);
      return { status: 502, error: 'Couldn\'t reach Google Sheets. Try again in a minute.' };
    }

    const { status } = response;
    if (status >= 300 && status < 400) {
      const location = response.headers && response.headers.location;
      if (!location) return { status: 502, error: 'Google Sheets sent an unexpected answer. Try again.' };
      const next = new URL(location, url).toString();
      if (new URL(next).hostname === 'accounts.google.com') return { status: 400, error: SHEET_PRIVATE };
      if (!isAllowedSheetRedirect(next)) {
        logger.warn(`Contact import: refused Google Sheet redirect to ${new URL(next).hostname}`);
        return { status: 400, error: SHEET_PRIVATE };
      }
      url = next;
      continue;
    }
    if (status === 401 || status === 403) return { status: 400, error: SHEET_PRIVATE };
    if (status === 404) return { status: 400, error: SHEET_NOT_FOUND };
    if (status < 200 || status >= 300) {
      logger.error(`Contact import: Google Sheet export answered ${status}`);
      return { status: 502, error: 'Google Sheets couldn\'t export this sheet. Try again in a minute.' };
    }
    const contentType = String((response.headers && response.headers['content-type']) || '').toLowerCase();
    if (contentType.includes('text/html')) return { status: 400, error: SHEET_PRIVATE };
    return { buffer: Buffer.from(response.data) };
  }
  return { status: 502, error: 'Google Sheets redirected too many times. Try again in a minute.' };
};

/**
 * The request's input → { source, fileName, sheetUrl, rawRows } or { status, error }.
 * @param {{ file?: { buffer, originalname, size }, sheetUrl?: string }} input
 */
const readInput = async ({ file, sheetUrl }) => {
  if (file) {
    const type = sourceFromFileName(file.originalname);
    if (type.error) return { status: 400, error: type.error };
    if (!file.buffer || file.buffer.length === 0) return { status: 400, error: 'The file is empty' };
    if (file.buffer.length > MAX_FILE_BYTES) return { status: 400, error: 'File size exceeds 5MB limit' };
    const parsed = type.source === 'csv' ? parseCsv(file.buffer) : await parseXlsx(file.buffer);
    if (parsed.error) return parsed;
    return { source: type.source, fileName: String(file.originalname).slice(0, 200), sheetUrl: null, rawRows: parsed.rawRows };
  }
  if (sheetUrl !== undefined && sheetUrl !== null && sheetUrl !== '') {
    const sheet = parseSheetUrl(sheetUrl);
    if (sheet.error) return { status: 400, error: sheet.error };
    const fetched = await fetchSheetCsv(sheet);
    if (fetched.error) return fetched;
    const parsed = parseCsv(fetched.buffer);
    if (parsed.error) return parsed;
    return { source: 'gsheet', fileName: null, sheetUrl: String(sheetUrl).trim().slice(0, 500), rawRows: parsed.rawRows };
  }
  return { status: 400, error: 'Upload a CSV / Excel file (field "file") or send a Google Sheet link (sheetUrl)' };
};

// ── Classifying ──

/** whatsapp_numbers among these that are already customers of the business. */
const loadExistingNumbers = async (businessId, numbers) => {
  const existing = new Set();
  for (let i = 0; i < numbers.length; i += ID_CHUNK) {
    const { data, error } = await supabase
      .from('customers').select('whatsapp_number').eq('business_id', businessId)
      .in('whatsapp_number', numbers.slice(i, i + ID_CHUNK));
    if (error) throw error;
    for (const row of data || []) existing.add(row.whatsapp_number);
  }
  return existing;
};

/**
 * Counts + samples for one mapping: the first SAMPLE_ROWS rows (with their
 * cells) and the first SAMPLE_ROWS invalid rows (with reasons). counts is
 * null when no phone column is chosen yet.
 */
const summarize = async (businessId, table, mapping) => {
  if (mapping.phoneColumn === null) {
    return {
      counts: null,
      sampleRows: table.rows.slice(0, SAMPLE_ROWS).map((cells, i) => ({ rowNumber: i + 2, cells, name: null, phone: null, status: null, reason: null })),
      invalidRows: []
    };
  }
  const existing = await loadExistingNumbers(businessId, validNumbers(table.rows, mapping));
  const { rows, counts } = classifyRows(table.rows, mapping, existing);
  return {
    counts,
    sampleRows: rows.slice(0, SAMPLE_ROWS).map(r => ({ ...r, cells: table.rows[r.rowNumber - 2] })),
    invalidRows: rows.filter(r => r.status === 'invalid').slice(0, SAMPLE_ROWS).map(r => ({ ...r, cells: table.rows[r.rowNumber - 2] }))
  };
};

// ── Previews ──

/** Deletes expired previews. Never throws — it's housekeeping. */
const cleanupExpiredPreviews = async (now = new Date()) => {
  const { error } = await supabase.from('contact_import_previews').delete().lt('expires_at', new Date(now).toISOString());
  if (error) logger.error('Contact import: expired preview cleanup failed:', error);
};

/** The business's unexpired preview (raw row) or null. Expired ones are deleted. */
const loadPreview = async (businessId, token, now = new Date()) => {
  if (!contactGroupService.isUuid(token)) return null;
  const { data, error } = await supabase
    .from('contact_import_previews').select('*').eq('id', token).eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (new Date(data.expires_at).getTime() <= new Date(now).getTime()) {
    await supabase.from('contact_import_previews').delete().eq('id', token);
    return null;
  }
  return data;
};

const previewResponse = (row, mapping, summary) => ({
  previewToken: row.id,
  expiresAt: row.expires_at,
  source: row.source,
  fileName: row.file_name,
  sheetUrl: row.sheet_url,
  headers: row.headers,
  mapping,
  counts: summary.counts,
  sampleRows: summary.sampleRows,
  invalidRows: summary.invalidRows
});

/** POST /preview — multipart `file` or { sheetUrl }. */
const preview = async (businessId, userId, input) => {
  const read = await readInput(input);
  if (read.error) return read;
  const table = toTable(read.rawRows);
  if (table.error) return { status: 400, error: table.error };

  const mapping = detectMapping(table.headers);
  const summary = await summarize(businessId, table, mapping);

  await cleanupExpiredPreviews();
  const { data: row, error } = await supabase.from('contact_import_previews').insert({
    business_id: businessId,
    created_by: userId || null,
    source: read.source,
    file_name: read.fileName,
    sheet_url: read.sheetUrl,
    headers: table.headers,
    rows: table.rows,
    mapping
  }).select('id, source, file_name, sheet_url, headers, expires_at').single();
  if (error) throw error;

  return previewResponse(row, mapping, summary);
};

/** POST /preview/:token/recount — Body { mapping }: counts for another mapping. */
const recount = async (businessId, token, body = {}) => {
  const row = await loadPreview(businessId, token);
  if (!row) return { status: 404, error: PREVIEW_GONE };
  const check = validateMapping(body.mapping, row.headers.length);
  if (check.error) return { status: 400, error: check.error };
  const summary = await summarize(businessId, { headers: row.headers, rows: row.rows }, check.mapping);
  return previewResponse(row, check.mapping, summary);
};

// ── Commit ──

const RPC_ERRORS = {
  group_not_found: { status: 404, error: 'Group not found' },
  group_name_taken: { status: 409, error: 'A group with this name already exists — choose it from the list instead' },
  group_and_new_group: { status: 400, error: 'Choose an existing group or a new group name, not both' }
};

/**
 * Checks the attestation part of a commit body.
 * optInAttested: true needs attestationConfirmed: true (the UI's explicit
 * confirmation) and can only come from the business owner.
 * @returns {{ attested: boolean } | { status, error }}
 */
const checkAttestation = (body, user) => {
  if (body.optInAttested === undefined || body.optInAttested === null || body.optInAttested === false) return { attested: false };
  if (body.optInAttested !== true) return { status: 400, error: 'optInAttested must be true or false' };
  if (body.attestationConfirmed !== true) {
    return { status: 400, error: 'Confirm that every contact in this list agreed to receive WhatsApp messages from your business (attestationConfirmed: true)' };
  }
  if (!user || user.role !== 'owner') {
    return { status: 403, error: 'Only the business owner can confirm that imported contacts opted in' };
  }
  return { attested: true };
};

/** groupId / newGroupName part of a commit body → { groupId, newGroupName } or { status, error }. */
const checkGroupChoice = (body) => {
  const hasGroupId = body.groupId !== undefined && body.groupId !== null && body.groupId !== '';
  const hasNewName = body.newGroupName !== undefined && body.newGroupName !== null && body.newGroupName !== '';
  if (hasGroupId && hasNewName) return RPC_ERRORS.group_and_new_group;
  if (hasGroupId) {
    if (!contactGroupService.isUuid(body.groupId)) return { status: 400, error: 'groupId must be a group id' };
    return { groupId: body.groupId, newGroupName: null };
  }
  if (hasNewName) {
    const nameCheck = contactGroupService.validateGroupName(body.newGroupName);
    if (nameCheck.error) return nameCheck;
    return { groupId: null, newGroupName: nameCheck.name };
  }
  return { groupId: null, newGroupName: null };
};

/**
 * POST /commit — Body { previewToken, mapping?, groupId?, newGroupName?,
 * optInAttested?, attestationConfirmed? }.
 * @param {{ userId, role }} user
 */
const commit = async (businessId, user, body = {}) => {
  const attestation = checkAttestation(body, user);
  if (attestation.error) return attestation;
  const group = checkGroupChoice(body);
  if (group.error) return group;

  const row = await loadPreview(businessId, body.previewToken);
  if (!row) return { status: 404, error: PREVIEW_GONE };
  const check = validateMapping(body.mapping === undefined ? row.mapping : body.mapping, row.headers.length);
  if (check.error) return { status: 400, error: check.error };

  // Re-classified now: customers may have messaged in since the preview.
  const existing = await loadExistingNumbers(businessId, validNumbers(row.rows, check.mapping));
  const { rows, counts } = classifyRows(row.rows, check.mapping, existing);
  const importable = rows.filter(r => r.status === 'new' || r.status === 'existing');
  if (importable.length === 0) return { status: 400, error: 'No valid phone numbers to import in this file' };

  const { data, error } = await supabase.rpc('import_contacts', {
    p_business_id: businessId,
    p_created_by: user.userId || null,
    p_source: row.source,
    p_file_name: row.file_name,
    p_sheet_url: row.sheet_url,
    p_total_rows: counts.total,
    p_invalid_count: counts.invalid,
    p_duplicate_count: counts.duplicate,
    p_opt_in_attested: attestation.attested,
    p_attested_by: attestation.attested ? user.userId : null,
    p_group_id: group.groupId,
    p_new_group_name: group.newGroupName,
    p_rows: importable.map(r => ({ phone: r.phone, name: r.name }))
  });
  if (error) throw error;
  if (data && data.error) {
    if (RPC_ERRORS[data.error]) return RPC_ERRORS[data.error];
    throw new Error(`import_contacts: ${data.error}`);
  }

  const { error: deleteErr } = await supabase.from('contact_import_previews').delete().eq('id', row.id);
  if (deleteErr) logger.error('Contact import: preview delete after commit failed:', deleteErr);

  logger.info(`Contact import ${data.batchId} for business ${businessId}: ${data.createdCount} new, ${data.existingCount} existing, ${counts.invalid} invalid, ${counts.duplicate} duplicate (attested: ${attestation.attested})`);
  return {
    batch: {
      id: data.batchId,
      groupId: data.groupId,
      totalRows: counts.total,
      createdCount: data.createdCount,
      existingCount: data.existingCount,
      existingAddedToGroupCount: data.existingAddedToGroupCount,
      invalidCount: counts.invalid,
      duplicateInFileCount: counts.duplicate,
      optInAttested: attestation.attested
    }
  };
};

// ── Batches + undo ──

/** Whether a batch can still be undone at `now`, and until when. */
const undoState = (batch, now = new Date()) => {
  const undoDeadline = new Date(new Date(batch.created_at).getTime() + UNDO_WINDOW_MS);
  return { canUndo: !batch.undone_at && new Date(now).getTime() < undoDeadline.getTime(), undoDeadline: undoDeadline.toISOString() };
};

const shapeBatch = (row, now) => ({ ...toCamelCase(row), ...undoState(row, now) });

/** GET / — the latest imports, newest first. */
const listBatches = async (businessId, now = new Date()) => {
  const { data, error } = await supabase
    .from('import_batches').select(BATCH_COLUMNS).eq('business_id', businessId)
    .order('created_at', { ascending: false }).limit(BATCH_LIST_LIMIT);
  if (error) throw error;
  return { batches: (data || []).map(r => shapeBatch(r, now)) };
};

const formatDate = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** DELETE /:batchId — undo, within 7 days of the import. */
const undo = async (businessId, batchId, now = new Date()) => {
  if (!contactGroupService.isUuid(batchId)) return { status: 404, error: 'Import not found' };
  const { data: batch, error } = await supabase
    .from('import_batches').select('id, created_at, undone_at').eq('id', batchId).eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  if (!batch) return { status: 404, error: 'Import not found' };
  if (batch.undone_at) return { status: 400, error: 'This import was already undone' };
  if (!undoState(batch, now).canUndo) {
    return { status: 400, error: `Imports can only be undone within 7 days. This one was imported on ${formatDate(batch.created_at)}.` };
  }

  const { data, error: rpcErr } = await supabase.rpc('undo_import_batch', { p_business_id: businessId, p_batch_id: batchId });
  if (rpcErr) throw rpcErr;
  if (data && data.error) {
    if (data.error === 'not_found') return { status: 404, error: 'Import not found' };
    if (data.error === 'already_undone') return { status: 400, error: 'This import was already undone' };
    if (data.error === 'window_closed') return { status: 400, error: 'Imports can only be undone within 7 days.' };
    throw new Error(`undo_import_batch: ${data.error}`);
  }
  logger.info(`Contact import ${batchId} undone for business ${businessId}: ${data.deletedCount} deleted, ${data.keptCount} kept`);
  return { deletedCount: data.deletedCount, keptCount: data.keptCount, membershipsRemoved: data.membershipsRemoved };
};

module.exports = {
  FEATURE,
  UNDO_WINDOW_MS,
  fetchSheetCsv,
  readInput,
  preview,
  recount,
  commit,
  listBatches,
  undo,
  undoState,
  checkAttestation
};
