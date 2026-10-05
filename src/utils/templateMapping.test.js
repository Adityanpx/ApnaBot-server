// Run: node --test src/utils/templateMapping.test.js
// What a stored template needs filled, and the shared mapping count check.
const test = require('node:test');
const assert = require('node:assert/strict');
const { requiredParams, buttonsOf, splitMapping, checkParamCounts } = require('./templateMapping');

const full = {
  header_type: 'TEXT',
  meta_components: [
    { type: 'HEADER', format: 'TEXT', text: 'Hello {{1}}' },
    { type: 'BODY', text: 'Pay {{1}} for {{2}}' },
    { type: 'BUTTONS', buttons: [
      { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+91' },
      { type: 'URL', text: 'Pay', url: 'https://x.com/{{1}}' },
      { type: 'URL', text: 'Terms', url: 'https://x.com/terms' }
    ] }
  ]
};

test('requiredParams counts header variable, body variables and dynamic URL buttons from stored components', () => {
  assert.deepEqual(requiredParams(full), { body: 2, header: 1, buttons: [1] });
  assert.deepEqual(requiredParams({ header_type: 'NONE', body_text: 'Hi {{1}} {{1}}' }), { body: 1, header: 0, buttons: [] });
  assert.deepEqual(requiredParams({ header_type: 'IMAGE', body_text: 'Hi' }), { body: 0, header: 0, buttons: [] });
  assert.deepEqual(buttonsOf(full).map(b => [b.index, b.type, b.dynamic]), [[0, 'PHONE_NUMBER', false], [1, 'URL', true], [2, 'URL', false]]);
});

test('splitMapping groups by target; no target means body', () => {
  const parts = splitMapping([{ source: 'static' }, { target: 'header', source: 'static' }, { target: 'button', buttonIndex: 1 }, { target: 'nope' }]);
  assert.deepEqual([parts.body.length, parts.header.length, parts.button.length, parts.unknown.length], [1, 1, 1, 1]);
  assert.deepEqual(splitMapping(null).body, []);
});

const good = [
  { position: 1, source: 'customer.name' }, { position: 2, source: 'static', value: 'x' },
  { target: 'header', source: 'customer.name' },
  { target: 'button', buttonIndex: 1, source: 'static', value: 'abc' }
];

test('checkParamCounts: a complete mapping passes', () => {
  assert.equal(checkParamCounts(good, full), null);
});

test('checkParamCounts: missing or extra header / button entries, wrong buttonIndex, duplicates', () => {
  assert.match(checkParamCounts(good.filter(e => e.target !== 'header'), full), /header has a variable/);
  assert.match(checkParamCounts(good.filter(e => e.target !== 'button'), full), /URL button 1/);
  assert.match(checkParamCounts([...good, { target: 'button', buttonIndex: 1, source: 'static', value: 'y' }], full), /more than one/);
  assert.match(checkParamCounts(good.map(e => (e.target === 'button' ? { ...e, buttonIndex: 2 } : e)), full), /not a URL button with a variable/);
  assert.match(checkParamCounts(good.map(e => (e.target === 'button' ? { ...e, buttonIndex: '1' } : e)), full), /not a URL button with a variable/);
  assert.match(checkParamCounts([...good.slice(0, 2), { target: 'header', source: 'static', value: 'x' }], { header_type: 'NONE', body_text: 'a {{1}} {{2}}' }), /no header variable/);
  assert.match(checkParamCounts([{ target: 'sideways', source: 'static' }], full), /target must be one of/);
});

test('checkParamCounts: body entries are counted only when asked', () => {
  const noBody = good.filter(e => e.target);
  assert.match(checkParamCounts(noBody, full), /2 body variable/);
  assert.equal(checkParamCounts(noBody, full, { checkBody: false }), null);
});

test('a body-only template with an all-body mapping is never an error here (old behaviour)', () => {
  const tpl = { header_type: 'NONE', body_text: 'Hi {{1}}' };
  assert.equal(checkParamCounts([{ position: 1, source: 'customer.name' }], tpl), null);
  assert.equal(checkParamCounts(null, { header_type: 'NONE', body_text: 'Hi' }), null);
});
