// Run: node --test src/controllers/messageTemplate.headerMedia.test.js
// PUT /api/message-templates/:id/header-media — attach a business_media file as
// a template's IMAGE / VIDEO / DOCUMENT header. Supabase is an in-memory stand-in
// that records the update; R2, Meta and the other services are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

const MB = 1024 * 1024;
let db; let updates;

const from = (table) => {
  const filters = []; let op = 'select'; let payload;
  const matching = () => db[table].filter(r => filters.every(([c, v]) => r[c] === v));
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push([c, v]); return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    maybeSingle: async () => ({ data: matching()[0] || null, error: null }),
    single: async () => {
      const row = matching()[0];
      if (op === 'update' && row) { Object.assign(row, payload); updates.push({ table, payload }); }
      return { data: row || null, error: null };
    }
  };
  return q;
};
const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/supabase', { from });
stub('../config/env', {});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/business.service', {});
stub('../services/r2.service', {});
stub('../utils/crypto', { decrypt: (x) => x });
stub('../services/whatsapp.service', { META_API_BASE: 'https://graph.example' });
stub('../services/templateSync.service', {});
const { setHeaderMedia } = require('./messageTemplate.controller');

const call = async (id, body, businessId = 'b1') => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await setHeaderMedia({ user: { businessId }, params: { id }, body }, res, (err) => { throw err; });
  return res;
};

const media = (over) => ({
  id: 'm1', business_id: 'b1', media_type: 'image', url: 'https://r2.example/business-media/b1-1.jpeg', r2_key: 'business-media/b1-1.jpeg',
  file_size_bytes: 1 * MB, original_filename: 'offer.jpg', ...over
});
const template = (over) => ({
  id: 't1', business_id: 'b1', name: 'ganpati_offer', status: 'approved', header_type: 'IMAGE', body_text: 'Hi {{1}}',
  meta_components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hi {{1}}' }],
  send_support: 'needs_header_media', header_image_url: null, header_media_url: null, header_media_id: null, header_media_filename: null, ...over
});

test.beforeEach(() => {
  updates = [];
  db = { message_templates: [template()], business_media: [media()] };
});

test('IMAGE header: attaches the file, stores url / id, and recomputes send_support to ok', async () => {
  const res = await call('t1', { mediaId: 'm1' });
  assert.equal(res.statusCode, 200);
  assert.equal(db.message_templates[0].header_media_url, 'https://r2.example/business-media/b1-1.jpeg');
  assert.equal(db.message_templates[0].header_media_id, 'm1');
  assert.equal(db.message_templates[0].header_media_filename, null); // only documents carry a filename
  assert.equal(db.message_templates[0].send_support, 'ok');
  assert.equal(res.body.data.sendSupport, 'ok');
  assert.equal(res.body.data.headerMediaUrl, 'https://r2.example/business-media/b1-1.jpeg');
});

