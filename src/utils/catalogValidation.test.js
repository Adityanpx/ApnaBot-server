// Run: node --test src/utils/catalogValidation.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCollectionInput, validateItemInput, cleanTranslations } = require('./catalogValidation');

const MEDIA = '9b2f1c6a-1d3e-4a55-8f0b-2c7d6e5a4b31';

test('collection input: title required on create, card text <= 160 chars and 2 line breaks, price label <= 30', () => {
  assert.match(validateCollectionInput({}, { partial: false }).error, /title is required/);
  assert.match(validateCollectionInput({ title: ' ' }, { partial: false }).error, /title is required/);
  assert.match(validateCollectionInput({ title: 'x'.repeat(61) }, { partial: false }).error, /60/);
  assert.deepEqual(validateCollectionInput({ title: ' Silk ', body: 'Pure silk', priceLabel: 'From 999', isActive: false, coverMediaId: MEDIA }, { partial: false }).value,
    { title: 'Silk', body: 'Pure silk', price_label: 'From 999', is_active: false, cover_media_id: MEDIA });
  assert.match(validateCollectionInput({ title: 'a', body: 'x'.repeat(161) }, { partial: false }).error, /160/);
  assert.match(validateCollectionInput({ title: 'a', body: 'a\nb\nc\nd' }, { partial: false }).error, /2 line breaks/);
  assert.equal(validateCollectionInput({ title: 'a', body: 'a\nb\nc' }, { partial: false }).error, undefined);
  assert.match(validateCollectionInput({ title: 'a', priceLabel: 'x'.repeat(31) }, { partial: false }).error, /30/);
  assert.match(validateCollectionInput({ title: 'a', coverMediaId: 'nope' }, { partial: false }).error, /coverMediaId/);
  assert.match(validateCollectionInput({ title: 'a', isActive: 'no' }, { partial: false }).error, /isActive/);
  assert.match(validateCollectionInput({ title: 'a', bodyTranslations: { hi: 'a\nb\nc\nd' } }, { partial: false }).error, /line breaks/);
});

test('collection input, partial: only the supplied keys, null clears', () => {
  assert.deepEqual(validateCollectionInput({ body: null, coverMediaId: null }, { partial: true }).value, { body: null, cover_media_id: null });
  assert.deepEqual(validateCollectionInput({}, { partial: true }).value, {});
});

test('item input: mediaId required on create; design no / price <= 40, caption <= 500', () => {
  assert.match(validateItemInput({}, { partial: false }).error, /mediaId/);
  assert.deepEqual(validateItemInput({ mediaId: MEDIA, designNo: ' A-1 ', priceText: '999', caption: 'Soft' }, { partial: false }).value,
    { media_id: MEDIA, design_no: 'A-1', price_text: '999', caption: 'Soft' });
  assert.match(validateItemInput({ mediaId: MEDIA, designNo: 'x'.repeat(41) }, { partial: false }).error, /40/);
  assert.match(validateItemInput({ mediaId: MEDIA, caption: 'x'.repeat(501) }, { partial: false }).error, /500/);
  assert.deepEqual(validateItemInput({ priceText: '' }, { partial: true }).value, { price_text: null });
  assert.match(validateItemInput('x', { partial: false }).error, /object/);
});

test('cleanTranslations drops blanks and returns null when nothing is left', () => {
  assert.deepEqual(cleanTranslations({ hi: ' a ', mr: '' }, 'x', 10).value, { hi: 'a' });
  assert.equal(cleanTranslations({ hi: '' }, 'x', 10).value, null);
  assert.equal(cleanTranslations(null, 'x', 10).value, null);
});
