// Run: node --test src/controllers/webhook.mediaReply.test.js
// "When a customer sends a photo, PDF or document" in the inbound-message webhook:
//   default          the old "I can only read text" reply, nothing stored, no alert
//   thank_and_alert  thank the customer, raise the handoff (reason 'media'), store documents in the chat;
//                    works with the human-needed alert itself off
// and the booking 'file' question, which takes the photo / document as its answer.
// In-memory Supabase and Redis, every queue / external service stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const BIZ = 'b1';
const NUMBER = '919800000001';
const SECRET = 'test-secret';
const HOUR = 3600 * 1000;

let db; let queued; let pushCalls; let activeSession; let redisStore; let currentField; let advanceCalls; let storeResult; let storeCalls;
let downloads; let uploads; let downloadResult;

const from = (table) => {
  const filters = []; let op = 'select'; let payload;
  const rows = () => (db[table] = db[table] || []);
  const matching = () => rows().filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'insert') { const row = { id: `${table}-${rows().length + 1}`, ...payload }; rows().push(row); return [row]; }
    if (op === 'update') { const m = matching(); m.forEach(r => Object.assign(r, payload)); return m; }
    return matching();
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    is: (c, v) => { filters.push(r => (r[c] ?? null) === v); return q; },
    not: (c, _op, v) => { filters.push(r => (r[c] ?? null) !== v); return q; },
    or: (expr) => {
      const parts = expr.split(',').map(p => p.split('.'));
      filters.push(r => parts.some(([col, opName]) => opName === 'is' && (r[col] === null || r[col] === undefined)));
      return q;
    },
    lt: () => q,
    update: (p) => { op = 'update'; payload = p; return q; },
    insert: (p) => { op = 'insert'; payload = p; return q; },
    order: () => q,
    limit: () => q,
    in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
    maybeSingle: async () => ({ data: run()[0] || null, error: null }),
    single: async () => ({ data: run()[0] || null, error: null }),
    then: (resolve, reject) => Promise.resolve({ data: run(), error: null }).then(resolve, reject)
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/env', { META_APP_SECRET: SECRET, FRONTEND_URL: 'https://app.test', STATUS_RETRY_DELAY_MS: 30 });
stub('../config/supabase', { from, rpc: async () => ({ data: { changed: [], changed_recipients: [], unmatched: [] }, error: null }) });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub('../config/redis', {
  get: async (k) => redisStore.get(k) ?? null,
  // SET key value EX n NX: only the first claim wins (the one-reply-per-minute cooldown)
  set: async (k, v, ...args) => {
    if (args.includes('NX') && redisStore.has(k)) return null;
    redisStore.set(k, v); return 'OK';
  },
  del: async (k) => (redisStore.delete(k) ? 1 : 0),
  incr: async (k) => { const n = (redisStore.get(k) || 0) + 1; redisStore.set(k, n); return n; },
  expire: async () => 1
});
stub('../config/queueConnection', { queueConnection: {}, workerConnection: {} });
stub('../queues/whatsapp.queue', {
  addToWhatsappQueue: async (job) => { queued.push(job); },
  addToWhatsappQueueAndWait: async (job) => { queued.push(job); }
});
stub('../queues/handoffReminder.queue', { scheduleHandoffReminder: async () => {}, cancelHandoffReminder: async () => {} });
stub('../queues/sessionTimeout.queue', { scheduleSessionTimeout: async () => {}, cancelSessionTimeout: async () => {} });
const socketEvents = [];
stub('../services/socket.service', { emitToBusiness: (...args) => { socketEvents.push(args); } });
stub('../services/broadcastProgress.service', { notifyBroadcastProgress: () => {} });
stub('../services/tenant.service', {
  invalidateTenantCache: async () => {},
  resolveBusinessByPhoneNumberId: async () => ({
    businessId: BIZ, isActive: true, subscription: { status: 'active' }, plan: { msg_limit: 500 },
    phoneNumberId: 'pn1', accessToken: 'tok', displayName: 'Biz', businessName: 'Biz', enabledLanguages: ['en', 'hi']
  })
});
stub('../services/usage.service', {
  checkUsageLimit: async () => ({ allowed: true, current: 0, limit: 500 }),
  recordOutbound: async () => {}
});
const realNotification = (() => { const real = require('../services/notification.service'); return { isAcknowledgement: real.isAcknowledgement, asksForHuman: real.asksForHuman }; })();
stub('../services/notification.service', {
  ...realNotification,
  notify: (...args) => { pushCalls.push(['notify', ...args]); },
  notifyOnce: async (...args) => { pushCalls.push(['notifyOnce', ...args]); },
  notifyNewMessage: async (...args) => { pushCalls.push(['notifyNewMessage', ...args]); }
});
stub('../services/smartFallback.service', { getSmartFallbackReply: async () => null });
stub('../services/business.service', { getBusinessById: async () => ({ id: BIZ, enabledLanguages: ['en', 'hi'], welcomeMessage: null }) });
stub('../services/booking.service', {
  getBookingSession: async () => activeSession,
  deleteBookingSession: async () => {},
  saveBookingSession: async () => {},
  recordBookingLead: async () => {},
  finalizeGraphBooking: async () => ({ text: 'done' }),
  normalizeOption: (o) => o
});
stub('../services/bookingGraph.service', {
  getCurrentNodeField: async () => currentField,
  advanceGraphSession: async (args) => { advanceCalls.push(args); return { session: activeSession, result: 'Next question?' }; },
  startGraphSession: async () => { throw new Error('unexpected'); },
  startGraphSessionAtNode: async () => { throw new Error('unexpected'); }
});
stub('../services/bookingFile.service', {
  storeBookingFile: async (args) => { storeCalls.push(args); return storeResult; },
  attachFilesToBooking: async () => {}
});
stub('../services/chatbot.service', {
  findMatchingRule: async () => null,
  resolveTappedEdge: async () => null,
  getOutgoingEdges: async () => []
});
stub('../services/r2.service', {
  uploadImage: async () => ({ url: 'https://r2.test/img.jpg', key: 'img.jpg' }),
  uploadFile: async (buffer, folder, publicId, ext, contentType) => {
    uploads.push({ folder, publicId, ext, contentType, size: buffer.length });
    return { url: `https://r2.test/${folder}/${publicId}.${ext}`, key: `${folder}/${publicId}.${ext}` };
  }
});
stub('../services/whatsapp.service', {
  downloadMedia: async (id, token, maxBytes) => { downloads.push({ id, maxBytes }); return downloadResult; }
});

