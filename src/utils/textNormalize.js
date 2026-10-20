// Keyword/message normalization for the reply matcher (chatbot.service.js#matchNodeInList) and
// the FlowSpec duplicate-keyword checks (flowSpec.js / flowSpecV2.js).
//
// Two normalizers live side by side while Unicode matching is rolled out per business:
//   normalizeLegacy   the original: JS \w is ASCII-only, so every Indic letter AND vowel sign is
//                     stripped and a native-script message normalizes to ''. Kept byte-for-byte
//                     (including the trim-before-strip quirk: "hi !" -> "hi ") so shadow mode can
//                     compare against exactly what is live.
//   normalizeUnicode  NFC, lowercase, invisible chars removed, Indic digits -> 0-9, then keeps
//                     letters + marks + digits + '_' (the legacy \w kept '_'), collapses
//                     whitespace and trims AFTER stripping.

const normalizeLegacy = (text) => {
  if (!text) return '';
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ');
};

// Code point of the digit ZERO of every decimal-digit block we map (\p{Nd} blocks are contiguous
// runs of ten). Arabic-Indic and Extended Arabic-Indic (Urdu) and fullwidth are included on top of
// the nine Indian scripts.
const DIGIT_ZEROS = [
  0x0660, 0x06F0, // Arabic-Indic, Extended (Urdu / Sindhi)
  0x0966, // Devanagari
  0x09E6, // Bengali
  0x0A66, // Gurmukhi
  0x0AE6, // Gujarati
  0x0B66, // Odia
  0x0BE6, // Tamil
  0x0C66, // Telugu
  0x0CE6, // Kannada
  0x0D66, // Malayalam
  0xFF10 // Fullwidth
];

// Code point ranges removed before matching: soft hyphen, zero-width space/joiners and bidi marks,
// bidi embeddings, word joiner, bidi isolates, BOM.
const INVISIBLE_RANGES = [[0xAD, 0xAD], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2060], [0x2066, 0x2069], [0xFEFF, 0xFEFF]];
const INVISIBLES = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => String.fromCodePoint(a) + (b > a ? '-' + String.fromCodePoint(b) : '')).join('')}]`, 'g');

const mapDigits = (text) => text.replace(/\p{Nd}/gu, (ch) => {
  const cp = ch.codePointAt(0);
  const zero = DIGIT_ZEROS.find(z => cp >= z && cp <= z + 9);
  return zero === undefined ? ch : String(cp - zero);
});

const normalizeUnicode = (text) => {
  if (!text) return '';
  return mapDigits(String(text).normalize('NFC').toLowerCase().replace(INVISIBLES, ''))
    .replace(/[^\p{L}\p{M}\p{N}\s_]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
};

/** True when the text has a non-ASCII letter/mark (a native-script keyword or message). */
const hasNonAsciiLetter = (text) => /[\p{L}\p{M}]/u.test((text || '').replace(/\p{ASCII}/gu, ''));

/** True when the raw message mixes ASCII letters with non-ASCII letters ("hi भाई"). */
const isMixedScript = (text) => /[a-z]/i.test(text || '') && hasNonAsciiLetter(text);

/** The message with every non-ASCII character blanked: "hi भाई" -> "hi". Normalized with the unicode rules. */
const asciiProjection = (text) => normalizeUnicode((text || '').replace(/[^\p{ASCII}]/gu, ' '));

/** Levenshtein distance over code points (not UTF-16 units). */
const codePointDistance = (a, b) => {
  const x = Array.from(a);
  const y = Array.from(b);
  if (x.length === 0) return y.length;
  if (y.length === 0) return x.length;
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= y.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
};

/**
 * Fuzzy threshold for a keyword that contains non-ASCII letters, by code-point length. Indic words
 * are short in code points and one wrong vowel sign can change the word, so: fuzzy OFF below 6
 * code points (returns -1), 1 edit up to 9, 2 edits from 10.
 */
const nativeFuzzyThreshold = (codePointLength) => {
  if (codePointLength < 6) return -1;
  if (codePointLength <= 9) return 1;
  return 2;
};

/**
 * Index of `needle` inside `haystack` where the match does not stop in the middle of a grapheme
 * (the next character is not a combining mark), at or after `from`; -1 if none. Stops "क" from
 * matching inside "की".
 */
const indexOfAtBoundary = (haystack, needle, from = 0) => {
  let i = haystack.indexOf(needle, from);
  while (i !== -1) {
    const next = haystack.codePointAt(i + needle.length);
    if (next === undefined || !/\p{M}/u.test(String.fromCodePoint(next))) return i;
    i = haystack.indexOf(needle, i + 1);
  }
  return -1;
};

module.exports = {
  normalizeLegacy,
  normalizeUnicode,
  hasNonAsciiLetter,
  isMixedScript,
  asciiProjection,
  codePointDistance,
  nativeFuzzyThreshold,
  indexOfAtBoundary
};
