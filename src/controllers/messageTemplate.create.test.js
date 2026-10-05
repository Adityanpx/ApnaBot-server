// Run: node --test src/controllers/messageTemplate.create.test.js
// POST /api/message-templates — header / footer / buttons / language, stored as
// synced-shape components with the chosen media attached. Supabase is an
// in-memory stand-in; Meta and the other services are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

const MB = 1024 * 1024;
let db; let inserts;

const from = (table) => {
  const filters = [];
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push([c, v]); return q; },
    insert: (row) => {
      inserts.push(row);
      return { select: () => ({ single: async () => ({ data: { id: 't1', status: 'draft', ...row }, error: null }) }) };
    },
    maybeSingle: async () => ({ data: db[table].find((r) => filters.every(([c, v]) => r[c] === v)) || null, error: null })
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
stub('../utils/crypto', { decrypt: (x) => x });
stub('../services/business.service', {});
stub('../services/r2.service', {});
stub('../services/templateSync.service', {});
stub('../services/whatsapp.service', { META_API_BASE: 'https://graph.example' });
const { createMessageTemplate } = require('./messageTemplate.controller');

const call = async (body, businessId = 'b1') => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await createMessageTemplate({ user: { businessId }, body }, res, (err) => { throw err; });
  return res;
};
const media = (over) => ({
  id: 'm1', business_id: 'b1', media_type: 'image', url: 'https://r2.example/business-media/b1-1.jpeg', r2_key: 'business-media/b1-1.jpeg',
  file_size_bytes: MB, original_filename: 'offer.jpg', ...over
});

test.beforeEach(() => { inserts = []; db = { business_media: [media()] }; });

test('body-only template: still works as before, now with stored components and send_support ok', async () => {
  const res = await call({ name: 'hello_world', bodyText: 'Hi {{1}}, welcome.', variableSamples: ['Sam'] });
  assert.equal(res.statusCode, 201);
  const row = inserts[0];
  assert.equal(row.category, 'MARKETING');
  assert.equal(row.language, 'en_US');
  assert.equal(row.variable_count, 1);
  assert.deepEqual(row.variable_samples, ['Sam']);
  assert.equal(row.header_type, 'NONE');
  assert.deepEqual(row.meta_components, [{ type: 'BODY', text: 'Hi {{1}}, welcome.', example: { body_text: [['Sam']] } }]);
  assert.equal(row.send_support, 'ok');
  assert.equal(res.body.data.metaComponents.length, 1);
});