const { receiveWebhook } = require('./webhook.controller');

const sendBody = async (body) => {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  const res = { status() { return this; }, json() {} };
  await receiveWebhook({ body, rawBody, headers: { 'x-hub-signature-256': signature } }, res);
};
const inbound = (message) => sendBody({
  entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'pn1' }, contacts: [{ profile: { name: 'Ravi' } }],
    messages: [{ id: `wamid.${Math.random()}`, from: NUMBER, ...message }]
  } }] }]
});
const image = () => inbound({ type: 'image', image: { id: 'media-img', mime_type: 'image/jpeg' } });
const pdf = () => inbound({ type: 'document', document: { id: 'media-pdf', mime_type: 'application/pdf', filename: 'Quote.pdf' } });
const video = () => inbound({ type: 'video', video: { id: 'media-vid', mime_type: 'video/mp4' } });
// storeInboundImage / storeInboundDocument run after the reply, in the background
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const hoursAgo = (h) => new Date(Date.now() - h * HOUR).toISOString();
const humanPushes = () => pushCalls.filter((c) => c[0] === 'notify' && c[2] === 'human_needed');
const customer = () => db.customers.find((c) => c.id === 'c1');
const texts = () => queued.map((j) => j.message);
const ONLY_TEXT = /I can only read text/;
const THANKS = /We've received your file/;
const settingsRow = (over = {}) => ({
  business_id: BIZ, enabled: false, keywords: null, unmatched_threshold: 3, reply_text: '', reply_text_translations: {},
  closed_text: '', closed_text_translations: {}, pause_bot_minutes: 0, reminder_minutes: 15, auto_resume_bot: false, hours: null,
  media_reply_mode: 'thank_and_alert', media_reply_text: '', media_reply_text_translations: {}, ...over
});

test.beforeEach(() => {
  queued = []; pushCalls = []; activeSession = null; redisStore = new Map(); currentField = null; advanceCalls = []; storeCalls = [];
  storeResult = { status: 'stored', url: 'https://r2.test/booking-files/b1/f1.pdf', key: 'booking-files/b1/f1.pdf' };
  downloads = []; uploads = [];
  downloadResult = { buffer: Buffer.from('%PDF-1.4 test'), mimeType: 'application/pdf' };
  socketEvents.length = 0;
  db = {
    customers: [
      { id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, name: 'Ravi', total_messages: 3, preferred_language: 'en', is_blocked: false, bot_paused_until: null, opted_out_at: null, marketing_blocked_at: null, last_message_at: hoursAgo(1), needs_human_at: null }
    ],
    messages: [], message_templates: [], flow_nodes: [], businesses: [],
    business_handoff_settings: [settingsRow()]
  };
});

