// src/scripts/reinstallSgQuoteFlowOnce.js
//
// ONE-TIME SCRIPT. DELETE THIS FILE (AND ITS TEST) RIGHT AFTER IT HAS RUN SUCCESSFULLY ON SG TRAVELS.
//
// SG Travels got the quote flow from the first seed script, with the fixed ids 5eed7a01-0000-4000-8000-… . The quote
// flow is now installed by the generic installer (services/quoteFlowInstaller.service.js) with ids derived from the
// business id, and nothing in the code knows the old ids any more. This script moves SG Travels over, once:
//
//   (a) saves a restore point of the whole current flow (flow_snapshots, the Versions tab),
//   (b) removes SG's old 5eed7a01-tagged quote nodes and edges - the ONLY place in the code where those ids appear,
//   (c) installs the quote flow with the derived ids, through the installer's own planning and checks, in the SAME
//       transaction as (b): one save_flow_graph_full call with the old rows as deletes and the new rows as upserts, so
//       either the old flow is replaced by the new one or nothing changes. The "Get a quote" button on the Rates reply
//       comes back (the installer's plan builds it from the Rates reply as it is without the old rows),
//   (d) verifies afterwards that every other node and edge is byte-identical, the new rows are all present, the old
//       ones are all gone, and the saved quotes (travel_quotes) are untouched - then flushes the bot-flow cache.
//
// What changes for the customer: the quote flow is the new install (Round Trip days first, the days-first order is the
// installer's default). A customer who is mid-quote (sessions last 5 minutes) when it is applied has a session that points
// at a node that no longer exists and is asked to start again: apply it when quiet. Quotes already sent keep working:
// their Confirm / Change / Talk to us buttons read the quote from travel_quotes, and Change restarts at the new entry.
// Owner edits made to the old quote nodes in the canvas (texts, translations, positions) are not carried over; they are
// in the restore point.
//
// It refuses any business except SG Travels and Search cab AI by id (looked up fresh in `businesses`), a flow that has no
// old rows to replace, one that already has the new ones (nothing to do) or both (mixed), an edge that is not the old
// install's wired to the old nodes, and everything the installer refuses (switch off, no priceable route, a keyword that
// is taken, ...).
//
// Dry-run by default (prints exactly what it would do, writes nothing). --confirm applies. There is no --rollback: the
// restore point is the way back, or installTravelQuoteFlow.js --rollback removes the new install again.
//
// Usage:
//   node src/scripts/reinstallSgQuoteFlowOnce.js                  (dry run)
//   node src/scripts/reinstallSgQuoteFlowOnce.js --confirm
//   node src/scripts/reinstallSgQuoteFlowOnce.js --ack-round-trip-team   (only if no route can be priced for Round Trip)
const installer = require('../services/quoteFlowInstaller.service');
const { derive } = require('../utils/quoteFlowIds');

const SG_TRAVELS_ID = 'a94aec66-23fb-43e1-afcc-f4e8d518134b';

