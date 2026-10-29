// Run: node --test src/utils/inboundFiles.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_FILE_BYTES, ALLOWED_EXTENSIONS, resolveStorableFile } = require('./inboundFiles');

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('the cap is 16 MB and the list is exactly the agreed types', () => {
  assert.equal(MAX_FILE_BYTES, 16 * 1024 * 1024);
  assert.deepEqual([...ALLOWED_EXTENSIONS].sort(), ['csv', 'docx', 'jpg', 'pdf', 'png', 'webp', 'xls', 'xlsx']);
});

test('the extension comes from the MIME type (jpeg folds into jpg)', () => {
  const cases = [
    ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['application/pdf', 'pdf'],
    [XLSX, 'xlsx'], ['application/vnd.ms-excel', 'xls'], ['text/csv', 'csv'], [DOCX, 'docx']
  ];
  for (const [mime, ext] of cases) assert.equal(resolveStorableFile(mime).ext, ext, mime);
  assert.equal(resolveStorableFile('IMAGE/JPEG; charset=x').ext, 'jpg');
});

test('the stored content type is the canonical one for the extension', () => {
  assert.equal(resolveStorableFile('application/octet-stream', 'sheet.xlsx').contentType, XLSX);
  assert.equal(resolveStorableFile('application/pdf').contentType, 'application/pdf');
});

test('an unlisted MIME falls back to the filename extension, only when that is on the list', () => {
  assert.equal(resolveStorableFile('application/octet-stream', 'Prices.XLSX').ext, 'xlsx');
  assert.equal(resolveStorableFile('application/octet-stream', 'photo.JPEG').ext, 'jpg');
  assert.equal(resolveStorableFile(null, 'data.csv').ext, 'csv');
  assert.equal(resolveStorableFile('application/octet-stream', 'archive.zip'), null);
  assert.equal(resolveStorableFile('application/octet-stream', 'noextension'), null);
  assert.equal(resolveStorableFile('application/octet-stream', 'macro.xlsm'), null);
});

test('the MIME wins over a misleading filename; anything else is refused', () => {
  assert.equal(resolveStorableFile('application/pdf', 'x.zip').ext, 'pdf');
  for (const mime of ['video/mp4', 'application/zip', 'text/html', 'image/gif', 'audio/ogg', '', null, undefined]) {
    assert.equal(resolveStorableFile(mime), null, String(mime));
  }
});
