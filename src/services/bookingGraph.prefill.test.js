// Run: node --test src/services/bookingGraph.prefill.test.js
// A catalogue Order starts the booking graph with prefill (collection / design no / price): the values land in
// collected + answeredFields (so the confirmation and bookings.fields have them), and any question whose
// field_key is one of the keys is skipped - the first one at start, later ones as the walk advances. A
// session started without prefill is exactly what it was before (no prefilledKeys on it).
const path = require('path');
const stub = (relativePath, exports) => {
  const resolved = require.resolve(path.join(__dirname, relativePath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

let graph = { nodes: [], edges: [] };
const from = (table) => {
  const rows = () => (table === 'flow_nodes' ? graph.nodes : graph.edges);
  const q = { select: () => q, eq: () => q, then: (resolve, reject) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject) };
  return q;
};
stub('../config/redis', {});
stub('../config/supabase', { from });
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {} });
stub('../queues/sessionTimeout.queue', { addToSessionTimeoutQueue: async () => {} });
stub('./socket.service', {});
stub('./payment.service', {});
stub('./distanceMatrix.service', {});
stub('./business.service', { getBusinessById: async () => ({ id: 'b1', travelSettings: {}, disabledBookingFields: [] }) });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

const test = require('node:test');
const assert = require('node:assert/strict');
const bookingGraph = require('./bookingGraph.service');
const { buildBookingSummaryBody } = require('./booking.service');

const REPLY = 'r0'; const Q_DESIGN = 'q1'; const Q_NAME = 'q2'; const Q_PRICE = 'q3'; const Q_NOTE = 'q4';
const reply = { id: REPLY, nodeType: 'reply', keyword: 'order', replyKind: 'booking_trigger', isActive: true };
const question = (id, fieldKey, label, over = {}) => ({
  id, nodeType: 'question', fieldKey, label, summaryLabel: label.replace('?', ''), contentType: 'text', required: true, options: [], isComputed: false, isActive: true, ...over
});
const edge = (id, from_, to) => ({ id, fromNodeId: from_, toNodeId: to, condition: null, preset: null, displayOrder: 0 });

const chain = (...questions) => {
  graph = {
    nodes: [reply, ...questions],
    edges: [edge('e0', REPLY, questions[0].id), ...questions.slice(1).map((qn, i) => edge(`e${i + 1}`, questions[i].id, qn.id))]
  };
};

const PREFILL = [{ key: 'catalogCollection', value: 'Silk Sarees' }, { key: 'catalogDesignNo', value: 'A-102' }, { key: 'catalogPrice', value: '1,499' }];

test('prefill is written into collected and answeredFields (English label for the owner, the customer language for the confirmation)', async () => {
  chain(question(Q_NAME, 'name', 'Your name?'));
  const { session, result } = await bookingGraph.startGraphSession('b1', REPLY, 'hi', { prefill: PREFILL });
  assert.deepEqual(session.collected, { catalogCollection: 'Silk Sarees', catalogDesignNo: 'A-102', catalogPrice: '1,499' });
  assert.deepEqual(session.answeredFields.map(f => [f.fieldKey, f.label]), [['catalogCollection', 'Collection'], ['catalogDesignNo', 'Design no'], ['catalogPrice', 'Price']]);
  assert.notEqual(session.answeredFields[0].summaryLabel, 'Collection', 'Hindi label in the confirmation');
  assert.deepEqual(session.prefilledKeys, ['catalogCollection', 'catalogDesignNo', 'catalogPrice']);
  assert.equal(result.nodeId, Q_NAME, 'a question with another field key is still asked');
});

test('the confirmation text lists the prefilled lines first, then the answers', async () => {
  chain(question(Q_NAME, 'name', 'Your name?'));
  const { session } = await bookingGraph.startGraphSession('b1', REPLY, 'en', { prefill: PREFILL });
  const { session: after } = await bookingGraph.advanceGraphSession({ businessId: 'b1', session, reply: 'Ravi', languageCode: 'en' });
  const body = buildBookingSummaryBody(after.collected, after.answeredFields, false, 'en');
  assert.equal(body, 'Collection: *Silk Sarees*\nDesign no: *A-102*\nPrice: *1,499*\nYour name: *Ravi*');
});

