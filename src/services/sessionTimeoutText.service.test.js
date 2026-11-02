// Run: node --test src/services/sessionTimeoutText.service.test.js
// The inactivity message of an ended booking chat: the standard text everywhere, except a chat in a travel-quote flow,
// which names the keyword that starts that flow. In-memory Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
const { createFakeSupabase } = require('../test-support/fakeSupabase');

const { getQuoteKeyword, sessionTimeoutText } = require('./sessionTimeoutText.service');
const { B1, uuid } = h;

const N = { menu: uuid(1), trip: uuid(2), picker: uuid(3), pax: uuid(4), quote: uuid(5), bookMenu: uuid(11), bookQ: uuid(12), noKw: uuid(21), noKwQ: uuid(22), noKwPicker: uuid(23) };
const node = (id, node_type, extra = {}) => ({ id, business_id: B1, node_type, is_active: true, reply_kind: null, keyword: null, ...extra });
const edge = (from, to) => ({ business_id: B1, from_node_id: from, to_node_id: to });

let db;
test.beforeEach(() => {
  h.reset();
  h.state.fake = createFakeSupabase();
  db = h.state.fake.db;
  db.flow_nodes = [
    node(N.menu, 'reply', { reply_kind: 'booking_trigger', keyword: ' quote ' }), node(N.trip, 'question'), node(N.picker, 'route_picker'),
    node(N.pax, 'question'), node(N.quote, 'quote'),
    node(N.bookMenu, 'reply', { reply_kind: 'booking_trigger', keyword: 'book' }), node(N.bookQ, 'question')
  ];
  db.flow_edges = [edge(N.menu, N.trip), edge(N.trip, N.picker), edge(N.picker, N.pax), edge(N.pax, N.quote), edge(N.bookMenu, N.bookQ)];
});

const STANDARD = {
  en: "Looks like you've stepped away — I've ended this session due to inactivity. Send 'book' anytime to start again."
};

test('a chat in a quote flow is told the keyword of that flow\'s entry trigger, not "book"', async () => {
  assert.equal(await getQuoteKeyword(B1, N.pax), 'quote');
  assert.equal(
    await sessionTimeoutText(B1, { currentNodeId: N.pax }, 'en'),
    "Looks like you've stepped away — I've ended this quote chat due to inactivity. Send 'quote' anytime to start again."
  );
  assert.equal(
    await sessionTimeoutText(B1, { currentNodeId: N.trip }, 'hi'),
    "लगता है आप व्यस्त हैं — जवाब न मिलने के कारण मैंने यह किराया चैट बंद कर दी है। फिर से शुरू करने के लिए कभी भी 'quote' भेजें।"
  );
  assert.equal(
    await sessionTimeoutText(B1, { currentNodeId: N.picker }, 'mr'),
    "तुम्ही व्यस्त आहात असे दिसते — प्रतिसाद न मिळाल्यामुळे मी ही भाडे चॅट बंद केली आहे. पुन्हा सुरू करण्यासाठी कधीही 'quote' पाठवा."
  );
  // no language yet, or a machine-translated one: the English quote text (its own text has the keyword translated)
  for (const lang of [null, undefined, 'gu', 'ta']) {
    assert.ok((await sessionTimeoutText(B1, { currentNodeId: N.pax }, lang)).endsWith("Send 'quote' anytime to start again."), String(lang));
  }
});

test('a manual sibling question (nothing leads into it) is found from the session\'s ruleId: the trigger, or the entry a Change restarted at', async () => {
  const sibling = uuid(31);
  db.flow_nodes.push(node(sibling, 'question'));
  assert.equal(await getQuoteKeyword(B1, sibling), null, 'no rule id: nothing to go by');
  assert.equal(await getQuoteKeyword(B1, sibling, N.menu), 'quote', 'started from the quote trigger');
  assert.equal(await getQuoteKeyword(B1, sibling, N.trip), 'quote', 'restarted at the entry question');
  assert.equal(await getQuoteKeyword(B1, sibling, N.bookMenu), null, 'started from another flow\'s trigger');
  assert.equal(await getQuoteKeyword(B1, sibling, N.bookQ), null);
  assert.equal(await getQuoteKeyword(B1, sibling, uuid(777)), null, 'unknown rule');
  assert.ok((await sessionTimeoutText(B1, { currentNodeId: sibling, ruleId: N.menu }, 'en')).includes("Send 'quote'"));
  assert.equal(await sessionTimeoutText(B1, { currentNodeId: sibling }, 'en'), STANDARD.en);
});

test('another flow of the same business, and a business with no quote flow, get the standard text exactly as before', async () => {
  assert.equal(await getQuoteKeyword(B1, N.bookQ), null);
  assert.equal(await sessionTimeoutText(B1, { currentNodeId: N.bookQ }, 'en'), STANDARD.en);
  assert.equal(await sessionTimeoutText(B1, { currentNodeId: N.bookQ }, 'hi'), require('../utils/systemMessages').SYSTEM_MESSAGES.sessionTimeout.hi);

  db.flow_nodes = db.flow_nodes.filter((n) => n.node_type !== 'route_picker');
  assert.equal(await getQuoteKeyword(B1, N.pax), null);
  assert.equal(await sessionTimeoutText(B1, { currentNodeId: N.pax }, 'en'), STANDARD.en);
  assert.equal(await sessionTimeoutText(B1, { currentNodeId: N.pax }, 'gu'), require('../utils/systemMessages').getSystemMessage('sessionTimeout', 'gu'));
  assert.equal(await sessionTimeoutText(B1, {}, 'en'), STANDARD.en, 'a session with no current node');
  assert.equal(await sessionTimeoutText(B1, null, 'en'), STANDARD.en);
});

test('a switched-off route picker, another business\'s quote flow, or a trigger without a keyword: the standard text', async () => {
  db.flow_nodes.find((n) => n.id === N.picker).is_active = false;
  assert.equal(await sessionTimeoutText(B1, { currentNodeId: N.pax }, 'en'), STANDARD.en);
  db.flow_nodes.find((n) => n.id === N.picker).is_active = true;

  assert.equal(await sessionTimeoutText(uuid(9999), { currentNodeId: N.pax }, 'en'), STANDARD.en, 'a node of another business');

  db.flow_nodes.find((n) => n.id === N.menu).keyword = '  ';
  assert.equal(await getQuoteKeyword(B1, N.pax), null);
  assert.equal(await sessionTimeoutText(B1, { currentNodeId: N.pax }, 'en'), STANDARD.en);
});

test('only a booking_trigger that leads to the entry gives the keyword; a failure gives the standard text', async () => {
  db.flow_nodes.find((n) => n.id === N.menu).reply_kind = 'text';
  assert.equal(await getQuoteKeyword(B1, N.pax), null);

  db.flow_nodes.find((n) => n.id === N.menu).reply_kind = 'booking_trigger';
  assert.equal(await getQuoteKeyword(B1, N.pax), 'quote');
  h.state.fake = { from: () => { throw new Error('db down'); } };
  assert.equal(await sessionTimeoutText(B1, { currentNodeId: N.pax }, 'en'), STANDARD.en);
});
