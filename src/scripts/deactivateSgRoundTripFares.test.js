// Run: node --test src/scripts/deactivateSgRoundTripFares.test.js
// The SG Travels "switch off the fixed Round Trip fares" script against an in-memory database: the dry run lists
// exactly the rows and writes nothing, --confirm writes the manifest then flips is_active on those rows only,
// --rollback switches back on only what the manifest holds, and every wrong target or state is refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('../test-support/fakeSupabase');
const { derive } = require('../utils/quoteFlowIds');
const script = require('./deactivateSgRoundTripFares');

const SG = 'a94aec66-23fb-43e1-afcc-f4e8d518134b';
const { N, E } = derive(SG);
const OTHER = 'b2b2b2b2-0000-4000-8000-000000000002';
const MANIFEST = 'logs/test-manifest.json';
let fake; let db; let lines; let migration; let marker; let manifests; let writes;

const vehicle = (n, name, over = {}) => ({ id: `v${n}`, custom_name: name, is_active: true, per_km_rate: 20, min_km_per_day: 250, driver_allowance_per_day: 300, ...over });
const VEHICLES = [vehicle(1, 'Dzire', { per_km_rate: 13 }), vehicle(2, 'Etios', { per_km_rate: 16 }), vehicle(3, 'Innova', { per_km_rate: 23 })];
let fareCounter;
const fare = (business, from, to, tripType, v, amount, over = {}) => ({
  id: `fare-${String(++fareCounter).padStart(3, "0")}`, business_id: business, from_city: from, to_city: to, trip_type: tripType, vehicle_id: v.id, fare: amount, is_active: true, off_reason: null, route_id: null, vehicle: v, ...over
});

test.beforeEach(() => {
  fake = createFakeSupabase();
  db = fake.db;
  lines = []; migration = true; marker = true; manifests = {}; writes = []; fareCounter = 0;
  db.businesses = [{ id: SG, name: 'SG Travels', business_category: 'travels' }, { id: OTHER, name: 'Search cab AI', business_category: 'travels' }];
  // the flow is cut over: the days come before the vehicles, and the quote flow's carousel is the only one
  db.flow_nodes = [{ id: N.vehicle, business_id: SG, node_type: 'vehicle_carousel', is_active: true }];
  db.flow_edges = [E.paxToDays, E.daysToVehicle].map((id) => ({ id, business_id: SG, from_node_id: 'a', to_node_id: 'b' }));
  db.travel_routes = [
    { id: 'r1', business_id: SG, from_city: 'pune', to_city: 'shirdi', one_way_distance_km: 185 },
    { id: 'r2', business_id: SG, from_city: 'pune', to_city: 'nashik', one_way_distance_km: 210 },
    { id: 'r3', business_id: SG, from_city: 'pune', to_city: 'goa', one_way_distance_km: 450 }
  ];
  db.route_fares = [];
  for (const [to, base] of [['shirdi', 4200], ['nashik', 3800], ['goa', 9800]]) {
    for (const v of VEHICLES) {
      db.route_fares.push(fare(SG, 'pune', to, 'oneway', v, base));
      db.route_fares.push(fare(SG, 'pune', to, 'round_trip', v, Math.round(base * 1.7)));
    }
  }
  // another business with its own Round Trip fares: never touched
  db.route_fares.push(fare(OTHER, 'pune', 'goa', 'round_trip', VEHICLES[0], 11500));
  db.travel_quotes = [{ id: 'q1', business_id: SG, status: 'accepted', route_fare_id: db.route_fares.find((r) => r.to_city === 'shirdi' && r.trip_type === 'round_trip' && r.vehicle_id === 'v3').id }];
});

const deps = () => ({
  supabase: fake,
  migrationApplied: async () => migration,
  offReasonApplied: async () => marker,
  writeManifest: async (file, content) => { writes.push('manifest'); manifests[file] = JSON.parse(JSON.stringify(content)); },
  readManifest: async (file) => (manifests[file] ? JSON.parse(JSON.stringify(manifests[file])) : null),
  now: () => '2026-11-10T10:00:00.000Z',
  log: (line) => lines.push(line)
});
const opts = (over = {}) => ({ mode: 'deactivate', confirm: false, businessArg: null, routes: null, allowRoutesOff: false, expectRows: null, manifestPath: MANIFEST, ...over });
const go = (over) => script.run(opts(over), deps());
const out = () => lines.join('\n');
const snapshot = () => JSON.stringify(db.route_fares);
const rtSg = () => db.route_fares.filter((r) => r.business_id === SG && r.trip_type === 'round_trip');
const active = (rows) => rows.filter((r) => r.is_active);

// ── Dry run ─────────────────────────────────────────────────────────────────────────────────────

