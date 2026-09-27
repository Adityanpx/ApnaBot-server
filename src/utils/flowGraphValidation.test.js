// Run: node --test src/utils/flowGraphValidation.test.js
// Fixture graphs in loadGraph's camelCase shape — no Supabase access.
const test = require('node:test');
const assert = require('node:assert/strict');
const { canEnterBookingQuestions } = require('./flowGraphValidation');

const reply = (id, replyKind) => ({ id, nodeType: 'reply', replyKind });
const question = (id, fieldKey, nodeType = 'question') => ({ id, nodeType, fieldKey });
const edge = (fromNodeId, toNodeId) => ({ id: `${fromNodeId}->${toNodeId}`, fromNodeId, toNodeId, condition: null });

const questionChain = [
  question('q-trip', 'tripType'),
  question('q-pickup', 'pickupLocation'),
  question('q-drop', 'dropLocation')
];
const questionEdges = [edge('q-trip', 'q-pickup'), edge('q-pickup', 'q-drop')];

test('booking_trigger reply present -> guard applies', () => {
  const nodes = [reply('r-book', 'booking_trigger'), ...questionChain];
  const edges = [edge('r-book', 'q-trip'), ...questionEdges];
  assert.equal(canEnterBookingQuestions(nodes, edges), true);
});

test('booking_trigger reply with no outgoing edge still counts -> guard applies', () => {
  const nodes = [reply('r-book', 'booking_trigger'), ...questionChain];
  assert.equal(canEnterBookingQuestions(nodes, questionEdges), true);
});

test('text reply button edge -> tripType -> guard applies', () => {
  const nodes = [reply('r-menu', 'text'), ...questionChain];
  const edges = [edge('r-menu', 'q-trip'), ...questionEdges];
  assert.equal(canEnterBookingQuestions(nodes, edges), true);
});

test('reply -> vehicle_carousel edge -> guard applies', () => {
  const nodes = [reply('r-menu', 'text'), question('q-vehicle', 'vehicleType', 'vehicle_carousel')];
  const edges = [edge('r-menu', 'q-vehicle')];
  assert.equal(canEnterBookingQuestions(nodes, edges), true);
});

test('reply -> rentalPackage edge -> guard applies', () => {
  const nodes = [reply('r-menu', 'text'), question('q-pkg', 'rentalPackage', 'rentalPackage')];
  const edges = [edge('r-menu', 'q-pkg')];
  assert.equal(canEnterBookingQuestions(nodes, edges), true);
});

test('web_form_trigger only, no reply->question edges -> no guard', () => {
  const nodes = [
    reply('r-menu', 'text'),
    reply('r-faq', 'text'),
    reply('r-form', 'web_form_trigger'),
    ...questionChain
  ];
  const edges = [edge('r-menu', 'r-form'), edge('r-menu', 'r-faq'), ...questionEdges];
  assert.equal(canEnterBookingQuestions(nodes, edges), false);
});

test('question->question edges only -> no guard', () => {
  assert.equal(canEnterBookingQuestions(questionChain, questionEdges), false);
});

test('empty graph -> no guard', () => {
  assert.equal(canEnterBookingQuestions([], []), false);
});
