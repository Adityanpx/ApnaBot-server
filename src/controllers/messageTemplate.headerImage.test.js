// Run: node --test src/controllers/messageTemplate.headerImage.test.js
// Template header images must be JPG or PNG (WhatsApp doesn't accept WebP
// template headers). The shared upload middleware lets WebP through, so
// uploadHeaderImage refuses it before anything reaches R2. R2 and the other
// services are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const uploads = [];
stub('../config/supabase', {});
stub('../config/env', {});
stub('../utils/crypto', { decrypt: (v) => v });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/business.service', {});
stub('../services/whatsapp.service', { META_API_BASE: 'https://graph.facebook.com/vX' });
stub('../services/r2.service', {
  uploadImage: async (buffer, folder, name, mimetype) => {
    uploads.push(mimetype);
    return { url: `https://r2.example/${name}`, key: `${folder}/${name}` };
  }
});
const { uploadHeaderImage } = require('./messageTemplate.controller');

const call = async (file) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await uploadHeaderImage({ file }, res, (err) => { throw err; });
  return res;
};
const image = (mimetype) => ({ buffer: Buffer.from('x'), mimetype });

test('JPG and PNG header images are uploaded', async () => {
  uploads.length = 0;
  for (const type of ['image/jpeg', 'image/png']) {
    const res = await call(image(type));
    assert.equal(res.statusCode, 200, type);
    assert.ok(res.body.data.url);
    assert.ok(res.body.data.key);
  }
  assert.deepEqual(uploads, ['image/jpeg', 'image/png']);
});

test('WebP (and other types) are refused with a clear 400, nothing uploaded', async () => {
  uploads.length = 0;
  for (const type of ['image/webp', 'image/gif']) {
    const res = await call(image(type));
    assert.equal(res.statusCode, 400, type);
    assert.equal(res.body.message, 'Header image must be a JPG or PNG.');
  }
  assert.equal(uploads.length, 0);
});

test('missing file is still "No image provided"', async () => {
  const res = await call(undefined);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'No image provided');
});
