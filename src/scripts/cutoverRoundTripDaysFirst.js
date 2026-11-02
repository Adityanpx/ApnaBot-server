// src/scripts/cutoverRoundTripDaysFirst.js
//
// Moves the "For how many days?" question BEFORE the vehicle carousel for Round Trip - on SG TRAVELS' quote flow
// (the one seedTravelQuoteFlow.js created) and nowhere else - so the carousel can price every vehicle for the days
// the customer chose (Round Trip pricing: fixed package price, or billed km x rate + driver allowance).
//
//   before   tripType > routePicker > passengers > vehicle > date > time > [days if Round Trip] > quote
//   after    tripType > routePicker > passengers > [days if Round Trip] > vehicle > date > time > quote
//   One Way is untouched: passengers > vehicle > date > time > quote.
//
// WHAT IT CHANGES: only edges that carry the seed script's tag (ids 5eed7a01-…). It deletes three of them
//   timeToDays, timeManualToDays   (pickup time -> days, Round Trip only)
//   daysToQuote                    (days -> quote)
// and creates two new tagged ones
//   paxToDays      passengers -> days   (only if tripType = Round Trip; display_order -1 so it is tried before the
//                                         unconditional passengers -> vehicle edge, which is left exactly as it is)
//   daysToVehicle  days -> vehicle
// No node row is written. No edge or node that is not tagged is read for writing, written or deleted; the payload is
// checked to contain tagged ids only, and afterwards every other row is compared byte for byte.
//
// HOW IT WRITES: through save_flow_graph_full (the RPC the canvas and the seed script write with), one transaction,
// then flushes the bot-flow cache (flow:<id>).
//
// REFUSES: any business id other than SG Travels' (hard-coded), a business named like Search cab AI, a database
// where migration 20261106120000 is not applied, a flow that has not been seeded or whose seeded edges were edited
// since, a non-tagged edge wired into the seeded nodes, a Round Trip with no offerable route, and any plan after which
// a Round Trip or One Way path would not reach the quote.
//
// ONE-TIME CUTOVER FOR SG TRAVELS: --confirm changes the live conversation immediately, no feature flag. A customer
// who is mid-way (sessions last 5 minutes) when it is applied finishes under the new edges: at the time question a
// Round Trip customer goes straight to the quote with no days question (rolling back has the mirror effect at the
// days question). Apply it when quiet.
//
// ORDER: apply the server code (commits through the Round Trip quote flow) and migration 20261106120000 first.
// Run deactivateSgRoundTripFares.js only AFTER this cutover (it refuses otherwise).
//
// Dry-run by default (prints exactly what it would do, writes nothing). --confirm applies.
//
// Usage:
//   node src/scripts/cutoverRoundTripDaysFirst.js                    (dry run)
//   node src/scripts/cutoverRoundTripDaysFirst.js --confirm
//   node src/scripts/cutoverRoundTripDaysFirst.js --rollback         (dry run: what would be restored)
//   node src/scripts/cutoverRoundTripDaysFirst.js --rollback --confirm
//   --expect-deletes=N --expect-creates=M   abort unless the plan has exactly these counts (copy from the dry run)
const seed = require('./seedTravelQuoteFlow');

const { SG_TRAVELS_ID, N, E, NODE_ID_LIST, EDGE_ID_LIST } = seed;
const REFUSED_NAME = /search\s*cab/i;
const ROUND_TRIP = { field: 'tripType', equals: 'Round Trip' };

const REMOVED_IDS = [E.timeToDays, E.timeManualToDays, E.daysToQuote];
const ADDED_IDS = [E.paxToDays, E.daysToVehicle];
const TOUCHED_IDS = [...REMOVED_IDS, ...ADDED_IDS];
// Seeded edges the new order relies on, left as the seed wrote them
const RELIED_ON_IDS = [E.pickerToPax, E.paxToVehicle, E.vehicleToDate, E.dateToTime, E.dateManualToTime, E.timeToQuote, E.timeManualToQuote];

