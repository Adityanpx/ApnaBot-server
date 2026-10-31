// A free-text search box value → safe to interpolate into a PostgREST .or() filter string.
// Replaces the characters that end or restructure a filter with a space: comma (starts the next
// condition), parentheses (grouping), '%' and '*' (wildcards - the caller adds its own),
// backslash (escape), quotes and backtick, and ':' (cast / JSON operators). Whitespace is
// collapsed. Returns '' when nothing usable is left (or the value is not a string, e.g. ?search=a&search=b).
const sanitizeSearchTerm = (raw) => {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[,()%*\\":'`]/g, ' ').replace(/\s+/g, ' ').trim();
};

module.exports = { sanitizeSearchTerm };
