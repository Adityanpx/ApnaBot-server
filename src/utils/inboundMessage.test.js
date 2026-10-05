// Run: node --test src/utils/inboundMessage.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { decideDuplicate, unsupportedLabel } = require('./inboundMessage');

test('decideDuplicate: no stored row -> insert, whatever the type', () => {
  assert.equal(decideDuplicate(null, 'text'), 'insert');
  assert.equal(decideDuplicate(undefined, 'unsupported'), 'insert');
});

test('decideDuplicate: real after unsupported -> replace', () => {
  for (const t of ['text', 'image', 'interactive', 'button']) assert.equal(decideDuplicate('unsupported', t), 'replace', t);
});

test('decideDuplicate: unsupported after real, after unsupported -> ignore', () => {
  assert.equal(decideDuplicate('text', 'unsupported'), 'ignore');
  assert.equal(decideDuplicate('unsupported', 'unsupported'), 'ignore');
});

test('decideDuplicate: a plain retry of a real message -> ignore', () => {
  assert.equal(decideDuplicate('text', 'text'), 'ignore');
  assert.equal(decideDuplicate('image', 'text'), 'ignore');
});

test('unsupportedLabel: raw type, error code when present, bounded', () => {
  assert.match(unsupportedLabel({ type: 'unsupported', errors: [{ code: 131051 }] }), /type: unsupported, error 131051/);
  assert.match(unsupportedLabel({ type: 'poll' }), /type: poll\)/);
  assert.match(unsupportedLabel({}), /type: unknown/);
  assert.ok(unsupportedLabel({ type: 'x'.repeat(500) }).length < 150);
});
