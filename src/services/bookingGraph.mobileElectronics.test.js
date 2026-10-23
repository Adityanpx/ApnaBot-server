// Run: node --test src/services/bookingGraph.mobileElectronics.test.js
// Walks the "Send enquiry" booking of templates/category/mobile_electronics.default.json through the real graph
// engine (bookingGraph.service.js + the confirmation summary), the way src/scripts/verifyBookingGraph.js does for
// a live business: drive each question by its field type, reach {done}, every required field collected.
// The graph is served from the file through an in-memory stand-in for flow_nodes / flow_edges; no database.
const path = require('path');
const fs = require('fs');
const stub = (relativePath, exports) => {
  const resolved = require.resolve(path.join(__dirname, relativePath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const template = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'category', 'mobile_electronics.default.json'), 'utf8'));
const { withNodeDefaults, withEdgeDefaults } = require('./flowSnapshot.service.js');

const from = (table) => {
  const rows = () => (table === 'flow_nodes' ? template.nodes.map(withNodeDefaults) : template.edges.map(withEdgeDefaults));
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
stub('./business.service', { getBusinessById: async () => ({ id: 'b1', businessCategory: 'mobile_electronics', travelSettings: {}, disabledBookingFields: [] }) });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

const test = require('node:test');
const assert = require('node:assert/strict');
const bookingGraph = require('./bookingGraph.service');
const { buildBookingSummaryBody } = require('./booking.service');

const TRIGGER = template.nodes.find((n) => n.reply_kind === 'booking_trigger');
const QUESTIONS = template.nodes.filter((n) => n.node_type === 'question').sort((a, b) => a.order - b.order);

// Answer a question the way a customer would: a free-text reply, or the first / chosen option's value.
const answerFor = (nodeId, pick = 0) => {
  const q = QUESTIONS.find((x) => x.id === nodeId);
  return q.options.length ? q.options[pick].value : 'Samsung A55';
};

const walk = async (picks = {}) => {
  let { session, result } = await bookingGraph.startGraphSession('b1', TRIGGER.id, 'en');
  const asked = [];
  while (!result.done) {
    asked.push(result.nodeId);
    ({ session, result } = await bookingGraph.advanceGraphSession({
      businessId: 'b1', session, reply: answerFor(result.nodeId, picks[result.nodeId] || 0), languageCode: 'en'
    }));
    assert.ok(asked.length <= QUESTIONS.length, 'the walk must end');
  }
  return { session, result, asked };
};

test('the enquiry asks product -> brand & model -> purchase type -> when, in that order, then completes', async () => {
  const { session, result, asked } = await walk();
  assert.deepEqual(asked, QUESTIONS.map((q) => q.id));
  assert.equal(result.done, true);
  assert.deepEqual(session.collected, { product: 'Mobile', brandModel: 'Samsung A55', purchaseType: 'CSD', visitWhen: 'Today' });
});

test('every required field_key ends up non-empty in collected', async () => {
  const { session } = await walk();
  for (const q of QUESTIONS.filter((x) => x.required)) assert.ok(session.collected[q.field_key], q.field_key);
});

test('each choice question accepts each of its options', async () => {
  for (const q of QUESTIONS.filter((x) => x.options.length)) {
    for (let i = 0; i < q.options.length; i++) {
      const { session } = await walk({ [q.id]: i });
      assert.equal(session.collected[q.field_key], q.options[i].value, `${q.field_key} option ${i}`);
    }
  }
});

test('the first question is what the customer is sent after tapping Send enquiry', async () => {
  const { result } = await bookingGraph.startGraphSession('b1', TRIGGER.id, 'en');
  assert.equal(result.nodeId, QUESTIONS[0].id);
  assert.ok(!result.done);
});

test('the confirmation lists the four answers with their summary labels', async () => {
  const { session } = await walk();
  assert.equal(
    buildBookingSummaryBody(session.collected, session.answeredFields, false, 'en'),
    'Product: *Mobile*\nBrand & model: *Samsung A55*\nPurchase type: *CSD*\nVisit: *Today*'
  );
});
