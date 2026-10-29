// Run: node --test src/services/bookingFile.service.test.js
// A customer's file answering a booking 'file' question: the allow-list, the 16 MB cap, the media
// storage limit, the booking_files row + storage counter, cleanup when tracking fails, and attaching
// the files to the finished booking. Meta, R2 and the database are in-memory stand-ins.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const stub = (rel, exports) => { const p = require.resolve(path.join(__dirname, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let downloadResult; let downloadError; let downloads; let uploads; let deletedKeys; let inserted; let insertError; let rpcCalls; let usedBytes;
let subscription; let updates;

stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub('../config/supabase', {
  from: (table) => {
    if (table === 'businesses') {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { storage_used_bytes: usedBytes }, error: null }) };
      return q;
    }
    if (table !== 'booking_files') throw new Error(`unexpected table ${table}`);
    return {
      insert: async (row) => { if (insertError) return { error: insertError }; inserted.push(row); return { error: null }; },
      update: (patch) => {
        const q = { eq: () => q, in: async (col, values) => { updates.push({ patch, col, values }); return { error: null }; } };
        return q;
      }
    };
  },
  rpc: async (name, args) => { rpcCalls.push([name, args]); return { error: null }; }
});
stub('./whatsapp.service', {
  downloadMedia: async (id, token, maxBytes) => {
    downloads.push({ id, token, maxBytes });
    if (downloadError) throw downloadError;
    return downloadResult;
  }
});
stub('./r2.service', {
  uploadFile: async (buffer, folder, publicId, ext, contentType) => {
    uploads.push({ size: buffer.length, folder, publicId, ext, contentType });
    return { url: `https://r2.test/${folder}/${publicId}.${ext}`, key: `${folder}/${publicId}.${ext}` };
  },
  deleteImage: async (key) => { deletedKeys.push(key); }
});
stub('./subscription.service', { getActiveSubscription: async () => subscription });

const { storeBookingFile, attachFilesToBooking } = require('./bookingFile.service');

const TENANT = { businessId: 'b1', accessToken: 'enc' };
const PDF = { id: 'm1', mimeType: 'application/pdf', filename: 'Quote.pdf' };
const store = (media = PDF) => storeBookingFile({ tenant: TENANT, customerId: 'c1', fieldKey: 'idProof', media });

test.beforeEach(() => {
  downloadResult = { buffer: Buffer.alloc(1000), mimeType: 'application/pdf' };
  downloadError = null; downloads = []; uploads = []; deletedKeys = []; inserted = []; insertError = null; rpcCalls = []; updates = [];
  usedBytes = 0;
  subscription = { plan: { storage_limit_mb: 100 } };
});

test('a PDF is downloaded (16 MB cap), stored under booking-files/<business>/, tracked, and counted in storage', async () => {
  const result = await store();
  assert.equal(result.status, 'stored');
  assert.deepEqual(downloads, [{ id: 'm1', token: 'enc', maxBytes: 16 * 1024 * 1024 }]);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].folder, 'booking-files/b1');
  assert.equal(uploads[0].ext, 'pdf');
  assert.equal(uploads[0].contentType, 'application/pdf');
  assert.match(result.url, /^https:\/\/r2\.test\/booking-files\/b1\/[0-9a-f-]{36}\.pdf$/);
  assert.deepEqual(inserted[0], {
    business_id: 'b1', customer_id: 'c1', field_key: 'idProof', r2_key: result.key, url: result.url,
    size_bytes: 1000, mime_type: 'application/pdf', filename: 'Quote.pdf'
  });
  assert.deepEqual(rpcCalls, [['increment_business_storage_used', { p_business_id: 'b1', p_delta_bytes: 1000 }]]);
});

