// Run: node --test src/utils/catalogSettings.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SETTINGS, resolveSettings, mergeSettings, nodeWords } = require('./catalogSettings');

const NODE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ok = (patch, current = null) => { const r = mergeSettings(current, patch); assert.equal(r.error, undefined, r.error); return r.settings; };
const bad = (patch, current = null) => { const r = mergeSettings(current, patch); assert.ok(r.error, 'expected an error'); return r.error; };

test('defaults: off, "catalogue" keyword, 10 photos a page, plain style, no order action', () => {
  const s = resolveSettings(null);
  assert.deepEqual([s.enabled, s.keywords, s.aliases, s.photosPerPage, s.photoStyle, s.orderAction, s.addToMainMenu],
    [false, ['catalogue'], [], 10, 'plain', null, false]);
  assert.deepEqual(DEFAULT_SETTINGS.keywords, ['catalogue']);
  // the defaults object is not shared / mutated
  resolveSettings(null).keywords.push('x');
  assert.deepEqual(resolveSettings(null).keywords, ['catalogue']);
});

test('a stored value wins over the default, unknown stored keys are dropped', () => {
  const s = resolveSettings({ enabled: true, photosPerPage: 4, bogus: 1 });
  assert.equal(s.enabled, true);
  assert.equal(s.photosPerPage, 4);
  assert.equal('bogus' in s, false);
});

test('a patch merges into the current settings', () => {
  const first = ok({ enabled: true, text: ' Our sarees ', photoStyle: 'order_button' });
  assert.equal(first.text, 'Our sarees');
  const second = ok({ photosPerPage: 5 }, first);
  assert.deepEqual([second.enabled, second.text, second.photoStyle, second.photosPerPage], [true, 'Our sarees', 'order_button', 5]);
});

test('unknown keys and wrong types are refused', () => {
  assert.match(bad({ nope: 1 }), /Unknown setting "nope"/);
  assert.match(bad({ enabled: 'yes' }), /enabled/);
  assert.match(bad({ addToMainMenu: 1 }), /addToMainMenu/);
  assert.match(bad({ photosPerPage: 0 }), /1 to 10/);
  assert.match(bad({ photosPerPage: 11 }), /1 to 10/);
  assert.match(bad({ photosPerPage: 2.5 }), /1 to 10/);
  assert.match(bad({ photoStyle: 'grid' }), /photoStyle/);
  assert.match(bad('x'), /object/);
  assert.match(bad([]), /object/);
});

test('keywords: trimmed, lower-cased, 3-40 characters, at most 10, no duplicates, none reserved', () => {
  assert.deepEqual(ok({ keywords: ['  Catalogue ', 'PRODUCTS'] }).keywords, ['catalogue', 'products']);
  assert.match(bad({ keywords: [] }), /at least one keyword/);
  assert.match(bad({ keywords: ['ab'] }), /3 to 40/);
  assert.match(bad({ keywords: ['x'.repeat(41)] }), /3 to 40/);
  assert.match(bad({ keywords: ['catalogue', 'Catalogue'] }), /more than once/);
  assert.match(bad({ keywords: ['menu'] }), /already used for something else/);
  assert.match(bad({ keywords: ['hello'] }), /already used/);
  assert.match(bad({ keywords: Array.from({ length: 11 }, (_, i) => `word${i}x`) }), /at most 10/);
  assert.match(bad({ keywords: ['catalogue'], aliases: ['catalogue'] }), /both a keyword and an alias/);
  assert.match(bad({ keywords: ['!!!!'] }), /no letters or digits/);
  assert.match(bad({ keywords: 'catalogue' }), /array/);
});

test('native-script keywords are accepted (counted by characters, not bytes)', () => {
  const hindi = 'कैटलॉग';
  const alias = 'दिखाओ';
  const s = ok({ keywords: ['catalogue', hindi], aliases: [alias] });
  assert.deepEqual(s.keywords, ['catalogue', hindi]);
  assert.deepEqual(s.aliases, [alias]);
});

test('nodeWords: the first keyword is the node keyword, the other keywords and the aliases its aliases', () => {
  assert.deepEqual(nodeWords(ok({ keywords: ['catalogue', 'products'], aliases: ['collection'] })),
    { keyword: 'catalogue', hindiAliases: ['products', 'collection'] });
});

test('texts: <= 1024, labels <= 20, blank clears, translations validated', () => {
  assert.equal(ok({ text: '   ' }).text, null);
  assert.match(bad({ text: 'x'.repeat(1025) }), /1024/);
  assert.match(bad({ viewButtonLabel: 'x'.repeat(21) }), /20/);
  assert.match(bad({ menuLabel: 'x'.repeat(21) }), /20/);
  assert.match(bad({ orderButtonLabelTranslations: { hi: 'x'.repeat(21) } }), /20/);
  assert.match(bad({ textTranslations: { xx: 'hello' } }), /invalid language code/);
  assert.match(bad({ textTranslations: 'hi' }), /object/);
  assert.deepEqual(ok({ textTranslations: { hi: ' namaste ', mr: '  ' } }).textTranslations, { hi: 'namaste' });
  assert.equal(ok({ textTranslations: { hi: ' ' } }).textTranslations, null);
});

test('orderAction: null, message, booking_trigger / web_form_trigger with a node id', () => {
  assert.equal(ok({ orderAction: null }).orderAction, null);
  assert.deepEqual(ok({ orderAction: { type: 'booking_trigger', nodeId: NODE.toUpperCase() } }).orderAction, { type: 'booking_trigger', nodeId: NODE });
  assert.deepEqual(ok({ orderAction: { type: 'web_form_trigger', nodeId: NODE } }).orderAction, { type: 'web_form_trigger', nodeId: NODE });
  assert.deepEqual(ok({ orderAction: { type: 'message', text: ' Thanks ', textTranslations: { hi: 'dhanyavaad' } } }).orderAction,
    { type: 'message', text: 'Thanks', textTranslations: { hi: 'dhanyavaad' } });
  assert.deepEqual(ok({ orderAction: { type: 'message' } }).orderAction, { type: 'message', text: null, textTranslations: null });
  assert.match(bad({ orderAction: { type: 'booking_trigger' } }), /nodeId/);
  assert.match(bad({ orderAction: { type: 'booking_trigger', nodeId: 'x' } }), /nodeId/);
  assert.match(bad({ orderAction: { type: 'payment' } }), /one of/);
  assert.match(bad({ orderAction: 'message' }), /object or null/);
});
