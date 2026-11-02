// Run: node --test src/services/quoteReadiness.service.test.js
// The "ready to enable the quote flow?" checklist: every rule of buildReadiness on its own, then getQuoteReadiness
// gathering the facts from an in-memory database with the real Travels default flow.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFakeSupabase } = require('../test-support/fakeSupabase');
const stub = (file, exports) => {
  const p = require.resolve(path.join(__dirname, file));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const holder = { fake: null };
stub('../config/env', { ENCRYPTION_KEY: 'x'.repeat(32) });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub('../config/supabase', { from: (t) => holder.fake.from(t), rpc: (n, a) => holder.fake.rpc(n, a) });
require('../test-support/stubRedis');
const fixture = require('../test-support/travelsDefaultFlowFixture');
const installer = require('./quoteFlowInstaller.service');
const { derive } = require('../utils/quoteFlowIds');
const readiness = require('./quoteReadiness.service');

const BIZ = fixture.BIZ;
const SEARCH_CAB = '8440ac0a-1f9f-4a30-95e3-19ad2adbe6a2';
const ids = derive(BIZ);

const vehicle = (name, over = {}) => ({ name, isActive: true, perKmRate: 14, minKmPerDay: 250, driverAllowancePerDay: 300, seats: 4, ...over });
const route = (n, over = {}) => ({ id: `r${n}`, isActive: true, fromLabel: 'Pune', toLabel: `City ${n}`, region: null, roundTrip: { ready: true, reason: null }, fromLabelTranslations: { hi: 'पुणे', mr: 'पुणे' }, toLabelTranslations: { hi: 'x', mr: 'x' }, regionTranslations: null, ...over });
const goodFacts = (over = {}) => ({
  businessId: BIZ, protectedBusiness: false, category: 'travels', featureOn: true, oneWayRoutes: 2, roundTripRoutes: 2,
  routes: [route(1), route(2)], vehicles: [vehicle('Dzire'), vehicle('Crysta', { seats: 7 })], settingsSaved: true,
  advance: { requireAdvancePayment: true, advancePaymentType: 'percentage', advancePaymentValue: 20, hasPaymentQr: true, hasUpi: true },
  whatsappConnected: true, subscription: { status: 'active', endDate: '2027-01-01T00:00:00Z' }, languages: ['en', 'hi', 'mr'],
  usage: { used: 100, cap: 50000, remaining: 49900 }, nodes: fixture.nodes(), edges: fixture.edges(), ...over
});
const check = (result, key) => result.items.find((i) => i.key === key);
const statuses = (result) => Object.fromEntries(result.items.map((i) => [i.key, i.status]));

// ── buildReadiness: one rule at a time ─────────────────────────────────────────────────────────

test('a fully set up business is ready: every item ok, no acknowledgement needed', () => {
  const r = readiness.buildReadiness(goodFacts());
  assert.equal(r.ready, true);
  assert.deepEqual([...new Set(Object.values(statuses(r)))], ['ok'], JSON.stringify(statuses(r)));
  assert.deepEqual(r.installed, { state: 'not_installed', nodes: 0, edges: 0 });
  assert.deepEqual(r.acknowledgements, [{ key: 'round_trip_to_team', text: 'Round Trip goes to my team', required: false }]);
  assert.deepEqual(r.keyword, { value: 'quote', aliases: installer.DEFAULT_ALIASES });
});

test('every item has a key, a status, a title and a detail', () => {
  for (const i of readiness.buildReadiness(goodFacts()).items) {
    assert.ok(i.key && ['ok', 'warn', 'block'].includes(i.status) && i.title && i.detail, i.key);
  }
});

test('the switch off only warns (Enable quotes turns it on) and enabled is false; a non-travel category blocks; the protected live business blocks', () => {
  assert.equal(check(readiness.buildReadiness(goodFacts({ featureOn: false })), 'feature').status, 'warn');
  assert.equal(readiness.buildReadiness(goodFacts({ featureOn: false })).ready, true);
  assert.equal(readiness.buildReadiness(goodFacts({ featureOn: false })).enabled, false);
  assert.equal(check(readiness.buildReadiness(goodFacts({ category: 'salon' })), 'category').status, 'block');
  const protectedRun = readiness.buildReadiness(goodFacts({ protectedBusiness: true }));
  assert.equal(check(protectedRun, 'not_protected').status, 'block');
  assert.equal(protectedRun.ready, false);
  assert.ok(!check(readiness.buildReadiness(goodFacts()), 'not_protected'), 'the item only appears for the protected business');
});

test('no One Way route blocks', () => {
  const r = readiness.buildReadiness(goodFacts({ oneWayRoutes: 0, roundTripRoutes: 0, routes: [] }));
  assert.equal(check(r, 'routes_one_way').status, 'block');
  assert.equal(r.ready, false);
});

test('no Round Trip route does NOT block: it warns, says why per route, and requires the acknowledgement', () => {
  const r = readiness.buildReadiness(goodFacts({
    roundTripRoutes: 0,
    routes: [route(1, { roundTrip: { ready: false, reason: 'add_distance' } }), route(2, { roundTrip: { ready: false, reason: 'add_min_km' } }), route(3, { roundTrip: { ready: false, reason: 'add_distance' } })]
  }));
  const item = check(r, 'routes_round_trip');
  assert.equal(item.status, 'warn');
  assert.match(item.detail, /2 x add distance, 1 x add min km/);
  assert.equal(item.requiresAcknowledgement, 'round_trip_to_team');
  assert.equal(r.ready, true, 'enabling is allowed');
  assert.equal(r.acknowledgements[0].required, true);
});

test('vehicle fields: a missing rate, minimum km or allowance is named per vehicle', () => {
  const r = readiness.buildReadiness(goodFacts({ vehicles: [vehicle('Dzire', { perKmRate: 0 }), vehicle('Etios', { minKmPerDay: null, driverAllowancePerDay: null }), vehicle('Crysta')] }));
  const item = check(r, 'vehicles');
  assert.equal(item.status, 'warn');
  assert.deepEqual(item.vehicles, ['Dzire (per-km rate)', 'Etios (minimum km per day, driver allowance (counted as 0))']);
  const off = readiness.buildReadiness(goodFacts({ vehicles: [vehicle('Old', { isActive: false, perKmRate: null }), vehicle('Crysta')] }));
  assert.equal(check(off, 'vehicles').status, 'ok', 'an inactive vehicle is not judged');
});

test('seats: a group size nobody fits, and vehicles with unknown seats, are reported (unknown seats are offered to everyone, not hidden)', () => {
  const small = readiness.buildReadiness(goodFacts({ vehicles: [vehicle('Dzire'), vehicle('Etios')] }));
  assert.equal(check(small, 'seats').status, 'warn');
  assert.deepEqual(check(small, 'seats').uncovered, ['5-6', '7+']);
  const unknown = readiness.buildReadiness(goodFacts({ vehicles: [vehicle('Dzire'), vehicle('Mystery', { seats: null })] }));
  assert.equal(check(unknown, 'seats').status, 'warn');
  assert.deepEqual(check(unknown, 'seats').uncovered, [], 'an unknown-seat vehicle is shown to every group size');
  assert.deepEqual(check(unknown, 'seats').unknownSeats, ['Mystery']);
});

test('settings not saved yet warns (the defaults apply); saved is ok', () => {
  assert.equal(check(readiness.buildReadiness(goodFacts({ settingsSaved: false })), 'settings').status, 'warn');
  assert.equal(check(readiness.buildReadiness(goodFacts()), 'settings').status, 'ok');
});

test('advance: off warns (Confirm books without payment); on without a QR warns; on with a QR is ok and mentions the UPI id', () => {
  const adv = (over) => goodFacts({ advance: { requireAdvancePayment: true, advancePaymentType: 'fixed', advancePaymentValue: 500, hasPaymentQr: true, hasUpi: true, ...over } });
  const off = check(readiness.buildReadiness(adv({ requireAdvancePayment: false })), 'advance');
  assert.equal(off.status, 'warn');
  assert.match(off.detail, /confirmed straight away without any payment/);
  const noQr = check(readiness.buildReadiness(adv({ hasPaymentQr: false })), 'advance');
  assert.equal(noQr.status, 'warn');
  assert.match(noQr.detail, /team will share the payment details/);
  const ok = check(readiness.buildReadiness(adv({})), 'advance');
  assert.equal(ok.status, 'ok');
  assert.match(ok.detail, /Rs 500.*UPI id/);
  assert.match(check(readiness.buildReadiness(adv({ hasUpi: false })), 'advance').detail, /no UPI id shown/);
});

test('WhatsApp not connected and no active plan each warn', () => {
  const r = readiness.buildReadiness(goodFacts({ whatsappConnected: false, subscription: null }));
  assert.equal(check(r, 'whatsapp').status, 'warn');
  assert.equal(check(r, 'subscription').status, 'warn');
  assert.equal(r.ready, true, 'they do not block the install');
});

test('keyword: an active reply that already uses it blocks; a paused one does not; a custom keyword is checked instead', () => {
  const taken = { ...fixture.nodes().find((n) => n.keyword === 'rates'), id: '00000000-0000-4000-8000-000000000999', keyword: 'quote', match_type: 'exact' };
  const blocked = readiness.buildReadiness(goodFacts({ nodes: [...fixture.nodes(), taken] }));
  assert.equal(check(blocked, 'keyword').status, 'block');
  assert.equal(blocked.ready, false);
  assert.equal(check(readiness.buildReadiness(goodFacts({ nodes: [...fixture.nodes(), { ...taken, is_active: false }] })), 'keyword').status, 'ok');
  const custom = readiness.buildReadiness(goodFacts({ nodes: [...fixture.nodes(), taken], entry: { keyword: 'fare' } }));
  assert.equal(check(custom, 'keyword').status, 'ok');
  assert.deepEqual(custom.keyword, { value: 'fare', aliases: [] });
});

test('Rates button: room is ok; no Rates reply warns (keyword only); three buttons block', () => {
  assert.equal(check(readiness.buildReadiness(goodFacts()), 'rates_button').status, 'ok');
  const noRates = fixture.nodes().filter((n) => n.id !== fixture.RATES);
  const warn = readiness.buildReadiness(goodFacts({ nodes: noRates, edges: fixture.edges().filter((e) => e.from_node_id !== fixture.RATES && e.to_node_id !== fixture.RATES) }));
  assert.equal(check(warn, 'rates_button').status, 'warn');
  assert.equal(warn.ready, true);
  const full = [...fixture.edges(), ...[1, 2].map((n) => ({ ...fixture.edges()[0], id: `00000000-0000-4000-8000-00000000088${n}`, from_node_id: fixture.RATES, label: `Extra ${n}` }))];
  const block = readiness.buildReadiness(goodFacts({ edges: full }));
  assert.equal(check(block, 'rates_button').status, 'block');
  assert.equal(block.ready, false);
});

test('the Travels default\'s own booking questions (same field keys) are not in the way', () => {
  const r = readiness.buildReadiness(goodFacts());
  assert.equal(check(r, 'flow').status, 'ok');
});

test('an existing quote flow of its own, or a question using a quote-only field key, blocks with the installer\'s reason', () => {
  const picker = { ...fixture.nodes()[2], id: '00000000-0000-4000-8000-000000000779', node_type: 'route_picker', field_key: 'pickRoute', is_computed: true };
  const r = readiness.buildReadiness(goodFacts({ nodes: [...fixture.nodes(), picker] }));
  assert.equal(r.installed.state, 'conflict');
  assert.equal(check(r, 'flow').status, 'block');
  const passengers = { ...fixture.nodes().find((n) => n.field_key === 'tripType'), id: '00000000-0000-4000-8000-000000000778', field_key: 'passengers' };
  const r2 = readiness.buildReadiness(goodFacts({ nodes: [...fixture.nodes(), passengers] }));
  assert.equal(check(r2, 'flow').status, 'block');
  assert.match(check(r2, 'flow').detail, /own field keys/);
});

test('installed: the derived rows are recognised; the keyword and button checks stop (their own rows would clash)', () => {
  const plan = installer.buildPlan({ businessId: BIZ, anchors: installer.findAnchors(fixture.nodes(), fixture.edges()) });
  const r = readiness.buildReadiness(goodFacts({ nodes: [...fixture.nodes(), ...plan.nodes], edges: [...fixture.edges(), ...plan.edges] }));
  assert.deepEqual(r.installed, { state: 'installed', nodes: 11, edges: 12 });
  assert.equal(check(r, 'keyword').status, 'ok');
  assert.equal(r.ready, true);
});

test('half installed: some derived rows but not all blocks', () => {
  const plan = installer.buildPlan({ businessId: BIZ, anchors: installer.findAnchors(fixture.nodes(), fixture.edges()) });
  const r = readiness.buildReadiness(goodFacts({ nodes: [...fixture.nodes(), plan.nodes[0]], edges: fixture.edges() }));
  assert.equal(r.installed.state, 'partial');
  assert.equal(check(r, 'flow').status, 'block');
  assert.equal(r.ready, false);
});

test('languages: en / hi / mr are built in; another enabled language warns until Translate runs; route names without a translation are counted', () => {
  assert.equal(check(readiness.buildReadiness(goodFacts()), 'languages').status, 'ok');
  const ta = readiness.buildReadiness(goodFacts({ languages: ['en', 'hi', 'ta'] }));
  assert.equal(check(ta, 'languages').status, 'warn');
  assert.match(check(ta, 'languages').detail, /ta show English until you press Translate/);
  assert.deepEqual(check(ta, 'languages').notBuiltIn, ['ta']);
  const gap = readiness.buildReadiness(goodFacts({ routes: [route(1), route(2, { toLabelTranslations: { hi: 'x' } })] }));
  assert.equal(check(gap, 'languages').status, 'warn');
  assert.deepEqual(check(gap, 'languages').routeGaps, { hi: 0, mr: 1 });
  assert.match(check(gap, 'languages').detail, /mr \(1\)/);
  const region = readiness.buildReadiness(goodFacts({ routes: [route(1, { region: 'West' })] }));
  assert.deepEqual(check(region, 'languages').routeGaps, { hi: 1, mr: 1 }, 'a region without a translation counts too');
});

test('translation budget: shown; warns only when translation is needed and nothing is left', () => {
  assert.equal(check(readiness.buildReadiness(goodFacts()), 'translation_budget').status, 'ok');
  assert.equal(check(readiness.buildReadiness(goodFacts({ languages: ['en', 'ta'], usage: { used: 50000, cap: 50000, remaining: 0 } })), 'translation_budget').status, 'warn');
  assert.equal(check(readiness.buildReadiness(goodFacts({ usage: { used: 50000, cap: 50000, remaining: 0 } })), 'translation_budget').status, 'ok', 'nothing to translate, nothing to spend');
  assert.ok(!check(readiness.buildReadiness(goodFacts({ usage: null })), 'translation_budget'));
});

// ── getQuoteReadiness: the facts, read from the database ──────────────────────────────────────

const freshDb = () => {
  holder.fake = createFakeSupabase();
  const db = holder.fake.db;
  db.businesses = [
    { id: BIZ, name: 'Demo Travels', display_name: null, business_category: 'travels', enabled_languages: ['en', 'hi'], require_advance_payment: true, advance_payment_type: 'fixed', advance_payment_value: 500, payment_qr_url: 'https://qr', upi_id: 'demo@upi', phone_number_id: '123' },
    { id: SEARCH_CAB, name: 'Search cab AI', display_name: 'Search cab AI', business_category: 'travels', enabled_languages: ['en', 'hi', 'mr'] }
  ];
  db.flow_nodes = fixture.nodes();
  db.flow_edges = fixture.edges();
  db.vehicles = [
    { id: 'v1', business_id: BIZ, custom_name: 'Dzire', is_active: true, per_km_rate: '13', min_km_per_day: '250', driver_allowance_per_day: '300', catalog: { name: 'Swift Dzire', seats: 4 } },
    { id: 'v2', business_id: BIZ, custom_name: null, is_active: true, per_km_rate: null, min_km_per_day: null, driver_allowance_per_day: null, catalog: { name: 'Innova', seats: 7 } }
  ];
  db.travel_quote_settings = [{ business_id: BIZ }];
  return db;
};
const deps = (over = {}) => ({
  supabase: holder.fake,
  isEnabled: async () => true,
  listQuotableRoutes: async (id, tripType) => (tripType === 'round_trip' ? [] : [{ id: 'r1' }]),
  listRoutes: async () => [route(1), { id: null, unlisted: true, isActive: true }],
  getSubscription: async () => ({ status: 'trial', end_date: '2026-12-01T00:00:00Z' }),
  getUsage: async () => ({ used: 10, cap: 100, remaining: 90 }),
  findProtectedBusinessIds: () => installer.findProtectedBusinessIds(holder.fake),
  ...over
});

test('getQuoteReadiness reads the business, vehicles, settings, flow, plan and budget and builds the checklist', async () => {
  freshDb();
  const r = await readiness.getQuoteReadiness(BIZ, {}, deps());
  assert.equal(r.ready, true, JSON.stringify(statuses(r)));
  assert.equal(check(r, 'routes_one_way').count, 1);
  assert.equal(check(r, 'routes_round_trip').status, 'warn');
  assert.equal(r.acknowledgements[0].required, true);
  assert.deepEqual(check(r, 'vehicles').vehicles, ['Innova (per-km rate, minimum km per day, driver allowance (counted as 0))'], 'the vehicle name falls back to the catalogue name');
  assert.equal(check(r, 'advance').status, 'ok');
  assert.equal(check(r, 'whatsapp').status, 'ok');
  assert.match(check(r, 'subscription').detail, /trial until 2026-12-01/);
  assert.equal(check(r, 'settings').status, 'ok');
  assert.deepEqual(check(r, 'languages').languages, ['en', 'hi']);
  assert.equal(check(r, 'translation_budget').usage.remaining, 90);
  assert.equal(r.installed.state, 'not_installed');
});

test('getQuoteReadiness is select-only: it writes nothing', async () => {
  const db = freshDb();
  const before = JSON.stringify(db);
  await readiness.getQuoteReadiness(BIZ, {}, deps());
  assert.equal(JSON.stringify(db), before);
});

test('Search cab AI is reported as blocked, by id from the fresh lookup', async () => {
  const db = freshDb();
  db.flow_nodes = fixture.nodes().map((n) => ({ ...n, business_id: SEARCH_CAB }));
  const r = await readiness.getQuoteReadiness(SEARCH_CAB, {}, deps());
  assert.equal(check(r, 'not_protected').status, 'block');
  assert.equal(r.ready, false);
});

test('a missing business is a 404; a failed translation-usage lookup only drops that item', async () => {
  freshDb();
  await assert.rejects(readiness.getQuoteReadiness('nope', {}, deps()), (e) => e.statusCode === 404);
  const r = await readiness.getQuoteReadiness(BIZ, {}, deps({ getUsage: async () => { throw new Error('boom'); } }));
  assert.ok(!check(r, 'translation_budget'));
  assert.equal(r.ready, true);
});

test('the keyword the owner is considering is checked, and echoed back', async () => {
  freshDb();
  const r = await readiness.getQuoteReadiness(BIZ, { keyword: 'Rates' }, deps());
  assert.equal(check(r, 'keyword').status, 'block');
  assert.deepEqual(r.keyword, { value: 'rates', aliases: [] });
});

test('the service names no business and no fixed id', () => {
  const source = require('node:fs').readFileSync(require.resolve('./quoteReadiness.service'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/5eed7a01|a94aec66|8440ac0a|sg\s*travels|search\s*cab/i.test(source));
});
