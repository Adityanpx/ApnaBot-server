// src/scripts/verifyBookingGraph.js
//
// Generic structural regression check for the graph-based booking engine
// (bookingGraph.service.js), run against ANY business's REAL flow_nodes/
// flow_edges/vehicle_catalog/route_fares data (no fixtures/mocks, no
// hardcoded business id, no hardcoded expected fares/vehicle/route-fare
// ids). Never sends anything to WhatsApp and never touches Redis for
// session storage (in-memory session, held in this script's own
// variables) — the dev Redis instance (Upstash free tier) has previously
// hit its request quota, an infra constraint unrelated to the code under
// test, so booking.service.js's `require('../config/redis')` is shimmed
// with an in-memory stand-in before it's ever required. Nothing about
// production code changes.
//
// WHY THIS IS GENERIC, NOT PER-BUSINESS: businesses on this platform are
// NOT all shaped like a travel/cab booking flow. A business's booking flow
// may branch through buttons/list questions into a vehicle_carousel
// selection (e.g. a trip-type choice leading to vehicle/route pricing),
// or it may be a simple linear chain of plain TEXT fields with no
// tripType, no vehicle_carousel, no route_fares/vehicle_catalog concept
// at all — this script must handle both shapes without assuming which
// one a given business uses. A script that types literal replies like
// 'One Way'/'Pune'/'Mumbai' can never run against a business shaped the
// second way. So this script never asks a question by field key or
// label — it drives the conversation generically by FIELD TYPE
// (buttons/list -> first option, vehicle_carousel -> first computed
// option, free text -> a fixed placeholder), and asserts structural
// correctness against whatever the business's live data actually is,
// never a frozen expected-value snapshot. This means it requires zero
// re-baselining when a business's vehicles/fares/flow change, and zero
// script edits to run against a different business.
//
// "Branches": if the first question after booking_trigger is a
// buttons/list field with more than one option (e.g. a trip-type choice
// between two options), each option is walked as its own branch.
// Otherwise there's exactly one branch. This reproduces coverage of a
// multi-option first question without hardcoding that those options
// exist, and collapses to a single walk for a business whose first node
// is plain text.
//
// Structural checks per branch (no hardcoded expected value anywhere):
//   1. Did the flow reach {done: true}?
//   2. Does `collected` hold a non-empty value for every field_key this
//      business currently marks `required: true` on some flow_nodes row?
//   3. If a vehicle_carousel selection happened (collected.vehicleId set),
//      does that vehicle/route_fare/rental_package still exist and is it
//      still active in this business's CURRENT live data? (independently
//      re-queried here, not just trusting bookingGraph.service.js's own
//      staleness check on the same run.) N/A if this business's graph
//      never reaches a vehicle_carousel node.
//   4. For every node visited, are all label_translations values
//      non-empty where label_translations is configured? N/A if no
//      visited node has any.
//
// Usage: node src/scripts/verifyBookingGraph.js --business=<businessId>
//        BUSINESS_ID=<businessId> node src/scripts/verifyBookingGraph.js
// --business is required (via flag or env var) — there is no default.
// "The" test business is not a stable concept in this repo: business ids
// for the test accounts have changed multiple times via delete/recreate
// (see PRD.md), so a baked-in default silently goes stale. Look the id up
// fresh from the live `businesses` table by name if you don't have it
// handy.

require('dotenv').config();

const redisModulePath = require.resolve('../config/redis');
const inMemoryStore = new Map();
require.cache[redisModulePath] = {
  id: redisModulePath,
  filename: redisModulePath,
  loaded: true,
  exports: {
    get: async (key) => (inMemoryStore.has(key) ? inMemoryStore.get(key) : null),
    set: async (key, value) => { inMemoryStore.set(key, value); return 'OK'; },
    del: async (key) => { inMemoryStore.delete(key); return 1; }
  }
};