const seededPlan = () => seed.buildPlan({ businessId: SG_TRAVELS_ID, anchors: { rates: null, ratesEdges: [], menu: null, menuEdges: [] } });
const SEEDED_EDGE = (id) => seededPlan().edges.find((e) => e.id === id);
const SEEDED_FIELD = Object.fromEntries(seededPlan().nodes.map((n) => [n.id, n.field_key || `reply:${n.keyword}`]));

/** The five-edge change: what is removed (as the seed wrote it) and what is created. */
const buildCutover = () => ({
  remove: REMOVED_IDS.map(SEEDED_EDGE),
  add: [
    seed.edgeRow({ id: E.paxToDays, from_node_id: N.passengers, to_node_id: N.numberOfDays, condition: ROUND_TRIP, display_order: -1 }),
    seed.edgeRow({ id: E.daysToVehicle, from_node_id: N.numberOfDays, to_node_id: N.vehicle })
  ]
});

// An edge as it matters to the flow: where it goes, when, in which order, with which button text
const shape = (e) => JSON.stringify([e.from_node_id, e.to_node_id, e.condition ?? null, e.display_order ?? 0, e.label ?? null, e.preset ?? null, e.card_index ?? null]);
const sameEdge = (live, expected) => !!live && shape(live) === shape(expected);
const fingerprint = (rows) => JSON.stringify([...rows].sort((a, b) => (a.id < b.id ? -1 : 1)));

/**
 * The path a customer of one trip type takes through the question edges, from `start`.
 * @returns {{ ok: boolean, path: string[] }} ok = it ends at the quote node
 */
const walk = (edges, start, tripType) => {
  const collected = { tripType };
  const path = [];
  let current = start;
  for (let hop = 0; hop < 30; hop++) {
    path.push(SEEDED_FIELD[current] || current);
    if (current === N.quote) return { ok: true, path };
    const next = edges
      .filter((e) => e.from_node_id === current)
      .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
      .find((e) => !e.condition || collected[e.condition.field] === e.condition.equals);
    if (!next) return { ok: false, path };
    current = next.to_node_id;
  }
  return { ok: false, path };
};

const TRIP_TYPES = ['One Way', 'Round Trip'];
/** Every way into the questions (the trip type, and the typed date / time siblings) must still reach the quote. */
const START_NODES = [N.tripType, N.travelDateManual, N.pickupTimeManual];
const pathsOf = (edges) => Object.fromEntries(TRIP_TYPES.map((t) => [t, START_NODES.map((s) => walk(edges, s, t))]));

/** Problems with a planned edge set: unreachable quote, One Way changed, days not exactly once before the vehicles. */
const planProblems = (beforePaths, afterPaths) => {
  const problems = [];
  for (const type of TRIP_TYPES) {
    afterPaths[type].forEach((p, i) => { if (!p.ok) problems.push(`${type}: the path from ${SEEDED_FIELD[START_NODES[i]]} would not reach the quote (${p.path.join(' > ')})`); });
  }
  if (JSON.stringify(afterPaths['One Way']) !== JSON.stringify(beforePaths['One Way'])) problems.push('the One Way path would change');
  const rt = afterPaths['Round Trip'][0].path;
  const days = rt.filter((f) => f === 'numberOfDays').length;
  if (days !== 1) problems.push(`Round Trip would ask the days ${days} times`);
  else if (rt.indexOf('numberOfDays') > rt.indexOf('vehicleType')) problems.push('Round Trip would still ask the days after the vehicles');
  return problems;
};

// ── Orchestration (dependencies injected, so tests run it against an in-memory database) ───────────
/**
 * @param {{ mode: 'cutover'|'rollback', confirm: boolean, businessArg: string|null,
 *           expectDeletes: number|null, expectCreates: number|null }} options
 * @param {{ supabase: Object, migrationApplied: Function, listQuotableRoutes: Function, invalidateCache: Function, log: Function }} deps
 * @returns {Promise<number>} process exit code
 */
