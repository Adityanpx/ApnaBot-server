// Run: node --test src/utils/flowGraphValidation.entry.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { findFlowEntryNodeId } = require('./flowGraphValidation');

const node = (id, nodeType) => ({ id, nodeType });
const edge = (fromNodeId, toNodeId) => ({ fromNodeId, toNodeId });
const nodes = [node('menu', 'reply'), node('trip', 'question'), node('pick', 'route_picker'), node('time', 'question'),
  node('timeManual', 'question'), node('quote', 'quote'), node('other', 'question')];
const edges = [edge('menu', 'trip'), edge('trip', 'pick'), edge('pick', 'time'), edge('time', 'quote'), edge('timeManual', 'quote')];

test('the entry is the question a reply button points to, found from any node deeper in the flow', () => {
  assert.equal(findFlowEntryNodeId(nodes, edges, 'quote'), 'trip');
  assert.equal(findFlowEntryNodeId(nodes, edges, 'pick'), 'trip');
  assert.equal(findFlowEntryNodeId(nodes, edges, 'trip'), 'trip');
});

test('a manual sibling with no incoming edge is not an entry; a node nothing leads into has none', () => {
  assert.equal(findFlowEntryNodeId(nodes, edges, 'timeManual'), null);
  assert.equal(findFlowEntryNodeId(nodes, edges, 'other'), null);
});

test('a booking_trigger style entry (reply -> question) works the same, and cycles do not loop', () => {
  const cyc = [edge('menu', 'trip'), edge('trip', 'pick'), edge('pick', 'trip')];
  assert.equal(findFlowEntryNodeId(nodes, cyc, 'pick'), 'trip');
});
