// src/scripts/recomputeSendSupport.js
//
// message_templates.send_support is stored when a template is synced, created
// or given header media, and only recomputed then. When the rules in
// utils/templateSendSupport.js change (e.g. QUICK_REPLY became sendable), rows
// stored as 'unsupported_component' keep blocking sends until their next sync.
// This recomputes the column for every template (or one business's) from the
// rules as they are now.
//
// Default is a DRY RUN: prints each row whose stored value differs from the
// recomputed one and writes nothing. --confirm applies it, row by row, only
// where the stored value is still what the dry run saw (a row changed
// meanwhile is left alone).
//
// Usage:
//   node src/scripts/recomputeSendSupport.js [--business <businessId>]
//   node src/scripts/recomputeSendSupport.js [--business <businessId>] --confirm
//
// Requires .env with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (see src/config/env.js).

require('dotenv').config();
const supabase = require('../config/supabase');
const { computeSendSupport } = require('../utils/templateSendSupport');

const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
};

const PAGE = 500;

async function loadTemplates(businessId) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let query = supabase.from('message_templates')
      .select('id, business_id, name, language, status, send_support, meta_components, header_type, body_text, header_media_url, header_image_url')
      .order('id').range(from, from + PAGE - 1);
    if (businessId) query = query.eq('business_id', businessId);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

async function main() {
  const businessId = argValue('--business');
  const confirm = process.argv.includes('--confirm');
  console.log(confirm ? 'Mode: --confirm (WRITING)' : 'Mode: dry run (nothing is written; pass --confirm to apply)');
  console.log(businessId ? `Scope: business ${businessId}\n` : 'Scope: every business\n');

  const rows = await loadTemplates(businessId);
  const changes = rows
    .map((row) => ({ row, next: computeSendSupport(row) }))
    .filter(({ row, next }) => row.send_support !== next);

  for (const { row, next } of changes) {
    console.log(`${row.business_id}  ${row.name} [${row.language}] ${row.status}: ${row.send_support} -> ${next}`);
  }
  console.log(`\n${rows.length} template(s) checked, ${changes.length} would change.`);
  if (!confirm || changes.length === 0) process.exit(0);

  let written = 0;
  let skipped = 0;
  for (const { row, next } of changes) {
    const { data, error } = await supabase.from('message_templates')
      .update({ send_support: next }).eq('id', row.id).eq('send_support', row.send_support).select('id');
    if (error) throw error;
    if (data.length === 1) written += 1; else skipped += 1;
  }
  console.log(`Wrote send_support for ${written} template(s)${skipped ? `; ${skipped} changed meanwhile and were left alone` : ''}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
