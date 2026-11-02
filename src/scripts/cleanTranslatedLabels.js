// src/scripts/cleanTranslatedLabels.js
//
// One-time data fix for machine translations of short labels that came back with stray edges
// ("Pune" -> "पुणे ." in Marathi). The forward fix is utils/translateProtect.js#cleanShortLabel, applied
// in translateTexts; this cleans what was stored before it:
//   1. travel_routes: the From / To / Region translations that are STILL the machine's text (the
//      auto_translations hash matches the stored text). The hash is updated to the cleaned text so the
//      "auto" badge stays. A hand-edited text (hash mismatch, or no mark) is never touched.
//   2. translation_cache: rows whose text cleans differently, for the sources this script can identify
//      (the English texts of the routes above - the cache keeps only a hash of the source). They are
//      rewritten in place, no Azure call; rows whose source is unknown are listed and left alone.
//
// Search cab AI is a LIVE production business: its routes are never written, even with --confirm.
//
// Dry-run by default (read-only: lists every change). Pass --confirm to execute.
//
// Usage:
//   node src/scripts/cleanTranslatedLabels.js            (dry run)
//   node src/scripts/cleanTranslatedLabels.js --confirm   (executes)

require('dotenv').config();

const supabase = require('../config/supabase');
const { routeSlots, textHash, clone } = require('../utils/translationSlots');
const { cleanShortLabel } = require('../utils/translateProtect');
const { sha256 } = require('../services/translation.service');

const CONFIRM = process.argv.includes('--confirm');
const LIVE_BUSINESS_NAME = /search\s*cab/i;
const ROUTE_COLUMNS = ['from_label_translations', 'to_label_translations', 'region_translations', 'auto_translations'];

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Cleans the machine-made translations of one travel_routes row.
 * @returns {{ changes: {slot:string, lang:string, from:string, to:string}[], patch: Object }} patch = the columns to write ({} when nothing changes)
 */
const planRouteCleanup = (route) => {
  const row = clone(route);
  const changes = [];
  for (const slot of routeSlots(row)) {
    const marks = isObject(row.auto_translations) && isObject(row.auto_translations[slot.id]) ? row.auto_translations[slot.id] : {};
    for (const [lang, hash] of Object.entries(marks)) {
      const text = slot.get(lang);
      if (typeof text !== 'string' || text.trim() === '' || textHash(text) !== hash) continue; // hand-edited or gone: not ours
      const cleaned = cleanShortLabel(slot.source, text);
      if (cleaned === text) continue;
      slot.set(lang, cleaned);
      row.auto_translations = { ...row.auto_translations, [slot.id]: { ...row.auto_translations[slot.id], [lang]: textHash(cleaned) } };
      changes.push({ slot: slot.id, lang, from: text, to: cleaned });
    }
  }
  const patch = {};
  for (const column of ROUTE_COLUMNS) {
    if (JSON.stringify(row[column] ?? null) !== JSON.stringify(route[column] ?? null)) patch[column] = row[column] ?? null;
  }
  return { changes, patch };
};

/**
 * Which translation_cache rows would be rewritten. `sourceByHash` maps sha256(English text) -> English text.
 * @returns {{ rewrite: {source_hash:string, target_lang:string, source:string, from:string, to:string}[], unknown: Object[] }}
 */
const planCacheCleanup = (cacheRows, sourceByHash) => {
  const rewrite = [];
  const unknown = [];
  for (const row of cacheRows) {
    const source = sourceByHash.get(row.source_hash);
    if (source === undefined) {
      // A stray trailing "." / "।" with an unknown source: cannot tell whether the English had one.
      if (/[\s.।]$/.test(row.translated_text)) unknown.push(row);
      continue;
    }
    const to = cleanShortLabel(source, row.translated_text);
    if (to !== row.translated_text) rewrite.push({ source_hash: row.source_hash, target_lang: row.target_lang, source, from: row.translated_text, to });
  }
  return { rewrite, unknown };
};