test('language en_US | hi | mr accepted; anything else is a 400', async () => {
  for (const language of ['en_US', 'hi', 'mr']) {
    assert.equal((await call({ name: `t_${language.toLowerCase()}`, bodyText: 'Hello there.', language })).statusCode, 201, language);
  }
  assert.equal(inserts.map((r) => r.language).join(), 'en_US,hi,mr');
  const res = await call({ name: 't_fr', bodyText: 'Hello there.', language: 'fr' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /en_US, hi, mr/);
});

test('IMAGE header from the media library: media url / id stored, template is sendable (ok)', async () => {
  const res = await call({ name: 'offer', bodyText: 'Big offer today.', header: { type: 'IMAGE', mediaId: 'm1' } });
  assert.equal(res.statusCode, 201);
  const row = inserts[0];
  assert.equal(row.header_type, 'IMAGE');
  assert.equal(row.header_media_url, 'https://r2.example/business-media/b1-1.jpeg');
  assert.equal(row.header_media_id, 'm1');
  assert.equal(row.header_media_filename, null);
  assert.equal(row.header_image_url, null);
  assert.deepEqual(row.meta_components[0], { type: 'HEADER', format: 'IMAGE' });
  assert.equal(row.send_support, 'ok');
});

test('DOCUMENT header stores the filename; VIDEO checks type and size', async () => {
  db.business_media = [media({ media_type: 'document', r2_key: 'x/f.pdf', url: 'https://r2.example/f.pdf', original_filename: 'Fees.pdf' })];
  assert.equal((await call({ name: 'fees', bodyText: 'Fee details.', header: { type: 'DOCUMENT', mediaId: 'm1' } })).statusCode, 201);
  assert.equal(inserts[0].header_media_filename, 'Fees.pdf');

  db.business_media = [media({ media_type: 'video', r2_key: 'x/v.mp4', file_size_bytes: 16 * MB + 1 })];
  const big = await call({ name: 'clip', bodyText: 'Watch this.', header: { type: 'VIDEO', mediaId: 'm1' } });
  assert.equal(big.statusCode, 400);
  assert.match(big.body.message, /at most 16 MB/);
  db.business_media = [media()]; // an image picked for a video header
  assert.match((await call({ name: 'clip', bodyText: 'Watch this.', header: { type: 'VIDEO', mediaId: 'm1' } })).body.message, /MP4 video/);
});

test('media header needs a mediaId from this business', async () => {
  assert.match((await call({ name: 'a', bodyText: 'Hello there.', header: { type: 'IMAGE' } })).body.message, /header.mediaId is required/);
  db.business_media = [media({ business_id: 'other' })];
  assert.equal((await call({ name: 'a', bodyText: 'Hello there.', header: { type: 'IMAGE', mediaId: 'm1' } })).statusCode, 404);
  assert.equal(inserts.length, 0);
});

test('TEXT header with a variable, footer, URL (static + dynamic) and phone buttons', async () => {
  const res = await call({
    name: 'tracking',
    category: 'UTILITY',
    bodyText: 'Your booking {{1}} is confirmed.',
    variableSamples: ['SG1042'],
    header: { type: 'TEXT', text: 'Booking {{1}}', textSample: 'SG1042' },
    footerText: 'SG Travels',
    buttons: [
      { type: 'URL', text: 'Track', url: 'https://sg.example/t/{{1}}', dynamic: true, example: 'https://sg.example/t/SG1042' },
      { type: 'PHONE_NUMBER', text: 'Call us', phone: '+919876543210' }
    ]
  });
  assert.equal(res.statusCode, 201);
  assert.equal(inserts[0].header_type, 'TEXT');
  assert.deepEqual(inserts[0].meta_components.map((c) => c.type), ['HEADER', 'BODY', 'FOOTER', 'BUTTONS']);
  assert.deepEqual(inserts[0].meta_components[3].buttons[1], { type: 'PHONE_NUMBER', text: 'Call us', phone_number: '+919876543210' });
  assert.equal(inserts[0].send_support, 'ok');
});

test('validation errors are a 400 with every message in `errors`; nothing is inserted', async () => {
  const res = await call({
    name: 'bad', bodyText: '{{1}} hello {{3}}', footerText: 'x'.repeat(61),
    buttons: [{ type: 'URL', text: 'Short', url: 'https://bit.ly/x' }, { type: 'QUICK_REPLY', text: 'Yes' }]
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.errors.length >= 4);
  assert.equal(res.body.message, res.body.errors[0]);
  assert.equal(inserts.length, 0);
  assert.match((await call({ name: 'Bad Name', bodyText: 'Hi there.' })).body.message, /lowercase_snake_case/);
  assert.match((await call({ name: 'ok_name', bodyText: 'Hi there.', category: 'AUTHENTICATION' })).body.message, /MARKETING, UTILITY/);
  assert.match((await call({ name: 'ok_name', bodyText: 'Hi there.', header: { type: 'AUDIO' } })).body.message, /header.type must be/);
  // a draft may omit samples (checked again at submit)
  assert.equal((await call({ name: 'no_samples', bodyText: 'Hi {{1}} there.' })).statusCode, 201);
  assert.match((await call({ name: 'bad_samples', bodyText: 'Hi {{1}} there.', variableSamples: ['a', 'b'] })).body.message, /exactly 1 sample/);
});

test('deprecated headerType / headerImageUrl (old clients) still create an IMAGE template', async () => {
  const res = await call({ name: 'old_client', bodyText: 'Hello there.', headerType: 'IMAGE', headerImageUrl: 'https://r2.example/template-headers/h-1.jpeg', headerImageR2Key: 'template-headers/h-1' });
  assert.equal(res.statusCode, 201);
  const row = inserts[0];
  assert.equal(row.header_type, 'IMAGE');
  assert.equal(row.header_image_url, 'https://r2.example/template-headers/h-1.jpeg');
  assert.equal(row.header_image_r2_key, 'template-headers/h-1');
  assert.equal(row.header_media_url, null);
  assert.equal(row.send_support, 'ok'); // header_image_url is the IMAGE fallback link

  assert.match((await call({ name: 'old2', bodyText: 'Hello there.', headerType: 'IMAGE' })).body.message, /headerImageUrl is required/);
  assert.match((await call({ name: 'old3', bodyText: 'Hello there.', headerType: 'VIDEO' })).body.message, /'NONE' or 'IMAGE'/);
});