// ── default: today's behaviour ──────────────────────────────────────────────
test('default mode: a photo gets the "I can only read text" reply, no alert, nothing stored', async () => {
  db.business_handoff_settings = [settingsRow({ media_reply_mode: 'default' })];
  await image();
  await pdf();
  await settle();
  assert.match(texts()[0], ONLY_TEXT);
  assert.equal(customer().needs_human_at, null);
  assert.equal(humanPushes().length, 0);
  // Unchanged: customer photos are copied to R2 as before (storeInboundImage); a document is only labelled.
  assert.deepEqual(downloads.map((d) => d.id), ['media-img']);
  assert.equal(uploads.length, 0);
});

test('no settings row: the same as default mode', async () => {
  db.business_handoff_settings = [];
  await pdf();
  await settle();
  assert.match(texts()[0], ONLY_TEXT);
  assert.equal(customer().needs_human_at, null);
  assert.equal(downloads.length, 0);
});

// ── thank_and_alert ─────────────────────────────────────────────────────────
test('thank_and_alert: thanks the customer, raises the handoff with reason media, no "text only" message', async () => {
  await image();
  assert.deepEqual(texts().filter((t) => ONLY_TEXT.test(t)), []);
  assert.match(texts()[0], THANKS);
  assert.equal(customer().needs_human_reason, 'media');
  assert.ok(customer().needs_human_at);
  assert.equal(humanPushes().length, 1);
});

test('thank_and_alert works with the human-needed alert off: the keyword trigger stays off', async () => {
  await image(); // settings.enabled is false in this row
  assert.equal(customer().needs_human_reason, 'media');
  db.customers[0].needs_human_at = null; db.customers[0].needs_human_reason = null; pushCalls = [];
  await inbound({ type: 'text', text: { body: 'talk to owner' } });
  assert.equal(customer().needs_human_at, null); // no keyword escalation
  assert.equal(humanPushes().length, 0);
});

test('thank_and_alert: the business text in the customer language, else the built-in one in that language', async () => {
  db.business_handoff_settings = [settingsRow({ media_reply_text: 'Got it, {{customerName}}', media_reply_text_translations: { hi: 'मिल गया' } })];
  db.customers[0].preferred_language = 'hi';
  await image();
  assert.equal(texts()[0], 'मिल गया');
  db.customers[0].preferred_language = 'en'; db.customers[0].needs_human_at = null; queued = []; redisStore.clear();
  await image();
  assert.match(texts()[0], /^Got it, /);
  db.business_handoff_settings = [settingsRow()];
  db.customers[0].needs_human_at = null; queued = []; redisStore.clear();
  await image();
  assert.match(texts()[0], THANKS);
});

test('thank_and_alert: a burst of photos gets one thank-you and one alert', async () => {
  await image();
  await image();
  await pdf();
  assert.equal(texts().filter((t) => THANKS.test(t)).length, 1);
  assert.equal(humanPushes().length, 1);
});

test('thank_and_alert: a repeat while the escalation is open sends no second alert', async () => {
  await image();
  redisStore.clear(); // the one-reply-a-minute cooldown has passed
  await image();
  assert.equal(texts().filter((t) => THANKS.test(t)).length, 2);
  assert.equal(humanPushes().length, 1);
});

test('thank_and_alert: mid-booking the thank-you is followed by the pending question', async () => {
  activeSession = { ruleId: 'r1', currentNodeId: 'n1' };
  currentField = { nodeId: 'n1', fieldKey: 'name', fieldType: 'text', label: 'Your name?' };
  await image();
  assert.match(texts()[0], THANKS);
  assert.match(texts()[1], /Your name\?/);
  assert.equal(advanceCalls.length, 0);
});

test('thank_and_alert: a video or voice note still gets the "text only" reply (not a photo, PDF or document)', async () => {
  await video();
  assert.match(texts()[0], ONLY_TEXT);
  assert.equal(customer().needs_human_at, null);
});

test('thank_and_alert: a PDF is stored in the chat folder with its type and name, and the app is told', async () => {
  await pdf();
  await settle();
  assert.deepEqual(downloads, [{ id: 'media-pdf', maxBytes: 16 * 1024 * 1024 }]);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].folder, `inbound-media/${BIZ}`);
  assert.equal(uploads[0].ext, 'pdf');
  assert.equal(uploads[0].contentType, 'application/pdf');
  const row = db.messages.find((m) => m.direction === 'inbound');
  assert.equal(row.media_url, `https://r2.test/inbound-media/${BIZ}/${row.id}.pdf`);
  assert.equal(row.wa_media_filename, 'Quote.pdf');
  assert.equal(row.wa_media_mime, 'application/pdf');
  const event = socketEvents.find((e) => e[1] === 'message_media');
  assert.deepEqual(event[2], { messageId: row.id, customerId: 'c1', mediaUrl: row.media_url, mediaFilename: 'Quote.pdf', mediaMime: 'application/pdf' });
});

