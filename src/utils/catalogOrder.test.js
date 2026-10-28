// Run: node --test src/utils/catalogOrder.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrefill, sanitizePrefill, prefillLabel, isPrefillKey, PREFILL_KEYS } = require('./catalogOrder');

test('collection order: the collection title and its price label', () => {
  assert.deepEqual(buildPrefill({ collection: { title: ' Silk  Sarees ', priceLabel: 'From 999' } }), [
    { key: 'catalogCollection', value: 'Silk Sarees' },
    { key: 'catalogPrice', value: 'From 999' }
  ]);
});

test('item order: collection, design number and the item own price', () => {
  assert.deepEqual(buildPrefill({
    collection: { title: 'Silk', priceLabel: 'From 999' }, item: { designNo: 'A-102', priceText: '1,499' }
  }), [
    { key: 'catalogCollection', value: 'Silk' },
    { key: 'catalogDesignNo', value: 'A-102' },
    { key: 'catalogPrice', value: '1,499' }
  ]);
});

test('an item with no price does not borrow the collection price label; empty values are left out', () => {
  assert.deepEqual(buildPrefill({ collection: { title: 'Silk', priceLabel: 'From 999' }, item: { designNo: 'A-1', priceText: '' } }), [
    { key: 'catalogCollection', value: 'Silk' },
    { key: 'catalogDesignNo', value: 'A-1' }
  ]);
});

test('sanitizePrefill keeps only well-formed known entries, once each, value capped at 200', () => {
  assert.deepEqual(sanitizePrefill([
    { key: 'catalogCollection', value: ' Silk ' }, { key: 'catalogCollection', value: 'again' },
    { key: 'other', value: 'x' }, { key: 'catalogPrice', value: '' }, null, 'x', { key: 'catalogDesignNo', value: 'y'.repeat(300) }
  ]), [{ key: 'catalogCollection', value: 'Silk' }, { key: 'catalogDesignNo', value: 'y'.repeat(200) }]);
  assert.deepEqual(sanitizePrefill(null), []);
  assert.deepEqual(sanitizePrefill({ key: 'catalogCollection', value: 'x' }), []);
});

test('labels: English for the owner, the customer language for the confirmation, English fallback', () => {
  assert.equal(prefillLabel('catalogCollection', null), 'Collection');
  assert.equal(prefillLabel('catalogDesignNo', 'en'), 'Design no');
  assert.notEqual(prefillLabel('catalogPrice', 'hi'), 'Price');
  assert.equal(prefillLabel('catalogPrice', 'zz'), 'Price'); // a language with no text at all: English
  for (const key of Object.keys(PREFILL_KEYS)) assert.equal(isPrefillKey(key), true);
  assert.equal(isPrefillKey('vehicleId'), false);
});
