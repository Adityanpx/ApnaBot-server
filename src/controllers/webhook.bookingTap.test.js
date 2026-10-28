// Run: node --test src/controllers/webhook.bookingTap.test.js
// A tap that is not an answer, during an active booking question (webhook Step 12 + the flow-graph preview):
// a tap on an older welcome message's row while a typed answer is expected must store nothing and re-ask with
// the "type your answer / send menu" hint; a stale or option-less tap during a choice question does the same;
// typed text is still stored; escape keywords still end the session. In-memory Supabase, everything else stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createFakeSupabase } = require('../test-support/fakeSupabase');

const BIZ = 'b1';
const NUMBER = '919800000001';
const SECRET = 'test-secret';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const Q_TEXT = id(1); const Q_CHOICE = id(2); const EDGE = id(50); const BOOK = id(30);
const HINT = 'Please type your answer. Send *menu* to leave this booking.';

let fake; let events; let activeSession; let currentField; let advanceCalls; let deletedSessions;

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/env', { META_APP_SECRET: SECRET, FRONTEND_URL: 'https://app.test' });
stub('../config/supabase', { from: (t) => fake.from(t), rpc: (n, a) => fake.rpc(n, a) });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub('../config/redis', {});
stub('../config/queueConnection', { queueConnection: {}, workerConnection: {} });
stub('../queues/whatsapp.queue', {
  addToWhatsappQueue: async (job) => { events.push(job); },
  addToWhatsappQueueAndWait: async (job) => { events.push(job); }
});
stub('../queues/sessionTimeout.queue', { scheduleSessionTimeout: async () => {}, cancelSessionTimeout: async () => {} });
stub('../services/socket.service', { emitToBusiness: () => {} });
stub('../services/tenant.service', {
  resolveBusinessByPhoneNumberId: async () => ({
    businessId: BIZ, isActive: true, subscription: { status: 'active' }, plan: { msg_limit: -1 }, businessCategory: 'real_estate',
    phoneNumberId: 'pn1', accessToken: 'tok', displayName: 'Estates', businessName: 'Estates'
  })
});
stub('../services/usage.service', {
  checkUsageLimit: async () => ({ allowed: true, current: 0, limit: 500 }),
  recordOutbound: async () => {}
});
stub('../services/smartFallback.service', { getSmartFallbackReply: async () => null });
stub('../services/business.service', { getBusinessById: async () => ({ id: BIZ, enabledLanguages: ['en'], name: 'Estates' }) });
stub('../services/booking.service', {
  getBookingSession: async () => activeSession,
  deleteBookingSession: async (businessId, number) => { deletedSessions.push([businessId, number]); },
  saveBookingSession: async () => {},
  recordBookingLead: async () => {}, finalizeGraphBooking: async () => ({ text: 'done' }), normalizeOption: (o) => o,
  buildBookingSummaryBody: () => 'summary', localizeField: (f) => f
});
stub('../services/bookingGraph.service', {
  getCurrentNodeField: async () => currentField,
  advanceGraphSession: async (args) => {
    advanceCalls.push(args);
    return { session: args.session, result: { nodeId: Q_CHOICE, fieldType: 'text', label: 'Next question', options: [] } };
  }
});
stub('../services/chatbot.service', {
  findMatchingRule: async () => null, resolveTappedEdge: async () => null, resolveCarouselTap: async () => null, getOutgoingEdges: async () => []
});
stub('../services/r2.service', {});
stub('../services/whatsapp.service', {});

const { receiveWebhook } = require('./webhook.controller');
const { previewMessage } = require('./flowGraphPreview.controller');

const deliver = async (message) => {
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
const say = (text) => deliver({ type: 'text', text: { body: text } });
const tapButton = (tapId) => deliver({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: tapId, title: 'x' } } });
const tapListRow = (tapId) => deliver({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: tapId, title: 'x' } } });

const textField = (over = {}) => ({ nodeId: Q_TEXT, fieldKey: 'catalogDesignNo', fieldType: 'text', label: 'Any property ID or preferred area?', options: [], ...over });
const choiceField = (over = {}) => ({
  nodeId: Q_CHOICE, fieldKey: 'purpose', fieldType: 'buttons', label: 'Buy or rent?',
  options: [{ label: 'Buy', value: 'Buy' }, { label: 'Rent', value: 'Rent' }], ...over
});

test.beforeEach(() => {
  fake = createFakeSupabase();
  events = []; advanceCalls = []; deletedSessions = [];
  fake.db.customers = [{ id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, name: 'Ravi', total_messages: 3, preferred_language: 'en', is_blocked: false, bot_paused_until: null, opted_out_at: null }];
  fake.db.messages = [];
  activeSession = { currentNodeId: Q_TEXT, ruleId: BOOK, collected: {}, answeredFields: [] };
  currentField = textField();
});

const sentTexts = () => events.map(job => job.message);

// ---- webhook Step 12 ----

test('a button tap while a typed answer is expected: nothing stored, the question again with the hint', async () => {
  await tapButton(EDGE);
  assert.equal(advanceCalls.length, 0, 'the session was not advanced');
  assert.deepEqual(sentTexts(), [`${HINT}\n\nAny property ID or preferred area?`]);
});

