// Run: node --test src/services/bookingGraph.roundTripQuote.test.js
// A Round Trip quote through the real graph engine AND the real travelQuote.service pricing: days asked
// before the vehicle carousel, routes offered only when a vehicle can be priced, every card priced for the
// days chosen, the tap pricing the same vehicle again from fresh rows, and "owner confirms" when something
// is missing. Rows live in an in-memory database; nothing else is real. No network.
const path = require('path');
const stub = (relativePath, exports) => {
  const resolved = require.resolve(path.join(__dirname, relativePath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const BIZ = 'b1';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n, extra) => ({
  id: id(n), business_id: BIZ, node_type: 'question', keyword: null, match_type: null, reply_kind: null, content_type: 'text',
  label: `Q${n}`, field_key: `f${n}`, options: [], is_computed: false, is_active: true, required: true, ...extra
});
const TRIP = id(1); const PICKER = id(2); const PAX = id(3); const CAR = id(4); const DATE = id(6); const TIME = id(7); const QUOTE = id(9); const DAYS = id(10);
const NODES = [
  node(1, { field_key: 'tripType', content_type: 'buttons', label: 'Trip?', options: ['One Way', 'Round Trip'] }),
  node(2, { node_type: 'route_picker', field_key: 'routePicker', content_type: 'list', label: 'Where to?', is_computed: true }),
  node(3, { field_key: 'passengers', content_type: 'buttons', label: 'How many?', options: ['1-4', '5-6', '7+'] }),
  node(4, { node_type: 'vehicle_carousel', field_key: 'vehicleType', content_type: 'list', label: 'Pick a vehicle', is_computed: true }),
  node(6, { field_key: 'travelDate', content_type: 'buttons', label: 'When?', options: ['Today', 'Tomorrow'] }),
  node(7, { field_key: 'pickupTime', content_type: 'list', label: 'What time?', options: ['6:00 AM', '10:00 PM'] }),
  node(9, { node_type: 'quote', field_key: 'quote', content_type: 'text', label: 'Your quote', is_computed: true }),
  node(10, { field_key: 'numberOfDays', content_type: 'list', label: 'How many days?', options: ['1', '2', '3', '4'] })
];
const edge = (n, from, to, extra) => ({ id: id(100 + n), business_id: BIZ, from_node_id: from, to_node_id: to, display_order: 0, condition: null, preset: null, ...extra });
const roundTrip = { field: 'tripType', equals: 'Round Trip' };
// Round Trip: the days are asked before the vehicles; One Way goes straight to the vehicles
const EDGES = [
  edge(1, TRIP, PICKER), edge(2, PICKER, PAX),
  edge(3, PAX, DAYS, { condition: roundTrip, display_order: 0 }), edge(4, PAX, CAR, { display_order: 1 }),
  edge(5, DAYS, CAR), edge(6, CAR, DATE), edge(7, DATE, TIME), edge(8, TIME, QUOTE)
];

let db;
const from = (table) => {
  const filters = [];
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
    maybeSingle: async () => ({ data: (db[table] || []).filter(r => filters.every(f => f(r)))[0] || null, error: null }),
    then: (resolve, reject) => Promise.resolve({ data: (db[table] || []).filter(r => filters.every(f => f(r))), error: null }).then(resolve, reject)
  };
  return q;
};
stub('../config/redis', {});
stub('../config/supabase', { from });
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {} });
stub('../queues/sessionTimeout.queue', { addToSessionTimeoutQueue: async () => {} });
stub('./socket.service', {});
stub('./payment.service', {});
stub('./distanceMatrix.service', {});
stub('./reports.service', { getPeriodRanges: () => ({}) });
stub('./business.service', { getBusinessById: async () => ({ id: BIZ, businessCategory: 'travels', travelSettings: {}, disabledBookingFields: [] }) });
stub('./categoryFeature.service', { isEnabled: async () => true });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

const test = require('node:test');
const assert = require('node:assert/strict');
const bookingGraph = require('./bookingGraph.service');

