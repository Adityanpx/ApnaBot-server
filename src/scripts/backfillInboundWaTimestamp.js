// src/scripts/backfillInboundWaTimestamp.js
//
// One-time data fix for messages.wa_timestamp (migration 20261030120000): sets it from
// raw_payload.timestamp (unix seconds, as Meta sent it) on existing INBOUND rows.
//
// Only rows that kept their raw payload can be filled - raw_payload is stored for inbound
// 'unsupported' rows alone, so ordinary text / media rows have nothing to read and keep
// wa_timestamp NULL (they order by created_at, as before). Never overwrites a wa_timestamp that
// is already set.
//
// Dry-run by default (prints counts, writes nothing). Pass --confirm to execute.
//
// Usage:
//   node src/scripts/backfillInboundWaTimestamp.js            (dry run)
//   node src/scripts/backfillInboundWaTimestamp.js --confirm   (executes)

require('dotenv').config();

const supabase = require('../config/supabase');
const { waTimestampOf } = require('../utils/inboundMessage');

const CONFIRM = process.argv.includes('--confirm');
const PAGE = 1000;
const UNDEFINED_COLUMN = '42703';

async function main() {
  // Is the migration applied? If not, a dry run still counts the candidates; --confirm refuses.
  const probe = await supabase.from('messages').select('wa_timestamp').limit(1);
  const columnExists = !probe.error;
  if (probe.error && probe.error.code !== UNDEFINED_COLUMN) throw probe.error;
  if (!columnExists) console.log('messages.wa_timestamp does not exist yet (migration 20261030120000 not applied).');
  if (!columnExists && CONFIRM) throw new Error('Apply the migration first; nothing written.');

  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from('messages')
      .select(columnExists ? 'id, raw_payload, wa_timestamp' : 'id, raw_payload')
      .eq('direction', 'inbound')
      .not('raw_payload', 'is', null);
    if (columnExists) q = q.is('wa_timestamp', null);
    const { data, error } = await q.order('id').range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  const fillable = [];
  let noTimestamp = 0;
  for (const r of rows) {
    const iso = waTimestampOf(r.raw_payload);
    if (iso) fillable.push({ id: r.id, iso }); else noTimestamp += 1;
  }
  console.log(`Inbound rows with a raw_payload${columnExists ? ' and no wa_timestamp' : ''}: ${rows.length}`);
  console.log(`  raw_payload.timestamp usable: ${fillable.length}`);
  console.log(`  raw_payload has no usable timestamp (left NULL): ${noTimestamp}`);

  if (!CONFIRM) {
    console.log('Dry run - nothing written. Re-run with --confirm to apply.');
    return;
  }

  let updated = 0;
  for (const { id, iso } of fillable) {
    // wa_timestamp IS NULL again in the WHERE: a row the webhook filled meanwhile is not overwritten.
    const { data, error } = await supabase.from('messages')
      .update({ wa_timestamp: iso }).eq('id', id).is('wa_timestamp', null).select('id');
    if (error) throw error;
    updated += (data || []).length;
  }
  console.log(`Set wa_timestamp on ${updated} rows.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Backfill failed:', err); process.exit(1); });
