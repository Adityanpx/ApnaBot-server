// Run: node --test src/controllers/webhook.interactiveSites.test.js
// Every place receiveWebhook saves a bot message that has buttons, a list, a link or a
// location prompt. Two things are checked for each:
//   1. the saved row's interactive_payload says what the customer was shown, and
//   2. the queue job and the Meta payload are unchanged: webhook.interactiveSites.golden.json
//      holds the exact JSON (key order included) captured BEFORE interactive_payload was
//      added, and the job is run through the REAL worker and senders to get the Meta body.
// In-memory Supabase, everything else stubbed - no database, Redis or WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const GOLDEN = require('./webhook.interactiveSites.golden.json');

const BIZ = 'b1';
const NODE = '33333333-3333-4333-8333-333333333333';
const TPL = '0b3f6c1e-1111-4222-8333-944455556666';
const NUMBER = '919800000001';
const SECRET = 'test-secret';

let db; let queued; let session; let enabledLanguages; let matches; let currentField; let directField; let processor; let posted;

const from = (table) => {
  const filters = []; let op = 'select'; let payload;
  const rows = () => (db[table] = db[table] || []);
  const matching = () => rows().filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'insert') {
      const row = { id: `${table}-${rows().length + 1}`, ...payload, ...(table === 'booking_form_tokens' ? { token: 'tok123' } : {}) };
      rows().push(row);
      return [row];
    }
    if (op === 'update') { const m = matching(); m.forEach(r => Object.assign(r, payload)); return m; }
    return matching();
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
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
stub('bullmq', { Worker: class { constructor(name, fn) { processor = fn; } on() {} } });
stub('../config/env', { META_APP_SECRET: SECRET, FRONTEND_URL: 'https://app.test', QUEUE_NAMESPACE: 'test', GRAPH_API_VERSION: 'v99.0' });
stub('../config/supabase', { from });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub('../utils/crypto', { decrypt: () => 'token', encrypt: (v) => v });
stub('../config/redis', {});
stub('../config/queueConnection', { queueConnection: {}, workerConnection: {} });
stub('../queues/whatsapp.queue', {
  addToWhatsappQueue: async (job) => { queued.push(JSON.stringify(job)); },
  addToWhatsappQueueAndWait: async (job) => { queued.push(JSON.stringify(job)); }
});
stub('../queues/sessionTimeout.queue', { scheduleSessionTimeout: async () => {}, cancelSessionTimeout: async () => {} });
stub('../services/socket.service', { emitToBusiness: () => {} });
stub('../services/tenant.service', {
  resolveBusinessByPhoneNumberId: async () => ({
    businessId: BIZ, isActive: true, subscription: { status: 'active' }, plan: { msg_limit: 500 },
    phoneNumberId: 'pn1', accessToken: 'tok', displayName: 'Biz', businessName: 'Biz'
  })
});
stub('../services/usage.service', {
  checkUsageLimit: async () => ({ allowed: true, current: 0, limit: 500 }),
  incrementUsage: async () => {}
});
stub('../services/smartFallback.service', { getSmartFallbackReply: async () => null });
stub('../services/business.service', {
  getBusinessById: async () => ({ id: BIZ, enabledLanguages, welcomeMessage: null })
});
stub('../services/booking.service', {
  getBookingSession: async () => session,
  deleteBookingSession: async () => {},
  saveBookingSession: async () => {},
  recordBookingLead: async () => {},
  finalizeGraphBooking: async () => ({ text: 'done' }),
  normalizeOption: (o) => o
});
stub('../services/bookingGraph.service', {
  getCurrentNodeField: async () => currentField,
  advanceGraphSession: async () => ({ session, result: 'x' }),
  startGraphSession: async () => { throw new Error('unexpected'); },
  startGraphSessionAtNode: async (businessId, nodeId) => ({ session: { nodeId }, field: directField })
});
stub('../services/chatbot.service', {
  findMatchingRule: async (businessId, text) => matches[text] || null,
  resolveTappedEdge: async () => null,
  getOutgoingEdges: async () => []
});
stub('../services/optInLink.service', {
  findLinkByCode: async () => ({ id: 'link1', is_active: true }),
  isFeatureEnabled: async () => true,
  isOptedIn: () => false,
  logEvent: async () => {},
  handleConsentTap: async () => ({ newlyOptedIn: false, customer: {} })
});
stub('../services/r2.service', {});

const axios = require('axios');
require('../queues/whatsapp.worker');
const { receiveWebhook } = require('./webhook.controller');

