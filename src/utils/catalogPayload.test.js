// Run: node --test src/utils/catalogPayload.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { composeCardText, planCatalogueCards, photoCaption, paginate } = require('./catalogPayload');
const { parseCatalogTapId } = require('./catalogIds');

const ids = Array.from({ length: 12 }, (_, i) => `3f2504e0-4f89-41d3-9a0c-0305e82c33${String(i).padStart(2, '0')}`);
const col = (i, extra = {}) => ({ id: ids[i], title: `Collection ${i}`, body: 'Soft cotton', priceLabel: 'From ₹499', mediaUrl: `https://r2.test/${i}.jpg`, ...extra });

test('card text: *title*, body, price label on separate lines (2 line breaks), at most 160 characters', () => {
  const text = composeCardText({ title: 'Silk Sarees', body: 'Pure Kanjivaram', priceLabel: 'From ₹4,999' });
  assert.equal(text, '*Silk Sarees*\nPure Kanjivaram\nFrom ₹4,999');
  assert.equal((text.match(/\n/g) || []).length, 2);
});

test('card text: a long body is shortened, the title and price label are always kept', () => {
  const text = composeCardText({ title: 'T'.repeat(60), body: 'b'.repeat(500), priceLabel: 'P'.repeat(30) });
  assert.ok(text.length <= 160, `length ${text.length}`);
  assert.ok(text.startsWith(`*${'T'.repeat(60)}*`));
  assert.ok(text.endsWith('P'.repeat(30)));
  assert.equal((text.match(/\n/g) || []).length, 2);
});

test('card text: the body\'s own line breaks become spaces; missing parts leave no blank lines; * in a title is dropped', () => {
  assert.equal(composeCardText({ title: 'A*B', body: 'one\ntwo\n\nthree', priceLabel: '' }), '*AB*\none two three');
  assert.equal(composeCardText({ title: 'Only', body: '', priceLabel: '' }), '*Only*');
  assert.equal(composeCardText({ title: 'T', body: '', priceLabel: '₹1' }), '*T*\n₹1');
});

test('cards: every card has View designs + Order with the same two buttons, ids route to that collection', () => {
  const plan = planCatalogueCards({ collections: [col(0), col(1), col(2)], maxCards: 10, viewLabel: 'View designs', orderLabel: 'Order' });
  assert.equal(plan.native, true);
  assert.equal(plan.cards.length, 3);
  for (const [i, card] of plan.cards.entries()) {
    assert.deepEqual(card.buttons.map(b => b.title), ['View designs', 'Order']);
    assert.deepEqual(parseCatalogTapId(card.buttons[0].nextKeyword), { kind: 'page', collectionId: ids[i], page: 0 });
    assert.deepEqual(parseCatalogTapId(card.buttons[1].nextKeyword), { kind: 'collection_order', collectionId: ids[i] });
    assert.equal(card.mediaType, 'image');
    assert.equal(card.mediaUrl, `https://r2.test/${i}.jpg`);
  }
});

test('cards: with no order action every card has just View designs', () => {
  const plan = planCatalogueCards({ collections: [col(0), col(1)], maxCards: 10, viewLabel: 'View designs', orderLabel: null });
  assert.deepEqual(plan.cards.map(c => c.buttons.length), [1, 1]);
});

test('cards: only the plan\'s carousel_max_cards collections are shown, the rest counted as skipped', () => {
  const plan = planCatalogueCards({ collections: [0, 1, 2, 3, 4].map(i => col(i)), maxCards: 3, viewLabel: 'V', orderLabel: 'O' });
  assert.equal(plan.cards.length, 3);
  assert.deepEqual(plan.skipped, { overPlan: 2 });
  assert.equal(planCatalogueCards({ collections: Array.from({ length: 12 }, (_, i) => col(i)), maxCards: 99, viewLabel: 'V', orderLabel: 'O' }).cards.length, 10);
});

test('cards: native needs 2+ photos; a collection without one is left out of the native carousel', () => {
  const plan = planCatalogueCards({ collections: [col(0), col(1, { mediaUrl: null }), col(2)], maxCards: 10, viewLabel: 'V', orderLabel: 'O' });
  assert.equal(plan.native, true);
  assert.deepEqual(plan.cards.map(c => c.mediaUrl), ['https://r2.test/0.jpg', 'https://r2.test/2.jpg']);
});

test('cards: fewer than 2 photos -> not native, every card kept (text card for one without a photo)', () => {
  const one = planCatalogueCards({ collections: [col(0)], maxCards: 10, viewLabel: 'V', orderLabel: 'O' });
  assert.equal(one.native, false);
  assert.equal(one.cards.length, 1);
  const mixed = planCatalogueCards({ collections: [col(0), col(1, { mediaUrl: null })], maxCards: 10, viewLabel: 'V', orderLabel: 'O' });
  assert.equal(mixed.native, false);
  assert.deepEqual(mixed.cards.map(c => c.mediaUrl), ['https://r2.test/0.jpg', null]);
  assert.equal(mixed.cards[1].mediaType, null);
});

test('button titles are cut at 20 characters', () => {
  const plan = planCatalogueCards({ collections: [col(0), col(1)], maxCards: 10, viewLabel: 'x'.repeat(30), orderLabel: 'y'.repeat(30) });
  assert.deepEqual(plan.cards[0].buttons.map(b => b.title.length), [20, 20]);
});

test('photo caption: "design no · price · caption", only the parts that exist', () => {
  assert.equal(photoCaption({ designNo: 'A-102', priceText: '₹1,499', caption: 'Pure cotton' }), 'A-102 · ₹1,499 · Pure cotton');
  assert.equal(photoCaption({ designNo: 'A-102', priceText: null, caption: '' }), 'A-102');
  assert.equal(photoCaption({ designNo: null, priceText: '₹5', caption: 'Soft\nfeel' }), '₹5 · Soft feel');
  assert.equal(photoCaption({}), '');
});

test('paginate: pages of photosPerPage, "Showing from-to of total", hasMore', () => {
  assert.deepEqual(paginate(34, 0, 10), { page: 0, offset: 0, limit: 10, from: 1, to: 10, hasMore: true, pages: 4 });
  assert.deepEqual(paginate(34, 3, 10), { page: 3, offset: 30, limit: 10, from: 31, to: 34, hasMore: false, pages: 4 });
  assert.deepEqual(paginate(10, 0, 10), { page: 0, offset: 0, limit: 10, from: 1, to: 10, hasMore: false, pages: 1 });
  assert.deepEqual(paginate(7, 0, 3), { page: 0, offset: 0, limit: 3, from: 1, to: 3, hasMore: true, pages: 3 });
});

test('paginate: a page past the end lands on the last page, a bad page on the first, an empty collection has no range', () => {
  assert.equal(paginate(34, 99, 10).page, 3);
  assert.equal(paginate(34, -4, 10).page, 0);
  assert.equal(paginate(34, NaN, 10).page, 0);
  assert.deepEqual(paginate(0, 0, 10), { page: 0, offset: 0, limit: 10, from: 0, to: 0, hasMore: false, pages: 1 });
  assert.equal(paginate(5, 0, 50).limit, 10);
  assert.equal(paginate(5, 0, 0).limit, 10);
});