test('a question whose field_key is a prefill key is not asked: the first one at start...', async () => {
  chain(question(Q_DESIGN, 'catalogDesignNo', 'Which design?'), question(Q_NAME, 'name', 'Your name?'));
  const { session, result } = await bookingGraph.startGraphSession('b1', REPLY, 'en', { prefill: PREFILL });
  assert.equal(result.nodeId, Q_NAME);
  assert.equal(session.currentNodeId, Q_NAME);
  assert.equal(session.collected.catalogDesignNo, 'A-102');
  assert.equal(session.answeredFields.filter(f => f.fieldKey === 'catalogDesignNo').length, 1);
});

test('...and later ones while the walk advances; a booking whose remaining questions are all prefilled finishes at once', async () => {
  chain(question(Q_NAME, 'name', 'Your name?'), question(Q_PRICE, 'catalogPrice', 'Budget?'), question(Q_NOTE, 'note', 'Any note?'));
  const { session } = await bookingGraph.startGraphSession('b1', REPLY, 'en', { prefill: PREFILL });
  const step = await bookingGraph.advanceGraphSession({ businessId: 'b1', session, reply: 'Ravi', languageCode: 'en' });
  assert.equal(step.result.nodeId, Q_NOTE, 'the budget question was skipped');

  chain(question(Q_DESIGN, 'catalogDesignNo', 'Which design?'), question(Q_PRICE, 'catalogPrice', 'Budget?'));
  const done = await bookingGraph.startGraphSession('b1', REPLY, 'en', { prefill: PREFILL });
  assert.equal(done.result.done, true);
  assert.equal(done.result.collected.catalogCollection, 'Silk Sarees');
});

test('only a key that was actually prefilled skips: an item order without a design number still asks for it', async () => {
  chain(question(Q_DESIGN, 'catalogDesignNo', 'Which design?'), question(Q_NAME, 'name', 'Your name?'));
  const { result } = await bookingGraph.startGraphSession('b1', REPLY, 'en', { prefill: [{ key: 'catalogCollection', value: 'Silk' }] });
  assert.equal(result.nodeId, Q_DESIGN);
});

test('no entry edge: the booking is confirmed at once and still carries the prefill', async () => {
  graph = { nodes: [reply], edges: [] };
  const { session, result } = await bookingGraph.startGraphSession('b1', REPLY, 'en', { prefill: PREFILL });
  assert.equal(result.done, true);
  assert.equal(session.collected.catalogPrice, '1,499');
  assert.equal(session.answeredFields.length, 3);
});

test('without prefill nothing changes: same session shape (no prefilledKeys), the first question is asked even if it has a catalog field key', async () => {
  chain(question(Q_DESIGN, 'catalogDesignNo', 'Which design?'), question(Q_NAME, 'name', 'Your name?'));
  const { session, result } = await bookingGraph.startGraphSession('b1', REPLY, 'en');
  assert.equal(result.nodeId, Q_DESIGN);
  assert.equal('prefilledKeys' in session, false);
  assert.deepEqual(session.collected, {});
  const again = await bookingGraph.startGraphSession('b1', REPLY, 'en', {});
  assert.equal('prefilledKeys' in again.session, false);
});

test('a malformed prefill is ignored entry by entry', async () => {
  chain(question(Q_NAME, 'name', 'Your name?'));
  const { session } = await bookingGraph.startGraphSession('b1', REPLY, 'en', { prefill: [{ key: 'vehicleId', value: 'x' }, null, { key: 'catalogPrice', value: ' 99 ' }] });
  assert.deepEqual(session.collected, { catalogPrice: '99' });
});
