// src/scripts/convertTalkToHandoff.js
//
// Turns the "talk to a person" reply nodes into handoff nodes (flow_nodes.reply_kind = 'handoff'),
// so reaching one also alerts the owner (services/handoff.service.js). Only a plain text reply
// whose keyword is exactly "talk" (change with --keyword=) is converted: a node with buttons, a
// list, a form link etc. is listed as skipped and left alone. The node's text is not touched.
//
// Targets (at least one; with neither flag the category templates are the default):
//   --templates          every SuperAdmin category template (flow_snapshots.nodes) - affects
//                        businesses created / imported from it AFTER this runs, no live business
//   --business=<uuid>    one business's live flow_nodes, then its rules:/tenant: caches are flushed
//
// REFUSES Search cab AI by name (a LIVE production business with real WhatsApp customers): the
// script never touches it, dry run included.
//
// Needs migration 20261028120000_handoff.sql applied first (the reply_kind check constraint must
// accept 'handoff'); it checks for the settings table that migration creates and aborts without it.
//
// Dry-run by default (prints what it would change, writes nothing). --confirm executes.
// --expect-nodes=N aborts if the count to convert differs from the N seen in the dry run.
//
// Usage:
//   node src/scripts/convertTalkToHandoff.js                          (dry run, all templates)
//   node src/scripts/convertTalkToHandoff.js --templates --confirm
//   node src/scripts/convertTalkToHandoff.js --business=<uuid>        (dry run, that business)
//   node src/scripts/convertTalkToHandoff.js --business=<uuid> --expect-nodes=1 --confirm

require('dotenv').config();
const supabase = require('../config/supabase');
const redis = require('../config/redis');

const CONFIRM = process.argv.includes('--confirm');
const argValue = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const BUSINESS_ID = argValue('business');
const KEYWORD = (argValue('keyword') || 'talk').trim().toLowerCase();
const EXPECT = argValue('expect-nodes');
const DO_TEMPLATES = process.argv.includes('--templates') || !BUSINESS_ID;

const REFUSED_NAME = /search\s*cab/i;

// A plain text reply node on the keyword: the only shape that is safe to convert.
const isCandidate = (n) => n.node_type === 'reply' && String(n.keyword || '').trim().toLowerCase() === KEYWORD;
const isConvertible = (n) => isCandidate(n) && n.reply_kind === 'text' && n.content_type === 'text';
const describe = (n) => `${n.id}  kw=${JSON.stringify(n.keyword)}  kind=${n.reply_kind}  content=${n.content_type}  label=${JSON.stringify(String(n.label || '').slice(0, 50))}`;

async function assertMigrationApplied() {
  const { error } = await supabase.from('business_handoff_settings').select('business_id').limit(1);
  if (error) {
    console.error(`\nbusiness_handoff_settings is not readable (${error.message}) - migration 20261028120000_handoff.sql is not applied.`);
    if (CONFIRM) {
      console.error('Aborting without writing: the reply_kind check would reject "handoff".');
      process.exit(1);
    }
    console.error('(dry run continues; --confirm would abort)');
  }
}

async function main() {
  console.log(CONFIRM ? 'MODE: --confirm (writes)\n' : 'MODE: dry run (nothing is written)\n');
  await assertMigrationApplied();

  const plan = []; // { kind: 'template'|'business', label, ids, snapshot?, business? }

  if (DO_TEMPLATES) {
    const { data: snapshots, error } = await supabase
      .from('flow_snapshots').select('id, category, name, nodes').eq('is_category_template', true);
    if (error) throw error;
    console.log(`Category templates: ${snapshots.length}`);
    for (const s of snapshots) {
      const nodes = Array.isArray(s.nodes) ? s.nodes : [];
      const convertible = nodes.filter(isConvertible);
      const skipped = nodes.filter((n) => isCandidate(n) && !isConvertible(n));
      if (convertible.length === 0 && skipped.length === 0) continue;
      console.log(`\n  [${s.category}] ${s.name}  (snapshot ${s.id})`);
      convertible.forEach((n) => console.log(`    convert  ${describe(n)}`));
      skipped.forEach((n) => console.log(`    SKIP     ${describe(n)}  (not a plain text reply)`));
      if (convertible.length > 0) plan.push({ kind: 'template', label: `${s.category} / ${s.name}`, snapshot: s, ids: convertible.map((n) => n.id) });
    }
  }

  if (BUSINESS_ID) {
    const { data: business, error } = await supabase
      .from('businesses').select('id, name, display_name, phone_number_id').eq('id', BUSINESS_ID).maybeSingle();
    if (error) throw error;
    if (!business) {
      console.error(`\nNo business with id ${BUSINESS_ID}.`);
      process.exit(1);
    }
    if (REFUSED_NAME.test(business.name || '') || REFUSED_NAME.test(business.display_name || '')) {
      console.error(`\nREFUSED: "${business.name}" is Search cab AI, a LIVE production business. This script never touches it.`);
      process.exit(1);
    }
    const { data: nodes, error: nodesErr } = await supabase
      .from('flow_nodes').select('id, keyword, label, reply_kind, content_type, node_type').eq('business_id', BUSINESS_ID).eq('node_type', 'reply');
    if (nodesErr) throw nodesErr;
    const convertible = nodes.filter(isConvertible);
    const skipped = nodes.filter((n) => isCandidate(n) && !isConvertible(n));
    console.log(`\nBusiness "${business.name}" (${business.id}): ${nodes.length} reply node(s)`);
    convertible.forEach((n) => console.log(`    convert  ${describe(n)}`));
    skipped.forEach((n) => console.log(`    SKIP     ${describe(n)}  (not a plain text reply)`));
    if (convertible.length > 0) plan.push({ kind: 'business', label: business.name, business, ids: convertible.map((n) => n.id) });
  }

  const total = plan.reduce((sum, p) => sum + p.ids.length, 0);
  console.log(`\nTotal nodes to convert to reply_kind 'handoff': ${total} in ${plan.length} place(s).`);
  if (EXPECT !== null && Number(EXPECT) !== total) {
    console.error(`--expect-nodes=${EXPECT} but ${total} found - the data has drifted from the dry run. Aborting without writing.`);
    process.exit(1);
  }
  if (total === 0) {
    console.log('Nothing to convert.');
    process.exit(0);
  }
  if (!CONFIRM) {
    console.log('Dry run only - pass --confirm to execute.');
    process.exit(0);
  }

  for (const p of plan) {
    if (p.kind === 'template') {
      const ids = new Set(p.ids);
      const nodes = p.snapshot.nodes.map((n) => (ids.has(n.id) ? { ...n, reply_kind: 'handoff' } : n));
      const { error } = await supabase.from('flow_snapshots').update({ nodes }).eq('id', p.snapshot.id).eq('is_category_template', true);
      if (error) throw error;
      console.log(`Updated template ${p.label}: ${p.ids.length} node(s)`);
    } else {
      const { error } = await supabase.from('flow_nodes').update({ reply_kind: 'handoff' }).in('id', p.ids).eq('business_id', p.business.id);
      if (error) throw error;
      console.log(`Updated business ${p.label}: ${p.ids.length} node(s)`);
      await redis.del(`rules:${p.business.id}`);
      console.log(`Flushed rules:${p.business.id}`);
      if (p.business.phone_number_id) {
        await redis.del(`tenant:${p.business.phone_number_id}`);
        console.log(`Flushed tenant:${p.business.phone_number_id}`);
      }
    }
  }
  console.log('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Script crashed:', err);
  process.exit(1);
});
