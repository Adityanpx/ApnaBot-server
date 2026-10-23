// Run: node --test src/controllers/webhook.replyMedia.test.js
// A reply node with extra media: gallery photos #2..N, then the video, are sent first - each
// awaited, stored as an outbound row, counted once, pushed to the dashboard - then the normal reply
// (with photo #1) exactly as before. Limits come from the business's CURRENT plan; media over them
// (after a downgrade) and ids that no longer resolve are skipped silently. In-memory Supabase,
// everything else stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const BIZ = 'b1';
const NUMBER = '919800000001';
const SECRET = 'test-secret';

let db; let events; let node; let plan; let usage; let sockets; let logs; let failSend;

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
    in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    insert: (p) => { op = 'insert'; payload = p; return q; },
    order: () => q,
    maybeSingle: async () => ({ data: run()[0] || null, error: null }),
    single: async () => ({ data: run()[0] || null, error: null }),
    then: (resolve, reject) => Promise.resolve({ data: run(), error: null }).then(resolve, reject)
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/env', { META_APP_SECRET: SECRET, FRONTEND_URL: 'https://app.test' });
stub('../config/supabase', { from });
stub('../utils/logger', {
  info: (...a) => logs.push(a.join(' ')), warn: () => {}, error: (...a) => logs.push(`ERROR ${a.join(' ')}`), debug: () => {}
});
stub('../config/redis', {});
stub('../config/queueConnection', { queueConnection: {}, workerConnection: {} });
stub('../queues/whatsapp.queue', {
  addToWhatsappQueue: async (job) => { events.push({ kind: 'queue', job }); },
  addToWhatsappQueueAndWait: async (job) => {
    if (failSend && failSend(job)) throw new Error('enqueue failed');
    events.push({ kind: 'wait', job });
  }
});
stub('../queues/sessionTimeout.queue', { scheduleSessionTimeout: async () => {}, cancelSessionTimeout: async () => {} });
stub('../services/socket.service', { emitToBusiness: (b, name, payload) => { sockets.push(payload.message); } });
stub('../services/tenant.service', {
  resolveBusinessByPhoneNumberId: async () => ({
    businessId: BIZ, isActive: true, subscription: { status: 'active' }, plan,
    phoneNumberId: 'pn1', accessToken: 'tok', displayName: 'Biz', businessName: 'Biz'
  })
});
stub('../services/usage.service', {
  checkUsageLimit: async () => ({ allowed: true, current: 0, limit: 500 }),
  recordOutbound: async () => { usage.push('outbound'); }
});
stub('../services/smartFallback.service', { getSmartFallbackReply: async () => null });
stub('../services/business.service', { getBusinessById: async () => ({ id: BIZ, enabledLanguages: ['en'], name: 'Biz' }) });
stub('../services/booking.service', {
  getBookingSession: async () => null, deleteBookingSession: async () => {}, saveBookingSession: async () => {},
  recordBookingLead: async () => {}, finalizeGraphBooking: async () => ({ text: 'done' }), normalizeOption: (o) => o
});
stub('../services/bookingGraph.service', {});
stub('../services/chatbot.service', {
  findMatchingRule: async (businessId, text) => (text === 'photos' ? { node, edges: [] } : null),
  resolveTappedEdge: async () => null,
  getOutgoingEdges: async () => []
});
stub('../services/r2.service', {});
stub('../services/whatsapp.service', {});

const { receiveWebhook } = require('./webhook.controller');

const say = async (text) => {
  const body = {
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'pn1' }, contacts: [{ profile: { name: 'Ravi' } }],
      messages: [{ id: `wamid.${Math.random()}`, from: NUMBER, type: 'text', text: { body: text } }]
    } }] }]
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  await receiveWebhook({ body, rawBody, headers: { 'x-hub-signature-256': signature } }, { status() { return this; }, json() {} });
};

const BASIC = { msg_limit: 500, images_per_reply: 1, video_per_reply: false };
const PRO = { msg_limit: 2000, images_per_reply: 3, video_per_reply: false };
const BUSINESS = { msg_limit: -1, images_per_reply: 10, video_per_reply: true };

test.beforeEach(() => {
  events = []; sockets = []; usage = []; logs = []; failSend = null; plan = BUSINESS;
  db = {
    customers: [{ id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, name: 'Ravi', total_messages: 3, preferred_language: 'en', is_blocked: false, bot_paused_until: null, opted_out_at: null }],
    messages: [],
    business_media: [
      { id: 'p2', business_id: BIZ, url: 'https://r2.test/p2.jpeg', media_type: 'image' },
      { id: 'p3', business_id: BIZ, url: 'https://r2.test/p3.jpeg', media_type: 'image' },
      { id: 'p4', business_id: BIZ, url: 'https://r2.test/p4.jpeg', media_type: 'image' },
      { id: 'vid', business_id: BIZ, url: 'https://r2.test/v.mp4', media_type: 'video' },
      { id: 'foreign', business_id: 'b2', url: 'https://r2.test/foreign.jpeg', media_type: 'image' }
    ]
  };
  node = {
    id: 'n1', contentType: 'text', replyKind: 'text', isActive: true, label: 'Our rooms',
    imageUrl: 'https://r2.test/p1.jpeg', galleryMediaIds: [], videoMediaId: null
  };
});

