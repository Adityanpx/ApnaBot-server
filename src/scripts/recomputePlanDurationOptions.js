// src/scripts/recomputePlanDurationOptions.js
//
// One-off: recompute plans.duration_options for every plan from plans.price (the
// monthly price) and each tier's stored discount % (defaults 10/20/30 for a missing
// tier), amounts rounded to the nearest rupee. Prints a before/after diff per plan.
//
// plans.price is NEVER written - only duration_options, so Basic's (or any plan's)
// price is untouched. The write is guarded on the price read here, so a plan edited
// in Super Admin while this runs is skipped rather than overwritten.
//
// Dry-run by default (prints what it would do, writes nothing). Pass --confirm to
// execute.
//
// Usage:
//   node src/scripts/recomputePlanDurationOptions.js            (dry run)
//   node src/scripts/recomputePlanDurationOptions.js --confirm   (executes)

require('dotenv').config();

const supabase = require('../config/supabase');
const { buildDurationOptions } = require('../utils/planFields');

const CONFIRM = process.argv.includes('--confirm');

const fmt = (t) => (t ? `${t.price} (${t.discount}% off, "${t.label}")` : '-');

const diffTiers = (before, after) => {
  const b = new Map((before || []).map(t => [t.months, t]));
  const a = new Map(after.map(t => [t.months, t]));
  const lines = [];
  for (const months of [...new Set([...b.keys(), ...a.keys()])].sort((x, y) => x - y)) {
    const from = b.get(months); const to = a.get(months);
    const same = from && to && JSON.stringify(from) === JSON.stringify(to);
    lines.push(`  ${same ? '  ' : '~ '}${String(months).padStart(2)}mo: ${fmt(from)}${same ? '' : `  ->  ${fmt(to)}`}`);
  }
  return lines;
};

async function main() {
  const { data: plans, error } = await supabase
    .from('plans').select('id, name, price, duration_options').order('name');
  if (error) throw error;

  let changed = 0;
  let skipped = 0;
  for (const plan of plans) {
    const price = Number(plan.price);
    console.log(`\nPlan "${plan.name}" (${plan.id}), price ${plan.price} (not modified)`);
    if (!Number.isFinite(price) || price < 0) {
      console.log('  SKIP: invalid price');
      skipped += 1;
      continue;
    }
    const after = buildDurationOptions(price, plan.duration_options);
    if (JSON.stringify(after) === JSON.stringify(plan.duration_options)) {
      console.log('  already consistent - nothing to do');
      continue;
    }
    diffTiers(plan.duration_options, after).forEach(l => console.log(l));
    changed += 1;
    if (CONFIRM) {
      const { data, error: upErr } = await supabase
        .from('plans').update({ duration_options: after })
        .eq('id', plan.id).eq('price', plan.price).select('id');
      if (upErr) throw upErr;
      if (!data || data.length === 0) {
        console.log('  SKIPPED: price changed since it was read');
        changed -= 1; skipped += 1;
      } else {
        console.log('  written');
      }
    }
  }

  console.log(`\n${CONFIRM ? 'Updated' : 'Would update'} ${changed} plan(s); skipped ${skipped}.`);
  if (!CONFIRM) console.log('Dry run only - pass --confirm to write.');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => { console.error('Recompute failed:', err); process.exit(1); });
}

module.exports = { main, diffTiers };