const vehicle = (n, name, seats, extra) => ({
  id: `v${n}`, custom_name: name, custom_photo_url: null, is_active: true,
  per_km_rate: null, min_km_per_day: null, driver_allowance_per_day: null, catalog: { name, photo_url: null, seats }, ...extra
});
const fareRow = (n, v, tripType, fare) => ({
  id: `rf${n}`, business_id: BIZ, from_city: 'pune', to_city: 'shirdi', trip_type: tripType, vehicle_id: v.id, fare, is_active: true, route_id: 'r1', vehicle: v
});

let INNOVA; let DZIRE; let ETIOS;
test.beforeEach(() => {
  INNOVA = vehicle(1, 'Innova Crysta', 7, { per_km_rate: 23, min_km_per_day: 250, driver_allowance_per_day: 300 });
  DZIRE = vehicle(2, 'Dzire', 4); // a fixed Round Trip package price, nothing else set
  ETIOS = vehicle(3, 'Etios', 4, { per_km_rate: 16, min_km_per_day: null }); // min km missing: the owner confirms
  db = {
    flow_nodes: NODES,
    flow_edges: EDGES,
    travel_routes: [
      { id: 'r1', business_id: BIZ, from_city: 'pune', to_city: 'shirdi', from_label: 'Pune', to_label: 'Shirdi', region: null, sort_order: 0, is_active: true, one_way_distance_km: 185 },
      { id: 'r2', business_id: BIZ, from_city: 'pune', to_city: 'goa', from_label: 'Pune', to_label: 'Goa', region: null, sort_order: 1, is_active: true, one_way_distance_km: null }
    ],
    route_fares: [
      fareRow(1, INNOVA, 'oneway', 4200), fareRow(2, DZIRE, 'oneway', 3000), fareRow(3, DZIRE, 'round_trip', 5200), fareRow(4, ETIOS, 'oneway', 3000),
      // Goa: only an unpriceable Etios -> no Round Trip there
      { ...fareRow(5, ETIOS, 'oneway', 9000), id: 'rf5', to_city: 'goa', route_id: 'r2' }
    ],
    vehicles: [{ id: 'v1', business_id: BIZ, is_active: true }, { id: 'v2', business_id: BIZ, is_active: true }, { id: 'v3', business_id: BIZ, is_active: true }],
    travel_quote_settings: []
  };
});

const start = () => bookingGraph.startGraphSessionAtNode(BIZ, TRIP, 'rule1', 'en');
const say = (session, reply, lang = 'en') => bookingGraph.advanceGraphSession({ businessId: BIZ, session, reply, languageCode: lang });
const values = (field) => field.options.map(o => o.value);

// Round Trip, Pune -> Shirdi, party of 1-4, for `days` days: lands on the vehicle carousel
const toCarousel = async (days = '3', band = '1-4') => {
  const { session } = await start();
  let r = await say(session, 'Round Trip');
  r = await say(r.session, 'to:r1');
  r = await say(r.session, band);
  assert.equal(r.result.fieldType, 'list', 'the days are asked before the vehicles');
  assert.equal(r.result.label, 'How many days?');
  return say(r.session, days);
};

test('Round Trip offers only routes where a vehicle can be priced: Shirdi yes, Goa (no distance, no package) no', async () => {
  const { session } = await start();
  const r = await say(session, 'Round Trip');
  assert.deepEqual(values(r.result), ['to:r1', 'other']);
  // One Way is unchanged: both routes (they have one-way fares)
  const { session: s2 } = await start();
  const oneWay = await say(s2, 'One Way');
  assert.deepEqual(values(oneWay.result), ['to:r1', 'to:r2', 'other']);
});

test('a route becomes offered as soon as it has a distance and a vehicle with min km and a rate', async () => {
  db.travel_routes[1].one_way_distance_km = 450;
  ETIOS.min_km_per_day = 250;
  const { session } = await start();
  const r = await say(session, 'Round Trip');
  assert.deepEqual(values(r.result), ['to:r1', 'to:r2', 'other']);
});

