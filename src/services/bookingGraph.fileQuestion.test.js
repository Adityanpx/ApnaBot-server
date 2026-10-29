// Run: node --test src/services/bookingGraph.fileQuestion.test.js
// The booking 'file' question type through the real graph engine: a stored file's link is the answer,
// typed text is not (required: asked again with the file hint, optional: skipped), a stale tap id is
// never an answer, the confirmation says "received" instead of printing the link. In-memory graph, no database.
const path = require('path');
const stub = (relativePath, exports) => {
  const resolved = require.resolve(path.join(__dirname, relativePath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const N = (n) => `3b0b11e0-0000-4000-8000-0000000000${n}`;
const node = (over) => ({
  keyword: null, match_type: null, hindi_aliases: [], reply_kind: null, trigger_count: 0, content_type: 'text', label: '',
  field_key: null, summary_label: null, required: false, order: null, options: [], is_computed: false, is_active: true,
  position_x: 0, position_y: 0, ...over
});
const NODES = [
  node({ id: N(10), node_type: 'reply', keyword: 'send_docs', match_type: 'exact', reply_kind: 'booking_trigger', label: 'Great!' }),
  node({ id: N(11), node_type: 'question', label: 'Your name?', field_key: 'customerName', summary_label: 'Name', required: true, order: 0 }),
  node({ id: N(12), node_type: 'question', content_type: 'file', label: 'Send your ID proof', field_key: 'idProof', summary_label: 'ID proof', required: true, order: 1 }),
  node({ id: N(13), node_type: 'question', content_type: 'file', label: 'Any extra photo?', label_translations: { hi: 'कोई और फ़ोटो?' }, field_key: 'extraPhoto', summary_label: 'Extra photo', required: false, order: 2 })
];
const edge = (id, from, to) => ({ id: N(id), from_node_id: N(from), to_node_id: N(to), label: null, description: null, condition: null, preset: null, display_order: 0 });
const EDGES = [edge(20, 10, 11), edge(21, 11, 12), edge(22, 12, 13)];

const from = (table) => {
  const q = { select: () => q, eq: () => q, then: (resolve, reject) => Promise.resolve({ data: table === 'flow_nodes' ? NODES : EDGES, error: null }).then(resolve, reject) };
  return q;
};
stub('../config/redis', {});
stub('../config/supabase', { from });
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {} });
stub('../queues/sessionTimeout.queue', { addToSessionTimeoutQueue: async () => {} });
stub('./socket.service', {});
stub('./payment.service', {});
stub('./distanceMatrix.service', {});
stub('./business.service', { getBusinessById: async () => ({ id: 'b1', businessCategory: 'general', travelSettings: {}, disabledBookingFields: [] }) });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

const test = require('node:test');
const assert = require('node:assert/strict');
const bookingGraph = require('./bookingGraph.service');
const { buildBookingSummaryBody } = require('./booking.service');

const URL1 = 'https://r2.test/booking-files/b1/f1.pdf';
const advance = (session, reply, languageCode = 'en') => bookingGraph.advanceGraphSession({ businessId: 'b1', session, reply, languageCode });

const toIdProofQuestion = async () => {
  const started = await bookingGraph.startGraphSession('b1', N(10), 'en', {});
  assert.equal(started.result.fieldKey, 'customerName');
  const asked = await advance(started.session, 'Ravi');
  assert.equal(asked.result.fieldType, 'file');
  assert.equal(asked.result.fieldKey, 'idProof');
  return asked.session;
};

test('the question is presented as fieldType file', async () => {
  const session = await toIdProofQuestion();
  const field = await bookingGraph.getCurrentNodeField('b1', session, 'en');
  assert.equal(field.fieldType, 'file');
  assert.equal(field.label, 'Send your ID proof');
  assert.equal(field.required, true);
});

test('a stored file answers it: the link is collected, the booking moves on', async () => {
  const session = await toIdProofQuestion();
  const { session: next, result } = await advance(session, { fileUrl: URL1 });
  assert.equal(next.collected.idProof, URL1);
  assert.equal(result.fieldKey, 'extraPhoto');
  assert.deepEqual(next.answeredFields.find((f) => f.fieldKey === 'idProof'), { fieldKey: 'idProof', label: 'Send your ID proof', summaryLabel: 'ID proof', isFile: true });
  assert.equal(next.answeredFields.find((f) => f.fieldKey === 'customerName').isFile, undefined);
});

test('typed text to a required file question asks again with the file hint, nothing is stored', async () => {
  const session = await toIdProofQuestion();
  const { session: same, result } = await advance(session, 'here you go');
  assert.equal(typeof result, 'string');
  assert.match(result, /^Please send a photo or file as your answer\. Send \*menu\*/);
  assert.match(result, /Send your ID proof$/);
  assert.equal(same.collected.idProof, undefined);
  assert.equal(same.currentNodeId, N(12));
});

test('an empty reply and a stale tap id to a required file question are asked again too', async () => {
  const session = await toIdProofQuestion();
  for (const reply of ['', `${N(11)}:2`, 'lang_hi']) {
    const { result } = await advance(session, reply);
    assert.match(result, /Please send a photo or file/, JSON.stringify(reply));
  }
});

test('an optional file question is skipped by typing text, and a stale tap id still asks again', async () => {
  const session = await toIdProofQuestion();
  const { session: atOptional } = await advance(session, { fileUrl: URL1 });
  const asked = await bookingGraph.getCurrentNodeField('b1', atOptional, 'hi');
  assert.equal(asked.label, 'कोई और फ़ोटो?');

  const stale = await advance(atOptional, `${N(12)}:0`, 'hi');
  assert.match(stale.result, /^कृपया अपने उत्तर के रूप में एक फ़ोटो या फ़ाइल भेजें/);

  const { session: done, result } = await advance(atOptional, 'skip');
  assert.equal(result.done, true);
  assert.equal(done.collected.extraPhoto, null);
  assert.equal(done.collected.idProof, URL1);
});

test('the confirmation says "received" in place of the link; a skipped file is left out', async () => {
  const session = await toIdProofQuestion();
  const { session: atOptional } = await advance(session, { fileUrl: URL1 });
  const { session: done } = await advance(atOptional, 'skip');
  const body = buildBookingSummaryBody(done.collected, done.answeredFields, false, 'en');
  assert.match(body, /ID proof: \*received\*/);
  assert.doesNotMatch(body, /r2\.test|extra photo/i);
  assert.match(body, /Name: \*Ravi\*/);
  assert.match(buildBookingSummaryBody(done.collected, done.answeredFields, false, 'hi'), /ID proof: \*प्राप्त हुआ\*/);
});
