// src/scripts/deactivateSgRoundTripFares.js
//
// Switches OFF (route_fares.is_active = false - never deletes) the fixed Round Trip fares of SG TRAVELS - and only
// SG Travels - so Round Trip is priced by the new formula (billed km x the vehicle's rate + driver allowance) instead
// of one flat fare for any number of days. One Way fares are never touched.
//
// WHAT IT WRITES: exactly one column, is_active true -> false, on exactly the rows it lists (active, trip_type
// round_trip, this business), through one guarded UPDATE (… where id in (listed) and business_id = SG and trip_type =
// 'round_trip' and is_active = true). No row is inserted or deleted; no other column, row, table or business is written.
// Because a deactivation cannot carry a tag in the database, the TAG is a manifest file written BEFORE the update:
// logs/sg-round-trip-fares-deactivated.json (ids + the fare each row held). --rollback re-activates exactly the rows
// in that manifest that are still switched off, and nothing else (a row the owner switched off by hand is not in the
// manifest and stays off).
//
// REFUSES (and says why) when
//   - the business is not SG Travels (hard-coded id), is named like Search cab AI, or migration 20261106120000 is missing;
//   - the flow is not cut over (cutoverRoundTripDaysFirst.js): the formula needs the days asked before the vehicles;
//   - ANOTHER PATH READS THESE ROWS: SG has an active vehicle carousel other than the quote flow's (it would lose the
//     vehicles priced by these rows), or a route that has a Round Trip fare would be left with no active One Way fare
//     (it would drop out of the served-city suggestions and the rate card);
//   - after the change a route would no longer be offered for Round Trip (no distance, min km or rate to price it by):
//     customers would not see that route. Add the distances on the Rates screen first, or pass --allow-routes-off.
//
// The readers of route_fares, as checked in the code (the two risky ones are checked against the live data above):
//   quote flow (bookingGraph + travelQuote.service)   reads ACTIVE rows: the consumer this change is for
//   other vehicle carousels in the flow engine         refused above if SG has one
//   web booking form (publicServiceForm.controller)    distance estimates only - does not read route_fares
//   served-city suggestions (business.service)         pair level: refused above if a pair would lose its One Way fare
//   Rates screen / route-fares API (owner)             lists both states; saving a price cell on a Round Trip fare, or
//                                                      switching a route off and on again, re-activates its rows
//   conversation preview (flowGraphPreview)            owner simulator, reads active rows
//   travel_quotes.route_fare_id, bookings.fields       by id; rows are not deleted, old quotes keep their price
//
// Dry-run by default (prints exactly the rows, writes nothing). --confirm applies.
//
// Usage:
//   node src/scripts/deactivateSgRoundTripFares.js                                  (dry run, all active Round Trip fares)
//   node src/scripts/deactivateSgRoundTripFares.js --routes=pune>shirdi,pune>nashik  (only those routes)
//   node src/scripts/deactivateSgRoundTripFares.js --confirm --expect-rows=36
//   node src/scripts/deactivateSgRoundTripFares.js --rollback                       (dry run: what would be switched back on)
//   node src/scripts/deactivateSgRoundTripFares.js --rollback --confirm
//   --allow-routes-off   go ahead even though some routes would no longer be offered for Round Trip
//   --manifest=PATH      where the manifest is written / read (default logs/sg-round-trip-fares-deactivated.json)
const seed = require('./seedTravelQuoteFlow');
const cutover = require('./cutoverRoundTripDaysFirst');
const { roundTripCandidates, roundTripReadiness, priceVehicleTrip } = require('../utils/travelQuote');

const { SG_TRAVELS_ID, N } = seed;
const REFUSED_NAME = /search\s*cab/i;
const DEFAULT_MANIFEST = 'logs/sg-round-trip-fares-deactivated.json';
const FARE_SELECT = '*, vehicle:vehicles(id, custom_name, is_active, per_km_rate, min_km_per_day, driver_allowance_per_day)';

const pairKey = (row) => `${row.from_city}>${row.to_city}`;
const num = (v) => (v === null || v === undefined ? null : Number(v));
const vehicleName = (row) => (row.vehicle && row.vehicle.custom_name) || row.vehicle_id;
const fingerprint = (rows) => JSON.stringify([...rows].sort((a, b) => (a.id < b.id ? -1 : 1)));

// ── Orchestration (dependencies injected, so tests run it against an in-memory database) ───────────
/**
 * @param {{ mode: 'deactivate'|'rollback', confirm: boolean, businessArg: string|null, routes: string[]|null,
 *           allowRoutesOff: boolean, expectRows: number|null, manifestPath: string }} options
 * @param {{ supabase: Object, migrationApplied: Function, writeManifest: Function, readManifest: Function,
 *           now: Function, log: Function }} deps
 * @returns {Promise<number>} process exit code
 */
