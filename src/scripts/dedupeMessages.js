// src/scripts/dedupeMessages.js
//
// One-time cleanup before migration 20261005140000_messages_meta_message_id_unique.sql.
// The same WhatsApp message id was saved more than once for a business (the
// inbound webhook processed it twice). That unique index cannot be created
// while those rows exist.
//
// For each (business_id, meta_message_id) group with more than one row, keep
// ONE row: prefer type 'text' over 'unsupported' (an earlier failed-type save
// left the 'unsupported' copies), then the newest created_at. The rest are
// deleted. A group is skipped (and reported) if any row that would be deleted
// is still referenced by followup_sends.message_id - the only foreign key to
// messages(id) in the migrations - so nothing is detached silently.
//
// Dry-run by default (prints every row to keep / delete, message text is
// truncated; writes nothing). Pass --confirm to delete.
//
// Usage:
//   node src/scripts/dedupeMessages.js            (dry run)
//   node src/scripts/dedupeMessages.js --confirm   (executes)

require('dotenv').config();

const supabase = require('../config/supabase');

const CONFIRM = process.argv.includes('--confirm');
const PAGE = 1000;

const fetchAllWithMetaId = async () => {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('messages')
      .select('id, business_id, customer_id, meta_message_id, direction, type, content, status, sender_type, created_at')
      .not('meta_message_id', 'is', null)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
};

// Anything that is not the 'unsupported' fallback first, then newest.
const keepOrder = (a, b) => {
  const au = a.type === 'unsupported' ? 1 : 0;
  const bu = b.type === 'unsupported' ? 1 : 0;
  if (au !== bu) return au - bu;
  return new Date(b.created_at) - new Date(a.created_at);
};

const describe = (r) =>
  `${r.id} ${r.created_at} ${r.direction}/${r.type}/${r.status}/${r.sender_type} "${(r.content || '').slice(0, 25)}"`;

async function main() {
  const rows = await fetchAllWithMetaId();
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.business_id}|${r.meta_message_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const dupGroups = [...groups.entries()].filter(([, v]) => v.length > 1);
  console.log(`${CONFIRM ? 'EXECUTING' : 'DRY RUN'} - ${rows.length} rows with a meta_message_id, ${dupGroups.length} duplicate group(s)`);

  const toDelete = [];
  for (const [key, list] of dupGroups) {
    const sorted = [...list].sort(keepOrder);
    const keep = sorted[0];
    const drop = sorted.slice(1);

    const { data: refs, error } = await supabase.from('followup_sends').select('id, message_id').in('message_id', drop.map(r => r.id));
    if (error) throw error;
    console.log(`\n${key.split('|')[0].slice(0, 8)} ${keep.meta_message_id.slice(0, 24)}...`);
    console.log(`  KEEP   ${describe(keep)}`);
    drop.forEach(r => console.log(`  DELETE ${describe(r)}`));
    if (refs.length > 0) {
      console.log(`  SKIPPED - ${refs.length} followup_sends row(s) reference a row to delete`);
      continue;
    }
    toDelete.push(...drop.map(r => r.id));
  }

  console.log(`\n${toDelete.length} row(s) to delete`);
  if (!CONFIRM) {
    console.log('Dry run - nothing written. Re-run with --confirm to delete.');
    return;
  }
  for (let i = 0; i < toDelete.length; i += 100) {
    const { error } = await supabase.from('messages').delete().in('id', toDelete.slice(i, i + 100));
    if (error) throw error;
  }
  console.log(`Deleted ${toDelete.length} row(s).`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('dedupeMessages failed:', err);
  process.exit(1);
});
