// Run: node --test src/utils/contactPhone.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeContactPhone } = require('./contactPhone');

test('10 digits are Indian: 91 is put in front, separators dropped', () => {
  assert.deepEqual(normalizeContactPhone('9876543210'), { phone: '919876543210' });
  assert.deepEqual(normalizeContactPhone(' 98765-43210 '), { phone: '919876543210' });
  assert.deepEqual(normalizeContactPhone(9876543210), { phone: '919876543210' });
  assert.deepEqual(normalizeContactPhone('(987) 654 3210'), { phone: '919876543210' });
});

test('11-15 digits are taken as already having a country code', () => {
  assert.deepEqual(normalizeContactPhone('919876543210'), { phone: '919876543210' });
  assert.deepEqual(normalizeContactPhone('+91 98765 43210'), { phone: '919876543210' });
  assert.deepEqual(normalizeContactPhone('+971501234567'), { phone: '971501234567' });
  assert.deepEqual(normalizeContactPhone('123456789012345'), { phone: '123456789012345' });
});

test('rejections carry a reason', () => {
  assert.deepEqual(normalizeContactPhone(undefined), { reason: 'empty' });
  assert.deepEqual(normalizeContactPhone(null), { reason: 'empty' });
  assert.deepEqual(normalizeContactPhone('  '), { reason: 'empty' });
  assert.deepEqual(normalizeContactPhone({}), { reason: 'empty' });
  assert.deepEqual(normalizeContactPhone('98765abc10'), { reason: 'invalid_chars' });
  assert.deepEqual(normalizeContactPhone('9876+543210'), { reason: 'invalid_chars' });
  assert.deepEqual(normalizeContactPhone('123456789'), { reason: 'bad_length' });
  assert.deepEqual(normalizeContactPhone('1234567890123456'), { reason: 'bad_length' });
});