// The old install's fixed ids (the 5eed7a01 tag): nodes 1-11, edges 101-116 (three of the edges no longer exist).
const oldTag = (n) => `5eed7a01-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OLD_NODE_IDS = Array.from({ length: 11 }, (_, i) => oldTag(i + 1));
const OLD_EDGE_IDS = Array.from({ length: 16 }, (_, i) => oldTag(101 + i));

// ── Orchestration (dependencies injected, so tests run it against an in-memory database) ───────────
/**
 * @param {{ confirm: boolean, businessArg?: string|null, ackRoundTripToTeam?: boolean }} options
 * @param {{ supabase: Object, isQuotesEnabled: Function, listQuotableRoutes: Function, invalidateCache: Function,
 *           saveSnapshot: Function, findProtectedBusinessIds: Function, log: Function }} deps
 * @returns {Promise<number>} process exit code
 */
const run = async (options, deps) => {
  const { supabase, invalidateCache, saveSnapshot, log } = deps;
  const { confirm, businessArg = null, ackRoundTripToTeam = false } = options;
  const businessId = SG_TRAVELS_ID;
  const ids = derive(businessId);
  const fail = (message) => { log(`\nREFUSED: ${message}`); return 1; };

  log(`MODE: ONE-TIME REINSTALL OF THE QUOTE FLOW ${confirm ? '--confirm (writes)' : '(dry run - nothing is written)'}`);
  log(`Scope: business ${businessId} (SG Travels) only`);
  if (businessArg && businessArg !== businessId) return fail(`--business=${businessArg} is not SG Travels' id; this script works on ${businessId} only.`);

  // The live production business is looked up fresh and compared by id, before anything of SG is read.
  const protectedIds = await deps.findProtectedBusinessIds();
  if (protectedIds.includes(businessId)) return fail('this is Search cab AI (a live production business); it is never written.');

  const read = async (table, filter = (q) => q) => {
    const { data, error } = await filter(supabase.from(table).select('*').eq('business_id', businessId));
    if (error) throw error;
    return data || [];
  };
  const { data: business, error: bizErr } = await supabase.from('businesses').select('id, name, business_category').eq('id', businessId).maybeSingle();
  if (bizErr) throw bizErr;

  const record = (ok, text) => { log(`  ${ok ? '✓' : '✗'} ${text}`); return ok; };
  const printChecks = (list) => { for (const c of list) record(c.ok, c.text); };
  log('\nPreconditions:');
  if (!record(!!business, 'the business exists')) return fail('business not found');
  record(true, `name: ${business.name}, category: ${business.business_category}`);
  record(true, 'it is not Search cab AI (compared by id)');
  if (!record(/sg\s*travels/i.test(business.name || '') && business.business_category === 'travels', 'it is SG Travels (category travels)')) return fail('not SG Travels');

  const nodes = await read('flow_nodes');
  const edges = await read('flow_edges');
  const quotes = await read('travel_quotes');
  const oldNodeSet = new Set(OLD_NODE_IDS);
  const oldEdgeSet = new Set(OLD_EDGE_IDS);
  const newNodeSet = new Set(ids.nodeIds);
  const newEdgeSet = new Set(ids.edgeIds);
  const oldNodes = nodes.filter((n) => oldNodeSet.has(n.id));
  const oldEdges = edges.filter((e) => oldEdgeSet.has(e.id));
  const newNodes = nodes.filter((n) => newNodeSet.has(n.id));
  const newEdges = edges.filter((e) => newEdgeSet.has(e.id));

  if (oldNodes.length === 0 && oldEdges.length === 0) {
    if (newNodes.length > 0 || newEdges.length > 0) {
      log(`\nAlready reinstalled: ${newNodes.length} node(s), ${newEdges.length} edge(s) carry the new ids and no old row is left. Nothing to do.`);
      return 0;
    }
    return fail('SG Travels has none of the old quote rows and none of the new ones: nothing to move. Install with installTravelQuoteFlow.js instead.');
  }
  if (!record(newNodes.length === 0 && newEdges.length === 0, 'the new ids do not exist yet')) {
    return fail(`mixed state: old rows and ${newNodes.length} node(s) / ${newEdges.length} edge(s) with the new ids both exist. Remove one side in the canvas, or run installTravelQuoteFlow.js --rollback for the new one.`);
  }
  // A node of the old install that the new one would conflict with is impossible (different ids), but an edge that is not the
  // old install's and is wired to the old nodes would be orphaned by the delete.
  const stray = edges.filter((e) => !oldEdgeSet.has(e.id) && (oldNodeSet.has(e.from_node_id) || oldNodeSet.has(e.to_node_id)));
  if (!record(stray.length === 0, 'no edge that is not the old install\'s is wired to the old quote nodes')) {
    return fail(`${stray.length} edge(s) connect to the old quote nodes (${stray.map((e) => e.id).join(', ')}); remove them in the canvas first.`);
  }
  const baseNodes = nodes.filter((n) => !oldNodeSet.has(n.id));
  const baseEdges = edges.filter((e) => !oldEdgeSet.has(e.id));

  const gate = await installer.readinessGate({ businessId, business, options: { ackRoundTripToTeam }, deps });
  printChecks(gate.checks);
  for (const note of gate.notes) log(`  i ${note}`);
  if (gate.refusal) return fail(gate.refusal);

  // The installer judges the flow WITHOUT the old rows: their keyword and button are about to go.
  const flow = installer.planInstall({ businessId, baseNodes, baseEdges, options: {}, ids });
  printChecks(flow.checks);
  for (const note of flow.notes) log(`  i ${note}`);
  if (flow.refusal) return fail(flow.refusal);
  const { plan } = flow;
  if (!record(!!plan.edges.find((e) => e.id === ids.E.rates), 'the "Get a quote" button on the Rates reply will come back')) {
    return fail('the Rates reply was not found, so its "Get a quote" button cannot come back; only the keyword would be left.');
  }

  // Rows that point at the old nodes with ON DELETE SET NULL (web booking-form tokens): informational
  const pointing = async (column) => {
    const { data, error } = await supabase.from('booking_form_tokens').select('id').in(column, OLD_NODE_IDS);
    if (error) throw error;
    return (data || []).length;
  };
  const tokens = (await pointing('flow_node_id')) + (await pointing('source_node_id'));
  log(`  i ${tokens} booking-form token(s) point at the old quote nodes (they would be set to no node; the quote flow creates none)`);
  log(`  i ${quotes.length} saved quote(s) in travel_quotes - never written by this script`);
  log('  i migration 20261105120000 (route_picker / quote node types) cannot be checked from here - it must be applied; if not, the write fails as a whole and nothing is written');

  log(`\nPlan, in ONE transaction after a restore point of the ${nodes.length} node(s) / ${edges.length} edge(s) flow:`);
  log(`  remove ${oldNodes.length} old node(s) and ${oldEdges.length} old edge(s) (5eed7a01-…):`);
  for (const n of oldNodes) log(`    - node ${n.id}  ${n.node_type}  ${n.field_key || n.keyword}`);
  for (const e of oldEdges) log(`    - edge ${e.id}  ${e.from_node_id} -> ${e.to_node_id}${e.label ? `  "${e.label}"` : ''}`);
  log(`  install ${plan.nodes.length} node(s) and ${plan.edges.length} edge(s) with the derived ids. Other rows modified: 0, deleted: 0.`);
  installer.describePlan(plan, baseNodes, log);
  log('\nNOTE: a customer who is mid-quote (5-minute sessions) when this is applied is asked to start again. Apply it when quiet.');

  if (!confirm) { log('\nDry run only. Re-run with --confirm to apply.'); return 0; }

  try {
    await saveSnapshot(businessId, installer.snapshotName('Before quote flow reinstall'), nodes, edges);
    log('\nRestore point saved (Versions tab).');
  } catch (error) {
    return fail(`could not save a restore point (${error.message}). Nothing was changed.`);
  }
  const { error } = await supabase.rpc('save_flow_graph_full', {
    p_business_id: businessId,
    p_node_upserts: plan.nodes, p_node_deletes: oldNodes.map((n) => n.id),
    p_edge_upserts: plan.edges, p_edge_deletes: oldEdges.map((e) => e.id)
  });
  if (error) throw error;

  const afterNodes = await read('flow_nodes');
  const afterEdges = await read('flow_edges');
  const afterQuotes = await read('travel_quotes');
  const created = afterNodes.filter((n) => newNodeSet.has(n.id)).length === plan.nodes.length && afterEdges.filter((e) => newEdgeSet.has(e.id)).length === plan.edges.length;
  const oldGone = !afterNodes.some((n) => oldNodeSet.has(n.id)) && !afterEdges.some((e) => oldEdgeSet.has(e.id));
  const untouched = installer.fingerprint(afterNodes.filter((n) => !newNodeSet.has(n.id))) === installer.fingerprint(baseNodes) &&
    installer.fingerprint(afterEdges.filter((e) => !newEdgeSet.has(e.id))) === installer.fingerprint(baseEdges);
  const quotesUntouched = installer.fingerprint(afterQuotes) === installer.fingerprint(quotes);
  await invalidateCache(businessId);
  log(`\nNew rows: ${created ? 'all present' : 'MISSING ROWS'}. Old rows: ${oldGone ? 'all gone' : 'SOME LEFT'}. Every other node and edge byte-identical: ${untouched ? 'yes' : 'NO'}. Saved quotes untouched (${quotes.length}): ${quotesUntouched ? 'yes' : 'NO'}. Flow cache flushed.`);
  return created && oldGone && untouched && quotesUntouched ? 0 : 2;
};