const run = async (options, deps) => {
  const { supabase, migrationApplied, writeManifest, readManifest, now, log } = deps;
  const { mode, confirm, businessArg, routes, allowRoutesOff, expectRows, manifestPath } = options;
  const businessId = SG_TRAVELS_ID;
  const rollback = mode === 'rollback';
  const fail = (message) => { log(`\nREFUSED: ${message}`); return 1; };

  log(`MODE: ${rollback ? 'ROLLBACK (switch the listed fares back on)' : 'DEACTIVATE the Round Trip fares'} ${confirm ? '--confirm (writes)' : '(dry run - nothing is written)'}`);
  log(`Scope: business ${businessId} (SG Travels) only. Writes: route_fares.is_active on the rows listed below, nothing else.`);
  if (businessArg && businessArg !== businessId) return fail(`--business=${businessArg} is not SG Travels' id; this script works on ${businessId} only.`);

  const read = async (table, columns = '*') => {
    const { data, error } = await supabase.from(table).select(columns).eq('business_id', businessId);
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

  // ---------------------------------------------------------------- rollback
  if (rollback) {
    const manifest = await readManifest(manifestPath);
    if (!record(!!manifest && manifest.script === 'deactivateSgRoundTripFares' && Array.isArray(manifest.rows), `the manifest ${manifestPath} exists and was written by this script`)) {
      return fail(`no usable manifest at ${manifestPath}: without it the script cannot know which rows it switched off.`);
    }
    if (!record(manifest.businessId === businessId, 'the manifest is for SG Travels')) return fail(`the manifest is for business ${manifest.businessId}.`);
    const ids = manifest.rows.map((r) => r.id);
    const live = (await read('route_fares')).filter((r) => ids.includes(r.id));
    const restore = live.filter((r) => r.trip_type === 'round_trip' && r.is_active === false);
    const skipped = ids.filter((id) => !restore.some((r) => r.id === id));
    log(`\nPlan: switch ${restore.length} of the ${ids.length} manifest row(s) back ON.`);
    for (const r of restore) log(`  + ${r.id}  ${r.from_city} > ${r.to_city}  ${vehicleName(r)}  ₹${r.fare}`);
    for (const id of skipped) log(`  . ${id}  left alone (already active again, deleted, or no longer a Round Trip fare)`);
    if (restore.length === 0) { log('\nNothing to switch back on.'); return 0; }
    if (expectRows !== null && expectRows !== restore.length) return fail(`--expect-rows=${expectRows} but ${restore.length} row(s) would be restored.`);
    if (!confirm) { log('\nDry run only. Re-run with --rollback --confirm to apply.'); return 0; }

    const before = await read('route_fares');
    const restoreIds = restore.map((r) => r.id);
    const { data, error } = await supabase.from('route_fares').update({ is_active: true })
      .in('id', restoreIds).eq('business_id', businessId).eq('trip_type', 'round_trip').eq('is_active', false).select('id');
    if (error) throw error;
    const after = await read('route_fares');
    const others = (rows) => fingerprint(rows.filter((r) => !restoreIds.includes(r.id)));
    const exact = (data || []).length === restoreIds.length && after.filter((r) => restoreIds.includes(r.id)).every((r) => r.is_active === true);
    const untouched = others(after) === others(before);
    log(`\nSwitched back on: ${(data || []).length} row(s). Exactly the planned rows: ${exact ? 'yes' : 'NO'}. Every other route_fares row unchanged: ${untouched ? 'yes' : 'NO'}.`);
    return exact && untouched ? 0 : 2;
  }

  // ---------------------------------------------------------------- deactivate
  if (!record(await migrationApplied(), 'migration 20261106120000 is applied')) return fail('apply supabase/migrations/20261106120000_round_trip_pricing.sql first.');

  const nodes = await read('flow_nodes');
  const edges = await read('flow_edges');
  const edgeIds = new Set(edges.map((e) => e.id));
  const cutOver = cutover.ADDED_IDS.every((id) => edgeIds.has(id)) && cutover.REMOVED_IDS.every((id) => !edgeIds.has(id));
  if (!record(cutOver, 'the quote flow asks the days BEFORE the vehicles for Round Trip (cutoverRoundTripDaysFirst.js is applied)')) {
    return fail('run cutoverRoundTripDaysFirst.js --confirm first: the formula needs the days before the vehicle cards.');
  }

  // Another path that reads these rows
  const otherCarousels = nodes.filter((n) => n.node_type === 'vehicle_carousel' && n.is_active !== false && n.id !== N.vehicle);
  if (!record(otherCarousels.length === 0, 'no other active vehicle carousel in the flow reads these rows (only the quote flow\'s)')) {
    return fail(`another vehicle carousel is active in SG Travels' flow (${otherCarousels.map((n) => n.id).join(', ')}) and would stop showing the vehicles these fares price.`);
  }

  const fares = await read('route_fares', FARE_SELECT);
  const wanted = routes ? new Set(routes) : null;
  const targets = fares.filter((r) => r.trip_type === 'round_trip' && r.is_active === true && (!wanted || wanted.has(pairKey(r))));
  if (wanted) {
    const unknown = [...wanted].filter((key) => !targets.some((r) => pairKey(r) === key));
    if (!record(unknown.length === 0, `every --routes entry has an active Round Trip fare`)) return fail(`no active Round Trip fare for: ${unknown.join(', ')}`);
  }
  if (targets.length === 0) { log('\nNothing to do: there is no active Round Trip fare.'); return 0; }
  const targetIds = new Set(targets.map((r) => r.id));
  const pairs = [...new Set(targets.map(pairKey))];

  const lostOneWay = pairs.filter((key) => !fares.some((r) => pairKey(r) === key && r.trip_type === 'oneway' && r.is_active === true));
  if (!record(lostOneWay.length === 0, 'every route keeps an active One Way fare (rate card and served-city suggestions are unaffected)')) {
    return fail(`these routes have no active One Way fare and would disappear: ${lostOneWay.join(', ')}`);
  }

  // Which routes are still offered for Round Trip afterwards
  const travelRoutes = await read('travel_routes');
  const distanceOf = (key) => {
    const route = travelRoutes.find((r) => `${r.from_city}>${r.to_city}` === key);
    return route ? num(route.one_way_distance_km) : null;
  };
  const afterFares = fares.map((r) => (targetIds.has(r.id) ? { ...r, is_active: false } : r));
  const consequence = pairs.map((key) => {
    const rows = afterFares.filter((r) => pairKey(r) === key);
    const candidates = roundTripCandidates(rows);
    const readiness = roundTripReadiness({ oneWayKm: distanceOf(key), vehicles: candidates });
    const priced = candidates.filter((c) => priceVehicleTrip({ tripType: 'round_trip', days: 1, fare: c.fare, oneWayKm: distanceOf(key), vehicle: c.vehicle }).ok).length;
    return { key, readiness, priced, of: candidates.length };
  });
  const dropped = consequence.filter((c) => !c.readiness.ready);
  log(`\nRound Trip after the change (per route): ${consequence.length - dropped.length} of ${consequence.length} still offered`);
  for (const c of consequence) {
    log(`  ${c.readiness.ready ? '✓' : '✗'} ${c.key}: ${c.readiness.ready ? `${c.priced} of ${c.of} vehicle(s) priced by formula` : `NOT offered for Round Trip (${c.readiness.reason})`}`);
  }
  if (!record(dropped.length === 0 || allowRoutesOff, dropped.length === 0 ? 'every route stays offered for Round Trip' : `${dropped.length} route(s) would no longer be offered for Round Trip (--allow-routes-off was ${allowRoutesOff ? 'given' : 'not given'})`)) {
    return fail(`${dropped.length} route(s) have no distance / min km / rate to price Round Trip by once the fixed fares are off: ${dropped.map((c) => c.key).join(', ')}. Fill them in on the Rates and Fleet screens, or pass --allow-routes-off.`);
  }

  const { data: openQuotes, error: quoteErr } = await supabase.from('travel_quotes').select('id, route_fare_id, status').eq('business_id', businessId);
  if (quoteErr) throw quoteErr;
  const referencing = (openQuotes || []).filter((q) => targetIds.has(q.route_fare_id));
  log(`\n  i ${referencing.length} saved quote(s) reference these fares by id (${referencing.map((q) => q.status).join(', ') || 'none'}): they keep the price they were sent at; no row is deleted.`);
  log('  i switching a route off and on again on the Rates screen, or saving a price on one of these Round Trip cells, re-activates the fare.');

  log(`\nPlan: switch OFF ${targets.length} Round Trip fare(s) on ${pairs.length} route(s). Rows inserted: 0. Rows deleted: 0. Columns written: is_active only. One Way fares touched: 0.`);
  log('\nRows (route | vehicle | fare | id):');
  for (const r of [...targets].sort((a, b) => pairKey(a).localeCompare(pairKey(b)) || vehicleName(a).localeCompare(vehicleName(b)))) {
    log(`  - ${r.from_city} > ${r.to_city} | ${vehicleName(r)} | ₹${r.fare} | ${r.id}`);
  }
  if (expectRows !== null && expectRows !== targets.length) return fail(`--expect-rows=${expectRows} but the plan has ${targets.length} row(s).`);
  if (!confirm) { log(`\nDry run only. Re-run with --confirm (optionally --expect-rows=${targets.length}). Undo with --rollback --confirm.`); return 0; }

  // The tag first: if anything fails after this, the manifest still says which rows were meant to change.
  // A later run on other routes adds to the same manifest (one --rollback undoes all of them).
  const previous = await readManifest(manifestPath);
  if (previous && (previous.script !== 'deactivateSgRoundTripFares' || previous.businessId !== businessId || !Array.isArray(previous.rows))) {
    return fail(`${manifestPath} exists but is not this script's manifest for SG Travels; move it away first.`);
  }
  const rows = [...(previous ? previous.rows : []), ...targets.filter((r) => !(previous && previous.rows.some((m) => m.id === r.id)))
    .map((r) => ({ id: r.id, from_city: r.from_city, to_city: r.to_city, vehicle_id: r.vehicle_id, vehicle: vehicleName(r), fare: num(r.fare) }))];
  await writeManifest(manifestPath, { script: 'deactivateSgRoundTripFares', version: 1, businessId, createdAt: previous ? previous.createdAt : now(), updatedAt: now(), rows });
  log(`\nManifest written: ${manifestPath} (${rows.length} row(s) in total)`);

  const before = await read('route_fares');
  const ids = [...targetIds];
  const { data, error } = await supabase.from('route_fares').update({ is_active: false })
    .in('id', ids).eq('business_id', businessId).eq('trip_type', 'round_trip').eq('is_active', true).select('id');
  if (error) throw error;
  const after = await read('route_fares');
  const exact = (data || []).length === ids.length && after.filter((r) => targetIds.has(r.id)).every((r) => r.is_active === false);
  const others = (rows) => fingerprint(rows.filter((r) => !targetIds.has(r.id)));
  const untouched = others(after) === others(before);
  // the listed rows changed in is_active only
  const sameColumns = after.filter((r) => targetIds.has(r.id)).every((r) => {
    const was = before.find((b) => b.id === r.id);
    return was && ['fare', 'trip_type', 'vehicle_id', 'from_city', 'to_city', 'route_id', 'business_id'].every((k) => JSON.stringify(was[k]) === JSON.stringify(r[k]));
  });
  log(`\nSwitched off: ${(data || []).length} row(s). Exactly the listed rows: ${exact ? 'yes' : 'NO'}. Their other columns unchanged: ${sameColumns ? 'yes' : 'NO'}. Every other route_fares row unchanged: ${untouched ? 'yes' : 'NO'}.`);
  return exact && untouched && sameColumns ? 0 : 2;
};

module.exports = { DEFAULT_MANIFEST, run };

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  require('dotenv').config();
  const fs = require('fs');
  const pathModule = require('path');
  const argValue = (name) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const supabase = require('../config/supabase');

  const migrationApplied = async () => {
    for (const [table, column] of [['vehicles', 'min_km_per_day'], ['vehicles', 'driver_allowance_per_day'], ['travel_routes', 'one_way_distance_km'], ['travel_quote_settings', 'allowance_basis']]) {
      const { error } = await supabase.from(table).select(column).limit(1);
      if (error) return false;
    }
    return true;
  };
  const writeManifest = async (file, content) => {
    const full = pathModule.resolve(file);
    fs.mkdirSync(pathModule.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(content, null, 2));
  };
  const readManifest = async (file) => {
    const full = pathModule.resolve(file);
    return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : null;
  };
  const routesArg = argValue('routes');

  run({
    mode: process.argv.includes('--rollback') ? 'rollback' : 'deactivate',
    confirm: process.argv.includes('--confirm'),
    businessArg: argValue('business'),
    routes: routesArg ? routesArg.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null,
    allowRoutesOff: process.argv.includes('--allow-routes-off'),
    expectRows: argValue('expect-rows') === null ? null : Number(argValue('expect-rows')),
    manifestPath: argValue('manifest') || DEFAULT_MANIFEST
  }, {
    supabase, migrationApplied, writeManifest, readManifest, now: () => new Date().toISOString(), log: (line) => console.log(line)
  }).then((code) => process.exit(code)).catch((err) => {
    console.error('\nFAILED:', err.message || err);
    process.exit(1);
  });
}
