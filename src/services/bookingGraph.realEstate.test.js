// Run: node --test src/services/bookingGraph.realEstate.test.js
// Walks the "Send enquiry" / "Book a site visit" booking of templates/category/real_estate.default.json through the
// real graph engine (bookingGraph.service.js + the confirmation summary), the way src/scripts/verifyBookingGraph.js
// does for a live business: drive each question by its field type, reach {done}, every required field collected.
// Includes the catalogue Order prefill (catalogCollection / catalogDesignNo). The graph is served from the file
// through an in-memory stand-in for flow_nodes / flow_edges; no database.
const path = require('path');
const fs = require('fs');
const stub = (relativePath, exports) => {
  const resolved = require.resolve(path.join(__dirname, relativePath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const template = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'category', 'real_estate.default.json'), 'utf8'));
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
stub('./business.service', { getBusinessById: async () => ({ id: 'b1', businessCategory: 'real_estate', travelSettings: {}, disabledBookingFields: [] }) });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

const test = require('node:test');
const assert = require('node:assert/strict');
const bookingGraph = require('./bookingGraph.service');
const { buildBookingSummaryBody } = require('./booking.service');

const TRIGGER = template.nodes.find((n) => n.reply_kind === 'booking_trigger');
const QUESTIONS = template.nodes.filter((n) => n.node_type === 'question').sort((a, b) => a.order - b.order);
const qid = (fieldKey) => QUESTIONS.find((q) => q.field_key === fieldKey).id;

// Answer a question the way a customer would: a free-text reply, or the first / chosen option's value.
const answerFor = (nodeId, pick = 0) => {
  const q = QUESTIONS.find((x) => x.id === nodeId);
  return q.options.length ? q.options[pick].value : 'Wakad, Baner';
};

const walk = async (picks = {}, options = {}) => {
  let { session, result } = await bookingGraph.startGraphSession('b1', TRIGGER.id, 'en', options);
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

test('the enquiry asks type -> buy/rent -> budget -> ID/area -> visit time, in that order, then completes', async () => {
  const { session, result, asked } = await walk();
  assert.deepEqual(asked, QUESTIONS.map((q) => q.id));
  assert.equal(asked.length, 5);
  assert.equal(result.done, true);
  assert.deepEqual(session.collected, {
    catalogCollection: '1 BHK / Studio', purpose: 'Buy', budget: 'Under ₹30 L', catalogDesignNo: 'Wakad, Baner', visitWhen: 'Today'
  });
});

test('an internal id arriving as the typed answer (stale tap) is never stored: the question again with the hint', async () => {
  const idArea = qid('catalogDesignNo');
  let { session } = await bookingGraph.startGraphSession('b1', TRIGGER.id, 'en');
  let result;
  while (session.currentNodeId !== idArea) {
    ({ session, result } = await bookingGraph.advanceGraphSession({ businessId: 'b1', session, reply: answerFor(session.currentNodeId), languageCode: 'en' }));
  }
  const answeredBefore = session.answeredFields.length;
  for (const staleId of ['ad074bf9-1111-4222-8333-944455556666', 'ad074bf9-1111-4222-8333-944455556666:2', 'cat:menu']) {
    ({ session, result } = await bookingGraph.advanceGraphSession({ businessId: 'b1', session, reply: staleId, languageCode: 'en' }));
    assert.equal(typeof result, 'string', staleId);
    assert.ok(result.startsWith('Please type your answer. Send *menu* to leave this booking.\n\n'), staleId);
    assert.equal(session.currentNodeId, idArea, staleId);
    assert.equal(session.collected.catalogDesignNo, undefined, staleId);
    assert.equal(session.answeredFields.length, answeredBefore, staleId);
  }
  ({ session } = await bookingGraph.advanceGraphSession({ businessId: 'b1', session, reply: '10:30 flat in Baner', languageCode: 'en' }));
  assert.equal(session.collected.catalogDesignNo, '10:30 flat in Baner', 'a colon in a real answer is fine');
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

test('the first question is what the customer is sent after tapping Send enquiry / Book a site visit', async () => {
  const { result } = await bookingGraph.startGraphSession('b1', TRIGGER.id, 'en');
  assert.equal(result.nodeId, QUESTIONS[0].id);
  assert.ok(!result.done);
});

test('the confirmation lists the five answers with their summary labels', async () => {
  const { session } = await walk();
  assert.equal(
    buildBookingSummaryBody(session.collected, session.answeredFields, false, 'en'),
    'Property type: *1 BHK / Studio*\nPurpose: *Buy*\nBudget: *Under ₹30 L*\nProperty ID / area: *Wakad, Baner*\nSite visit: *Today*'
  );
});

test('a catalogue Order (collection + ID prefilled) skips Q1 and Q4 and asks only buy/rent, budget and visit time', async () => {
  const prefill = [{ key: 'catalogCollection', value: 'Wakad Flats' }, { key: 'catalogDesignNo', value: 'WKD-2B-01' }];
  const { session, asked, result } = await walk({}, { prefill });
  assert.equal(result.done, true);
  assert.deepEqual(asked, [qid('purpose'), qid('budget'), qid('visitWhen')]);
  assert.equal(session.collected.catalogCollection, 'Wakad Flats', 'a title outside the list options is kept as is');
  assert.equal(session.collected.catalogDesignNo, 'WKD-2B-01');
  for (const q of QUESTIONS) assert.ok(session.collected[q.field_key], q.field_key);
});

test('a collection-card Order (no ID) skips the property-type question but still asks the ID / area', async () => {
  const { asked } = await walk({}, { prefill: [{ key: 'catalogCollection', value: 'Wakad Flats' }] });
  assert.deepEqual(asked, [qid('purpose'), qid('budget'), qid('catalogDesignNo'), qid('visitWhen')]);
});

test('without prefill all five questions are asked', async () => {
  const { asked } = await walk();
  assert.deepEqual(asked, QUESTIONS.map((q) => q.id));
});