const supabase = require('../config/supabase');
const bookingService = require('../services/booking.service');
const bookingGraph = require('../services/bookingGraph.service');

const TEST_CUSTOMER_NUMBER = 'VERIFY_BOOKING_GRAPH_TEST';
const MAX_TURNS = 40; // cycle guard for the auto-walk itself, independent of pickNextNodeId's own MAX_HOPS
const TEXT_FIELD_ANSWER = 'Test';

function resolveBusinessId() {
  const cliArg = process.argv.find(arg => arg.startsWith('--business='));
  if (cliArg) return cliArg.slice('--business='.length);
  if (process.env.BUSINESS_ID) return process.env.BUSINESS_ID;
  return null;
}

async function ensureTestCustomer(businessId) {
  const { data: existing, error: findErr } = await supabase
    .from('customers').select('id').eq('business_id', businessId).eq('whatsapp_number', TEST_CUSTOMER_NUMBER).maybeSingle();
  if (findErr) throw findErr;
  if (existing) return existing.id;

  const { data: created, error: insertErr } = await supabase
    .from('customers').insert({ business_id: businessId, whatsapp_number: TEST_CUSTOMER_NUMBER, name: 'Verify Script Test Customer' })
    .select('id').single();
  if (insertErr) throw insertErr;
  return created.id;
}

async function cleanupTestData(businessId) {
  if (!businessId) return;
  await supabase.from('bookings').delete().eq('business_id', businessId).eq('customer_number', TEST_CUSTOMER_NUMBER);
  await supabase.from('customers').delete().eq('business_id', businessId).eq('whatsapp_number', TEST_CUSTOMER_NUMBER);
  await bookingService.deleteBookingSession(businessId, TEST_CUSTOMER_NUMBER);
}

/**
 * Pick the next reply generically, by field TYPE only — never by field key
 * or label, so this works for any business's flow regardless of vertical.
 * @returns {string|null} the reply to send, or null if this field offers
 *   no options to pick from (a structural problem worth failing on).
 */
function chooseAutoReply(field) {
  if (field.fieldType === 'vehicle_carousel') {
    const first = (field.options || [])[0];
    return first ? String(first.index) : null;
  }
  if (field.fieldType === 'buttons' || field.fieldType === 'list') {
    return (field.options || []).length > 0 ? '1' : null;
  }
  return TEXT_FIELD_ANSWER;
}

/**
 * Drive one full auto-walk from a given starting {session, field}, always
 * picking `firstReply` for the very first turn (so branch enumeration can
 * force a specific first option) and the generic auto-reply for every turn
 * after that. Returns every node visited (for the label/translations check)
 * plus the final collected state.
 */
async function runBranch(businessId, startSession, startField, firstReply, languageCode) {
  const visitedFields = [startField];
  let session = startSession;
  let field = startField;
  let reply = firstReply;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (reply === null) {
      throw new Error(`auto-walk: node "${field.label}" (fieldKey=${field.fieldKey}, type=${field.fieldType}) offers no options to answer with`);
    }
    const { session: nextSession, result } = await bookingGraph.advanceGraphSession({ businessId, session, reply, languageCode });
    session = nextSession;
    if (result === null) {
      throw new Error('auto-walk: session lookup failed unexpectedly mid-script');
    }
    if (result && result.done) {
      return { visitedFields, collected: { ...session.collected, ...(session.displayOverrides || {}) }, reachedDone: true };
    }
    if (typeof result === 'string') {
      // A re-prompt/status string (e.g. stale-tap recovery) — no state
      // advance happened, retry the same node with a fresh auto-reply.
      field = await bookingGraph.getCurrentNodeField(businessId, session, languageCode);
    } else {
      field = result;
      visitedFields.push(field);
    }
    reply = chooseAutoReply(field);
  }

  throw new Error(`auto-walk: did not reach {done:true} within ${MAX_TURNS} turns — possible cycle or misconfigured graph`);
}

