// Run: node --test src/utils/flowWarnings.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { flowWarnings } = require('./flowWarnings');

const reply = (id, reply_kind) => ({ id, reply_kind });
const question = (id, content_type, field_key = id) => ({ id, content_type, field_key });
const edge = (from_node_id, to_node_id) => ({ from_node_id, to_node_id });

test('no file question, or no web form: nothing to say', () => {
  assert.deepEqual(flowWarnings({ replyNodes: [reply('w', 'web_form_trigger')], questionNodes: [question('q', 'text')], edges: [] }), []);
  assert.deepEqual(flowWarnings({ replyNodes: [reply('b', 'booking_trigger')], questionNodes: [question('f', 'file')], edges: [edge('b', 'f')] }), []);
  assert.deepEqual(flowWarnings({ replyNodes: [], questionNodes: [], edges: [] }), []);
});

test('a file question reachable from a web_form_trigger is flagged, once', () => {
  const w = flowWarnings({
    replyNodes: [reply('w', 'web_form_trigger')],
    questionNodes: [question('q', 'text'), question('f', 'file', 'idProof')],
    edges: [edge('w', 'q'), edge('q', 'f')]
  });
  assert.equal(w.length, 1);
  assert.equal(w[0].code, 'file_question_web_form');
  assert.equal(w[0].nodeId, 'f');
  assert.equal(w[0].fieldKey, 'idProof');
  assert.match(w[0].message, /web booking form/);
});

test('a business with a web form whose chat booking does not reach the file question is flagged', () => {
  const w = flowWarnings({
    replyNodes: [reply('w', 'web_form_trigger'), reply('b', 'booking_trigger')],
    questionNodes: [question('q', 'text'), question('f', 'file')],
    edges: [edge('b', 'q')]
  });
  assert.deepEqual(w.map((x) => x.nodeId), ['f']);
});

test('a file question the chat booking reaches, in a business that also has a web form, is fine', () => {
  const w = flowWarnings({
    replyNodes: [reply('w', 'web_form_trigger'), reply('b', 'booking_trigger')],
    questionNodes: [question('f', 'file')],
    edges: [edge('b', 'f')]
  });
  assert.deepEqual(w, []);
});

test('a cycle in the edges does not loop', () => {
  const w = flowWarnings({
    replyNodes: [reply('w', 'web_form_trigger')],
    questionNodes: [question('a', 'text'), question('f', 'file')],
    edges: [edge('w', 'a'), edge('a', 'f'), edge('f', 'a')]
  });
  assert.equal(w.length, 1);
});