test('every type on the list is accepted: images (no filename) and office files', async () => {
  for (const [mime, ext] of [['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['text/csv', 'csv'], ['application/vnd.ms-excel', 'xls']]) {
    uploads = [];
    downloadResult = { buffer: Buffer.alloc(10), mimeType: mime };
    const result = await store({ id: 'm', mimeType: mime, filename: null });
    assert.equal(result.status, 'stored', mime);
    assert.equal(uploads[0].ext, ext, mime);
  }
});

test('an octet-stream Excel file is kept by its filename extension', async () => {
  downloadResult = { buffer: Buffer.alloc(10), mimeType: 'application/octet-stream' };
  const result = await store({ id: 'm', mimeType: 'application/octet-stream', filename: 'Prices.xlsx' });
  assert.equal(result.status, 'stored');
  assert.equal(uploads[0].ext, 'xlsx');
});

test('a type off the list is refused from the payload alone, without downloading', async () => {
  assert.deepEqual(await store({ id: 'm', mimeType: 'application/zip', filename: 'a.zip' }), { status: 'rejected', reason: 'type' });
  assert.deepEqual(await store({ id: 'm', mimeType: 'video/mp4', filename: null }), { status: 'rejected', reason: 'type' });
  assert.equal(downloads.length, 0);
  assert.equal(uploads.length, 0);
  assert.equal(inserted.length, 0);
});

test('a payload with no type is decided after the download', async () => {
  downloadResult = { buffer: Buffer.alloc(10), mimeType: 'video/mp4' };
  assert.deepEqual(await store({ id: 'm', mimeType: null, filename: null }), { status: 'rejected', reason: 'type' });
  assert.equal(downloads.length, 1);
  assert.equal(uploads.length, 0);
});

test('over 16 MB is refused: by Meta size check, by the download cap, or by the buffer itself', async () => {
  downloadError = new Error('Media m1 is 20000000 bytes, over the 16777216 limit');
  assert.deepEqual(await store(), { status: 'rejected', reason: 'too_large' });
  downloadError = new Error('maxContentLength size of 16777216 exceeded');
  assert.deepEqual(await store(), { status: 'rejected', reason: 'too_large' });
  downloadError = null;
  downloadResult = { buffer: Buffer.alloc(16 * 1024 * 1024 + 1), mimeType: 'application/pdf' };
  assert.deepEqual(await store(), { status: 'rejected', reason: 'too_large' });
  assert.equal(uploads.length, 0);
});

test('the media storage limit applies: a file that would exceed the plan is refused and nothing is counted', async () => {
  subscription = { plan: { storage_limit_mb: 1 } };
  usedBytes = 1024 * 1024 - 500;
  assert.deepEqual(await store(), { status: 'rejected', reason: 'storage_limit' });
  assert.equal(uploads.length, 0);
  assert.equal(rpcCalls.length, 0);
  usedBytes = 1024 * 1024 - 1000; // exactly fits
  assert.equal((await store()).status, 'stored');
});

test('a business with no active plan is not blocked by the limit', async () => {
  subscription = null;
  usedBytes = 10 ** 12;
  assert.equal((await store()).status, 'stored');
});

test('a Meta failure is "failed", never a throw', async () => {
  downloadError = new Error('expired media id');
  assert.deepEqual(await store(), { status: 'rejected', reason: 'failed' });
});

test('if the file cannot be tracked, the R2 object is removed again and nothing is counted', async () => {
  insertError = new Error('db down');
  assert.deepEqual(await store(), { status: 'rejected', reason: 'failed' });
  assert.equal(uploads.length, 1);
  assert.deepEqual(deletedKeys, [`booking-files/b1/${uploads[0].publicId}.pdf`]);
  assert.equal(rpcCalls.length, 0);
});

test('attachFilesToBooking links the files by url to the booking, and does nothing without any', async () => {
  await attachFilesToBooking('b1', 'booking-9', ['https://r2.test/a.pdf', 'https://r2.test/b.jpg']);
  assert.deepEqual(updates, [{ patch: { booking_id: 'booking-9' }, col: 'url', values: ['https://r2.test/a.pdf', 'https://r2.test/b.jpg'] }]);
  updates = [];
  await attachFilesToBooking('b1', 'booking-9', []);
  await attachFilesToBooking('b1', 'booking-9', undefined);
  assert.equal(updates.length, 0);
});