/**
 * Every distinct field_key this business currently marks required on any
 * flow_nodes row (a field can have multiple sibling nodes, e.g. a
 * vehicle_carousel node and its static fallback sharing one field_key).
 */
function requiredFieldKeys(nodes) {
  return [...new Set(nodes.filter(n => n.nodeType === 'question' && n.required === true && n.fieldKey).map(n => n.fieldKey))];
}

function checkRequiredFieldsPresent(collected, required) {
  const missing = required.filter(key => collected[key] === undefined || collected[key] === null || collected[key] === '');
  return { pass: missing.length === 0, missing };
}

/**
 * Independently re-verify a vehicle_carousel selection against this
 * business's CURRENT live data — mirrors the exact staleness-check shapes
 * bookingGraph.service.js's advanceGraphSession itself uses, but queried
 * fresh here rather than trusting that the engine-under-test's own check
 * was correct on this run.
 */
async function checkVehicleSelectionLive(businessId, collected) {
  if (!collected.vehicleId) {
    return { applicable: false };
  }
  if (collected.fareSource === 'route_fare') {
    const { data } = await supabase
      .from('route_fares')
      .select('id, is_active, vehicle:vehicles(id, is_active)')
      .eq('id', collected.routeFareId).eq('business_id', businessId).maybeSingle();
    const pass = !!(data && data.is_active && data.vehicle && data.vehicle.is_active && data.vehicle.id === collected.vehicleId);
    return { applicable: true, pass, detail: data };
  }
  if (collected.fareSource === 'distance_estimate') {
    const { data } = await supabase
      .from('vehicles')
      .select('id, is_active, per_km_rate')
      .eq('id', collected.vehicleId).eq('business_id', businessId).maybeSingle();
    const pass = !!(data && data.is_active && data.per_km_rate !== null && data.per_km_rate !== undefined);
    return { applicable: true, pass, detail: data };
  }
  if (collected.fareSource === 'rental_package') {
    const { data } = await supabase
      .from('rental_packages')
      .select('id, is_active, vehicle:vehicles(id, is_active)')
      .eq('id', collected.rentalPackageId).eq('business_id', businessId).maybeSingle();
    const pass = !!(data && data.is_active && data.vehicle && data.vehicle.is_active && data.vehicle.id === collected.vehicleId);
    return { applicable: true, pass, detail: data };
  }
  return { applicable: true, pass: false, detail: `unknown fareSource '${collected.fareSource}'` };
}

/**
 * label_translations values must be non-empty where configured, across
 * every node actually visited this branch.
 */
function checkLabelTranslations(visitedFields) {
  let anyConfigured = false;
  const empties = [];
  for (const field of visitedFields) {
    if (!field.labelTranslations || typeof field.labelTranslations !== 'object') continue;
    for (const [lang, value] of Object.entries(field.labelTranslations)) {
      anyConfigured = true;
      if (!value || !String(value).trim()) {
        empties.push({ fieldKey: field.fieldKey, lang });
      }
    }
  }
  if (!anyConfigured) return { applicable: false };
  return { applicable: true, pass: empties.length === 0, empties };
}

function printCheck(label, result) {
  if (result.applicable === false) {
    console.log(`  N/A  ${label}`);
    return true;
  }
  console.log(`  ${result.pass ? 'PASS' : 'FAIL'} ${label}`);
  return result.pass;
}

