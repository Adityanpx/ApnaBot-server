// The route_picker node's choices, as pure functions over the business's quotable routes.
//
//   routes   [{ id, fromCity, toCity, fromLabel, toLabel, region, sortOrder }] - active routes that
//            have an active fare for the chosen trip type (travelQuote.service#listQuotableRoutes)
//   state    { stage: 'from' | 'region' | 'to', from, region, offset } - kept in the booking session
//
// Flow: From (skipped when there is only one) -> To. A To list of more than 9 destinations is grouped
// by region first, then cities; a long list is paged. Every list ends with "Other route".
//
// WhatsApp lists hold 10 rows. "Other route" always takes one, so a page shows up to 9 items, or 8
// items + "More..." when there are further pages (8 + More + Other = 10).
const { LIMITS } = require('./flowSpec');

const ROW_MAX = LIMITS.LIST_ROW_TITLE; // 24
const ITEMS_LAST_PAGE = 9;
const ITEMS_PAGE_WITH_MORE = 8;
const NO_REGION = '__none__'; // routes with no region, shown as "Other places"

const initcap = (key) => String(key || '').replace(/\b\w/g, (c) => c.toUpperCase());
const clip = (text) => String(text).slice(0, ROW_MAX);
const cityLabel = (label, key) => clip((label && String(label).trim()) || initcap(key));
const byOrder = (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.label).localeCompare(String(b.label));

/** Distinct From cities, in the routes' sort order. */
const fromCities = (routes) => {
  const seen = new Map();
  for (const r of routes) {
    if (!seen.has(r.fromCity)) seen.set(r.fromCity, { value: `from:${r.fromCity}`, label: cityLabel(r.fromLabel, r.fromCity), sortOrder: r.sortOrder });
  }
  return [...seen.values()].sort(byOrder);
};

const destinationsFrom = (routes, from) => routes.filter((r) => r.fromCity === from);

const regionKey = (route) => (route.region && route.region.trim() ? route.region.trim() : NO_REGION);

const cityItems = (routes) => routes
  .map((r) => ({ value: `to:${r.id}`, label: cityLabel(r.toLabel, r.toCity), sortOrder: r.sortOrder }))
  .sort(byOrder);

/** Distinct regions of `routes` as list items, first-seen by sort order. */
const regionItems = (routes, text) => {
  const seen = new Map();
  for (const r of [...routes].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))) {
    const key = regionKey(r);
    if (!seen.has(key)) {
      seen.set(key, key === NO_REGION
        ? { value: `region:${NO_REGION}`, label: text.otherPlaces.en, labelTranslations: text.otherPlaces.translations }
        : { value: `region:${key}`, label: clip(key) });
    }
  }
  return [...seen.values()];
};

/** The page of `items` starting at `offset`, plus the "More..." and "Other route" rows. */
const pageRows = (items, offset, text) => {
  const remaining = items.slice(offset);
  const hasMore = remaining.length > ITEMS_LAST_PAGE;
  const shown = remaining.slice(0, hasMore ? ITEMS_PAGE_WITH_MORE : ITEMS_LAST_PAGE);
  const rows = shown.map(({ value, label, labelTranslations }) => ({ value, label, ...(labelTranslations ? { labelTranslations } : {}) }));
  if (hasMore) rows.push({ value: 'more', label: text.more.en, labelTranslations: text.more.translations });
  rows.push({ value: 'other', label: text.other.en, labelTranslations: text.other.translations });
  return rows;
};

/**
 * What to ask next. Normalises the state (a single From is chosen for the customer, a To list that
 * fits is not grouped).
 * @param {Object} text  { more, other, otherPlaces } each { en, translations: { hi, mr } }
 * @returns {{ state: Object, promptKey: string, rows: Object[] } | { state: Object, empty: true } | { state: Object, route: Object }}
 */
const view = (routes, state, text) => {
  let s = { stage: 'from', from: null, region: null, offset: 0, ...(state || {}) };

  if (s.stage === 'from') {
    const froms = fromCities(routes);
    if (froms.length === 0) return { state: s, empty: true };
    if (froms.length > 1) return { state: s, promptKey: 'routePickerFromPrompt', rows: pageRows(froms, s.offset, text) };
    s = { stage: 'to', from: froms[0].value.slice('from:'.length), region: null, offset: 0 };
  }

  const dests = destinationsFrom(routes, s.from);
  if (dests.length === 0) return { state: s, empty: true };

  if (s.stage === 'to' && s.region === null && dests.length > ITEMS_LAST_PAGE) {
    const regions = regionItems(dests, text);
    if (regions.length > 1) s = { ...s, stage: 'region', offset: 0 };
  }
  if (s.stage === 'region') {
    return { state: s, promptKey: 'routePickerRegionPrompt', rows: pageRows(regionItems(dests, text), s.offset, text) };
  }
  const inRegion = s.region === null ? dests : dests.filter((r) => regionKey(r) === s.region);
  return { state: s, promptKey: 'routePickerToPrompt', rows: pageRows(cityItems(inRegion), s.offset, text) };
};

/**
 * Applies a tapped / typed row.
 * @returns {{ state: Object } | { route: Object } | { other: true } | { invalid: true }}
 */
const choose = (routes, state, value, text) => {
  const current = view(routes, state, text);
  if (current.empty || current.route) return { invalid: true };
  const s = current.state;
  if (!current.rows.some((row) => row.value === value)) return { invalid: true };

  if (value === 'other') return { other: true };
  if (value === 'more') return { state: { ...s, offset: s.offset + ITEMS_PAGE_WITH_MORE } };
  if (value.startsWith('from:')) return { state: { stage: 'to', from: value.slice('from:'.length), region: null, offset: 0 } };
  if (value.startsWith('region:')) return { state: { stage: 'to', from: s.from, region: value.slice('region:'.length), offset: 0 } };
  if (value.startsWith('to:')) {
    const route = routes.find((r) => r.id === value.slice('to:'.length));
    return route ? { route } : { invalid: true };
  }
  return { invalid: true };
};

module.exports = { ITEMS_LAST_PAGE, ITEMS_PAGE_WITH_MORE, NO_REGION, view, choose };
