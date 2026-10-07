// Customer filters shared by the Customers list / ids (customer.controller.js)
// and the 'segment' broadcast audience (broadcastAudience.service.js), so the
// two read the same words the same way.

const PIPELINE_STAGES = ['new', 'contacted', 'converted', 'lost'];
const MAX_TAG_FILTER = 20;
const MAX_TAG_LENGTH = 100;

/**
 * A list of tags → { tags } (trimmed, de-duplicated, empties dropped) or { error }.
 * `label` names the field in the message ('tags', 'audienceParams.tags').
 */
const normalizeTags = (input, label = 'tags') => {
  if (!Array.isArray(input) || !input.every(t => typeof t === 'string')) return { error: `${label} must be a list of tags` };
  const tags = [...new Set(input.map(t => t.trim()).filter(Boolean))];
  if (tags.length > MAX_TAG_FILTER) return { error: `${label} can list at most ${MAX_TAG_FILTER} tags` };
  if (tags.some(t => t.length > MAX_TAG_LENGTH)) return { error: `A tag in ${label} is longer than ${MAX_TAG_LENGTH} characters` };
  return { tags };
};

/**
 * ?tags= of the list / ids endpoints → { tags } or { error }. Repeat the
 * parameter (?tags=a&tags=b) or comma-separate one value (?tags=a,b); a tag
 * that itself contains a comma needs the repeated form. Match is ANY, exact.
 */
const parseTagsParam = (raw) => {
  if (raw === undefined || raw === null || raw === '') return { tags: [] };
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : null);
  return normalizeTags(list, 'tags');
};

/**
 * One PostgREST or() condition: the customer's tags (a jsonb array) contain
 * this exact tag (jsonb @>). The JSON is double-quoted for PostgREST, so a
 * tag may contain commas, quotes or parentheses.
 */
const tagContainsCondition = (tag) => {
  const json = JSON.stringify([tag]);
  return `tags.cs."${json.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

/** query restricted to customers having ANY of `tags` (a no-op for an empty list). */
const applyTagsAny = (query, tags) => (tags && tags.length > 0
  ? query.or(tags.map(tagContainsCondition).join(','))
  : query);

module.exports = { PIPELINE_STAGES, MAX_TAG_FILTER, MAX_TAG_LENGTH, normalizeTags, parseTagsParam, tagContainsCondition, applyTagsAny };