test('PNG is fine, WebP is not (WhatsApp template headers take JPG / PNG)', async () => {
  db.business_media = [media({ r2_key: 'business-media/b1-2.png', url: 'https://r2.example/b1-2.png' })];
  assert.equal((await call('t1', { mediaId: 'm1' })).statusCode, 200);
  db.business_media = [media({ r2_key: 'business-media/b1-3.webp', url: 'https://r2.example/b1-3.webp' })];
  const res = await call('t1', { mediaId: 'm1' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /JPG or PNG/);
});

test('VIDEO header: mp4 only, 16 MB max', async () => {
  db.message_templates = [template({ header_type: 'VIDEO', meta_components: [{ type: 'HEADER', format: 'VIDEO' }, { type: 'BODY', text: 'Hi' }] })];
  db.business_media = [media({ media_type: 'video', r2_key: 'business-media/v.mp4', url: 'https://r2.example/v.mp4', file_size_bytes: 16 * MB })];
  assert.equal((await call('t1', { mediaId: 'm1' })).statusCode, 200);
  assert.equal(db.message_templates[0].send_support, 'ok');

  db.business_media = [media({ media_type: 'video', r2_key: 'business-media/v.quicktime', url: 'https://r2.example/v.quicktime' })];
  assert.match((await call('t1', { mediaId: 'm1' })).body.message, /MP4 video/);
  db.business_media = [media({ media_type: 'video', r2_key: 'business-media/v.webm', url: 'https://r2.example/v.webm' })];
  assert.equal((await call('t1', { mediaId: 'm1' })).statusCode, 400);

  db.business_media = [media({ media_type: 'video', r2_key: 'business-media/v.mp4', url: 'https://r2.example/v.mp4', file_size_bytes: 16 * MB + 1 })];
  const big = await call('t1', { mediaId: 'm1' });
  assert.equal(big.statusCode, 400);
  assert.match(big.body.message, /at most 16 MB/);
});

test('DOCUMENT header: pdf, 10 MB max, filename stored', async () => {
  db.message_templates = [template({ header_type: 'DOCUMENT', meta_components: [{ type: 'HEADER', format: 'DOCUMENT' }, { type: 'BODY', text: 'Hi' }] })];
  db.business_media = [media({ media_type: 'document', r2_key: 'business-media/f.pdf', url: 'https://r2.example/f.pdf', original_filename: 'Fees 2026.pdf', file_size_bytes: 10 * MB })];
  assert.equal((await call('t1', { mediaId: 'm1' })).statusCode, 200);
  assert.equal(db.message_templates[0].header_media_filename, 'Fees 2026.pdf');
  assert.equal(db.message_templates[0].send_support, 'ok');

  db.business_media = [media({ media_type: 'document', r2_key: 'business-media/f.pdf', url: 'https://r2.example/f.pdf', file_size_bytes: 10 * MB + 1 })];
  assert.match((await call('t1', { mediaId: 'm1' })).body.message, /at most 10 MB/);
});

test('type mismatch with the template header format is refused, nothing written', async () => {
  db.message_templates = [template({ header_type: 'VIDEO' })];
  const res = await call('t1', { mediaId: 'm1' }); // m1 is an image
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /MP4 video/);
  db.message_templates = [template({ header_type: 'DOCUMENT' })];
  assert.equal((await call('t1', { mediaId: 'm1' })).statusCode, 400);
  assert.equal(updates.length, 0);
});

test('image over the 5 MB cap is refused', async () => {
  db.business_media = [media({ file_size_bytes: 5 * MB + 1 })];
  const res = await call('t1', { mediaId: 'm1' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /at most 5 MB/);
});

test("another business's media is not found, and another business's template is not found", async () => {
  db.business_media = [media({ business_id: 'other' })];
  const res = await call('t1', { mediaId: 'm1' });
  assert.equal(res.statusCode, 404);
  assert.match(res.body.message, /Media not found/);
  db.business_media = [media()];
  assert.equal((await call('t1', { mediaId: 'm1' }, 'other')).statusCode, 404);
  assert.equal(updates.length, 0);
});

test('a template without a media header (NONE / TEXT / LOCATION) is refused; mediaId is required', async () => {
  for (const header_type of ['NONE', 'TEXT', 'LOCATION']) {
    db.message_templates = [template({ header_type })];
    const res = await call('t1', { mediaId: 'm1' });
    assert.equal(res.statusCode, 400, header_type);
    assert.match(res.body.message, /does not have an image, video or document header/);
  }
  assert.equal((await call('t1', {})).statusCode, 400);
  assert.equal((await call('t1', { mediaId: 7 })).statusCode, 400);
  assert.equal((await call('missing', { mediaId: 'm1' })).statusCode, 404);
});

test('send_support is recomputed over everything else: a synced template that also has a quick-reply stays unsupported_component', async () => {
  db.message_templates = [template({
    meta_components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hi' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }] }]
  })];
  assert.equal((await call('t1', { mediaId: 'm1' })).statusCode, 200);
  assert.equal(db.message_templates[0].send_support, 'unsupported_component');
  assert.equal(db.message_templates[0].header_media_id, 'm1'); // media is still attached
});

test('replacing the media on a template that already has one overwrites url / id / filename', async () => {
  db.message_templates = [template({ header_media_url: 'https://old', header_media_id: 'old', send_support: 'ok' })];
  await call('t1', { mediaId: 'm1' });
  assert.equal(db.message_templates[0].header_media_id, 'm1');
  assert.notEqual(db.message_templates[0].header_media_url, 'https://old');
});
