// src/scripts/capBusinessLanguages.js
//
// One-time data fix after the language cap dropped from 4 to 3 (English + 2 more,
// utils/languageCatalog.js MAX_ENABLED_LANGUAGES). A business that was saved with 4 languages
// keeps working but could not be re-saved as-is; this trims it the same way PUT /api/business
// would: keep 'en' and the first 2 other languages in their current order, and reset
// customers.preferred_language to NULL for customers on a removed language (so they are asked
// again on their next message). Stored translations are never touched.
//
// Search cab AI is a LIVE production business: it is never written by this script, even with
// --confirm (it is skipped and reported). The dry run always prints its languages so you can
// see it is untouched.
//
// Dry-run by default (read-only: prints id, name, languages and what would change). Pass
// --confirm to execute.
//
// Usage:
//   node src/scripts/capBusinessLanguages.js            (dry run)
//   node src/scripts/capBusinessLanguages.js --confirm   (executes)

require('dotenv').config();

const supabase = require('../config/supabase');
const { MAX_ENABLED_LANGUAGES } = require('../utils/languageCatalog');

const CONFIRM = process.argv.includes('--confirm');
const LIVE_BUSINESS_NAME = /search\s*cab/i;

/** 'en' first, then the first MAX-1 others in current order. */
const capLanguages = (languages, max = MAX_ENABLED_LANGUAGES) => {
  const list = Array.isArray(languages) ? [...new Set(languages)] : [];
  const others = list.filter((code) => code !== 'en');
  const kept = ['en', ...others.slice(0, max - 1)];
  return { kept, removed: others.slice(max - 1), changed: list.length > max };
};

async function main() {
  const { data, error } = await supabase.from('businesses').select('id, name, display_name, enabled_languages');
  if (error) throw error;
  const rows = data || [];

  const live = rows.filter((b) => LIVE_BUSINESS_NAME.test(`${b.name || ''} ${b.display_name || ''}`));
  for (const b of live) {
    console.log(`LIVE business (never written): ${b.name} [${b.id}] languages ${(b.enabled_languages || []).join(',')} (${(b.enabled_languages || []).length}) - ${capLanguages(b.enabled_languages).changed ? 'WOULD BE TRIMMED but is skipped' : 'untouched'}`);
  }
  if (live.length === 0) console.log('No business matching "Search cab" found.');

  const over = rows.filter((b) => capLanguages(b.enabled_languages).changed);
  console.log(`\nBusinesses with more than ${MAX_ENABLED_LANGUAGES} enabled languages: ${over.length}`);

  const todo = [];
  for (const b of over) {
    const { kept, removed } = capLanguages(b.enabled_languages);
    const isLive = live.some((l) => l.id === b.id);
    console.log(`  ${b.name} [${b.id}]  ${b.enabled_languages.join(',')}  ->  ${kept.join(',')}  (removes ${removed.join(',')})${isLive ? '  SKIPPED (live)' : ''}`);
    if (!isLive) todo.push({ business: b, kept, removed });
  }

  if (todo.length === 0) {
    console.log('\nNothing to change.');
    return;
  }
  if (!CONFIRM) {
    console.log('\nDry run - nothing written. Re-run with --confirm to apply.');
    return;
  }

  const tenantService = require('../services/tenant.service'); // loads Redis: only needed to write
  for (const { business: b, kept, removed } of todo) {
    const { error: updateErr } = await supabase.from('businesses').update({ enabled_languages: kept }).eq('id', b.id);
    if (updateErr) throw updateErr;
    const { error: resetErr } = await supabase.from('customers')
      .update({ preferred_language: null }).eq('business_id', b.id).in('preferred_language', removed);
    if (resetErr) throw resetErr;
    try {
      const { data: full } = await supabase.from('businesses').select('phone_number_id').eq('id', b.id).single();
      if (full && full.phone_number_id) await tenantService.invalidateTenantCache(full.phone_number_id);
    } catch (cacheErr) {
      console.error(`  (tenant cache not cleared for ${b.name}: ${cacheErr.message} - it expires on its own)`);
    }
    console.log(`  done: ${b.name} -> ${kept.join(',')}`);
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => { console.error('Cap languages failed:', err); process.exit(1); });
}

module.exports = { capLanguages };
