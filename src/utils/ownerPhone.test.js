// Run: node --test src/utils/ownerPhone.test.js
// users.phone normalization (+91 + 10 digits, 6-9 first) and the Super Admin search-term sanitiser.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOwnerPhone } = require('./ownerPhone');
const { sanitizeSearchTerm } = require('./searchTerm');

test('accepted forms all normalize to +919876543210', () => {
  for (const raw of ['9876543210', '+919876543210', '09876543210', '919876543210', ' +91 98765-43210 ', 9876543210]) {
    assert.deepEqual(normalizeOwnerPhone(raw), { phone: '+919876543210' }, String(raw));
  }
});

test('missing values are reason empty', () => {
  for (const raw of [undefined, null, '', '   ']) {
    assert.deepEqual(normalizeOwnerPhone(raw), { reason: 'empty' }, String(raw));
  }
});

test('anything that is not an Indian mobile is invalid', () => {
  for (const raw of ['5876543210', '1234567890', '98765', '98765432101', 'abcdefghij', '+14155552671', '+971501234567', '9.8765E+11', {}, [], true]) {
    const out = normalizeOwnerPhone(raw);
    assert.equal(out.phone, undefined, JSON.stringify(raw));
    assert.equal(out.reason, 'invalid', JSON.stringify(raw));
  }
});

test('every normalized value satisfies the DB CHECK regex', () => {
  for (const raw of ['6000000000', '7999999999', '8123456789', '9876543210']) {
    assert.match(normalizeOwnerPhone(raw).phone, /^\+91[6-9][0-9]{9}$/);
  }
});

test('sanitizeSearchTerm strips PostgREST filter characters', () => {
  assert.equal(sanitizeSearchTerm('ravi,owner_user_id.in.(a,b)'), 'ravi owner_user_id.in. a b');
  assert.equal(sanitizeSearchTerm('50%*off'), '50 off');
  assert.equal(sanitizeSearchTerm('a"b\'c\\d:e`f'), 'a b c d e f');
  assert.equal(sanitizeSearchTerm('  Sai   Travels '), 'Sai Travels');
  assert.equal(sanitizeSearchTerm(',()'), '');
  assert.equal(sanitizeSearchTerm(['a', 'b']), '');
  assert.equal(sanitizeSearchTerm(undefined), '');
});