const sent = () => events.map(e => e.job);
const mediaSends = () => sent().filter(j => j.type === 'image' || j.type === 'video');
const reply = () => events.find(e => e.kind === 'queue').job;
const outboundRows = () => db.messages.filter(m => m.direction === 'outbound');

test('Business plan: gallery photos in order, then the video, then the normal reply with photo #1', async () => {
  node.galleryMediaIds = ['p3', 'p2']; node.videoMediaId = 'vid';
  await say('photos');

  assert.deepEqual(events.map(e => e.kind), ['wait', 'wait', 'wait', 'queue'], 'extras awaited, the reply enqueued last');
  const [a, b, v, r] = sent();
  assert.deepEqual([a.type, a.imageUrl, a.message], ['image', 'https://r2.test/p3.jpeg', '']);
  assert.deepEqual([b.type, b.imageUrl], ['image', 'https://r2.test/p2.jpeg']);
  assert.deepEqual([v.type, v.videoUrl, v.message], ['video', 'https://r2.test/v.mp4', '']);
  assert.equal(v.imageUrl, undefined);
  assert.deepEqual([r.message, r.imageUrl, r.type], ['Our rooms', 'https://r2.test/p1.jpeg', 'text']);
  for (const j of [a, b, v]) assert.deepEqual([j.businessId, j.to, j.phoneNumberId], [BIZ, NUMBER, 'pn1']);
});

test('each extra is stored as an outbound row (bot, media_url) before the reply row, counted once, pushed to the dashboard', async () => {
  node.galleryMediaIds = ['p2']; node.videoMediaId = 'vid';
  await say('photos');

  const rows = outboundRows();
  assert.deepEqual(rows.map(r => [r.type, r.media_url, r.sender_type, r.content]), [
    ['image', 'https://r2.test/p2.jpeg', 'bot', ''],
    ['video', 'https://r2.test/v.mp4', 'bot', ''],
    ['text', undefined, 'bot', 'Our rooms']
  ]);
  assert.deepEqual(sent().map(j => j.messageId), rows.map(r => r.id), 'each job points at its own row');
  assert.deepEqual(usage, [], 'counted by the queue worker (one unit per job), not by the webhook');
  assert.equal(sockets.filter(m => m && m.direction === 'outbound').length, 3);
});

test('Pro plan: photo #1 + 2 extra; a 3rd extra and the video (stored from a higher plan) are skipped with one info log', async () => {
  plan = PRO;
  node.galleryMediaIds = ['p2', 'p3', 'p4']; node.videoMediaId = 'vid';
  await say('photos');

  assert.deepEqual(mediaSends().map(j => j.imageUrl || j.videoUrl), ['https://r2.test/p2.jpeg', 'https://r2.test/p3.jpeg']);
  assert.equal(reply().message, 'Our rooms');
  assert.equal(logs.filter(l => l.includes('skipping stored media over the plan')).length, 1);
  assert.equal(logs.some(l => l.startsWith('ERROR')), false, 'never an error');
});

test('Basic plan (and no plan at all): only the normal reply is sent, extras skipped', async () => {
  node.galleryMediaIds = ['p2']; node.videoMediaId = 'vid';
  for (const p of [BASIC, null]) {
    events = []; db.messages = []; plan = p;
    await say('photos');
    assert.deepEqual(mediaSends(), []);
    assert.equal(events.length, 1);
    assert.equal(reply().imageUrl, 'https://r2.test/p1.jpeg');
  }
});

test('limits are read at send time: the same stored node sends more after an upgrade', async () => {
  node.galleryMediaIds = ['p2', 'p3'];
  plan = BASIC; await say('photos');
  assert.equal(mediaSends().length, 0);
  events = []; plan = BUSINESS; await say('photos');
  assert.equal(mediaSends().length, 2);
});

test('an id that was deleted, belongs to another business, or has the wrong type is skipped; the rest still go in order', async () => {
  node.galleryMediaIds = ['gone', 'p2', 'foreign', 'vid', 'p3'];
  await say('photos');
  assert.deepEqual(mediaSends().map(j => j.imageUrl), ['https://r2.test/p2.jpeg', 'https://r2.test/p3.jpeg']);
  assert.equal(reply().message, 'Our rooms');
  assert.equal(outboundRows().length, 3);
});

test('a failed enqueue of one extra is logged and the rest, and the reply, still go out', async () => {
  node.galleryMediaIds = ['p2', 'p3'];
  failSend = (job) => job.imageUrl === 'https://r2.test/p2.jpeg';
  await say('photos');
  assert.deepEqual(mediaSends().map(j => j.imageUrl), ['https://r2.test/p3.jpeg']);
  assert.equal(reply().message, 'Our rooms');
  assert.ok(logs.some(l => l.startsWith('ERROR')));
});

test('a list reply sends no extra media', async () => {
  node.contentType = 'list'; node.galleryMediaIds = ['p2']; node.videoMediaId = 'vid';
  await say('photos');
  assert.deepEqual(mediaSends(), []);
});

test('a node with no extra media: no library lookup, no extra rows, the reply job is unchanged', async () => {
  await say('photos');
  assert.equal(events.length, 1);
  assert.equal(outboundRows().length, 1);
  assert.deepEqual(usage, [], 'counted by the queue worker when Meta accepts the job, not by the webhook');
});
