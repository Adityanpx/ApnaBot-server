// "The customer is asking for a person" - the keyword trigger of the human-needed alert.
// Whole-word / whole-phrase match on normalizeUnicode, independent of the per-business
// Unicode-matching flag (this is not the rule matcher), so a Devanagari phrase matches even for a
// business still on the legacy matcher. Pure: no I/O.
const { normalizeUnicode } = require('./textNormalize');

// A longer message falls through to normal rule matching: "can you talk to me about the 6 seater
// price" is a question, not a request for a person.
const HANDOFF_MAX_WORDS = 6;

const tokens = (text) => {
  const normalized = normalizeUnicode(text);
  return normalized ? normalized.split(' ') : [];
};

// True when `phrase` appears in `words` as a run of whole words.
const containsPhrase = (words, phrase) => {
  if (phrase.length === 0 || phrase.length > words.length) return false;
  for (let start = 0; start + phrase.length <= words.length; start += 1) {
    if (phrase.every((word, offset) => words[start + offset] === word)) return true;
  }
  return false;
};

/**
 * @param {string} text the customer's typed message
 * @param {string[]} keywords phrases ("talk to", "बात करनी है"); non-strings and blanks are ignored
 * @returns {boolean} true when the message has at most HANDOFF_MAX_WORDS words and holds one of them as whole words
 */
const asksForPerson = (text, keywords) => {
  const words = tokens(text);
  if (words.length === 0 || words.length > HANDOFF_MAX_WORDS) return false;
  return (keywords || []).some((keyword) => typeof keyword === 'string' && containsPhrase(words, tokens(keyword)));
};

module.exports = { HANDOFF_MAX_WORDS, asksForPerson };
