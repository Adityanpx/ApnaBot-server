// src/scripts/seedCourseCatalog.js
//
// Pre-fills course_catalog (Super Admin's course suggestions, category
// 'coaching') with common courses. Businesses COPY entries into their own
// business_courses and edit them freely — the description/details here are
// only starting text; "____" marks what each institute must fill in.
//
// Default is a DRY RUN: prints what would be inserted and what already
// exists. Pass --confirm to insert. Idempotent: a course whose name already
// exists in the category (case-insensitive) is skipped, never updated.
//
// Usage: node src/scripts/seedCourseCatalog.js [--confirm]

require('dotenv').config();
const supabase = require('../config/supabase');

const CATEGORY = 'coaching';
const fees = '💰 Fees: ₹____';

const COURSES = [
  { name: 'Abacus', description: 'Mental maths for kids, age 6+', details: `🧮 Abacus classes\n👦 Age: 6 years and above\n📚 Levels: ____\n🕘 Duration: ____ per level\n${fees} per level` },
  { name: 'Vedic Maths', description: 'Fast calculation techniques, age 10+', details: `🔢 Vedic Maths classes\n👦 Age: 10 years and above\n📚 Levels: ____\n🕘 Duration: ____ per level\n${fees} per level` },
  { name: 'JEE Main + Advanced', description: 'Engineering entrance prep, 11th & 12th', details: `🎯 JEE Main + Advanced\n📚 Subjects: Physics, Chemistry, Maths\n🕘 Duration: ____\n📝 Regular tests & doubt sessions\n${fees}` },
  { name: 'MHT-CET', description: 'Maharashtra CET prep (PCM / PCB)', details: `🎯 MHT-CET preparation\n📚 Group: PCM / PCB\n🕘 Duration: ____\n📝 Mock tests included\n${fees}` },
  { name: 'NEET', description: 'Medical entrance prep, 11th & 12th', details: `🩺 NEET preparation\n📚 Subjects: Physics, Chemistry, Biology\n🕘 Duration: ____\n📝 Regular tests & doubt sessions\n${fees}` },
  { name: '11th Science', description: 'State board / CBSE, PCM & PCB', details: `📘 11th Science\n🏫 Board: ____\n📚 Subjects: ____\n🕘 Batch timings: ____\n${fees}` },
  { name: '12th Science', description: 'Board exam prep, PCM & PCB', details: `📘 12th Science\n🏫 Board: ____\n📚 Subjects: ____\n🕘 Batch timings: ____\n${fees}` },
  { name: '11th Commerce', description: 'Accounts, Economics, OC & more', details: `📗 11th Commerce\n🏫 Board: ____\n📚 Subjects: ____\n🕘 Batch timings: ____\n${fees}` },
  { name: '12th Commerce', description: 'Board exam prep for Commerce', details: `📗 12th Commerce\n🏫 Board: ____\n📚 Subjects: ____\n🕘 Batch timings: ____\n${fees}` },
  { name: 'Foundation (8th-10th)', description: 'Strong basics for school & entrance exams', details: `🧱 Foundation course (8th–10th)\n📚 Subjects: Maths, Science\n🕘 Batch timings: ____\n${fees}` },
  { name: 'Spoken English', description: 'Speak English with confidence', details: `🗣️ Spoken English\n👥 For: students & working people\n🕘 Duration: ____\n${fees}` },
  { name: 'Computer Basics', description: 'MS Office, typing & internet', details: `💻 Computer basics\n📚 Covers: MS Office, typing, internet\n🕘 Duration: ____\n${fees}` }
];

const main = async () => {
  const confirm = process.argv.includes('--confirm');
  for (const c of COURSES) {
    if (c.name.length > 24 || c.description.length > 72) throw new Error(`Seed data too long: ${c.name}`);
  }

  const { data: existing, error } = await supabase.from('course_catalog').select('name').eq('category', CATEGORY);
  if (error) throw error;
  const have = new Set((existing || []).map(r => r.name.trim().toLowerCase()));

  const toInsert = COURSES
    .map((c, i) => ({ category: CATEGORY, name: c.name, description: c.description, details: c.details, is_active: true, order: i }))
    .filter(c => !have.has(c.name.toLowerCase()));

  console.log(`Mode: ${confirm ? 'CONFIRM — will insert' : 'DRY RUN — nothing will be written'}`);
  console.log(`Category "${CATEGORY}": ${have.size} course(s) already in the catalog, ${toInsert.length} to add.\n`);
  for (const c of COURSES) {
    const skip = have.has(c.name.toLowerCase());
    console.log(`${skip ? 'SKIP (exists)' : 'ADD          '}  ${c.name.padEnd(24)} — ${c.description}`);
  }

  if (!confirm || toInsert.length === 0) {
    if (!confirm) console.log('\nDry run only. Re-run with --confirm to insert.');
    return;
  }
  const { error: insertErr } = await supabase.from('course_catalog').insert(toInsert);
  if (insertErr) throw insertErr;
  console.log(`\nInserted ${toInsert.length} course(s).`);
};

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('seedCourseCatalog failed:', err); process.exit(2); });