test('thank_and_alert: an Excel file whose type Meta reports as octet-stream is stored by its filename extension', async () => {
  downloadResult = { buffer: Buffer.from('x'), mimeType: 'application/octet-stream' };
  await inbound({ type: 'document', document: { id: 'media-x', filename: 'Prices.XLSX' } });
  await settle();
  assert.equal(uploads[0].ext, 'xlsx');
  assert.match(uploads[0].contentType, /spreadsheetml\.sheet$/);
});

test('thank_and_alert: a file type off the list is not stored, but the customer is still thanked and the team alerted', async () => {
  await inbound({ type: 'document', document: { id: 'media-zip', mime_type: 'application/zip', filename: 'all.zip' } });
  await settle();
  assert.equal(downloads.length, 0);
  assert.equal(uploads.length, 0);
  assert.equal(db.messages.find((m) => m.direction === 'inbound').media_url ?? null, null);
  assert.match(texts()[0], THANKS);
  assert.equal(humanPushes().length, 1);
});

test('thank_and_alert: a document over 16 MB is not stored (the download is refused), the reply and alert still happen', async () => {
  const realDownload = downloadResult;
  downloadResult = null;
  stub('../services/whatsapp.service', { downloadMedia: async () => { throw new Error('Media m is 20000000 bytes, over the 16777216 limit'); } });
  await pdf();
  await settle();
  assert.equal(uploads.length, 0);
  assert.match(texts()[0], THANKS);
  assert.equal(humanPushes().length, 1);
  stub('../services/whatsapp.service', { downloadMedia: async (id, token, maxBytes) => { downloads.push({ id, maxBytes }); return realDownload; } });
});

// ── booking 'file' question ─────────────────────────────────────────────────
const fileQuestion = () => {
  activeSession = { ruleId: 'r1', currentNodeId: 'n-file' };
  currentField = { nodeId: 'n-file', fieldKey: 'idProof', fieldType: 'file', label: 'Send your ID proof' };
};

test('file question: a photo answers it - stored first, then handed to the engine as { fileUrl }', async () => {
  fileQuestion();
  await image();
  assert.equal(storeCalls.length, 1);
  assert.deepEqual(storeCalls[0].media, { id: 'media-img', mimeType: 'image/jpeg', filename: null });
  assert.equal(storeCalls[0].fieldKey, 'idProof');
  assert.equal(advanceCalls.length, 1);
  assert.deepEqual(advanceCalls[0].reply, { fileUrl: 'https://r2.test/booking-files/b1/f1.pdf' });
  assert.equal(texts().filter((t) => ONLY_TEXT.test(t)).length, 0);
});

test('file question: a document answers it too, with its filename', async () => {
  fileQuestion();
  await pdf();
  assert.deepEqual(storeCalls[0].media, { id: 'media-pdf', mimeType: 'application/pdf', filename: 'Quote.pdf' });
  assert.equal(advanceCalls.length, 1);
});

test('file question: takes precedence over thank_and_alert - no alert, no thank-you', async () => {
  fileQuestion();
  await image();
  assert.equal(customer().needs_human_at, null);
  assert.equal(humanPushes().length, 0);
  assert.equal(texts().filter((t) => THANKS.test(t)).length, 0);
});

test('file question: works in default mode too', async () => {
  db.business_handoff_settings = [];
  fileQuestion();
  await image();
  assert.equal(advanceCalls.length, 1);
});

test('file question: a file that cannot be stored is explained and the question asked again, the booking does not advance', async () => {
  fileQuestion();
  storeResult = { status: 'rejected', reason: 'type' };
  await pdf();
  assert.equal(advanceCalls.length, 0);
  assert.match(texts()[0], /couldn't accept that file/);
  assert.match(texts()[0], /16 MB/);
  assert.match(texts()[1], /Send your ID proof/);
});

test('file question: a burst of rejected files gets one explanation', async () => {
  fileQuestion();
  storeResult = { status: 'rejected', reason: 'too_large' };
  await image();
  await image();
  assert.equal(texts().filter((t) => /couldn't accept that file/.test(t)).length, 1);
});

test('a photo on a question that is not a file question is not a booking answer', async () => {
  activeSession = { ruleId: 'r1', currentNodeId: 'n1' };
  currentField = { nodeId: 'n1', fieldKey: 'name', fieldType: 'text', label: 'Your name?' };
  db.business_handoff_settings = [];
  await image();
  assert.equal(storeCalls.length, 0);
  assert.equal(advanceCalls.length, 0);
  assert.match(texts()[0], ONLY_TEXT);
  assert.match(texts()[1], /Your name\?/);
});
