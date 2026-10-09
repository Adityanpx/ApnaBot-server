// Run: node --test src/services/echoMedia.service.test.js
// Media of phone-app echoes: image / video / document echoes get a media_url in R2
// and a message_media socket event; a failed download, a wrong type or an oversize
// file leaves the row with its label. Supabase, Meta download, R2 and socket stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

let db; let emitted; let logs; let nextId; let downloads; let uploads; let downloadImpl; let uploadImpl;

const uniqueKeys = { customers: ['business_id', 'whatsapp_number'], messages: ['business_id', 'meta_message_id'] };

const from = (table) => {
  const filters = []; let op = 'select'; let payload = null; let single = false;
  const rows = () => (db[table] = db[table] || []);
  const matching = () => rows().filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'insert') {
      const keys = uniqueKeys[table];
      if (keys && rows().some(r => keys.every(k => r[k] === payload[k]))) return { data: null, error: { code: '23505', message: 'duplicate key' } };
      const row = { id: `${table}-${nextId++}`, created_at: '2026-10-05T00:00:00Z', ...payload };
      rows().push(row);
      return { data: row, error: null };
    }
    if (op === 'update') { const hit = matching(); hit.forEach(r => Object.assign(r, payload)); return { data: hit, error: null }; }
    return { data: matching(), error: null };
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
    limit: () => q,
    insert: (p) => { op = 'insert'; payload = p; return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    single: () => { single = true; return Promise.resolve(run()); },
    maybeSingle: async () => { const r = run(); return { data: r.data[0] || null, error: r.error }; },
    then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject)
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/env', { ECHO_AUTO_PAUSE: false });
stub('../config/supabase', { from });
stub('../utils/logger', {
  info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m])
});
stub('./socket.service', { emitToBusiness: (id, event, data) => { emitted.push([id, event, data]); } });
stub('./tenant.service', { resolveBusinessByPhoneNumberId: async () => null, invalidateTenantCache: async () => {} });
stub('./whatsapp.service', { downloadMedia: (...args) => { downloads.push(args); return downloadImpl(...args); } });
stub('./r2.service', { uploadImage: (...args) => { uploads.push(args); return uploadImpl(...args); } });
const svc = require('./coexistence.service');
const { echoMediaOf, storeEchoMedia } = require('./echoMedia.service');

const MB = 1024 * 1024;
const BIZ = 'b1';
const tenant = { businessId: BIZ, accessToken: 'enc-token' };
const meta = { display_phone_number: '+91 96070 24225', phone_number_id: 'pn1' };
const mediaEcho = (id, type, payload) => ({ from: '919607024225', to: '919800000001', id, timestamp: '1760000000', type, [type]: payload });

// Lets the fire-and-forget storeEchoMedia finish.
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

test.beforeEach(() => {
  db = { customers: [], messages: [] };
  emitted = []; logs = []; nextId = 1; downloads = []; uploads = [];
  downloadImpl = async () => ({ buffer: Buffer.from('x'), mimeType: 'image/jpeg' });
  uploadImpl = async (_buf, folder, id, mime) => ({ url: `https://r2.test/${folder}/${id}.${mime.split('/')[1]}` });
});

const run = async (echo) => {
  await svc.handleEchoes(tenant, { metadata: meta, message_echoes: [echo] });
  await settle();
  return db.messages[0];
};

test('image echo: downloaded, uploaded to R2, media_url set, message_media emitted, label kept as content', async () => {
  const m = await run(mediaEcho('wamid.I1', 'image', { id: 'media-1', mime_type: 'image/jpeg', caption: 'Receipt' }));
  assert.equal(m.type, 'image');
  assert.equal(m.content, '📷 Photo: Receipt');
  assert.equal(m.media_url, `https://r2.test/echo-media/b1/${m.id}.jpeg`);
  assert.deepEqual(downloads[0], ['media-1', 'enc-token', 10 * MB]);
  const ev = emitted.find(e => e[1] === 'message_media');
  assert.deepEqual(ev[2], { messageId: m.id, customerId: db.customers[0].id, mediaUrl: m.media_url });
});

test('image echo: WebP is stored', async () => {
  downloadImpl = async () => ({ buffer: Buffer.from('x'), mimeType: 'image/webp' });
  const m = await run(mediaEcho('wamid.I2', 'image', { id: 'media-2', mime_type: 'image/webp' }));
  assert.match(m.media_url, /\.webp$/);
});

test('video echo: MP4 stored with the 16 MB cap', async () => {
  downloadImpl = async () => ({ buffer: Buffer.from('x'), mimeType: 'video/mp4' });
  const m = await run(mediaEcho('wamid.V1', 'video', { id: 'media-3', mime_type: 'video/mp4' }));
  assert.equal(m.type, 'video');
  assert.equal(m.content, '🎥 Video');
  assert.match(m.media_url, /\.mp4$/);
  assert.equal(downloads[0][2], 16 * MB);
});

