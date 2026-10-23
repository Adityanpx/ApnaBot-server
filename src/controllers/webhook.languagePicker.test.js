// Run: node --test src/controllers/webhook.languagePicker.test.js
// The language picker: reply buttons for 2-3 enabled languages, a list for 4; the change-language
// keyword (built-in aliases + the owner's own, also with mode 'off'); a customer whose language was
// switched off is asked again; English fallback for a language the owner has not translated.
// In-memory Supabase, everything else stubbed (same harness as webhook.locationPin.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const BIZ = 'b1';
const NUMBER = '919800000001';
const SECRET = 'test-secret';

let db; let queued; let business; let tenant;

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
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub('../config/redis', {});
stub('../config/queueConnection', { queueConnection: {}, workerConnection: {} });
stub('../queues/whatsapp.queue', {
  addToWhatsappQueue: async (job) => { queued.push(job); },
  addToWhatsappQueueAndWait: async (job) => { queued.push(job); }
});
stub('../queues/sessionTimeout.queue', { scheduleSessionTimeout: async () => {}, cancelSessionTimeout: async () => {} });
stub('../services/socket.service', { emitToBusiness: () => {} });
stub('../services/tenant.service', { resolveBusinessByPhoneNumberId: async () => tenant });
stub('../services/usage.service', { checkUsageLimit: async () => ({ allowed: true, current: 0, limit: 500 }), recordOutbound: async () => {} });
stub('../services/smartFallback.service', { getSmartFallbackReply: async () => null });
stub('../services/business.service', { getBusinessById: async () => business });
stub('../services/booking.service', {
  getBookingSession: async () => null, deleteBookingSession: async () => {}, saveBookingSession: async () => {},
  recordBookingLead: async () => {}, finalizeGraphBooking: async () => ({ text: 'done' }), normalizeOption: (o) => o
});
stub('../services/bookingGraph.service', {});
stub('../services/chatbot.service', {
  findMatchingRule: async () => null,
  resolveTappedEdge: async () => null,
  getOutgoingEdges: async () => []
});
stub('../services/r2.service', {});
stub('../services/whatsapp.service', {});

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
  await receiveWebhook({ body, rawBody, headers: { 'x-hub-signature-256': signature } }, { status() { return this; }, json() {} });
};
const say = (text) => send({ type: 'text', text: { body: text } });
const tapList = (id, title) => send({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title } } });
const tapButton = (id, title) => send({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } });
const customer = () => db.customers[0];
const botRows = () => db.messages.filter(m => m.direction === 'outbound');

const setLanguages = (languages, picker = null) => {
  business = { ...business, enabledLanguages: languages, languagePicker: picker };
  tenant = { ...tenant, enabledLanguages: languages, languagePicker: picker };
};

test.beforeEach(() => {
  db = {
    customers: [{ id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, name: 'Ravi', total_messages: 3, preferred_language: null, is_blocked: false, bot_paused_until: null, opted_out_at: null }],
    messages: []
  };
  queued = [];
  business = { id: BIZ, name: 'Biz', enabledLanguages: ['en', 'hi'], languagePicker: null, welcomeMessage: 'Welcome!', welcomeMessageTranslations: { hi: 'स्वागत है!' } };
  tenant = {
    businessId: BIZ, isActive: true, subscription: { status: 'active' }, plan: { msg_limit: 500 },
    phoneNumberId: 'pn1', accessToken: 'tok', displayName: 'Biz', businessName: 'Biz',
    enabledLanguages: ['en', 'hi'], languagePicker: null
  };
});

test('2 languages: reply buttons, the long-standing prompt line', async () => {
  await say('hi');
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].buttons, [{ title: 'English', nextKeyword: 'lang_en' }, { title: 'हिंदी', nextKeyword: 'lang_hi' }]);
  assert.equal(queued[0].message, 'Welcome!\n\nChoose your language / अपनी भाषा चुनें');
  assert.equal(queued[0].listOptions, undefined);
  assert.equal(botRows()[0].interactive_payload.kind, 'buttons');
  assert.equal(customer().preferred_language, null);
});

test('3 languages incl. Gujarati: still buttons, and the prompt names the new language', async () => {
  setLanguages(['en', 'hi', 'gu']);
  await say('hi');
  assert.deepEqual(queued[0].buttons.map(b => b.nextKeyword), ['lang_en', 'lang_hi', 'lang_gu']);
  assert.equal(queued[0].buttons[2].title, 'ગુજરાતી');
  assert.match(queued[0].message, /Choose your language \/ अपनी भाषा चुनें \/ તમારી ભાષા પસંદ કરો$/);
});