test('dry run: writes nothing (no row, no manifest) and lists exactly the 9 active Round Trip fares with route, vehicle, fare and id', async () => {
  const before = snapshot();
  const code = await go();
  assert.equal(code, 0, out());
  assert.equal(snapshot(), before);
  assert.deepEqual(manifests, {});
  assert.equal(fake.calls.filter((c) => c.op === 'update').length, 0);
  const text = out();
  assert.match(text, /dry run - nothing is written/);
  assert.ok(text.includes(`business ${SG} (SG Travels) only`));
  assert.match(text, /✓ it is not Search cab AI/);
  assert.match(text, /✓ the quote flow asks the days BEFORE the vehicles/);
  assert.match(text, /✓ no other active vehicle carousel/);
  assert.match(text, /✓ every route keeps an active One Way fare/);
  assert.match(text, /Plan: switch OFF 9 Round Trip fare\(s\) on 3 route\(s\)\. Rows inserted: 0\. Rows deleted: 0\. Columns written: is_active and off_reason \('manual'\)\. One Way fares touched: 0\./);
  for (const r of rtSg()) assert.ok(text.includes(`- ${r.from_city} > ${r.to_city} | ${r.vehicle.custom_name} | ₹${r.fare} | ${r.id}`), r.id);
  assert.ok(!text.includes(db.route_fares.find((r) => r.business_id === OTHER).id), 'the other business is not listed');
  assert.ok(!db.route_fares.filter((r) => r.trip_type === 'oneway').some((r) => text.includes(r.id)), 'no One Way fare is listed');
  assert.match(text, /3 of 3 still offered/);
  assert.match(text, /✓ pune>shirdi: 3 of 3 vehicle\(s\) priced by formula/);
  assert.match(text, /1 saved quote\(s\) reference these fares by id \(accepted\)/);
  assert.match(text, /marked off_reason = 'manual'/);
  assert.match(text, /Dry run only\. Re-run with --confirm/);
});

// ── Confirm ─────────────────────────────────────────────────────────────────────────────────────

test('--confirm: the manifest is written first, then only is_active flips on the listed rows; One Way, other columns and the other business are untouched', async () => {
  const ids = rtSg().map((r) => r.id);
  const others = (rows) => JSON.stringify(rows.filter((r) => !ids.includes(r.id)));
  const beforeOthers = others(db.route_fares);
  const beforeColumns = rtSg().map((r) => JSON.stringify({ ...r, is_active: undefined, off_reason: undefined }));

  const code = await go({ confirm: true, expectRows: 9 });
  assert.equal(code, 0, out());
  assert.equal(writes.length, 1);
  const manifest = manifests[MANIFEST];
  assert.equal(manifest.script, 'deactivateSgRoundTripFares');
  assert.equal(manifest.businessId, SG);
  assert.deepEqual(manifest.rows.map((r) => r.id).sort(), [...ids].sort());
  assert.deepEqual(manifest.rows[0], { id: manifest.rows[0].id, from_city: 'pune', to_city: manifest.rows[0].to_city, vehicle_id: manifest.rows[0].vehicle_id, vehicle: manifest.rows[0].vehicle, fare: manifest.rows[0].fare });

  assert.equal(active(rtSg()).length, 0);
  assert.equal(others(db.route_fares), beforeOthers);
  assert.deepEqual(rtSg().map((r) => JSON.stringify({ ...r, is_active: undefined, off_reason: undefined })), beforeColumns);
  // the deactivation is marked as on purpose; One Way rows and the other business carry no marker
  assert.ok(rtSg().every((r) => r.off_reason === 'manual'));
  assert.ok(db.route_fares.filter((r) => !ids.includes(r.id)).every((r) => r.off_reason === null));
  assert.equal(db.route_fares.filter((r) => r.trip_type === 'oneway' && r.is_active).length, 9);
  assert.equal(db.route_fares.find((r) => r.business_id === OTHER).is_active, true);
  assert.equal(db.travel_quotes.length, 1);
  assert.match(out(), /Switched off: 9 row\(s\)\. Exactly the listed rows: yes\. Their other columns unchanged: yes\. Every other route_fares row unchanged: yes\./);
});

test('--confirm is a no-op the second time: there is no active Round Trip fare left', async () => {
  await go({ confirm: true });
  lines = []; writes = [];
  assert.equal(await go({ confirm: true }), 0);
  assert.match(out(), /Nothing to do: there is no active Round Trip fare/);
  assert.equal(writes.length, 0);
});

test('--routes limits it to those routes; a later run on other routes adds to the same manifest', async () => {
  assert.equal(await go({ confirm: true, routes: ['pune>shirdi'] }), 0, out());
  assert.equal(active(rtSg()).length, 6);
  assert.equal(active(rtSg().filter((r) => r.to_city === 'shirdi')).length, 0);
  assert.equal(manifests[MANIFEST].rows.length, 3);
  lines = [];
  assert.equal(await go({ confirm: true, routes: ['pune>nashik'] }), 0, out());
  assert.equal(manifests[MANIFEST].rows.length, 6);
  assert.equal(manifests[MANIFEST].createdAt, '2026-11-10T10:00:00.000Z');
  assert.equal(active(rtSg()).length, 3);
});

