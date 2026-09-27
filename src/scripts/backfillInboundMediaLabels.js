// src/scripts/backfillInboundMediaLabels.js
//
// One-time data fix for inbound media messages saved before
// webhook.controller.js started storing a placeholder label (2026-09-28):
// photos, documents and audio were saved with empty content and show as
// blank bubbles in the inbox. Sets the same labels inboundMediaLabel() now
// writes for new messages. The files themselves were never stored and
// can't be recovered (Meta media ids weren't kept), so no media_url is set.
//
// Scoped to direction='inbound', content empty/null, type in the media types
// below. Voice notes vs. audio files can't be told apart after the fact
// (the payload's audio.voice flag wasn't stored), so both get "🎤 Audio".
//
// Dry-run by default (prints counts, writes nothing). Pass --confirm to
// execute.
//
// Usage:
//   node src/scripts/backfillInboundMediaLabels.js            (dry run)
//   node src/scripts/backfillInboundMediaLabels.js --confirm   (executes)

require('dotenv').config();

const supabase = require('../config/supabase');

const CONFIRM = process.argv.includes('--confirm');

const LABELS = {
  image: '📷 Photo',
  video: '🎥 Video',
  document: '📄 Document',
  audio: '🎤 Audio',
  sticker: 'Sticker',
};

async function main() {
  const types = Object.keys(LABELS);
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('messages')
      .select('id, type, content')
      .eq('direction', 'inbound')
      .in('type', types)
      .or('content.is.null,content.eq.')
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }

  const counts = {};
  for (const r of rows) counts[r.type] = (counts[r.type] || 0) + 1;
  console.log(`Empty inbound media messages: ${rows.length}`, JSON.stringify(counts));

  if (!CONFIRM) {
    console.log('Dry run — nothing written. Re-run with --confirm to apply.');
    return;
  }

  for (const type of types) {
    if (!counts[type]) continue;
    const { error } = await supabase.from('messages')
      .update({ content: LABELS[type] })
      .eq('direction', 'inbound')
      .eq('type', type)
      .or('content.is.null,content.eq.');
    if (error) throw error;
    console.log(`  ${type}: set "${LABELS[type]}" on ${counts[type]} rows`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Backfill failed:', err); process.exit(1); });