test('One Way skips the days question and keeps the plain fare cards', async () => {
  const { session } = await start();
  let r = await say(session, 'One Way');
  r = await say(r.session, 'to:r1');
  r = await say(r.session, '1-4');
  assert.equal(r.result.fieldType, 'vehicle_carousel');
  assert.deepEqual(r.result.options.map(o => [o.name, o.fare, o.source, o.priceDisplay]), [['Innova Crysta', 4200, 'route_fare', undefined], ['Dzire', 3000, 'route_fare', undefined], ['Etios', 3000, 'route_fare', undefined]]);
});

test('the cards are priced for the days chosen: formula, package, and "team will confirm"', async () => {
  const r = await toCarousel('3');
  assert.equal(r.result.fieldType, 'vehicle_carousel');
  const cards = r.result.options.map(o => [o.name, o.fare, o.source, o.priceDisplay]);
  assert.deepEqual(cards, [
    ['Innova Crysta', 18150, 'quote_vehicle', { kind: 'formula', total: 18150, days: 3, billedKm: 750 }],
    ['Dzire', 5200, 'quote_vehicle', { kind: 'package', total: 5200, days: 3, billedKm: null }],
    ['Etios', null, 'quote_vehicle', { kind: 'on_request' }]
  ]);
  assert.deepEqual(r.result.options.map(o => o.index), [0, 1, 2]);
  // another day count, another formula price; the package price does not move
  const one = await toCarousel('1');
  assert.deepEqual(one.result.options.map(o => o.fare), [8810, 5200, null]);
});

test('the seat filter applies to the Round Trip cards', async () => {
  const r = await toCarousel('2', '5-6');
  assert.deepEqual(r.result.options.map(o => o.name), ['Innova Crysta']);
});

test('tap a formula vehicle: priced again, the session carries the km charge and the snapshot, the flow goes on', async () => {
  const carousel = await toCarousel('3');
  const r = await say(carousel.session, '0');
  assert.equal(r.result.label, 'When?');
  const c = r.session.collected;
  assert.deepEqual([c.vehicleId, c.vehicleName, c.vehicleFare, c.routeFareId, c.fareSource], ['v1', 'Innova Crysta', 17250, null, 'rate_formula']);
  assert.deepEqual(
    [c.quotePricing.method, c.quotePricing.total, c.quotePricing.billedKm, c.quotePricing.days, c.quotePricing.allowance.amount],
    ['formula', 18150, 750, 3, 900]
  );
});

test('tap a package vehicle: the fixed price as entered, from its route fare row', async () => {
  const carousel = await toCarousel('4');
  const r = await say(carousel.session, '1');
  const c = r.session.collected;
  assert.deepEqual([c.vehicleId, c.vehicleFare, c.routeFareId, c.fareSource, c.quotePricing.method], ['v2', 5200, 'rf3', 'route_fare', 'package']);
});

test('tap a vehicle the owner has to price: the vehicle is kept and the engine hands off with what is missing', async () => {
  const carousel = await toCarousel('3');
  const r = await say(carousel.session, '2');
  assert.deepEqual(r.result, { quote: { action: 'handoff', reason: 'price_on_request', pricingReason: 'missing_min_km' } });
  assert.deepEqual([r.session.collected.vehicleId, r.session.collected.vehicleName, r.session.collected.numberOfDays], ['v3', 'Etios', '3']);
});

test('a route without a distance: its vehicles with a package price still price; the others hand off with missing_distance', async () => {
  db.travel_routes[0].one_way_distance_km = null;
  const carousel = await toCarousel('3');
  assert.deepEqual(carousel.result.options.map(o => o.fare), [null, 5200, null]);
  const r = await say(carousel.session, '0');
  assert.equal(r.result.quote.pricingReason, 'missing_distance');
});

test('the owner changes a price between the card and the tap: the cards are shown again, nothing is quoted', async () => {
  const carousel = await toCarousel('3');
  INNOVA.per_km_rate = 25; // 750 x 25 + 900 = 19,650
  const r = await say(carousel.session, '0');
  assert.equal(r.result, 'The prices were just updated. Please choose again:');
  assert.deepEqual(r.session.currentNodeComputedOptions.map(o => o.fare), [19650, 5200, null]);
  assert.equal(r.session.collected.vehicleFare, undefined);
  // choosing again quotes the new price
  const again = await say(r.session, '0');
  assert.equal(again.session.collected.quotePricing.total, 19650);
});