test('--routes with a route that has no active Round Trip fare is refused', async () => {
  const code = await go({ confirm: true, routes: ['pune>mumbai'] });
  assert.equal(code, 1);
  assert.match(out(), /no active Round Trip fare for: pune>mumbai/);
});

// ── Rollback ────────────────────────────────────────────────────────────────────────────────────

test('--rollback dry run lists what would come back on and writes nothing', async () => {
  await go({ confirm: true });
  lines = [];
  const before = snapshot();
  assert.equal(await go({ mode: 'rollback' }), 0, out());
  assert.equal(snapshot(), before);
  assert.match(out(), /✓ the manifest logs\/test-manifest\.json exists/);
  assert.match(out(), /Plan: switch 9 of the 9 manifest row\(s\) back ON\./);
  assert.match(out(), /Dry run only\. Re-run with --rollback --confirm/);
});

test('--rollback --confirm switches back on exactly the manifest rows still off; a row switched off by hand and a row already on again are left alone', async () => {
  const original = snapshot();
  await go({ confirm: true });
  // an Etios fare the owner switched off by hand before the script (not in the manifest) stays off
  const handOff = db.route_fares.find((r) => r.business_id === SG && r.trip_type === 'oneway' && r.vehicle_id === 'v2');
  handOff.is_active = false;
  // one manifest row the owner already switched back on
  const alreadyOn = rtSg()[0];
  alreadyOn.is_active = true; alreadyOn.off_reason = null; // the owner switched it on through the API (clears the marker)
  lines = [];
  assert.equal(await go({ mode: 'rollback', confirm: true }), 0, out());
  assert.equal(active(rtSg()).length, 9);
  assert.equal(handOff.is_active, false);
  assert.match(out(), /Plan: switch 8 of the 9 manifest row\(s\) back ON\./);
  assert.match(out(), new RegExp(`\\. ${alreadyOn.id} {2}left alone`));
  assert.match(out(), /Exactly the planned rows: yes\. Every other route_fares row unchanged: yes/);
  handOff.is_active = true;
  assert.equal(snapshot(), original);
});

test('--rollback never touches another business, even if its id is in the manifest', async () => {
  await go({ confirm: true });
  const foreign = db.route_fares.find((r) => r.business_id === OTHER);
  foreign.is_active = false;
  manifests[MANIFEST].rows.push({ id: foreign.id });
  lines = [];
  assert.equal(await go({ mode: 'rollback', confirm: true }), 0, out());
  assert.equal(foreign.is_active, false);
});

test('--rollback without a manifest, or with one for another business, is refused', async () => {
  assert.equal(await go({ mode: 'rollback', confirm: true }), 1);
  assert.match(out(), /no usable manifest/);
  manifests[MANIFEST] = { script: 'deactivateSgRoundTripFares', businessId: OTHER, rows: [{ id: 'x' }] };
  lines = [];
  assert.equal(await go({ mode: 'rollback', confirm: true }), 1);
  assert.match(out(), /the manifest is for business/);
});

// ── Refusals ────────────────────────────────────────────────────────────────────────────────────

const refuses = async (over, pattern) => {
  const before = snapshot();
  const code = await go(over);
  assert.equal(code, 1, out());
  assert.match(out(), pattern);
  assert.equal(snapshot(), before);
  assert.deepEqual(manifests, {});
};