const run = async (options, deps) => {
  const { supabase, migrationApplied, listQuotableRoutes, invalidateCache, log } = deps;
  const { mode, confirm, businessArg, expectDeletes, expectCreates } = options;
  const businessId = SG_TRAVELS_ID;
  const fail = (message) => { log(`\nREFUSED: ${message}`); return 1; };
  const rollback = mode === 'rollback';

  log(`MODE: ${rollback ? 'ROLLBACK of the days-first cutover' : 'CUTOVER (days before the vehicles for Round Trip)'} ${confirm ? '--confirm (writes)' : '(dry run - nothing is written)'}`);
  log(`Scope: business ${businessId} (SG Travels) only`);
  if (businessArg && businessArg !== businessId) return fail(`--business=${businessArg} is not SG Travels' id; this script works on ${businessId} only.`);

  const read = async (table) => {
    const { data, error } = await supabase.from(table).select('*').eq('business_id', businessId);
    if (error) throw error;
    return data || [];
  };
  const { data: business, error: bizErr } = await supabase.from('businesses').select('id, name, business_category').eq('id', businessId).maybeSingle();
  if (bizErr) throw bizErr;

  const record = (ok, text) => { log(`  ${ok ? '✓' : '✗'} ${text}`); return ok; };
  log('\nPreconditions:');
  if (!record(!!business, 'the business exists')) return fail('business not found');
  record(true, `name: ${business.name}, category: ${business.business_category}`);
  if (!record(!REFUSED_NAME.test(business.name || ''), 'it is not Search cab AI (a live production business)')) return fail('this is Search cab AI');
  if (!record(/sg\s*travels/i.test(business.name || '') && business.business_category === 'travels', 'it is SG Travels (category travels)')) return fail('not SG Travels');

  if (!record(await migrationApplied(), 'migration 20261106120000 is applied (vehicles.min_km_per_day / driver_allowance_per_day, travel_routes.one_way_distance_km, travel_quote_settings.allowance_basis exist)')) {
    return fail('apply supabase/migrations/20261106120000_round_trip_pricing.sql first.');
  }

  const nodes = await read('flow_nodes');
  const edges = await read('flow_edges');
  const ownNodeIds = new Set(NODE_ID_LIST);
  const ownEdgeIds = new Set(EDGE_ID_LIST);
  const missingNodes = NODE_ID_LIST.filter((id) => !nodes.some((n) => n.id === id));
  if (!record(missingNodes.length === 0, 'the quote flow is seeded (all 11 tagged nodes exist)')) return fail(`${missingNodes.length} tagged node(s) missing - run seedTravelQuoteFlow.js first.`);
  const stray = edges.filter((e) => !ownEdgeIds.has(e.id) && (ownNodeIds.has(e.from_node_id) || ownNodeIds.has(e.to_node_id)));
  if (!record(stray.length === 0, 'no edge that is not the seed\'s is wired to the seeded nodes')) return fail(`${stray.length} non-tagged edge(s) connect to the quote flow (${stray.map((e) => e.id).join(', ')}); remove them in the canvas first.`);

  const { remove, add } = buildCutover();
  const byId = new Map(edges.map((e) => [e.id, e]));
  const removedPresent = REMOVED_IDS.filter((id) => byId.has(id));
  const addedPresent = ADDED_IDS.filter((id) => byId.has(id));
  const cutOver = addedPresent.length === ADDED_IDS.length && removedPresent.length === 0;
  const notYet = addedPresent.length === 0 && removedPresent.length === REMOVED_IDS.length;
  if (!cutOver && !notYet) {
    return fail(`the quote flow is in a mixed state (present: ${[...removedPresent, ...addedPresent].join(', ')}); it was edited after the seed. Fix it in the canvas, or run seedTravelQuoteFlow.js --rollback --confirm and start again.`);
  }
  record(true, `state: ${cutOver ? 'cut over (days are asked before the vehicles)' : 'seeded, not cut over (days are asked after the pickup time)'}`);

  // The seeded edges involved must still be exactly what the seed wrote (an owner edit in the canvas would be overwritten or orphaned)
  const expectedLive = cutOver ? [...add] : [...remove];
  const edited = [...expectedLive, ...RELIED_ON_IDS.map(SEEDED_EDGE)].filter((e) => !sameEdge(byId.get(e.id), e));
  if (!record(edited.length === 0, 'every edge this change touches or relies on is still exactly as written')) {
    return fail(`edited since: ${edited.map((e) => e.id).join(', ')}. Restore them in the canvas (or re-seed), then re-run.`);
  }

  if (!rollback) {
    if (cutOver) { log('\nAlready cut over. Nothing to do (use --rollback to restore the old order).'); return 0; }
    let roundTripRoutes;
    try {
      roundTripRoutes = await listQuotableRoutes(businessId, 'round_trip');
    } catch (error) {
      return fail(`could not list the Round Trip routes (${error.message}) - the server code is not deployed or the migration is missing.`);
    }
    if (!record(roundTripRoutes.length > 0, `Round Trip has at least one offerable route (${roundTripRoutes.length})`)) {
      return fail('no route can be priced for Round Trip: customers would be handed off at the route question.');
    }
  } else if (notYet) {
    log('\nNothing to roll back: the flow is not cut over.');
    return 0;
  }

  // The edge set after the change, and the paths customers take before and after
  const quoteEdges = (list) => list.filter((e) => ownEdgeIds.has(e.id) && e.id !== E.rates && e.id !== E.menu);
  const toRemove = rollback ? add : remove;
  const toCreate = rollback ? remove : add;
  const removeIds = new Set(toRemove.map((e) => e.id));
  const beforeEdges = quoteEdges(edges);
  const afterEdges = [...beforeEdges.filter((e) => !removeIds.has(e.id)), ...toCreate];
  const before = pathsOf(beforeEdges);
  const after = pathsOf(afterEdges);
  const problems = planProblems(rollback ? after : before, rollback ? before : after);
  // For a rollback the "new order" is the one being left; the checks that matter are that nothing dead-ends afterwards
  const dead = TRIP_TYPES.flatMap((t) => after[t].filter((p) => !p.ok).map((p) => `${t}: ${p.path.join(' > ')}`));
  if (JSON.stringify(after['One Way']) !== JSON.stringify(before['One Way'])) dead.push('the One Way path would change');
  if (!record(rollback ? dead.length === 0 : problems.length === 0, 'after the change every path still reaches the quote; One Way is unchanged; Round Trip asks the days once, before the vehicles')) {
    return fail((rollback ? dead : problems).join('; '));
  }

  log(`\nPlan: delete ${toRemove.length} tagged edge(s), create ${toCreate.length} tagged edge(s). Nodes written: 0. Non-tagged rows touched: 0.`);
  const nameOf = (id) => SEEDED_FIELD[id] || id;
  const describe = (e) => `${e.id}  ${nameOf(e.from_node_id)} -> ${nameOf(e.to_node_id)}${e.condition ? `  if ${e.condition.field} = ${e.condition.equals}` : ''}  order ${e.display_order}`;
  log('\nEdges deleted:');
  for (const e of toRemove) log(`  - ${describe(e)}`);
  log('\nEdges created:');
  for (const e of toCreate) log(`  + ${describe(e)}`);
  log('\nWhat customers go through (before -> after):');
  for (const type of TRIP_TYPES) {
    log(`  ${type}`);
    log(`    before: ${before[type][0].path.join(' > ')}`);
    log(`    after:  ${after[type][0].path.join(' > ')}${JSON.stringify(before[type]) === JSON.stringify(after[type]) ? '   (unchanged)' : ''}`);
  }
  log('  typed "Other date" / "Other time" answers continue the same way as the list answers (checked above).');
  log(`\nNOTE: a customer who is mid-flow (5-minute sessions) when this is applied finishes under the ${rollback ? 'old' : 'new'} edges: ${rollback ? 'at the days question they go to the quote with no vehicle chosen and get the fallback message' : 'at the time question a Round Trip customer goes to the quote with no days question'}. Apply it when quiet.`);

  if (expectDeletes !== null && expectDeletes !== toRemove.length) return fail(`--expect-deletes=${expectDeletes} but the plan deletes ${toRemove.length}.`);
  if (expectCreates !== null && expectCreates !== toCreate.length) return fail(`--expect-creates=${expectCreates} but the plan creates ${toCreate.length}.`);
  if (!confirm) { log(`\nDry run only. Re-run with ${rollback ? '--rollback ' : ''}--confirm to apply (optionally --expect-deletes / --expect-creates from the counts above).`); return 0; }

  // Defence: nothing outside the tagged ids is ever sent
  const payloadIds = [...toRemove, ...toCreate].map((e) => e.id);
  if (!payloadIds.every((id) => TOUCHED_IDS.includes(id))) throw new Error('refusing to write: the payload holds an id that is not one of this script\'s tagged edges');

  const { error } = await supabase.rpc('save_flow_graph_full', {
    p_business_id: businessId, p_node_upserts: [], p_node_deletes: [], p_edge_upserts: toCreate, p_edge_deletes: toRemove.map((e) => e.id)
  });
  if (error) throw error;

  const afterNodes = await read('flow_nodes');
  const afterLive = await read('flow_edges');
  const afterById = new Map(afterLive.map((e) => [e.id, e]));
  const created = toCreate.every((e) => sameEdge(afterById.get(e.id), e));
  const removed = toRemove.every((e) => !afterById.has(e.id));
  const untouched = fingerprint(afterNodes) === fingerprint(nodes) &&
    fingerprint(afterLive.filter((e) => !TOUCHED_IDS.includes(e.id))) === fingerprint(edges.filter((e) => !TOUCHED_IDS.includes(e.id)));
  await invalidateCache(businessId);
  log(`\nDone. New edges present and as planned: ${created ? 'yes' : 'NO'}. Old edges gone: ${removed ? 'yes' : 'NO'}. Every node and every other edge byte-identical: ${untouched ? 'yes' : 'NO'}. Flow cache flushed.`);
  return created && removed && untouched ? 0 : 2;
};