const send = async (message) => {
  const body = {
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'pn1' }, contacts: [{ profile: { name: 'Ravi' } }],
      messages: [{ id: `wamid.${Math.random()}`, from: NUMBER, ...message }]
    } }] }]
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  const res = { status() { return this; }, json() {} };
  await receiveWebhook({ body, rawBody, headers: { 'x-hub-signature-256': signature } }, res);
};
const say = (text) => send({ type: 'text', text: { body: text } });
const tap = (index, title) => send({ type: 'button', button: { payload: `tpl:${TPL}:${index}`, text: title } });

// Each queued job, as JSON, with the Meta request body the real worker and senders make from it.
const sent = async () => {
  const out = [];
  for (const json of queued) {
    posted = [];
    const job = JSON.parse(json);
    const forSend = { ...job };
    delete forSend.messageId;
    await processor({ data: forSend, attemptsMade: 0 });
    out.push({ job: json, meta: posted.length ? JSON.stringify(posted[0]) : null });
  }
  return out;
};
const botRows = () => db.messages.filter(m => m.direction === 'outbound');

test.beforeEach(() => {
  db = {
    customers: [{ id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, name: 'Ravi', total_messages: 3, preferred_language: 'en', is_blocked: false, bot_paused_until: null, opted_out_at: null }],
    messages: [],
    message_templates: [{ id: TPL, business_id: BIZ, button_actions: [
      { index: 0, text: 'Prices', action: { type: 'keyword', keyword: 'price' } },
      { index: 2, text: 'Book', action: { type: 'node', nodeId: NODE } }
    ] }],
    flow_nodes: [{ id: NODE, business_id: BIZ, node_type: 'question', is_active: true }]
  };
  queued = []; session = null; enabledLanguages = ['en']; matches = {}; currentField = null; directField = null;
  axios.post = async (url, body) => { posted.push(body); return { data: { messages: [{ id: 'wamid' }] } }; };
});

const node = (extra) => ({ id: 'n1', contentType: 'text', replyKind: 'text', isActive: true, label: 'Hello there', ...extra });
const MID_BOOKING = { currentNodeId: 'q1', ruleId: 'r1' };