test('a list-row tap (an older welcome message\'s row) while a typed answer is expected: the same', async () => {
  await tapListRow(EDGE);
  assert.equal(advanceCalls.length, 0);
  assert.deepEqual(sentTexts(), [`${HINT}\n\nAny property ID or preferred area?`]);
});

test('a textarea and a location_request question behave like a text question for a tap', async () => {
  for (const fieldType of ['textarea', 'location_request']) {
    events = [];
    currentField = textField({ fieldType });
    await tapListRow(EDGE);
    assert.equal(advanceCalls.length, 0, fieldType);
    assert.equal(sentTexts().length, 1, fieldType);
    assert.ok(sentTexts()[0].startsWith(HINT), fieldType);
  }
});

test('typed text during a typed question is stored (the session advances with the text)', async () => {
  await say('Wakad, Baner');
  assert.equal(advanceCalls.length, 1);
  assert.equal(advanceCalls[0].reply, 'Wakad, Baner');
  assert.deepEqual(sentTexts(), ['Next question']);
});

test('a stale tap (another node\'s id, or an edge id) during a choice question: the question again with the hint, nothing stored', async () => {
  activeSession.currentNodeId = Q_CHOICE; currentField = choiceField();
  for (const staleId of [`${Q_TEXT}:0`, EDGE]) {
    events = [];
    await tapButton(staleId);
    assert.equal(advanceCalls.length, 0, staleId);
    assert.equal(events.length, 1, staleId);
    assert.equal(events[0].message, `${HINT}\n\nBuy or rent?`, staleId);
    assert.deepEqual(events[0].interactiveButtons, ['Buy', 'Rent'], 'the options are shown again');
  }
});

test('a tap for the right question but an index it has no option for: re-asked with the hint, not advanced', async () => {
  activeSession.currentNodeId = Q_CHOICE; currentField = choiceField();
  await tapButton(`${Q_CHOICE}:7`);
  assert.equal(advanceCalls.length, 0);
  assert.equal(events[0].message, `${HINT}\n\nBuy or rent?`);
});

test('a valid tap on the current choice question is still an answer', async () => {
  activeSession.currentNodeId = Q_CHOICE; currentField = choiceField();
  await tapButton(`${Q_CHOICE}:1`);
  assert.equal(advanceCalls.length, 1);
  assert.equal(advanceCalls[0].reply, 'Rent');
});

test('a catalogue tap or a template-button tap mid-booking re-asks with the hint and leaves the session alone', async () => {
  await tapButton('cat:menu');
  assert.equal(advanceCalls.length, 0);
  assert.deepEqual(sentTexts(), [`${HINT}\n\nAny property ID or preferred area?`]);
});

test('escape keywords still end the session, whatever the current question', async () => {
  for (const keyword of ['menu', 'cancel', 'exit', 'restart', ' Menu ']) {
    deletedSessions = []; events = [];
    await say(keyword);
    assert.equal(deletedSessions.length, 1, keyword);
    assert.equal(advanceCalls.length, 0, keyword);
    assert.ok(!sentTexts()[0].includes(HINT), keyword);
  }
});

// ---- flow-graph preview (Auto-Replies -> Test, the home-page demo) ----

const preview = async ({ message = '', buttonReplyId = null, session }) => {
  let payload = null;
  const res = { status() { return this; }, json(body) { payload = body; } };
  await previewMessage({ user: { businessId: BIZ }, body: { message, buttonReplyId, session } }, res, (err) => { throw err; });
  return payload.data;
};

test('preview: a tap during a typed question re-asks with the hint and returns the session unchanged', async () => {
  const session = { currentNodeId: Q_TEXT, collected: {}, answeredFields: [] };
  const out = await preview({ message: EDGE, buttonReplyId: EDGE, session });
  assert.equal(advanceCalls.length, 0);
  assert.ok(out.replyText.startsWith(HINT));
  assert.ok(out.replyText.includes('Any property ID or preferred area?'));
  assert.deepEqual(out.session, session);
});

test('preview: a stale tap and an option-less tap during a choice question re-ask with the hint, buttons shown again', async () => {
  const session = { currentNodeId: Q_CHOICE, collected: {}, answeredFields: [] };
  currentField = choiceField();
  for (const tapId of [EDGE, `${Q_CHOICE}:9`]) {
    const out = await preview({ message: tapId, buttonReplyId: tapId, session });
    assert.ok(out.replyText.startsWith(HINT), tapId);
    assert.deepEqual(out.buttons.map(b => b.title || b.label), ['Buy', 'Rent'], tapId);
  }
  assert.equal(advanceCalls.length, 0);
});

test('preview: typed text and a valid tap still advance', async () => {
  const typed = await preview({ message: 'Wakad', session: { currentNodeId: Q_TEXT, collected: {}, answeredFields: [] } });
  assert.equal(advanceCalls.length, 1);
  assert.equal(advanceCalls[0].reply, 'Wakad');
  assert.equal(typed.replyText, 'Next question');

  currentField = choiceField();
  await preview({ message: `${Q_CHOICE}:0`, buttonReplyId: `${Q_CHOICE}:0`, session: { currentNodeId: Q_CHOICE, collected: {}, answeredFields: [] } });
  assert.equal(advanceCalls[1].reply, 'Buy');
});
