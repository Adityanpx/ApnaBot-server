// src/scripts/exportSystemMessagesForReview.js
//
// Builds the native-speaker review sheets for the system messages (utils/systemMessages.js) and
// the built-in "Choose your language" line, for the 8 languages that have no reviewed text yet:
// gu kn ta te ml bn pa or. One file per language:
//   docs/translations-review/system-messages-<lang>.csv
//   columns: key, english, machine_translation, reviewed_translation (empty), notes
// The machine translation is a starting point for the reviewer. By default only the
// reviewed_translation column is imported (scripts/importReviewedSystemMessages.js); with
// --source=machine the machine column becomes src/i18n/systemMessages.<lang>.machine.js, an interim
// fallback that any reviewed key overrides.
//
// Translation goes through services/translation.service.js with scope 'system' (placeholders and
// *bold* protected as in the translate endpoint, plus PROTECTED_TERMS: ApnaBot, WhatsApp, menu, STOP...
// stay as typed; the shared cache is bypassed; only the GLOBAL monthly Azure counter moves, no
// business is charged). A rate limit is retried up to 5 times with a growing wait; each language's
// CSV is written before the next language starts.
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
const { REVIEW_LANGUAGES, PROTECTED_TERMS, buildCsv, parseCsv, exportNotes, checkProtectedTerms } = require('../utils/systemMessagesReview');
const { spaceAroundPlaceholders } = require('../utils/translateProtect');

// Azure's rate limit comes back from azureTranslate.service as a 503 (TRANSLATE_UNAVAILABLE): wait and retry.
const MAX_ATTEMPTS = 5;
const RETRY_WAIT_MS = [20000, 40000, 60000, 90000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** --keys=a,b: translate only these keys (see below), or null for every message. */
const selectedKeys = (allEntries) => {
  const arg = process.argv.find((a) => a.startsWith('--keys='));
  if (!arg) return null;
  const wanted = arg.slice('--keys='.length).split(',').map((s) => s.trim()).filter(Boolean);
  const known = new Set(allEntries.map((e) => e.key));
  const bad = wanted.filter((k) => !known.has(k));
  if (bad.length) throw new Error(`--keys has unknown key(s): ${bad.join(', ')}`);
  return new Set(wanted);
};

const csvPath = (lang) => path.join(OUT_DIR, `system-messages-${lang}.csv`);
const readExistingRows = (lang) => (fs.existsSync(csvPath(lang)) ? parseCsv(fs.readFileSync(csvPath(lang), 'utf8')) : []);

async function main() {
  const langs = selectedLanguages();
  const allEntries = collectEntries();
  const onlyKeys = selectedKeys(allEntries);
  // With --keys the existing CSV is kept: only the listed keys that have no machine text yet are translated
  // and merged in, so hand-corrected rows and reviewer input are never overwritten. Without it the CSV is rebuilt.
  const todoFor = (lang) => {
    if (!onlyKeys) return allEntries;
    const done = new Set(readExistingRows(lang).filter((r) => r.machine_translation).map((r) => r.key));
    return allEntries.filter((e) => onlyKeys.has(e.key) && !done.has(e.key));
  };
  const chars = allEntries.reduce((sum, e) => sum + e.english.length, 0);
  console.log(`${allEntries.length} messages (${Object.keys(SYSTEM_MESSAGES).length} system + ${Object.keys(BUILT_IN_MESSAGES).length} built-in), ${chars} characters each.`);
  const planned = langs.map((l) => [l, todoFor(l)]);
  const plannedChars = planned.reduce((sum, [, list]) => sum + list.reduce((s, e) => s + e.english.length, 0), 0);
  console.log(`Languages: ${langs.join(' ')}  ->  up to ${plannedChars} Azure characters${onlyKeys ? ` (only ${[...onlyKeys].join(', ')}, where missing)` : ''}, global cap only.`);

  if (!CONFIRM) {
    for (const [lang, list] of planned) console.log(`  ${lang}: ${list.length} message(s)${onlyKeys ? `: ${list.map((e) => e.key).join(', ')}` : ''}`);
    console.log(`Dry run - nothing translated or written. Would write ${langs.map((l) => `system-messages-${l}.csv`).join(', ')} to docs/translations-review/. Re-run with --confirm.`);
    return;
  }

  const { translateTexts } = require('../services/translation.service'); // loads Supabase: only needed to translate
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [lang, entries] of planned) {
    if (entries.length === 0) { console.log(`  ${lang}: nothing to translate`); continue; }
    const texts = entries.map((e) => e.english);
    let result;
    for (let attempt = 1; ; attempt += 1) {
      try {
        // protectTerms: keywords stay as typed, and the shared cache is bypassed (see translateTexts).
        result = await translateTexts({ businessId: null, texts, to: [lang], scope: 'system', protectTerms: PROTECTED_TERMS });
        break;
      } catch (error) {
        if (error.code !== 'TRANSLATE_UNAVAILABLE' || attempt >= MAX_ATTEMPTS) throw error;
        const wait = RETRY_WAIT_MS[attempt - 1];
        console.log(`  ${lang}: Azure unavailable or rate limited (attempt ${attempt}/${MAX_ATTEMPTS}), waiting ${wait / 1000}s`);
        await sleep(wait);
      }
    }
    const { translations, warnings, charged, cacheHits } = result;
    const problems = new Map(warnings.filter((w) => w.language === lang).map((w) => [w.index, w.reason]));
    // A protected word that Azure translated anyway is dropped (English fallback), never shipped.
    translations[lang] = translations[lang].map((text, i) => {
      const termProblem = text ? checkProtectedTerms(entries[i].english, text) : null;
      if (termProblem) problems.set(i, termProblem);
      return termProblem ? null : (text && spaceAroundPlaceholders(text));
    });
    let rows = buildRows(entries, translations[lang], problems);
    if (onlyKeys) {
      const fresh = new Map(rows.map((r) => [r.key, r]));
      const existing = new Map(readExistingRows(lang).map((r) => [r.key, r]));
      rows = allEntries.map((e) => fresh.get(e.key) || existing.get(e.key)
        || { key: e.key, english: e.english, machine_translation: '', reviewed_translation: '', notes: exportNotes(e.english, 'not translated') });
    }
    const file = csvPath(lang);
    fs.writeFileSync(file, '﻿' + buildCsv(rows)); // BOM so Excel reads UTF-8
    console.log(`  ${lang}: ${entries.length - problems.size}/${entries.length} machine-translated${problems.size ? ` (dropped: ${[...problems].map(([i, why]) => `${entries[i].key} - ${why}`).join('; ')})` : ''} (${charged} chars charged, ${cacheHits} cache hits) -> ${path.relative(process.cwd(), file)}`);
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => { console.error('Export failed:', err); process.exit(1); });
}

module.exports = { collectEntries, buildRows };
