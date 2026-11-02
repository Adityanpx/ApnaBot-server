// Run: node --test src/utils/quoteChat.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { tapNodeId, payloadNodeId, quoteFlowEntry } = require('./quoteChat');

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MENU = id(1); const TRIP = id(2); const PICKER = id(3); const PAX = id(4); const QUOTE = id(5);
const OTHER_MENU = id(11); const OTHER_Q1 = id(12); const OTHER_Q2 = id(13); const SIBLING = id(20);
const nodes = [
  { id: MENU, nodeType: 'reply' }, { id: TRIP, nodeType: 'question' }, { id: PICKER, nodeType: 'route_picker' },
  { id: PAX, nodeType: 'question' }, { id: QUOTE, nodeType: 'quote' },
  { id: OTHER_MENU, nodeType: 'reply' }, { id: OTHER_Q1, nodeType: 'question' }, { id: OTHER_Q2, nodeType: 'question' },
  { id: SIBLING, nodeType: 'question' }
];
const edges = [
  { fromNodeId: MENU, toNodeId: TRIP }, { fromNodeId: TRIP, toNodeId: PICKER }, { fromNodeId: PICKER, toNodeId: PAX }, { fromNodeId: PAX, toNodeId: QUOTE },
  { fromNodeId: OTHER_MENU, toNodeId: OTHER_Q1 }, { fromNodeId: OTHER_Q1, toNodeId: OTHER_Q2 }
];

test('tapNodeId: only a "{nodeId}:{n|other}" question id names a node', () => {
  assert.equal(tapNodeId(`${PAX}:1`), PAX);
  assert.equal(tapNodeId(`${PAX}:other`), PAX);
  assert.equal(tapNodeId(PAX.toUpperCase() + ':0'), PAX);
  for (const other of [`quote:${QUOTE}:confirm`, `${PAX}`, `${PAX}:x`, 'lang_hi', 'to:r1', null, undefined, 5]) assert.equal(tapNodeId(other), null, String(other));
});

test('payloadNodeId: reads the question from a saved buttons / list payload; a quote or plain payload has none', () => {
  assert.equal(payloadNodeId({ kind: 'buttons', body: 'How many?', options: [{ id: `${PAX}:0`, title: '1-4' }, { id: `${PAX}:1`, title: '5-6' }] }), PAX);
  assert.equal(payloadNodeId({ kind: 'list', body: 'Where?', buttonText: 'Choose', options: [{ id: `${PICKER}:0`, title: 'Shirdi' }] }), PICKER);
  assert.equal(payloadNodeId({ kind: 'buttons', body: 'Your quote', options: [{ id: `quote:${QUOTE}:confirm`, title: 'Confirm' }] }), null);
  assert.equal(payloadNodeId({ kind: 'cta_url', body: 'x', label: 'y' }), null);
  assert.equal(payloadNodeId(null), null);
});

test('quoteFlowEntry: the entry question for any question of a flow that reaches a route_picker; null for other flows', () => {
  for (const node of [TRIP, PICKER, PAX, QUOTE]) assert.equal(quoteFlowEntry(nodes, edges, node), TRIP, node);
  assert.equal(quoteFlowEntry(nodes, edges, OTHER_Q1), null, 'a booking flow with no route picker');
  assert.equal(quoteFlowEntry(nodes, edges, OTHER_Q2), null);
  assert.equal(quoteFlowEntry(nodes, edges, MENU), null, 'a reply node is never a question');
  assert.equal(quoteFlowEntry(nodes, edges, SIBLING), null, 'a question nothing enters');
  assert.equal(quoteFlowEntry(nodes, edges, id(99)), null, 'unknown node');
});
