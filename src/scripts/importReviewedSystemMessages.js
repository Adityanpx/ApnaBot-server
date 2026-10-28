// src/scripts/importReviewedSystemMessages.js
//
// Turns a native-reviewed CSV (from exportSystemMessagesForReview.js) into the static module
// src/i18n/systemMessages.<lang>.js that utils/systemMessages.js loads.
//
//  - Only the reviewed_translation column is used; rows with it empty are skipped (the machine
//    translation is NEVER imported).
//  - A row is rejected when its key is unknown, repeated, or its {{placeholders}} differ from the
//    English; formatting differences (bold, line breaks, emoji) are only warned about.
//  - Keys already in the existing file but not in this CSV are kept, so reviews can be imported in
//    batches. Keys with no reviewed text keep falling back to English at send time.
//
// Dry-run by default: prints what would change in the file and writes nothing. --confirm writes it.
// The language comes from the file name (system-messages-<lang>.csv).
//
// Usage:
//   node src/scripts/importReviewedSystemMessages.js docs/translations-review/system-messages-gu.csv
//   node src/scripts/importReviewedSystemMessages.js docs/translations-review/system-messages-gu.csv --confirm
//   node src/scripts/importReviewedSystemMessages.js docs/translations-review/system-messages-gu.csv --source=machine --confirm

const fs = require('fs');
const path = require('path');
const { SYSTEM_MESSAGES, BUILT_IN_MESSAGES } = require('../utils/systemMessages');
const { REVIEW_LANGUAGES, parseCsv, validateReviewed, buildLangModule } = require('../utils/systemMessagesReview');

const CONFIRM = process.argv.includes('--confirm');
// --source=machine imports the machine_translation column into src/i18n/systemMessages.<lang>.machine.js
// (an interim fallback a reviewed key always overrides); the default imports reviewed_translation.
const SOURCE = process.argv.includes('--source=machine') ? 'machine' : 'reviewed';
const SOURCE_COLUMN = SOURCE === 'machine' ? 'machine_translation' : 'reviewed_translation';
const I18N_DIR = path.join(__dirname, '..', 'i18n');

const englishByKey = () => ({
  ...Object.fromEntries(Object.entries(SYSTEM_MESSAGES).map(([key, entry]) => [key, entry.en])),
  ...BUILT_IN_MESSAGES
});

/** 'system-messages-gu.csv' -> 'gu' (null when the name or language is not one of the 8). */
const languageFromFileName = (file) => {
  const m = /^system-messages-([a-z]{2})\.csv$/i.exec(path.basename(file));
  return m && REVIEW_LANGUAGES.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
};

/** existing + accepted -> { merged, added, changed, unchanged } (accepted wins). */
const mergeMessages = (existing, accepted) => {
  const merged = { ...existing };
  const result = { added: [], changed: [], unchanged: [] };
  for (const [key, text] of Object.entries(accepted)) {
    if (!(key in existing)) result.added.push(key);
    else if (existing[key] !== text) result.changed.push(key);
    else result.unchanged.push(key);
    merged[key] = text;
  }
  return { merged, ...result };
};

async function main() {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!file) throw new Error('Usage: node src/scripts/importReviewedSystemMessages.js <system-messages-xx.csv> [--confirm]');
  const lang = languageFromFileName(file);
  if (!lang) throw new Error(`File name must be system-messages-<${REVIEW_LANGUAGES.join('|')}>.csv`);

  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const english = englishByKey();
  const { accepted, rejected, warnings, skippedEmpty } = validateReviewed(rows, english, SOURCE_COLUMN);

  const target = path.join(I18N_DIR, SOURCE === 'machine' ? `systemMessages.${lang}.machine.js` : `systemMessages.${lang}.js`);
  let existing = {};
  if (fs.existsSync(target)) existing = require(target);
  const { merged, added, changed, unchanged } = mergeMessages(existing, accepted);

  console.log(`${lang}: ${rows.length} rows - ${Object.keys(accepted).length} ${SOURCE} and valid, ${skippedEmpty} empty (skipped), ${rejected.length} rejected.`);
  for (const r of rejected) console.log(`  REJECTED ${r.key}: ${r.reason}`);
  for (const w of warnings) console.log(`  warning  ${w.key}: ${w.reason}`);
  console.log(`File ${path.relative(process.cwd(), target)}: ${added.length} added, ${changed.length} changed, ${unchanged.length} unchanged, ${Object.keys(existing).length - changed.length - unchanged.length} kept from the existing file.`);
  console.log(`Messages with no ${SOURCE} text in this file: ${Object.keys(english).length - Object.keys(merged).length}`);

  if (rejected.length) console.log('Fix the rejected rows in the CSV and re-run to include them.');
  if (!CONFIRM) {
    console.log('Dry run - nothing written. Re-run with --confirm to write the file.');
    return;
  }
  if (Object.keys(accepted).length === 0) {
    console.log(`Nothing ${SOURCE} to write.`);
    return;
  }
  fs.mkdirSync(I18N_DIR, { recursive: true });
  fs.writeFileSync(target, buildLangModule(lang, merged, Object.keys(english), SOURCE));
  console.log('Written.');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => { console.error('Import failed:', err.message); process.exit(1); });
}

module.exports = { languageFromFileName, mergeMessages, englishByKey };
