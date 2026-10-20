// Run: node --test src/utils/flowSpec.unicode.test.js
// FlowSpec keyword checks (minimum length, duplicates, overlap warnings) with the legacy normalizer
// (default) and the Unicode one ({ unicode: true }, a business whose unicode_matching flag is on).
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateFlowSpec, compileFlowSpec } = require('./flowSpec');

const spec = (faqKeywords) => ({
  version: 1,
  greeting: { text: 'Welcome! How can we help you today?' },
  menu: [
    { id: 'timings', title: 'Timings', action: { type: 'faq', faqId: 'f0' } },
    { id: 'fees', title: 'Fees', action: { type: 'faq', faqId: 'f1' } }
  ],
  faqs: faqKeywords.map((keyword, i) => ({ id: `f${i}`, keyword, answer: `Answer ${i}`, backToMenu: true }))
});

test('legacy: a native-script keyword normalizes to empty and is rejected as too short', () => {
  assert.match(validateFlowSpec(spec(['खुलने का समय', 'परामर्श शुल्क'])), /at least/);
});

test('unicode: distinct native keywords are accepted', () => {
  assert.equal(validateFlowSpec(spec(['खुलने का समय', 'परामर्श शुल्क']), { unicode: true }), null);
  assert.equal(validateFlowSpec(spec(['ખુલવાનો સમય', 'સલાહ ફી']), { unicode: true }), null);
});

test('unicode: two native keywords that normalize alike are duplicates, even with ZWJ / danda / case differences', () => {
  assert.match(validateFlowSpec(spec(['मेनू', 'मे‍नू']), { unicode: true }), /duplicates/);
  assert.match(validateFlowSpec(spec(['मेनू', 'मेनू।']), { unicode: true }), /duplicates/);
});

test('unicode: native keywords no longer falsely collide with each other', () => {
  assert.equal(validateFlowSpec(spec(['मेनू', 'मदद करो']), { unicode: true }), null);
});

test('ASCII specs validate and compile identically in both modes', () => {
  const s = spec(['opening hours', 'consultation fee']);
  assert.equal(validateFlowSpec(s), null);
  assert.equal(validateFlowSpec(s, { unicode: true }), null);
  assert.deepEqual(compileFlowSpec(s), compileFlowSpec(s, { unicode: true }));
  assert.match(validateFlowSpec(spec(['opening hours', 'Opening Hours!'])), /duplicates/);
  assert.match(validateFlowSpec(spec(['opening hours', 'Opening Hours!']), { unicode: true }), /duplicates/);
});