async function main() {
  console.log(CONFIRM ? 'MODE: --confirm (writes)\n' : 'MODE: dry run (nothing is written)\n');

  const { data: businesses, error: bizErr } = await supabase.from('businesses').select('id, name, display_name');
  if (bizErr) throw bizErr;
  const nameOf = new Map((businesses || []).map((b) => [b.id, b.name]));
  const liveIds = new Set((businesses || []).filter((b) => LIVE_BUSINESS_NAME.test(`${b.name || ''} ${b.display_name || ''}`)).map((b) => b.id));

  const { data: routes, error: routeErr } = await supabase.from('travel_routes').select('*');
  if (routeErr) throw routeErr;

  const sourceByHash = new Map();
  const routeJobs = [];
  for (const route of routes || []) {
    for (const slot of routeSlots(route)) sourceByHash.set(sha256(slot.source), slot.source);
    const { changes, patch } = planRouteCleanup(route);
    if (changes.length === 0) continue;
    const live = liveIds.has(route.business_id);
    console.log(`${nameOf.get(route.business_id) || route.business_id}  ${route.from_city} > ${route.to_city}${live ? '   SKIPPED (live business)' : ''}`);
    for (const c of changes) console.log(`    ${c.slot} ${c.lang}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
    if (!live) routeJobs.push({ route, patch });
  }
  console.log(`\nRoute rows to update: ${routeJobs.length}`);

  const { data: cacheRows, error: cacheErr } = await supabase.from('translation_cache').select('source_hash, target_lang, translated_text')
    .or('translated_text.like.%.,translated_text.like.%।,translated_text.like.% ');
  if (cacheErr) throw cacheErr;
  const { rewrite, unknown } = planCacheCleanup(cacheRows || [], sourceByHash);
  console.log(`\ntranslation_cache rows to rewrite: ${rewrite.length}`);
  for (const r of rewrite) console.log(`    ${JSON.stringify(r.source)} ${r.target_lang}: ${JSON.stringify(r.from)} -> ${JSON.stringify(r.to)}`);
  if (unknown.length > 0) {
    console.log(`translation_cache rows with a trailing "." / "।" / space whose English source is unknown (left alone): ${unknown.length}`);
    for (const r of unknown) console.log(`    ${r.source_hash.slice(0, 12)} ${r.target_lang}: ${JSON.stringify(r.translated_text)}`);
  }

  if (routeJobs.length === 0 && rewrite.length === 0) {
    console.log('\nNothing to change.');
    return;
  }
  if (!CONFIRM) {
    console.log('\nDry run - nothing written. Re-run with --confirm to apply.');
    return;
  }

  for (const { route, patch } of routeJobs) {
    // Guarded on updated_at being what was read, so a save made meanwhile is not overwritten.
    const { data, error } = await supabase.from('travel_routes').update(patch).eq('id', route.id).eq('updated_at', route.updated_at).select('id');
    if (error) throw error;
    console.log(`  ${data && data.length ? 'done' : 'CHANGED MEANWHILE, skipped'}: ${route.from_city} > ${route.to_city}`);
  }
  for (const r of rewrite) {
    const { error } = await supabase.from('translation_cache').update({ translated_text: r.to }).eq('source_hash', r.source_hash).eq('target_lang', r.target_lang);
    if (error) throw error;
    console.log(`  cache done: ${r.source} ${r.target_lang}`);
  }

  const chatbotService = require('../services/chatbot.service'); // loads Redis: only needed to write
  for (const businessId of new Set(routeJobs.map((j) => j.route.business_id))) {
    try {
      await chatbotService.invalidateRulesCache(businessId);
    } catch (e) {
      console.error(`  (rules cache not cleared for ${nameOf.get(businessId)}: ${e.message} - it expires on its own)`);
    }
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => { console.error('Clean translated labels failed:', err); process.exit(1); });
}

module.exports = { planRouteCleanup, planCacheCleanup };