// name -> how to produce the turn. `golden` compares to the file; `payload` is what the row must hold.
const CASES = {
  'flow buttons with an image': {
    arrange: () => { matches.price = { node: node({ contentType: 'buttons', imageUrl: 'https://img/menu.png', label: 'Our services' }),
      edges: [{ nextKeyword: 'e1', label: 'Prices' }, { nextKeyword: 'e2', label: 'Timings and a very long title' }] }; },
    act: () => say('price'),
    payload: { kind: 'buttons', body: 'Our services', options: [{ id: 'e1', title: 'Prices' }, { id: 'e2', title: 'Timings and a very l' }], imageUrl: 'https://img/menu.png' }
  },
  'flow list with descriptions and a button label': {
    arrange: () => { matches.price = { node: node({ contentType: 'list', buttonText: 'See courses', label: 'Courses' }),
      edges: [{ nextKeyword: 'e1', label: 'Abacus', description: 'Ages 5-14' }, { nextKeyword: 'e2', label: 'Vedic maths' }] }; },
    act: () => say('price'),
    payload: { kind: 'list', body: 'Courses', buttonText: 'See courses', options: [{ id: 'e1', title: 'Abacus', description: 'Ages 5-14' }, { id: 'e2', title: 'Vedic maths' }] }
  },
  'flow plain text reply': {
    arrange: () => { matches.price = { node: node({ label: 'Prices start at 100' }), edges: [] }; },
    act: () => say('price'),
    payload: null
  },
  'flow web-form link button': {
    arrange: () => { matches.price = { node: node({ replyKind: 'web_form_trigger', label: 'Fill the form', buttonText: 'Open form' }), edges: [] }; },
    act: () => say('price'),
    payload: { kind: 'cta_url', body: 'Fill the form', label: 'Open form' }
  },
  'tapped question node asks a list': {
    arrange: () => { directField = { fieldType: 'list', label: 'Which car?', nodeId: 'q9', options: [{ label: 'Swift' }, { label: 'Innova' }] }; },
    act: () => tap(2, 'Book'),
    payload: { kind: 'list', body: 'Which car?', buttonText: 'Choose', options: [{ id: 'q9:0', title: 'Swift' }, { id: 'q9:1', title: 'Innova' }] }
  },
  'tapped question node asks buttons': {
    arrange: () => { directField = { fieldType: 'buttons', label: 'Trip type?', nodeId: 'q8', options: [{ label: 'One way' }, { label: 'Round trip' }] }; },
    act: () => tap(2, 'Book'),
    payload: { kind: 'buttons', body: 'Trip type?', options: [{ id: 'q8:0', title: 'One way' }, { id: 'q8:1', title: 'Round trip' }] }
  },
  'booking question as a list': {
    arrange: () => { session = MID_BOOKING; currentField = { fieldType: 'list', label: 'Which car?', nodeId: 'q9', options: [{ label: 'Swift' }, { label: 'Innova' }] }; },
    act: () => tap(0, 'Prices'),
    payload: { kind: 'list', body: 'Which car?', buttonText: 'Choose', options: [{ id: 'q9:0', title: 'Swift' }, { id: 'q9:1', title: 'Innova' }] }
  },
  'booking question as buttons': {
    arrange: () => { session = MID_BOOKING; currentField = { fieldType: 'buttons', label: 'Trip type?', nodeId: 'q8', options: [{ label: 'One way' }, { label: 'Round trip' }] }; },
    act: () => tap(0, 'Prices'),
    payload: { kind: 'buttons', body: 'Trip type?', options: [{ id: 'q8:0', title: 'One way' }, { id: 'q8:1', title: 'Round trip' }] }
  },
  'booking question asks for a location': {
    arrange: () => { session = MID_BOOKING; currentField = { fieldType: 'location_request', label: 'Share pickup', nodeId: 'q7' }; },
    act: () => tap(0, 'Prices'),
    payload: { kind: 'location_request', body: 'Share pickup' }
  },
  'booking question as plain text': {
    arrange: () => { session = MID_BOOKING; currentField = { fieldType: 'text', label: 'Your name?', nodeId: 'q1' }; },
    act: () => tap(0, 'Prices'),
    payload: null
  },
  'vehicle carousel': {
    arrange: () => { session = MID_BOOKING; currentField = { fieldType: 'vehicle_carousel', label: 'Pick a vehicle', nodeId: 'v1', options: [
      { index: 0, name: 'Swift', seats: 4, fare: 1200, photoUrl: 'https://img/swift.png' }, { index: 1, name: 'Innova', fare: 2000 }] }; },
    act: () => tap(0, 'Prices'),
    payloads: [null, { kind: 'buttons', body: 'Swift • 4 seats • ₹1200', options: [{ id: 'v1:0', title: 'Book this' }], imageUrl: 'https://img/swift.png' },
      { kind: 'buttons', body: 'Innova • ₹2000', options: [{ id: 'v1:1', title: 'Book this' }] },
      { kind: 'buttons', body: "Don't see the vehicle you want?", options: [{ id: 'v1:other', title: 'Other options' }] }]
  },
  'language picker on the first message': {
    arrange: () => { db.customers[0].preferred_language = null; enabledLanguages = ['en', 'hi']; },
    act: () => say('hi'),
    payload: { kind: 'buttons', body: 'Choose your language / अपनी भाषा चुनें', options: [{ id: 'lang_en', title: 'English' }, { id: 'lang_hi', title: 'हिंदी' }] }
  },
  'change-language keyword': {
    arrange: () => { enabledLanguages = ['en', 'hi']; },
    act: () => say('language'),
    payload: { kind: 'buttons', body: 'Choose your language / अपनी भाषा चुनें', options: [{ id: 'lang_en', title: 'English' }, { id: 'lang_hi', title: 'हिंदी' }] }
  },
  'opt-in consent question': {
    arrange: () => { session = MID_BOOKING; },
    act: () => say('JOIN-K7M2'),
    payloadMatches: (p) => p.kind === 'buttons' && p.options.length === 2 && p.options[0].id === 'optin_yes:link1' && p.options[1].id === 'optin_no:link1'
  }
};

for (const [name, c] of Object.entries(CASES)) {
  test(`${name}: job and Meta payload unchanged`, async () => {
    c.arrange(); await c.act();
    const actual = await sent();
    assert.ok(actual.length > 0, 'something was queued');
    assert.deepEqual(actual, GOLDEN[name]);
  });

  test(`${name}: the saved row holds what the customer was shown`, async () => {
    c.arrange(); await c.act();
    const rows = botRows();
    if (c.payloads) {
      assert.deepEqual(rows.map(r => r.interactive_payload ?? null), c.payloads);
    } else if (c.payloadMatches) {
      assert.ok(c.payloadMatches(rows[rows.length - 1].interactive_payload), JSON.stringify(rows[rows.length - 1].interactive_payload));
    } else {
      assert.deepEqual(rows[rows.length - 1].interactive_payload ?? null, c.payload);
    }
    const payload = rows[rows.length - 1].interactive_payload;
    if (payload) assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
  });
}

test('the web-form link row never holds the link or its token', async () => {
  CASES['flow web-form link button'].arrange();
  await say('price');
  const row = botRows()[botRows().length - 1];
  assert.equal(JSON.stringify(row).includes('tok123'), false);
});
