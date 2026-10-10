// Run: node --test src/utils/templateValue.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanValue, fillPlaceholders } = require('./templateValue');

test('cleanValue trims the ends and collapses inner whitespace to one space', () => {
  assert.equal(cleanValue('PrimeCare Health Clinic '), 'PrimeCare Health Clinic');
  assert.equal(cleanValue('  Asha'), 'Asha');
  assert.equal(cleanValue('Asha\n\tPatil   Rao'), 'Asha Patil Rao');
  assert.equal(cleanValue('Asha Patil '), 'Asha Patil'); // NBSP counts as whitespace
});

test('cleanValue: multiline trims the ends only', () => {
  assert.equal(cleanValue('  Mon-Sat 9-6\nSun closed \n', { multiline: true }), 'Mon-Sat 9-6\nSun closed');
  assert.equal(cleanValue('a  b', { multiline: true }), 'a  b');
});

test('cleanValue: null, undefined and whitespace-only read as empty; other types are stringified', () => {
  assert.equal(cleanValue(null), '');
  assert.equal(cleanValue(undefined), '');
  assert.equal(cleanValue('   \n '), '');
  assert.equal(cleanValue(1500), '1500');
});

test('cleanValue does not strip a zero-width space', () => {
  assert.equal(cleanValue('Asha​'), 'Asha​');
});

test('fillPlaceholders: single pass, cleaned values, unknown marks left as written', () => {
  assert.equal(
    fillPlaceholders('Hi *{{name}}*, {{other}}', { name: ' Asha \n' }),
    'Hi *Asha*, {{other}}'
  );
});

test('fillPlaceholders: a value is never re-scanned for marks or read for $ patterns', () => {
  assert.equal(fillPlaceholders('{{a}} {{b}}', { a: '{{b}}', b: 'x' }), '{{b}} x');
  assert.equal(fillPlaceholders('{{a}}', { a: 'Pay $& $1 $$' }), 'Pay $& $1 $$');
});

test('fillPlaceholders: no vars returns the text untouched; clean:false keeps the value as given', () => {
  assert.equal(fillPlaceholders('Hi {{a}}', undefined), 'Hi {{a}}');
  assert.equal(fillPlaceholders('{{a}}', { a: 'x  y' }, { clean: false }), 'x  y');
});

test('fillPlaceholders: numbers fill as before, null reads as empty', () => {
  assert.equal(fillPlaceholders('Fare {{fare}}', { fare: 1500 }), 'Fare 1500');
  assert.equal(fillPlaceholders('Hi {{a}}!', { a: null }), 'Hi !');
});