async function main() {
  const businessId = resolveBusinessId();
  if (!businessId) {
    console.error('Usage: node src/scripts/verifyBookingGraph.js --business=<businessId>  (or BUSINESS_ID env var)');
    console.error('No default business id — look it up fresh from the live `businesses` table by name.');
    process.exit(1);
  }

  const { data: business, error: bizErr } = await supabase
    .from('businesses').select('id, name').eq('id', businessId).maybeSingle();
  if (bizErr) throw bizErr;
  if (!business) throw new Error(`No business found with id ${businessId}.`);

  await ensureTestCustomer(business.id);
  await cleanupTestData(business.id); // safety net: clear anything a previous failed/interrupted run left behind

  const { data: entryNode, error: entryErr } = await supabase
    .from('flow_nodes').select('id, keyword').eq('business_id', business.id)
    .eq('node_type', 'reply').eq('reply_kind', 'booking_trigger').maybeSingle();
  if (entryErr) throw entryErr;
  if (!entryNode) throw new Error('No booking_trigger reply node found for this business.');

  console.log(`Business: ${business.name} (${business.id})`);
  console.log(`Entry reply node: keyword="${entryNode.keyword}" id=${entryNode.id}\n`);

  const { nodes } = await bookingGraph.loadGraph(business.id);
  const required = requiredFieldKeys(nodes);
  console.log(`Currently required fields: ${required.length ? required.join(', ') : '(none)'}\n`);

  let anyFailed = false;

  try {
    // Peek at the first question to enumerate branches; each branch below
    // starts its OWN fresh session via startGraphSession — advanceGraphSession
    // mutates session.collected in place rather than cloning it, so reusing
    // one session object across branches would leak the first branch's
    // answers into the second.
    const { result: firstFieldPeek } = await bookingGraph.startGraphSession(business.id, entryNode.id, null);

    // Branch enumeration: one branch per option on the first question if
    // it's a multi-option buttons/list field, else a single branch.
    const branchStarts = (firstFieldPeek.fieldType === 'buttons' || firstFieldPeek.fieldType === 'list') && (firstFieldPeek.options || []).length > 1
      ? firstFieldPeek.options.map(opt => ({ name: `first option: ${typeof opt === 'string' ? opt : opt.value}`, reply: typeof opt === 'string' ? opt : opt.value }))
      : [{ name: '(single path)', reply: chooseAutoReply(firstFieldPeek) }];

    for (const branch of branchStarts) {
      console.log(`=== Branch: ${branch.name} ===`);

      let outcome;
      try {
        const { session: startSession, result: startField } = await bookingGraph.startGraphSession(business.id, entryNode.id, null);
        outcome = await runBranch(business.id, startSession, startField, branch.reply, null);
      } catch (err) {
        console.error('  Auto-walk FAILED:', err.message);
        anyFailed = true;
        console.log('');
        continue;
      }

      console.log(`  visited ${outcome.visitedFields.length} question node(s)`);
      console.log('\n-- structural checks --');

      let branchPassed = true;
      branchPassed = printCheck('reached {done:true}', { pass: outcome.reachedDone }) && branchPassed;

      const reqCheck = checkRequiredFieldsPresent(outcome.collected, required);
      branchPassed = printCheck(`all required fields present${reqCheck.pass ? '' : ` (missing: ${reqCheck.missing.join(', ')})`}`, reqCheck) && branchPassed;

      const vehicleCheck = await checkVehicleSelectionLive(business.id, outcome.collected);
      branchPassed = printCheck('selected vehicle/fare exists in current live data', vehicleCheck) && branchPassed;

      const labelCheck = checkLabelTranslations(outcome.visitedFields);
      branchPassed = printCheck(`label_translations non-empty${labelCheck.applicable && !labelCheck.pass ? ` (empty: ${JSON.stringify(labelCheck.empties)})` : ''}`, labelCheck) && branchPassed;

      if (!branchPassed) anyFailed = true;
      console.log(`\nBranch ${branch.name}: ${branchPassed ? 'PASS' : 'FAIL'}\n`);
    }
  } finally {
    await cleanupTestData(business.id);
  }

  if (anyFailed) {
    console.error('One or more branches failed a structural check.');
    process.exit(1);
  }
  console.log('All branches reached {done:true} and passed every structural check.');
  process.exit(0);
}

main().catch(err => {
  console.error('Verification script crashed:', err);
  process.exit(1);
});