test('4 languages: a list message (a 4th reply button does not exist)', async () => {
  setLanguages(['en', 'hi', 'gu', 'ta']);
  await say('hi');
  assert.equal(queued[0].buttons, undefined);
  assert.deepEqual(queued[0].listOptions, [
    { label: 'English', nextKeyword: 'lang_en' }, { label: 'हिंदी', nextKeyword: 'lang_hi' },
    { label: 'ગુજરાતી', nextKeyword: 'lang_gu' }, { label: 'தமிழ்', nextKeyword: 'lang_ta' }
  ]);
  assert.equal(queued[0].listButtonLabel, 'Language');
  assert.equal(botRows()[0].interactive_payload.kind, 'list');
  assert.equal(botRows()[0].interactive_payload.options.length, 4);
});

test('a tap on the list picker saves the language and greets (a list row is not mistaken for a flow edge)', async () => {
  setLanguages(['en', 'hi', 'gu', 'ta']);
  await tapList('lang_gu', 'ગુજરાતી');
  assert.equal(customer().preferred_language, 'gu');
  assert.equal(queued.length, 1);
  // No Gujarati welcome text yet: the English one is sent (fallback), not nothing.
  assert.equal(queued[0].message, 'Welcome!');
  assert.equal(db.messages.find(m => m.direction === 'inbound').content, 'ગુજરાતી');
});

test('a tap on a button picker still works, and uses the translation when there is one', async () => {
  await tapButton('lang_hi', 'हिंदी');
  assert.equal(customer().preferred_language, 'hi');
  assert.equal(queued[0].message, 'स्वागत है!');
});

test('a tap on a language that is not enabled is ignored', async () => {
  await tapList('lang_ta', 'தமிழ்');
  assert.equal(customer().preferred_language, null);
  assert.equal(queued.length, 0);
});

test('the change keyword (built-in aliases) reopens the picker and keeps the current language until a tap', async () => {
  customer().preferred_language = 'hi';
  for (const word of ['language', 'भाषा', 'Bhasha']) {
    queued = [];
    await say(word);
    assert.equal(queued.length, 1, word);
    assert.deepEqual(queued[0].buttons.map(b => b.nextKeyword), ['lang_en', 'lang_hi']);
  }
  assert.equal(customer().preferred_language, 'hi');
});

test("the owner's own change keyword works, and so does a prompt translated into the customer's language", async () => {
  setLanguages(['en', 'hi'], { changeKeyword: 'mylang', prompt: 'Pick a language', promptTranslations: { hi: 'भाषा चुनिए' } });
  customer().preferred_language = 'hi';
  await say('MyLang');
  assert.equal(queued[0].message, 'भाषा चुनिए');
  queued = [];
  customer().preferred_language = 'en';
  await say('mylang');
  assert.equal(queued[0].message, 'Pick a language');
});

test("mode 'off': no automatic picker (first enabled language is set), the keyword still opens it", async () => {
  setLanguages(['en', 'hi'], { mode: 'off' });
  await say('hi');
  assert.equal(customer().preferred_language, 'en');
  assert.equal(queued.every(j => !j.buttons || j.buttons[0].nextKeyword !== 'lang_en'), true);

  queued = [];
  await say('language');
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].buttons.map(b => b.nextKeyword), ['lang_en', 'lang_hi']);
});

test('a customer whose language was switched off is asked again on the next message', async () => {
  customer().preferred_language = 'ta';
  await say('hi');
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].buttons.map(b => b.nextKeyword), ['lang_en', 'lang_hi']);
});

test('a customer whose language is still enabled is not asked', async () => {
  customer().preferred_language = 'hi';
  await say('hi');
  assert.equal(queued.every(j => !j.buttons || j.buttons[0].nextKeyword !== 'lang_en'), true);
  assert.equal(queued[0].message, 'स्वागत है!');
});

test('a tenant cached before enabledLanguages existed does not break anything', async () => {
  delete tenant.enabledLanguages;
  delete tenant.languagePicker;
  customer().preferred_language = 'ta';
  await say('hi');
  assert.equal(customer().preferred_language, 'ta');
});
