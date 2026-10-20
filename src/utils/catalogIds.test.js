// Run: node --test src/utils/catalogIds.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { PREFIX, MENU_ID, pageId, collectionOrderId, itemOrderId, parseCatalogTapId } = require('./catalogIds');
const { isSystemTapId } = require('./optInLink');

const C = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const I = '9b2f1c6a-1d3e-4a55-8f0b-2c7d6e5a4b31';

test('ids round-trip through parseCatalogTapId', () => {
  assert.deepEqual(parseCatalogTapId(pageId(C, 0)), { kind: 'page', collectionId: C, page: 0 });
  assert.deepEqual(parseCatalogTapId(pageId(C, 12)), { kind: 'page', collectionId: C, page: 12 });
  assert.deepEqual(parseCatalogTapId(collectionOrderId(C)), { kind: 'collection_order', collectionId: C });
  assert.deepEqual(parseCatalogTapId(itemOrderId(I)), { kind: 'item_order', itemId: I });
  assert.deepEqual(parseCatalogTapId(MENU_ID), { kind: 'menu' });
});

test('the documented id shapes', () => {
  assert.equal(pageId(C, 2), `cat:${C}:p:2`);
  assert.equal(collectionOrderId(C), `cat:${C}:order`);
  assert.equal(itemOrderId(I), `cat:item:${I}:order`);
  assert.equal(MENU_ID, 'cat:menu');
});

test('a negative or fractional page is clamped when building', () => {
  assert.equal(pageId(C, -3), `cat:${C}:p:0`);
  assert.equal(pageId(C, 1.7), `cat:${C}:p:1`);
});

test('malformed or foreign ids are not catalogue ids', () => {
  for (const bad of [null, undefined, '', 'lang_hi', 'optin_yes:abc', 'cat:', 'cat:x', `cat:${C}`, `cat:${C}:p`, `cat:${C}:p:-1`,
    `cat:${C}:p:abc`, `cat:${C}:order:extra`, `cat:item:${I}`, `cat:item:not-a-uuid:order`, 'cat:not-a-uuid:order', C, `${C}:0`, 5]) {
    assert.equal(parseCatalogTapId(bad), null, String(bad));
  }
  assert.equal(parseCatalogTapId(`cat:${C}:p:${'9'.repeat(5)}`), null);
});

test('uppercase uuids parse to lowercase', () => {
  assert.equal(parseCatalogTapId(`cat:${C.toUpperCase()}:order`).collectionId, C);
});

test('every catalogue id is a system tap (an active booking session never consumes it) and fits Meta\'s 256 limit', () => {
  for (const id of [MENU_ID, pageId(C, 99), collectionOrderId(C), itemOrderId(I)]) {
    assert.equal(isSystemTapId(id), true, id);
    assert.ok(id.length <= 256);
    assert.ok(id.startsWith(PREFIX));
  }
  // flow edge ids and booking ids are not
  assert.equal(isSystemTapId(C), false);
  assert.equal(isSystemTapId(`${C}:3`), false);
});