test('the allowance basis setting prices per night: 3 days = 17,850', async () => {
  db.travel_quote_settings = [{ business_id: BIZ, allowance_basis: 'night' }];
  const r = await toCarousel('3');
  assert.equal(r.result.options[0].fare, 17850);
});

test('a vehicle switched off, or a route switched off, between card and tap is stale: the rest is offered again', async () => {
  const carousel = await toCarousel('3');
  DZIRE.is_active = false;
  const r = await say(carousel.session, '1');
  assert.equal(r.result, 'Sorry, that vehicle is no longer available for this route. Here are the current options:');
  assert.deepEqual(r.session.currentNodeComputedOptions.map(o => o.name), ['Innova Crysta', 'Etios']);
  db.travel_routes[0].is_active = false;
  const gone = await say(r.session, '0');
  assert.deepEqual(gone.result, { quote: { action: 'no_vehicle', reason: null } });
});

test('without the days yet (the old question order) a formula vehicle shows "team will confirm", a package price still shows', async () => {
  const { session } = await start();
  let r = await say(session, 'Round Trip');
  r = await say(r.session, 'to:r1');
  // simulate the older order: the carousel before the days
  r.session.collected.numberOfDays = undefined;
  const options = await require('./travelQuote.service').listRoundTripVehicleOptions(BIZ, 'r1', null);
  assert.deepEqual(options.map(o => [o.name, o.fare, o.priceDisplay.kind]), [['Innova Crysta', null, 'on_request'], ['Dzire', 5200, 'package'], ['Etios', null, 'on_request']]);
});

// ── Fares of a switched-off route, and fares switched off on purpose ─────────────────────────────────

test('the quote readers hide a switched-off route and its fares: not offered for One Way or Round Trip, no cards, a tap is stale', async () => {
  const quoteService = require('./travelQuote.service');
  assert.deepEqual((await quoteService.listQuotableRoutes(BIZ, 'round_trip')).map(r => r.id), ['r1']);
  assert.deepEqual((await quoteService.listQuotableRoutes(BIZ, 'oneway')).map(r => r.id), ['r1', 'r2']);
  db.travel_routes[0].is_active = false; // the fares keep their own flags: whatever the route does to them, the route flag alone hides them
  assert.deepEqual((await quoteService.listQuotableRoutes(BIZ, 'round_trip')).map(r => r.id), []);
  assert.deepEqual((await quoteService.listQuotableRoutes(BIZ, 'oneway')).map(r => r.id), ['r2']);
  assert.deepEqual(await quoteService.listRoundTripVehicleOptions(BIZ, 'r1', 3), []);
  assert.deepEqual(await quoteService.priceRoundTripVehicle(BIZ, 'r1', 'v1', 3), { stale: true });
});

test('a Round Trip fare switched off on purpose is never used as a package price: the vehicle falls back to the formula or "team will confirm"', async () => {
  const dzireRoundTrip = db.route_fares.find(f => f.id === 'rf3');
  assert.equal(dzireRoundTrip.trip_type, 'round_trip');
  dzireRoundTrip.is_active = false;
  dzireRoundTrip.off_reason = 'manual';
  DZIRE.per_km_rate = 13; DZIRE.min_km_per_day = 250; // Dzire can now be priced by formula: 750 km x 13 = 9,750 for 3 days
  const quoteService = require('./travelQuote.service');
  const cards = await quoteService.listRoundTripVehicleOptions(BIZ, 'r1', 3);
  assert.deepEqual(cards.map(o => [o.name, o.fare, o.priceDisplay.kind]), [['Innova Crysta', 18150, 'formula'], ['Dzire', 9750, 'formula'], ['Etios', null, 'on_request']]);
  // and with nothing to price it by, the route is not offered through that fare either
  DZIRE.per_km_rate = null; DZIRE.min_km_per_day = null;
  db.travel_routes[0].one_way_distance_km = null;
  INNOVA.min_km_per_day = null;
  assert.deepEqual((await quoteService.listQuotableRoutes(BIZ, 'round_trip')).map(r => r.id), []);
});