module.exports = { REMOVED_IDS, ADDED_IDS, buildCutover, walk, pathsOf, planProblems, run };

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  require('dotenv').config();
  const argValue = (name) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const intArg = (name) => (argValue(name) === null ? null : Number(argValue(name)));
  const supabase = require('../config/supabase');
  const travelQuoteService = require('../services/travelQuote.service');
  const { invalidateRulesCache } = require('../services/chatbot.service');

  // The columns the Round Trip server code reads; a select fails if the migration is not applied
  const migrationApplied = async () => {
    for (const [table, column] of [['vehicles', 'min_km_per_day'], ['vehicles', 'driver_allowance_per_day'], ['travel_routes', 'one_way_distance_km'], ['travel_quote_settings', 'allowance_basis']]) {
      const { error } = await supabase.from(table).select(column).limit(1);
      if (error) return false;
    }
    return true;
  };

  run({
    mode: process.argv.includes('--rollback') ? 'rollback' : 'cutover',
    confirm: process.argv.includes('--confirm'),
    businessArg: argValue('business'),
    expectDeletes: intArg('expect-deletes'),
    expectCreates: intArg('expect-creates')
  }, {
    supabase,
    migrationApplied,
    listQuotableRoutes: (id, tripType) => travelQuoteService.listQuotableRoutes(id, tripType),
    invalidateCache: invalidateRulesCache,
    log: (line) => console.log(line)
  }).then((code) => process.exit(code)).catch((err) => {
    console.error('\nFAILED (nothing was partially written - the write is one transaction):', err.message || err);
    process.exit(1);
  });
}
