// Run: node --test src/utils/textLimits.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { LIMITS, textLength, truncate, edgeLabelLimit, validateEdgeCopy, validateButtonText } = require('./textLimits');

test('limits come from flowSpec LIMITS, plus the list button label', () => {
  assert.equal(LIMITS.LIST_ROW_TITLE, 24);
  assert.equal(LIMITS.BUTTON_TITLE, 20);
  assert.equal(LIMITS.LIST_ROW_DESCRIPTION, 72);
  assert.equal(LIMITS.LIST_BUTTON_LABEL, 20);
});

test('textLength is the trimmed UTF-16 length', () => {
  assert.equal(textLength('  abc  '), 3);
  assert.equal(textLength('😀'), 2);
  assert.equal(textLength(null), 0);
});

test('truncate leaves short text alone and tolerates non-strings', () => {
  assert.equal(truncate('Choose', 20), 'Choose');
  assert.equal(truncate(undefined, 20), '');
  assert.equal(truncate(null, 20), '');
});

test('truncate cuts plain text at the limit', () => {
  assert.equal(truncate('a'.repeat(30), 24), 'a'.repeat(24));
});

test('truncate never splits a surrogate pair at the cut', () => {
  const out = truncate(`${'a'.repeat(23)}😀tail`, 24);
  assert.equal(out, 'a'.repeat(23));
  assert.ok(!/[\ud800-\udbff]$/.test(out));
});

test('truncate keeps an emoji that fits exactly', () => {
  assert.equal(truncate(`${'a'.repeat(22)}😀tail`, 24), `${'a'.repeat(22)}😀`);
});

test('truncate does not cut inside a multi-code-point grapheme', () => {
  const family = '👨‍👩‍👧';
  assert.equal(truncate(`${'a'.repeat(10)}${family}`, 15), 'a'.repeat(10));
});

test('truncate falls back to code points when one grapheme exceeds the limit', () => {
  assert.equal(truncate('👨‍👩‍👧', 4), '👨');
});

test('edgeLabelLimit: 24 for a list, 20 for buttons, none otherwise', () => {
  assert.equal(edgeLabelLimit('reply', 'list'), 24);
  assert.equal(edgeLabelLimit('reply', 'buttons'), 20);
  assert.equal(edgeLabelLimit('reply', 'text'), null);
  assert.equal(edgeLabelLimit('question', 'list'), null);
});

const list = { parentNodeType: 'reply', parentContentType: 'list' };
const buttons = { parentNodeType: 'reply', parentContentType: 'buttons' };

test('new edge: label over the list limit is rejected, naming field and limit', () => {
  assert.equal(validateEdgeCopy({ ...list, label: 'x'.repeat(25) }, null), 'label must be 24 characters or less.');
});

test('new edge: label limit is 20 under a buttons parent', () => {
  assert.equal(validateEdgeCopy({ ...buttons, label: 'x'.repeat(20) }, null), null);
  assert.equal(validateEdgeCopy({ ...buttons, label: 'x'.repeat(21) }, null), 'label must be 20 characters or less.');
});

test('label length is the trimmed length', () => {
  assert.equal(validateEdgeCopy({ ...list, label: `  ${'x'.repeat(24)}  ` }, null), null);
});

test('description limit is 72, and applies under a buttons parent too', () => {
  assert.equal(validateEdgeCopy({ ...buttons, description: 'd'.repeat(72) }, null), null);
  assert.equal(validateEdgeCopy({ ...buttons, description: 'd'.repeat(73) }, null), 'description must be 72 characters or less.');
  assert.equal(validateEdgeCopy({ ...list, description: 'd'.repeat(73) }, null), 'description must be 72 characters or less.');
});

test('translation values are limited per value, using the label or description limit', () => {
  assert.equal(
    validateEdgeCopy({ ...list, labelTranslations: { hi: 'x'.repeat(25) } }, null),
    'labelTranslations for language "hi" must be 24 characters or less.'
  );
  assert.equal(
    validateEdgeCopy({ ...list, descriptionTranslations: { mr: 'd'.repeat(73) } }, null),
    'descriptionTranslations for language "mr" must be 72 characters or less.'
  );
});

test('prefix is prepended to the field name', () => {
  assert.equal(validateEdgeCopy({ ...list, label: 'x'.repeat(25) }, null, 'edges[3].'), 'edges[3].label must be 24 characters or less.');
});

test('non-string label or description is rejected', () => {
  assert.equal(validateEdgeCopy({ ...list, label: 42 }, null), 'label must be a string.');
  assert.equal(validateEdgeCopy({ ...list, description: {} }, null), 'description must be a string.');
});

test('null and undefined are not checked (clearing is allowed)', () => {
  assert.equal(validateEdgeCopy({ ...list, label: null, description: null, labelTranslations: null }, null), null);
  assert.equal(validateEdgeCopy({ ...list }, null), null);
});

test('a parent that is not a list or buttons reply has no label limit', () => {
  assert.equal(validateEdgeCopy({ parentNodeType: 'reply', parentContentType: 'text', label: 'x'.repeat(100) }, null), null);
  assert.equal(validateEdgeCopy({ parentNodeType: 'question', parentContentType: 'list', label: 'x'.repeat(100) }, null), null);
});

test('legacy over-limit values that are unchanged still pass', () => {
  const stored = {
    label: 'L'.repeat(40), description: 'D'.repeat(90),
    label_translations: { hi: 'H'.repeat(40) }, description_translations: { hi: 'D'.repeat(90) }
  };
  const err = validateEdgeCopy({
    ...list,
    label: stored.label, description: stored.description,
    labelTranslations: stored.label_translations, descriptionTranslations: stored.description_translations
  }, stored);
  assert.equal(err, null);
});

test('a changed value on a legacy row is checked, an unchanged sibling is not', () => {
  const stored = { label: 'L'.repeat(40), description: 'ok', label_translations: { hi: 'H'.repeat(40) } };
  assert.equal(
    validateEdgeCopy({ ...list, label: stored.label, description: 'd'.repeat(73) }, stored),
    'description must be 72 characters or less.'
  );
  assert.equal(
    validateEdgeCopy({ ...list, labelTranslations: { hi: 'H'.repeat(40), mr: 'M'.repeat(30) } }, stored),
    'labelTranslations for language "mr" must be 24 characters or less.'
  );
  assert.equal(validateEdgeCopy({ ...list, label: 'L'.repeat(41) }, stored), 'label must be 24 characters or less.');
});

test('buttonText: 20 for new and changed values, legacy unchanged passes', () => {
  assert.equal(validateButtonText({ buttonText: 'b'.repeat(20) }, null), null);
  assert.equal(validateButtonText({ buttonText: 'b'.repeat(21) }, null), 'buttonText must be 20 characters or less.');
  assert.equal(
    validateButtonText({ buttonTextTranslations: { hi: 'b'.repeat(21) } }, null, 'replyNodes[1].'),
    'replyNodes[1].buttonTextTranslations for language "hi" must be 20 characters or less.'
  );
  const stored = { button_text: 'B'.repeat(30), button_text_translations: { hi: 'B'.repeat(30) } };
  assert.equal(validateButtonText({ buttonText: stored.button_text, buttonTextTranslations: stored.button_text_translations }, stored), null);
  assert.equal(validateButtonText({ buttonText: 'B'.repeat(31) }, stored), 'buttonText must be 20 characters or less.');
});

test('buttonText: empty string is fine', () => {
  assert.equal(validateButtonText({ buttonText: '', buttonTextTranslations: null }, null), null);
});
