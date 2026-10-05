// Run: node --test src/utils/messageStatus.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { statusesBefore } = require('./messageStatus');

test('forward only: delivered from sent, read from sent or delivered', () => {
  assert.deepEqual(statusesBefore('delivered'), ['sent']);
  assert.deepEqual(statusesBefore('read'), ['sent', 'delivered']);
});

test('sent changes nothing; failed only from sent', () => {
  assert.deepEqual(statusesBefore('sent'), []);
  assert.deepEqual(statusesBefore('failed'), ['sent']);
});

test('a status the messages table does not store is null', () => {
  for (const s of ['deleted', 'warning', '', undefined, 'constructor', '__proto__']) assert.equal(statusesBefore(s), null, String(s));
});