module.exports = { SG_TRAVELS_ID, OLD_NODE_IDS, OLD_EDGE_IDS, run };

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  require('dotenv').config();
  const supabase = require('../config/supabase');
  const categoryFeatureService = require('../services/categoryFeature.service');
  const travelQuoteService = require('../services/travelQuote.service');
  const { createSnapshotFromRows } = require('../services/flowSnapshot.service');
  const { invalidateRulesCache } = require('../services/chatbot.service');
  const businessArg = (process.argv.find((a) => a.startsWith('--business=')) || '').slice('--business='.length) || null;

  run({
    confirm: process.argv.includes('--confirm'),
    businessArg,
    ackRoundTripToTeam: process.argv.includes('--ack-round-trip-team')
  }, {
    supabase,
    isQuotesEnabled: (category, id) => categoryFeatureService.isEnabled(category, 'travel_quotes', id),
    listQuotableRoutes: (id, tripType) => travelQuoteService.listQuotableRoutes(id, tripType),
    invalidateCache: invalidateRulesCache,
    saveSnapshot: createSnapshotFromRows,
    findProtectedBusinessIds: () => installer.findProtectedBusinessIds(supabase),
    log: (line) => console.log(line)
  }).then((code) => process.exit(code)).catch((err) => {
    console.error('\nFAILED (nothing was partially written - the write is one transaction):', err.message || err);
    process.exit(1);
  });
}