test('document echo: PDF stored, filename label kept', async () => {
  downloadImpl = async () => ({ buffer: Buffer.from('x'), mimeType: 'application/pdf' });
  const m = await run(mediaEcho('wamid.D1', 'document', { id: 'media-4', mime_type: 'application/pdf', filename: 'Fees.pdf' }));
  assert.equal(m.type, 'document');
  assert.equal(m.content, '📄 Fees.pdf');
  assert.match(m.media_url, /\.pdf$/);
  assert.equal(downloads[0][2], 10 * MB);
});

test('download failure: the row keeps its label, no media_url, no socket event, webhook unaffected', async () => {
  downloadImpl = async () => { throw new Error('media expired'); };
  const m = await run(mediaEcho('wamid.I3', 'image', { id: 'media-5', mime_type: 'image/jpeg' }));
  assert.equal(m.content, '📷 Photo');
  assert.equal(m.media_url, undefined);
  assert.equal(emitted.some(e => e[1] === 'message_media'), false);
  assert.equal(uploads.length, 0);
  assert.ok(logs.some(l => l[0] === 'error' && /echo media/i.test(l[1])));
});

test('upload failure: the row keeps its label', async () => {
  uploadImpl = async () => { throw new Error('r2 down'); };
  const m = await run(mediaEcho('wamid.I4', 'image', { id: 'media-6', mime_type: 'image/png' }));
  assert.equal(m.media_url, undefined);
  assert.equal(m.content, '📷 Photo');
});

test('oversize: Meta-reported size over the cap (download refuses) is skipped, label kept', async () => {
  downloadImpl = async (id, tok, max) => { throw new Error(`Media ${id} is ${17 * MB} bytes, over the ${max} limit`); };
  const m = await run(mediaEcho('wamid.V2', 'video', { id: 'media-7', mime_type: 'video/mp4' }));
  assert.equal(m.media_url, undefined);
  assert.equal(m.content, '🎥 Video');
  assert.equal(uploads.length, 0);
});

test('oversize: a buffer larger than the cap is not uploaded', async () => {
  downloadImpl = async () => ({ buffer: Buffer.alloc(10 * MB + 1), mimeType: 'application/pdf' });
  const m = await run(mediaEcho('wamid.D2', 'document', { id: 'media-8', mime_type: 'application/pdf', filename: 'Big.pdf' }));
  assert.equal(m.media_url, undefined);
  assert.equal(uploads.length, 0);
});

test('unstorable types are not downloaded at all (payload mime) or not uploaded (real mime)', async () => {
  let m = await run(mediaEcho('wamid.D3', 'document', { id: 'media-9', mime_type: 'application/msword', filename: 'a.doc' }));
  assert.equal(m.media_url, undefined);
  assert.equal(downloads.length, 0);

  downloadImpl = async () => ({ buffer: Buffer.from('x'), mimeType: 'video/3gpp' });
  await svc.handleEchoes(tenant, { metadata: meta, message_echoes: [mediaEcho('wamid.V3', 'video', { id: 'media-10' })] });
  await settle();
  m = db.messages.find(x => x.meta_message_id === 'wamid.V3');
  assert.equal(m.media_url, undefined);
  assert.equal(uploads.length, 0);
});

test('audio, sticker and text echoes never trigger a download; a duplicate echo downloads once', async () => {
  await run(mediaEcho('wamid.A1', 'audio', { id: 'media-11', voice: true }));
  await svc.handleEchoes(tenant, { metadata: meta, message_echoes: [{ from: '919607024225', to: '919800000001', id: 'wamid.T1', timestamp: '1760000000', type: 'text', text: { body: 'hi' } }] });
  assert.equal(downloads.length, 0);

  const echo = mediaEcho('wamid.I5', 'image', { id: 'media-12', mime_type: 'image/jpeg' });
  await svc.handleEchoes(tenant, { metadata: meta, message_echoes: [echo] });
  await svc.handleEchoes(tenant, { metadata: meta, message_echoes: [echo] });
  await settle();
  assert.equal(downloads.length, 1);
});

test('echoMediaOf: only image / video / document with an id', () => {
  assert.deepEqual(echoMediaOf(mediaEcho('a', 'image', { id: 'm', mime_type: 'image/png' })), { type: 'image', id: 'm', mimeType: 'image/png' });
  assert.equal(echoMediaOf(mediaEcho('a', 'image', { caption: 'no id' })), null);
  assert.equal(echoMediaOf(mediaEcho('a', 'audio', { id: 'm' })), null);
  assert.equal(echoMediaOf({ type: 'text', text: { body: 'x' } }), null);
});

test('storeEchoMedia never throws, even when the database update fails', async () => {
  db.messages.push({ id: 'm1', customer_id: 'c1' });
  const supabase = require('../config/supabase');
  const realFrom = supabase.from;
  supabase.from = () => { throw new Error('db down'); };
  try {
    const url = await storeEchoMedia(tenant, { id: 'm1', customer_id: 'c1' }, { type: 'image', id: 'x', mimeType: null });
    assert.equal(url, null);
  } finally { supabase.from = realFrom; }
});
