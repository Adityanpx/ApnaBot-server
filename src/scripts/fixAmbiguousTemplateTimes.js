// src/scripts/fixAmbiguousTemplateTimes.js
//
// Adds AM/PM to opening-hours / batch-time text in the SuperAdmin category templates
// (flow_snapshots.nodes, is_category_template = true) where the range is ambiguous ("11-12",
// "Morning 7-9 · Evening 5-7"). Affects only businesses created / imported from a template AFTER
// this runs; no live business's own flow_nodes is touched (so Search cab AI, a LIVE production
// business, is out of reach).
//
// Dry-run by default (prints each change, writes nothing). --confirm executes.
//
// Usage:
//   node src/scripts/fixAmbiguousTemplateTimes.js
//   node src/scripts/fixAmbiguousTemplateTimes.js --confirm

require('dotenv').config();
const supabase = require('../config/supabase');

const CONFIRM = process.argv.includes('--confirm');

// Exact strings found in the templates on 2026-10-23 (coaching, general). Anything not listed is left alone.
const REPLACEMENTS = [
  ['Sat–Sun 11–12', 'Sat–Sun 11 am–12 pm'],
  ['Morning 7–9 · Evening 5–7', 'Morning 7–9 am · Evening 5–7 pm']
];

const main = async () => {
  const { data: templates, error } = await supabase
    .from('flow_snapshots').select('id, category, nodes').eq('is_category_template', true);
  if (error) throw error;

  let changed = 0;
  for (const template of templates || []) {
    let json = JSON.stringify(template.nodes);
    const applied = [];
    for (const [from, to] of REPLACEMENTS) {
      if (json.includes(from)) {
        json = json.split(from).join(to);
        applied.push(`"${from}" -> "${to}"`);
      }
    }
    if (applied.length === 0) continue;
    changed += 1;
    console.log(`${template.category} (${template.id}): ${applied.join('; ')}`);
    if (CONFIRM) {
      const { error: updateError } = await supabase
        .from('flow_snapshots').update({ nodes: JSON.parse(json) }).eq('id', template.id);
      if (updateError) throw updateError;
    }
  }
  console.log(CONFIRM ? `Updated ${changed} template(s).` : `Dry run: ${changed} template(s) would change. Re-run with --confirm.`);
  process.exit(0);
};

main().catch((err) => { console.error(err); process.exit(1); });
