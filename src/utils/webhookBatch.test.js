// Run: node --test src/utils/webhookBatch.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitMessages } = require('./webhookBatch');

const ch = (messages, contacts) => ({ field: 'messages', value: { metadata: { phone_number_id: 'p' }, contacts, messages } });
const m = (id, from) => ({ id, from, type: 'text' });

test('a change with zero or one message (or none at all) is returned as is', () => {
  const one = ch([m('1', 'a')], [{ wa_id: 'a' }]);
  assert.deepEqual(splitMessages(one), [one]);
  const none = { field: 'messages', value: { statuses: [{ id: 'x' }] } };
  assert.deepEqual(splitMessages(none), [none]);
  assert.deepEqual(splitMessages(undefined), [undefined]);
  assert.deepEqual(splitMessages({ field: 'x' }), [{ field: 'x' }]);
});

test('several messages: one change each, same metadata, contacts narrowed to the sender', () => {
  const out = splitMessages(ch([m('1', 'a'), m('2', 'b'), m('3', 'a')], [{ wa_id: 'a', profile: { name: 'A' } }, { wa_id: 'b', profile: { name: 'B' } }]));
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(c => c.value.messages.map(x => x.id)), [['1'], ['2'], ['3']]);
  assert.deepEqual(out.map(c => c.value.contacts.map(x => x.wa_id)), [['a'], ['b'], ['a']]);
  assert.ok(out.every(c => c.value.metadata.phone_number_id === 'p' && c.field === 'messages'));
});

test('a sender with no matching contact keeps the whole contacts list; no contacts stays absent', () => {
  const out = splitMessages(ch([m('1', 'a'), m('2', 'zzz')], [{ wa_id: 'a' }]));
  assert.deepEqual(out[1].value.contacts, [{ wa_id: 'a' }]);
  const bare = splitMessages({ field: 'messages', value: { messages: [m('1', 'a'), m('2', 'b')] } });
  assert.equal('contacts' in bare[0].value, false);
});

test('the original change is not mutated', () => {
  const original = ch([m('1', 'a'), m('2', 'b')], [{ wa_id: 'a' }, { wa_id: 'b' }]);
  splitMessages(original);
  assert.equal(original.value.messages.length, 2);
  assert.equal(original.value.contacts.length, 2);
});
