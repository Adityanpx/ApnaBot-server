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

/** Source text -> the HTML fragment to send to Azure. */
const protect = (text) => {
  const placeholders = [];
  let s = String(text).replace(PLACEHOLDER_RE, (m) => {
    placeholders.push(m);
    return `${SENTINEL_OPEN}${placeholders.length - 1}${SENTINEL_CLOSE}`;
  });
  s = escapeHtml(s);
  s = s.replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
  // _italic_ only at word edges, so snake_case words and URLs are left alone.
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,!?;:)])/g, '$1<i>$2</i>');
  s = s.replace(/\r?\n/g, '<br>');
  s = s.replace(SENTINEL_RE, (_, i) => `<span class="notranslate">${escapeHtml(placeholders[Number(i)])}</span>`);
  return s;
};

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
  // Strip placeholders before counting markers, so {{customer_name}} cannot look like italic.
  const bare = (t) => String(t || '').replace(PLACEHOLDER_RE, '');
  if (countOf(bare(source), /\*[^*\n]+\*/g) !== countOf(bare(translated), /\*[^*\n]+\*/g)) return 'Bold formatting lost.';
  if (countOf(bare(source), /(^|[\s(])_[^_\n]+_(?=$|[\s.,!?;:)])/g) !== countOf(bare(translated), /(^|[\s(])_[^_\n]+_(?=$|[\s.,!?;:)])/g)) return 'Italic formatting lost.';
  if (countOf(source, /\n/g) !== countOf(translated, /\n/g)) return 'Line breaks changed.';
  if (sortedKey(String(source).match(EMOJI_RE) || []) !== sortedKey(String(translated).match(EMOJI_RE) || [])) return 'Emoji changed.';
  return null;
};

module.exports = { protect, restore, isFaithful, placeholdersOf };
