// src/scripts/fixNullReplyKind.js
//
// One-time data fix: sets flow_nodes.reply_kind = 'text' on every 'reply'
// node that currently has reply_kind = null. Confirmed via investigation on
// 2026-09-15 ([[localization_empty_string_and_null_reply_kind_bug]] memory):
// webhook.controller.js's reply-dispatch chain (Step 14) only sets
// `replyText` inside a branch keyed on matchedNode.replyKind ('text',
// 'booking_trigger', 'payment_trigger', 'web_form_trigger') — a 'reply' node
// whose replyKind is null falls through every branch with replyText left
// null, which flows through to an empty interactive.body.text that Meta
// rejects. webhook.controller.js has since been patched to fall back to
// text-reply behavior for any unrecognized replyKind (defensive fix, covers
// future bad data too), but the live rows themselves still carry the bad
// null value and should be corrected directly rather than relying solely on
// the runtime fallback.
//
// Scoped by node_type = 'reply' AND reply_kind IS NULL — confirmed via a
// live scan on 2026-09-15 to currently match exactly 2 rows, both under the
// Multi-Brand Router business (8ae9d68f-daa9-4b9b-bc73-e7063955435e):
//   - ca085e54-e39b-400f-8901-8a6bb1211806 (keyword 'hi')
//   - 8267754f-bad0-4a9c-b18a-d6ee3dc77bfb (keyword '1visiionkart')
// Not hardcoded to those ids/that business, though — the query is generic
// (any 'reply' node with a null reply_kind, across all tenants) so this
// stays correct if the same bad-data pattern shows up elsewhere later.
// Precondition-checked: if a fresh query returns a different row set than
// what was confirmed via dry-run in chat, it aborts instead of writing.
//
// Then flushes the rules:{businessId} and tenant:{phoneNumberId} Redis
// caches per affected business (pattern verified against
// fixSgTravelsTripTypeRouting.js), since direct writes bypass the app's
// normal cache invalidation.
//
// Dry-run by default (prints current state, writes nothing). Pass
// --confirm to execute.
//
// Usage:
//   node src/scripts/fixNullReplyKind.js            (dry run)
//   node src/scripts/fixNullReplyKind.js --confirm   (executes)

require('dotenv').config();
const supabase = require('../config/supabase');
const redis = require('../config/redis');

// The exact row set confirmed via dry-run in chat on 2026-09-15. Used only
// as a precondition check below — the query itself stays generic.
const EXPECTED_IDS = new Set([
  'ca085e54-e39b-400f-8901-8a6bb1211806',
  '8267754f-bad0-4a9c-b18a-d6ee3dc77bfb'
]);

const CONFIRM = process.argv.includes('--confirm');

async function main() {
  const { data: nodes, error: nodesErr } = await supabase
    .from('flow_nodes')
    .select('id, business_id, keyword, label')
    .eq('node_type', 'reply')
    .is('reply_kind', null);
  if (nodesErr) throw nodesErr;

  console.log(`Found ${nodes.length} 'reply' node(s) with reply_kind = null:\n`);
  nodes.forEach(n => console.log(`  ${n.id}  business=${n.business_id}  keyword=${n.keyword}  label="${n.label}"`));

  const foundIds = new Set(nodes.map(n => n.id));
  const sameSet = foundIds.size === EXPECTED_IDS.size && [...EXPECTED_IDS].every(id => foundIds.has(id));
  if (!sameSet) {
    console.error('\nLive row set has drifted from what was confirmed via dry-run in chat — aborting without writing.');
    console.error('Expected ids:', [...EXPECTED_IDS]);
    console.error('Found ids:   ', [...foundIds]);
    process.exit(1);
  }

  if (nodes.length === 0) {
    console.log('\nNothing to fix.');
    process.exit(0);
  }

  if (!CONFIRM) {
    console.log('\nDry run only — pass --confirm to execute.');
    console.log(`Would set reply_kind = 'text' on ${nodes.length} row(s) listed above.`);
    process.exit(0);
  }

  const { error: updateErr } = await supabase
    .from('flow_nodes')
    .update({ reply_kind: 'text' })
    .in('id', [...foundIds]);
  if (updateErr) throw updateErr;
  console.log(`\nUpdated ${nodes.length} row(s): reply_kind -> 'text'.`);

  const businessIds = [...new Set(nodes.map(n => n.business_id))];
  const { data: businesses, error: bizErr } = await supabase
    .from('businesses')
    .select('id, phone_number_id')
    .in('id', businessIds);
  if (bizErr) throw bizErr;

  for (const business of businesses) {
    await redis.del(`rules:${business.id}`);
    console.log(`Flushed rules:${business.id}`);
    if (business.phone_number_id) {
      await redis.del(`tenant:${business.phone_number_id}`);
      console.log(`Flushed tenant:${business.phone_number_id}`);
    } else {
      console.log(`No phone_number_id on business ${business.id} — skipped tenant:* cache flush.`);
    }
  }

  console.log('\n=== Verification ===');
  const { data: afterNodes, error: afterErr } = await supabase
    .from('flow_nodes')
    .select('id, reply_kind')
    .in('id', [...foundIds]);
  if (afterErr) throw afterErr;
  console.log(JSON.stringify(afterNodes, null, 2));

  process.exit(0);
}

main().catch(err => {
  console.error('Script crashed:', err);
  process.exit(1);
});
