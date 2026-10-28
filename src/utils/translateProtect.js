// Keeps WhatsApp formatting and {{placeholders}} intact through a machine translation. Pure.
//
// Method: the text becomes a small HTML fragment (Azure Translator's textType=html leaves tags
// alone and moves them with the words they wrap), and is converted back afterwards:
//   {{name}}        -> <span class="notranslate">{{name}}</span>   (Azure does not translate it)
//   *bold*          -> <b>bold</b>        _italic_ -> <i>italic</i>
//   line break      -> <br>
//   & < >           -> escaped
// Placeholders are lifted out first (private-use sentinels), so the underscores inside
// {{customer_name}} can never be read as italic and the other markers never cut through one.
// restore() undoes it; isFaithful() then checks the result still has the same placeholders,
// bold/italic spans, line breaks and emojis as the source - a translation that lost any of them
// is dropped by the caller (the field falls back to English at send time) rather than stored.
const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g;
const SENTINEL_OPEN = '';
const SENTINEL_CLOSE = '';
const SENTINEL_RE = /(\d+)/g;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeHtml = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

const placeholdersOf = (text) => (String(text || '').match(PLACEHOLDER_RE) || []);
const countOf = (text, re) => (String(text || '').match(re) || []).length;
const sortedKey = (arr) => [...arr].sort().join('\u0000');

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Source text -> the HTML fragment to send to Azure.
 * @param {string} text
 * @param {Object} [options]
 * @param {string[]} [options.terms] whole words (case-sensitive) to leave untranslated, e.g. 'WhatsApp', 'menu'
 */
const protect = (text, { terms } = {}) => {
  const placeholders = [];
  // A bold term (*menu*) is lifted out whole, like a placeholder: inside <b> Azure moves the tag over the
  // neighbouring word ("*menuSend*"), which would change the word the customer is told to type.
  const liftRe = terms && terms.length
    ? new RegExp(`${PLACEHOLDER_RE.source}|\\*(?:${terms.map(escapeRegExp).join('|')})\\*`, 'g')
    : PLACEHOLDER_RE;
  let s = String(text).replace(liftRe, (m) => {
    placeholders.push(m);
    return `${SENTINEL_OPEN}${placeholders.length - 1}${SENTINEL_CLOSE}`;
  });
  s = escapeHtml(s);
  s = s.replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
  // _italic_ only at word edges, so snake_case words and URLs are left alone.
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,!?;:)])/g, '$1<i>$2</i>');
  s = s.replace(/\r?\n/g, '<br>');
  if (terms && terms.length) {
    // Before the placeholder spans go in, so a term inside {{...}} is never wrapped twice.
    const termRe = new RegExp(`(?<![\\p{L}\\p{N}_])(${terms.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
    s = s.replace(termRe, '<span class="notranslate">$1</span>');
  }
  s = s.replace(SENTINEL_RE, (_, i) => `<span class="notranslate">${escapeHtml(placeholders[Number(i)])}</span>`);
  return s;
};

/**
 * Puts a space between a protected term (optionally in *bold*) and a directly attached letter of another
 * script, which Azure leaves when the term sits inside a sentence it rebuilt ("WhatsAppપર", "STOPજવાબ").
 */
const padTerms = (text, terms) => {
  if (!terms || !terms.length) return text;
  // ASCII word edges here (not \p{L}): the neighbour we are looking for is a letter of another script.
  const termRe = new RegExp(`\\*?(?<![A-Za-z0-9_])(?:${terms.map(escapeRegExp).join('|')})(?![A-Za-z0-9_])\\*?`, 'gu');
  const isOtherScriptLetter = (ch) => !!ch && /[\p{L}\p{M}]/u.test(ch) && !/[A-Za-z]/.test(ch);
  return String(text).replace(termRe, (m, offset, str) => {
    const before = str[offset - 1];
    const after = str[offset + m.length];
    return `${isOtherScriptLetter(before) ? ' ' : ''}${m}${isOtherScriptLetter(after) ? ' ' : ''}`;
  });
};

/**
 * A space between a placeholder and a directly attached letter ("{{business}}તરફથી" -> "{{business}} તરફથી"),
 * and between a letter and a following placeholder. For machine-translated system messages, where Azure
 * glues the notranslate span to the neighbouring word.
 */
const spaceAroundPlaceholders = (text) => String(text)
  .replace(/\}\}(?=[\p{L}\p{M}])/gu, '}} ')
  .replace(/([\p{L}\p{M}])(?=\{\{)/gu, '$1 ');

/** Azure's HTML answer -> WhatsApp text. */
const restore = (html) => {
  let s = String(html);
  s = s.replace(/<span[^>]*notranslate[^>]*>([\s\S]*?)<\/span>/gi, (_, inner) => unescapeHtml(inner.replace(/<[^>]+>/g, '')));
  // Bold/italic: WhatsApp only formats when the markers touch the words, so inner padding goes.
  s = s.replace(/<b>\s*([\s\S]*?)\s*<\/b>/gi, '*$1*');
  s = s.replace(/<i>\s*([\s\S]*?)\s*<\/i>/gi, '_$1_');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  return unescapeHtml(s).trim();
};

/**
 * Does `translated` keep everything `source` had that must survive? Same placeholders (as a
 * multiset), same number of bold and italic spans, same number of line breaks, same emojis.
 * @returns {string|null} why not, or null when faithful
 */
const isFaithful = (source, translated) => {
  if (typeof translated !== 'string' || !translated.trim()) return 'Empty translation.';
  if (sortedKey(placeholdersOf(source)) !== sortedKey(placeholdersOf(translated))) return 'Placeholder mismatch.';
  // Swap each placeholder for a plain letter before counting markers: its underscores ("{{customer_name}}")
  // cannot look like italic, and bold that wraps only a placeholder ("*{{code}}*") still counts as a span.
  const bare = (t) => String(t || '').replace(PLACEHOLDER_RE, 'x');
  if (countOf(bare(source), /\*[^*\n]+\*/g) !== countOf(bare(translated), /\*[^*\n]+\*/g)) return 'Bold formatting lost.';
  if (countOf(bare(source), /(^|[\s(])_[^_\n]+_(?=$|[\s.,!?;:)])/g) !== countOf(bare(translated), /(^|[\s(])_[^_\n]+_(?=$|[\s.,!?;:)])/g)) return 'Italic formatting lost.';
  if (countOf(source, /\n/g) !== countOf(translated, /\n/g)) return 'Line breaks changed.';
  if (sortedKey(String(source).match(EMOJI_RE) || []) !== sortedKey(String(translated).match(EMOJI_RE) || [])) return 'Emoji changed.';
  return null;
};

module.exports = { protect, restore, padTerms, spaceAroundPlaceholders, isFaithful, placeholdersOf };
