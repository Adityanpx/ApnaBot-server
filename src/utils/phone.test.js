// Run: node --test src/utils/phone.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone } = require('./phone');

const ok = (raw, phone) => assert.deepEqual(normalizePhone(raw), { phone }, `${JSON.stringify(raw)} → ${phone}`);
const bad = (raw, reason) => assert.deepEqual(normalizePhone(raw), { reason }, `${JSON.stringify(raw)} → ${reason}`);

test('10-digit Indian mobile gets 91 in front', () => {
  ok('9876543210', '919876543210');
  ok('6000000000', '916000000000');
  ok(9876543210, '919876543210'); // a numeric cell
});

test('spaces, dashes, dots, brackets, non-breaking spaces are removed', () => {
  ok('98765 43210', '919876543210');
  ok('98765-43210', '919876543210');
  ok('(987) 654-3210', '919876543210');
  ok('987.654.3210', '919876543210');
  ok('98765 43210', '919876543210');
  ok('  +91 98765–43210  ', '919876543210'); // en dash
});

test('leading 0, 91, +91 and 0091 all give the same number', () => {
  ok('09876543210', '919876543210');
  ok('919876543210', '919876543210');
  ok(919876543210, '919876543210');
  ok('+919876543210', '919876543210');
  ok('+91 98765 43210', '919876543210');
  ok('0091 9876543210', '919876543210');
  ok('00919876543210', '919876543210');
});

test('other countries only with an explicit + or 00', () => {
  ok('+971 50 123 4567', '971501234567');
  ok('00971501234567', '971501234567');
  ok('+44 7911 123456', '447911123456');
  bad('971501234567', 'invalid'); // no prefix: can't tell it from a typo
  bad('+12345', 'too_short');
  bad('+1234567890123456', 'invalid'); // 16 digits > E.164
});

test('Excel scientific notation is rejected, not guessed', () => {
  bad('9.19876E+11', 'scientific_notation');
  bad('9.19876e11', 'scientific_notation');
  bad('9,19876E+11', 'scientific_notation');
});

test('reason codes: empty, too_short, landline, not_mobile, invalid', () => {
  bad('', 'empty');
  bad('   ', 'empty');
  bad(null, 'empty');
  bad(undefined, 'empty');
  bad('+', 'empty');
  bad('98765', 'too_short');
  bad('+91 98765', 'too_short');
  bad('2226543210', 'landline');
  bad('02226543210', 'landline');
  bad('+91 22 2654 3210', 'landline');
  bad('1800123456', 'not_mobile');
  bad('0123456789', 'not_mobile');
  bad('98765abc10', 'invalid');
  bad('call me', 'invalid');
  bad('98765432101', 'invalid');   // 11 digits, no leading 0
  bad('+91 98765432101', 'invalid'); // 11 national digits
  bad('9876543210 / 9876543211', 'invalid'); // two numbers in one cell
});
