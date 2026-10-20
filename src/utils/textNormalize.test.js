// Run: node --test src/utils/textNormalize.test.js
// The Unicode keyword normalizer next to the legacy one it replaces behind the unicode_matching flag.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeLegacy, normalizeUnicode, hasNonAsciiLetter, isMixedScript, asciiProjection,
  codePointDistance, nativeFuzzyThreshold, indexOfAtBoundary
} = require('./textNormalize');

// One everyday word per script ("menu" / "help"), to prove letters AND vowel signs survive.
const WORDS = {
  hi: 'मेनू', mr: 'मदत', gu: 'મેનુ', ta: 'மெனு', te: 'మెనూ',
  kn: 'ಮೆನು', ml: 'മെനു', bn: 'মেনু', pa: 'ਮੇਨੂ', or: 'ମେନୁ'
};

test('legacy normalizer is unchanged: native text is wiped, trailing space survives', () => {
  for (const word of Object.values(WORDS)) assert.equal(normalizeLegacy(word), '');
  assert.equal(normalizeLegacy('  Hello,  World!! '), 'hello world');
  assert.equal(normalizeLegacy('hi !'), 'hi ');
  assert.equal(normalizeLegacy('faq_a-b'), 'faq_ab');
  assert.equal(normalizeLegacy(null), '');
});

for (const [lang, word] of Object.entries(WORDS)) {
  test(`${lang}: letters and vowel signs (matras) are kept`, () => {
    assert.equal(normalizeUnicode(word), word);
    assert.equal(normalizeUnicode(`  ${word}!!  `), word);
    assert.equal(normalizeUnicode(`${word}।`), word);
    assert.equal(normalizeUnicode(`${word}॥`), word);
    assert.ok(hasNonAsciiLetter(word));
  });
}

test('NFC: composed and decomposed spellings normalize to the same text', () => {
  assert.equal(normalizeUnicode('क़'), normalizeUnicode('क़')); // क + nukta == क़
  assert.equal(normalizeUnicode('Café'), 'café');
});

test('ZWJ / ZWNJ / other invisible characters are removed', () => {
  assert.equal(normalizeUnicode('मे‍नू'), 'मेनू');
  assert.equal(normalizeUnicode('मे‌नू'), 'मेनू');
  assert.equal(normalizeUnicode('﻿hi​'), 'hi');
  assert.equal(normalizeUnicode('മെ‍നു'), 'മെനു');
});

test('Indic digits map to 0-9', () => {
  assert.equal(normalizeUnicode('०१२३४५६७८९'), '0123456789'); // Devanagari
  assert.equal(normalizeUnicode('૦૧૨'), '012'); // Gujarati
  assert.equal(normalizeUnicode('௦௧௨'), '012'); // Tamil
  assert.equal(normalizeUnicode('౦౧౨'), '012'); // Telugu
  assert.equal(normalizeUnicode('೦೧೨'), '012'); // Kannada
  assert.equal(normalizeUnicode('൦൧൨'), '012'); // Malayalam
  assert.equal(normalizeUnicode('০১২'), '012'); // Bengali
  assert.equal(normalizeUnicode('੦੧੨'), '012'); // Gurmukhi
  assert.equal(normalizeUnicode('୦୧୨'), '012'); // Odia
  assert.equal(normalizeUnicode('२'), '2');
  assert.equal(normalizeUnicode('option २'), 'option 2');
});

test('whitespace is collapsed and trimmed AFTER stripping (the trailing-space fix)', () => {
  assert.equal(normalizeUnicode('hi !'), 'hi');
  assert.equal(normalizeUnicode('  a \t\n b  '), 'a b');
  assert.equal(normalizeUnicode('hi 🙏'), 'hi');
});

test('underscore is kept, like the legacy \\w (tap-only keywords such as page_travels_info)', () => {
  assert.equal(normalizeUnicode('page_travels_info'), 'page_travels_info');
});

test('emoji-only and punctuation-only text normalize to empty', () => {
  assert.equal(normalizeUnicode('🙏'), '');
  assert.equal(normalizeUnicode('!!!'), '');
  assert.equal(normalizeUnicode(''), '');
  assert.equal(normalizeUnicode(undefined), '');
});

test('ASCII-only text: identical to legacy except the documented trailing/leading-space fix', () => {
  const samples = ['Hi', 'HELLO there', 'price?', 'faq-a', 'faq_a', 'book  a   cab', "what's your address", '123', 'a\tb', 'ok.'];
  for (const s of samples) assert.equal(normalizeUnicode(s), normalizeLegacy(s), s);
  for (const s of ['hi !', ' hi ! ', 'ok .']) assert.equal(normalizeUnicode(s), normalizeLegacy(s).trim(), s);
});

test('mixed-script detection and ASCII projection', () => {
  assert.ok(isMixedScript('hi भाई'));
  assert.ok(!isMixedScript('hi'));
  assert.ok(!isMixedScript('भाई'));
  assert.ok(!isMixedScript('hi 🙏'));
  assert.equal(asciiProjection('hi भाई'), 'hi');
  assert.equal(asciiProjection('मेनू book दो'), 'book');
});

test('code-point Levenshtein counts a combining sequence per code point, astral characters as one', () => {
  assert.equal(codePointDistance('मेनू', 'मेनु'), 1);
  assert.equal(codePointDistance('a😀b', 'acb'), 1); // UTF-16 length of 😀 is 2
  assert.equal(codePointDistance('', 'abc'), 3);
  assert.equal(codePointDistance('same', 'same'), 0);
});

test('native fuzzy thresholds: off below 6 code points, 1 up to 9, 2 from 10', () => {
  assert.equal(nativeFuzzyThreshold(4), -1);
  assert.equal(nativeFuzzyThreshold(5), -1);
  assert.equal(nativeFuzzyThreshold(6), 1);
  assert.equal(nativeFuzzyThreshold(9), 1);
  assert.equal(nativeFuzzyThreshold(10), 2);
});

test('indexOfAtBoundary refuses a match that stops before a vowel sign', () => {
  assert.equal(indexOfAtBoundary('की', 'क'), -1);
  assert.equal(indexOfAtBoundary('कि', 'क'), -1);
  assert.equal(indexOfAtBoundary('क ख', 'क'), 0);
  assert.equal(indexOfAtBoundary('कीक', 'क'), 2);
});
