// src/scripts/exportSystemMessagesForReview.js
//
// Builds the native-speaker review sheets for the system messages (utils/systemMessages.js) and
// the built-in "Choose your language" line, for the 8 languages that have no reviewed text yet:
// gu kn ta te ml bn pa or. One file per language:
//   docs/translations-review/system-messages-<lang>.csv
//   columns: key, english, machine_translation, reviewed_translation (empty), notes
// The machine translation is a starting point for the reviewer only; nothing here reaches a
// customer. Only the reviewed_translation column is ever imported
// (scripts/importReviewedSystemMessages.js).
//
// Translation goes through services/translation.service.js with scope 'system' (placeholders and
// *bold* protected as in the translate endpoint; cached pairs are free; only the GLOBAL monthly
// Azure counter moves, no business is charged).
//
// Dry-run by default: prints how many messages and characters it would send to Azure and writes
// nothing. Pass --confirm to translate and write the CSVs. Optional: --lang=gu,ta to limit it.
// The CSVs are overwritten, so export BEFORE a reviewer starts filling one in.
//
// Usage:
//   node src/scripts/exportSystemMessagesForReview.js            (dry run)
//   node src/scripts/exportSystemMessagesForReview.js --confirm   (translates + writes)

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { SYSTEM_MESSAGES, BUILT_IN_MESSAGES } = require('../utils/systemMessages');
const { REVIEW_LANGUAGES, buildCsv, exportNotes } = require('../utils/systemMessagesReview');

const CONFIRM = process.argv.includes('--confirm');
const OUT_DIR = path.join(__dirname, '..', '..', 'docs', 'translations-review');

/** [{ key, english }] - every SYSTEM_MESSAGES key, then the built-in lines. */
const collectEntries = () => [
  ...Object.entries(SYSTEM_MESSAGES).map(([key, entry]) => ({ key, english: entry.en })),
  ...Object.entries(BUILT_IN_MESSAGES).map(([key, english]) => ({ key, english }))
];

/** CSV rows for one language from the entries and the aligned translations / warnings. */
const buildRows = (entries, translated, problems) => entries.map((e, i) => ({
  key: e.key,
  english: e.english,
  machine_translation: translated[i] || '',
  reviewed_translation: '',
  notes: exportNotes(e.english, translated[i] ? null : (problems.get(i) || 'not translated'))
}));

const selectedLanguages = () => {
  const arg = process.argv.find((a) => a.startsWith('--lang='));
  if (!arg) return REVIEW_LANGUAGES;
  const wanted = arg.slice('--lang='.length).split(',').map((s) => s.trim()).filter(Boolean);
  const bad = wanted.filter((l) => !REVIEW_LANGUAGES.includes(l));
  if (bad.length) throw new Error(`--lang must be from: ${REVIEW_LANGUAGES.join(' ')} (got ${bad.join(',')})`);
  return wanted;
};

async function main() {
  const langs = selectedLanguages();
  const entries = collectEntries();
  const chars = entries.reduce((sum, e) => sum + e.english.length, 0);
  console.log(`${entries.length} messages (${Object.keys(SYSTEM_MESSAGES).length} system + ${Object.keys(BUILT_IN_MESSAGES).length} built-in), ${chars} characters each.`);
  console.log(`Languages: ${langs.join(' ')}  ->  up to ${chars * langs.length} Azure characters (cached pairs are free), global cap only.`);

  if (!CONFIRM) {
    console.log(`Dry run - nothing translated or written. Would write ${langs.map((l) => `system-messages-${l}.csv`).join(', ')} to docs/translations-review/. Re-run with --confirm.`);
    return;
  }

  const { translateTexts } = require('../services/translation.service'); // loads Supabase: only needed to translate
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const texts = entries.map((e) => e.english);
  for (const lang of langs) {
    const { translations, warnings, charged, cacheHits } = await translateTexts({ businessId: null, texts, to: [lang], scope: 'system' });
    const problems = new Map(warnings.filter((w) => w.language === lang).map((w) => [w.index, w.reason]));
    const file = path.join(OUT_DIR, `system-messages-${lang}.csv`);
    fs.writeFileSync(file, '﻿' + buildCsv(buildRows(entries, translations[lang], problems))); // BOM so Excel reads UTF-8
    console.log(`  ${lang}: ${entries.length - problems.size}/${entries.length} machine-translated (${charged} chars charged, ${cacheHits} cache hits) -> ${path.relative(process.cwd(), file)}`);
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => { console.error('Export failed:', err); process.exit(1); });
}

module.exports = { collectEntries, buildRows };
