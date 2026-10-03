// Run: node --test src/routes/contactImport.routes.test.js
// The upload chain on POST /api/contacts/import/preview: multer's import
// instance + handleUploadError must turn "too large" / "wrong type" into a
// 400 (not the global error handler's 500), and a JSON { sheetUrl } body must
// pass through untouched. Auth / feature switch / service are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../middleware/auth.middleware', {
  protect: (req, res, next) => { req.user = { userId: 'u', businessId: 'b', role: req.headers['x-role'] || 'owner' }; next(); },
  requireBusiness: (req, res, next) => next()
});
stub('../middleware/categoryFeature.middleware', { requireCategoryFeature: () => (req, res, next) => next() });
stub('../services/contactImport.service', {
  preview: async (businessId, userId, input) => ({
    got: input.file ? { name: input.file.originalname, bytes: input.file.buffer.length } : { sheetUrl: input.sheetUrl }
  })
});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });

const app = express();
app.use(express.json());
app.use('/api/contacts/import', require('./contactImport.routes'));
// Same shape as the real errorHandler.middleware.js: no statusCode → 500.
app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ success: false, message: err.message })); // eslint-disable-line no-unused-vars

let server; let base;
test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/contacts/import`;
});
test.after(() => server.close());

const upload = (name, bytes, headers = {}) => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.alloc(bytes, 0x41)]), name);
  return fetch(`${base}/preview`, { method: 'POST', body: form, headers });
};

test('a CSV upload reaches the service', async () => {
  const res = await upload('contacts.csv', 100);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data.got, { name: 'contacts.csv', bytes: 100 });
});

test('over 5 MB → 400 from handleUploadError, not a 500', async () => {
  const res = await upload('big.csv', 5 * 1024 * 1024 + 1);
  assert.equal(res.status, 400);
  assert.match((await res.json()).message, /exceeds 5MB/);
});

test('.xls / other types → 400 with a clear message', async () => {
  const xls = await upload('old.xls', 10);
  assert.equal(xls.status, 400);
  assert.match((await xls.json()).message, /\.xls\) files aren't supported/);
  const png = await upload('photo.png', 10);
  assert.equal(png.status, 400);
  assert.match((await png.json()).message, /CSV or Excel/);
});

test('JSON { sheetUrl } passes through multer untouched', async () => {
  const res = await fetch(`${base}/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sheetUrl: 'https://docs.google.com/spreadsheets/d/x' }) });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data.got, { sheetUrl: 'https://docs.google.com/spreadsheets/d/x' });
});

test('staff can\'t import (owner / superadmin only)', async () => {
  const res = await upload('contacts.csv', 10, { 'x-role': 'staff' });
  assert.equal(res.status, 403);
});
