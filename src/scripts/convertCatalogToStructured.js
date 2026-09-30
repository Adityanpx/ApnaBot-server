// src/scripts/convertCatalogToStructured.js
//
// One-time move of course_catalog entries (Super Admin's course suggestions)
// from their free-text `details` to the structured fields added by
// 20260930140000_course_structured_details.sql, so businesses that add a
// catalog course get Age / Duration / Fees filled in (with any ____ blanks
// kept for them to complete):
//
//   first line            → dropped (the page now starts with the bold course name)
//   "… Age: X"            → age_group
//   "… Duration: X"       → duration
//   "… Fees: X"           → fees
//   every other line      → more_details (in order)
//
// Mode stays empty (each institute sets its own). `details` is left as it
// was. Only entries with details and NO structured field set yet are
// touched, so re-running is harmless. business_courses rows are NOT touched
// — owners switch their own courses over in the course editor.
//
// Default is a DRY RUN: prints each entry's result. Pass --confirm to write.
//
// Usage: node src/scripts/convertCatalogToStructured.js [--confirm]

require('dotenv').config();
const supabase = require('../config/supabase');
const { coursePageText, validateCourseFields } = require('../utils/courseValidation');

const FIELD_LINES = [
  { column: 'age_group', key: 'ageGroup', pattern: /^\s*\S*\s*Age:\s*(.+)$/i },
  { column: 'duration', key: 'duration', pattern: /^\s*\S*\s*Duration:\s*(.+)$/i },
  { column: 'fees', key: 'fees', pattern: /^\s*\S*\s*Fees:\s*(.+)$/i }
];

/** details text → { age_group?, duration?, fees?, more_details? } */
const parseDetails = (details) => {
  const lines = details.split('\n').map(l => l.trim()).filter(Boolean).slice(1);
  const out = {};
  const rest = [];
  for (const line of lines) {
    const field = FIELD_LINES.find(f => !out[f.column] && f.pattern.test(line));
    if (field) out[field.column] = line.match(field.pattern)[1].trim();
    else rest.push(line);
  }
  if (rest.length > 0) out.more_details = rest.join('\n');
  return out;
};

const main = async () => {
  const confirm = process.argv.includes('--confirm');
  const { data: rows, error } = await supabase
    .from('course_catalog')
    .select('id, category, name, description, details, age_group, duration, fees, mode, more_details')
    .order('category').order('order').order('name');
  if (error) throw error;

  const todo = rows.filter(r => r.details && r.details.trim() &&
    !r.age_group && !r.duration && !r.fees && !r.mode && !r.more_details);
  console.log(`Mode: ${confirm ? 'CONFIRM — will update' : 'DRY RUN — nothing will be written'}`);
  console.log(`${rows.length} catalog entries, ${todo.length} to convert (details set, no structured fields yet)\n`);

  const updates = [];
  for (const r of todo) {
    const columns = parseDetails(r.details);
    const asApi = { name: r.name, ageGroup: columns.age_group, duration: columns.duration, fees: columns.fees, moreDetails: columns.more_details };
    const invalid = validateCourseFields(asApi);
    const page = coursePageText({ name: r.name, description: r.description, ...asApi });
    console.log(`--- ${r.category} / ${r.name}${invalid ? `   ✗ SKIPPED: ${invalid}` : ''}`);
    console.log(`    ${JSON.stringify(columns)}`);
    console.log(`    page (${page.length} chars):\n      ${page.replace(/\n/g, '\n      ')}\n`);
    if (!invalid) updates.push({ id: r.id, name: r.name, columns });
  }

  if (!confirm || updates.length === 0) {
    if (!confirm) console.log('Dry run only. Re-run with --confirm to write.');
    return;
  }
  for (const u of updates) {
    // Guarded on "still unconverted" so a concurrent Super Admin edit isn't overwritten.
    const { data, error: updErr } = await supabase.from('course_catalog').update(u.columns)
      .eq('id', u.id).is('age_group', null).is('duration', null).is('fees', null).is('more_details', null)
      .select('id');
    if (updErr) throw updErr;
    console.log(`${data.length ? 'updated' : 'skipped (changed meanwhile)'}: ${u.name}`);
  }
};

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => { console.error('convertCatalogToStructured failed:', err); process.exit(2); });
}

module.exports = { parseDetails };
