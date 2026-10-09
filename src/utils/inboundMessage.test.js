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

test('unsupportedLabel: one friendly label whatever the type or error code (the detail stays in raw_payload)', () => {
  const label = "WhatsApp couldn't show this message here — open it in your WhatsApp Business app.";
  assert.equal(unsupportedLabel({ type: 'unsupported', errors: [{ code: 131051 }] }), label);
  assert.equal(unsupportedLabel({ type: 'poll' }), label);
  assert.equal(unsupportedLabel({}), label);
  assert.equal(unsupportedLabel({ type: 'x'.repeat(500) }), label);
});