test('refuses any other business id, a business named like Search cab AI, and one that is not SG Travels', async () => {
  await refuses({ confirm: true, businessArg: OTHER }, /is not SG Travels' id/);
  lines = [];
  db.businesses[0].name = 'Search cab AI';
  await refuses({ confirm: true }, /this is Search cab AI/);
  lines = [];
  db.businesses[0].name = 'Some Cabs';
  await refuses({ confirm: true }, /not SG Travels/);
});

test('refuses when the migration is not applied', async () => {
  migration = false;
  await refuses({ confirm: true }, /apply supabase\/migrations\/20261106120000_round_trip_pricing\.sql first/);
});

test('refuses when the quote flow is not installed with the days first (the days would still come after the vehicles)', async () => {
  db.flow_edges = [];
  await refuses({ confirm: true }, /install the quote flow first/);
  lines = [];
  db.flow_edges = [E.paxToDays].map((id) => ({ id, business_id: SG }));
  await refuses({ confirm: true }, /install the quote flow first/);
});

test('refuses when another path reads these rows: a second active vehicle carousel in the flow', async () => {
  db.flow_nodes.push({ id: 'old-carousel', business_id: SG, node_type: 'vehicle_carousel', is_active: true });
  await refuses({ confirm: true }, /another vehicle carousel is active in SG Travels' flow \(old-carousel\)/);
  lines = [];
  db.flow_nodes[1].is_active = false; // a paused one reads nothing
  assert.equal(await go(), 0, out());
});

test('refuses when a route would be left with no active One Way fare', async () => {
  for (const r of db.route_fares.filter((x) => x.business_id === SG && x.to_city === 'goa' && x.trip_type === 'oneway')) r.is_active = false;
  await refuses({ confirm: true }, /no active One Way fare and would disappear: pune>goa/);
});

test('refuses when a route would stop being offered for Round Trip; --allow-routes-off goes ahead and says which', async () => {
  db.travel_routes[1].one_way_distance_km = null; // Nashik has no distance
  await refuses({ confirm: true }, /1 route\(s\) have no distance \/ min km \/ rate .*: pune>nashik/);
  assert.match(out(), /✗ pune>nashik: NOT offered for Round Trip \(add_distance\)/);
  assert.match(out(), /2 of 3 still offered/);
  lines = [];
  assert.equal(await go({ confirm: true, allowRoutesOff: true }), 0, out());
  assert.match(out(), /1 route\(s\) would no longer be offered for Round Trip \(--allow-routes-off was given\)/);
  assert.equal(active(rtSg()).length, 0);
});

test('a route stays offered when only some vehicles lack min km: the others are priced by formula', async () => {
  VEHICLES[1].min_km_per_day = null;
  assert.equal(await go(), 0, out());
  assert.match(out(), /✓ pune>shirdi: 2 of 3 vehicle\(s\) priced by formula/);
  VEHICLES[1].min_km_per_day = 250;
});

test('refuses when the expected row count does not match the plan', async () => {
  await refuses({ confirm: true, expectRows: 36 }, /--expect-rows=36 but the plan has 9 row\(s\)/);
});

test('a manifest of another script is never overwritten', async () => {
  manifests[MANIFEST] = { script: 'something else', rows: [] };
  const before = snapshot();
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /is not this script's manifest/);
  assert.equal(snapshot(), before);
});

// ── The off_reason marker ───────────────────────────────────────────────────────────────────────

test('the dry run says the fares will be marked manual and that unmarked off fares are still revived by a route toggle', async () => {
  assert.equal(await go(), 0, out());
  assert.match(out(), /✓ migration 20261107120000 is applied \(route_fares\.off_reason exists\)/);
  assert.match(out(), /marked off_reason = 'manual': switching a route off and on again, or saving a price on one of these Round Trip cells, leaves them off/);
  assert.match(out(), /already off WITHOUT that marker .* is still brought back by a route off \/ on/);
  assert.ok(!/re-activates the fare/.test(out()));
});

test('--rollback clears the marker together with switching the fare on', async () => {
  await go({ confirm: true });
  assert.ok(rtSg().every((r) => r.off_reason === 'manual' && r.is_active === false));
  lines = [];
  assert.equal(await go({ mode: 'rollback', confirm: true }), 0, out());
  assert.ok(rtSg().every((r) => r.off_reason === null && r.is_active === true));
  assert.match(out(), /Exactly the planned rows: yes/);
});

test('refuses (deactivate and rollback) when migration 20261107120000 is not applied: nothing is written, no manifest', async () => {
  marker = false;
  await refuses({ confirm: true }, /apply supabase\/migrations\/20261107120000_route_fares_off_reason\.sql first/);
  lines = [];
  manifests[MANIFEST] = { script: 'deactivateSgRoundTripFares', businessId: SG, rows: [{ id: 'fare-002' }] };
  const before = snapshot();
  assert.equal(await go({ mode: 'rollback', confirm: true }), 1);
  assert.match(out(), /apply supabase\/migrations\/20261107120000_route_fares_off_reason\.sql first/);
  assert.equal(snapshot(), before);
});

test('what the route API does afterwards: a deactivated fare survives a route off / on and a price save (the cascade skips off_reason manual)', async () => {
  await go({ confirm: true });
  // the same two statements travelRoute.service.js runs when a route is switched on and when a price is saved
  const pair = (r) => r.business_id === SG && r.to_city === 'shirdi';
  await fake.from('route_fares').update({ is_active: false }).eq('business_id', SG).eq('from_city', 'pune').eq('to_city', 'shirdi');
  await fake.from('route_fares').update({ is_active: true }).eq('business_id', SG).eq('from_city', 'pune').eq('to_city', 'shirdi').is('off_reason', null);
  assert.ok(db.route_fares.filter((r) => pair(r) && r.trip_type === 'round_trip').every((r) => r.is_active === false));
  assert.ok(db.route_fares.filter((r) => pair(r) && r.trip_type === 'oneway').every((r) => r.is_active === true));
});
