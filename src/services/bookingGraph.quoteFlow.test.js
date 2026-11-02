// Run: node --test src/services/bookingGraph.quoteFlow.test.js
// The travel-quote flow through the real graph engine: trip type -> route_picker -> passengers -> vehicle
// carousel (rate card, filtered by seats) -> date -> pickup time -> quote. Served from an in-memory
// flow_nodes / flow_edges; the route list, vehicle lookup and feature switch are stubbed. No database.
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
const TRIP = id(1); const PICKER = id(2); const PAX = id(3); const CAR = id(4); const CAR_FALLBACK = id(5);
const DATE = id(6); const TIME = id(7); const TIME_MANUAL = id(8); const QUOTE = id(9); const DAYS = id(10);

const NODES = [
  node(1, { field_key: 'tripType', content_type: 'buttons', label: 'Trip?', options: ['One Way', 'Round Trip'] }),
  node(2, { node_type: 'route_picker', field_key: 'routePicker', content_type: 'list', label: 'Where to?', is_computed: true }),
  node(3, { field_key: 'passengers', content_type: 'buttons', label: 'How many?', options: ['1-4', '5-6', '7+'] }),
  node(4, { node_type: 'vehicle_carousel', field_key: 'vehicleType', content_type: 'list', label: 'Pick a vehicle', is_computed: true }),
  node(5, { field_key: 'vehicleType', content_type: 'list', label: 'Which vehicle?', options: ['Sedan', 'SUV'] }),
  node(6, { field_key: 'travelDate', content_type: 'buttons', label: 'When?', options: ['Today', 'Tomorrow', 'Other date'] }),
  node(7, { field_key: 'pickupTime', content_type: 'list', label: 'What time?', options: ['6:00 AM', '10:00 PM', 'Other time'] }),
  node(8, { field_key: 'pickupTime', content_type: 'text', label: 'Type the pickup time' }),
  node(9, { node_type: 'quote', field_key: 'quote', content_type: 'text', label: 'Your quote', is_computed: true }),
  node(10, { field_key: 'numberOfDays', content_type: 'text', label: 'How many days?' })
];
const edge = (n, from, to, extra) => ({ id: id(100 + n), business_id: BIZ, from_node_id: from, to_node_id: to, display_order: 0, condition: null, preset: null, ...extra });
const EDGES = [
  edge(1, TRIP, PICKER), edge(2, PICKER, PAX), edge(3, PAX, CAR), edge(4, CAR, DATE), edge(5, DATE, TIME), edge(6, TIME, QUOTE), edge(7, TIME_MANUAL, QUOTE)
];

const from = (table) => {
  if (table === 'route_fares') {
    // the tap re-reads the chosen fare row (stale check)
    let wanted = null;
    const q = {
      select: () => q,
      eq: (col, val) => { if (col === 'id') wanted = val; return q; },
      maybeSingle: async () => ({ data: (state.fares.find(f => f.id === wanted) && { ...state.fares.find(f => f.id === wanted), is_active: true }) || null })
    };
    return q;
  }
  const rows = () => (table === 'flow_nodes' ? NODES : EDGES);
  const q = { select: () => q, eq: () => q, then: (resolve, reject) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject) };
  return q;
};
const state = { quotesOn: true, routes: [], fares: [] };
stub('../config/redis', {});
stub('../config/supabase', { from });
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {} });
stub('../queues/sessionTimeout.queue', { addToSessionTimeoutQueue: async () => {} });
stub('./socket.service', {});
stub('./payment.service', {});
stub('./distanceMatrix.service', {});
stub('./business.service', { getBusinessById: async () => ({ id: BIZ, businessCategory: 'travels', travelSettings: {}, disabledBookingFields: [] }) });
stub('./categoryFeature.service', { isEnabled: async (category, feature, businessId) => { assert.equal(feature, 'travel_quotes'); assert.equal(businessId, BIZ); return state.quotesOn; } });
stub('./travelQuote.service', { listQuotableRoutes: async (businessId, tripType) => { state.lastTripType = tripType; return state.routes; } });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

const test = require('node:test');
const assert = require('node:assert/strict');
const bookingService = require('./booking.service');
const bookingGraph = require('./bookingGraph.service');

// route_fares rows the vehicle lookup would return (joined shape findMatchingVehicleOptions gives back)
const fare = (n, name, seats, amount) => ({
  id: `rf${n}`, fare: amount, vehicle: { id: `v${n}`, custom_name: name, custom_photo_url: null, is_active: true, catalog: { name, photo_url: null, seats } }
});
bookingService.findMatchingVehicleOptions = async (businessId, pickup, drop, tripType) => {
  state.lastLookup = { pickup, drop, tripType };
  return state.fares;
};

const route = (n, extra) => ({ id: `r${n}`, fromCity: 'pune', toCity: `city${n}`, fromLabel: 'Pune', toLabel: `City ${n}`, region: 'West', sortOrder: n, ...extra });

test.beforeEach(() => {
  state.quotesOn = true;
  state.routes = [route(1), route(2)];
  state.fares = [fare(1, 'Dzire', 4, 2500), fare(2, 'Etios', 4, 2500), fare(3, 'Crysta', 7, 3500)];
  state.lastLookup = null;
});

const start = () => bookingGraph.startGraphSessionAtNode(BIZ, TRIP, 'rule1', 'en');
const say = async (session, reply, lang = 'en') => bookingGraph.advanceGraphSession({ businessId: BIZ, session, reply, languageCode: lang });
const values = (field) => field.options.map(o => o.value);

// One Way, Pune -> City 1, up to the passengers question
const toPassengers = async (tripType = 'One Way') => {
  let { session, field } = await start();
  assert.equal(field.fieldType, 'buttons');
  let r = await say(session, tripType);
  assert.equal(r.result.fieldType, 'list');
  return say(r.session, 'to:r1');
};

test('trip type -> route picker: a single From is skipped; the To list has the cities and "Other route"', async () => {
  const { session } = await start();
  const { result } = await say(session, 'One Way');
  assert.equal(result.fieldType, 'list');
  assert.equal(result.label, 'Where do you want to go? 🚕');
  assert.deepEqual(values(result), ['to:r1', 'to:r2', 'other']);
  assert.deepEqual(result.options.map(o => o.label), ['City 1', 'City 2', 'Other route']);
  assert.equal(state.lastTripType, 'oneway');
});

test('the picker prompt and the fixed rows follow the customer\'s language', async () => {
  const { session } = await start();
  const { result } = await say(session, 'One Way', 'hi');
  assert.equal(result.label, 'आप कहाँ जाना चाहते हैं? 🚕');
  assert.equal(result.options.at(-1).label, 'अन्य रूट');
});

test('choosing a route sets the city keys + labels the vehicle lookup and the quote use, then asks passengers', async () => {
  const r = await toPassengers();
  assert.equal(r.result.label, 'How many?');
  assert.deepEqual(
    [r.session.collected.quoteRouteId, r.session.collected.pickupLocation, r.session.collected.dropLocation, r.session.collected.quoteFromLabel, r.session.collected.quoteToLabel],
    ['r1', 'pune', 'city1', 'Pune', 'City 1']
  );
  assert.equal(r.session.routePicker, null);
  assert.equal(r.session.currentNodeId, PAX);
});

test('a route with no labels is quoted as the title-cased city keys; a long custom label is not clipped', async () => {
  const long = 'Pune Airport Terminal Pickup Point';
  state.routes = [route(1, { fromCity: 'pune', toCity: 'shirdi', fromLabel: null, toLabel: null }), route(2, { toLabel: long })];
  const a = await toPassengers();
  assert.deepEqual([a.session.collected.quoteFromLabel, a.session.collected.quoteToLabel], ['Pune', 'Shirdi']);
  assert.equal(a.session.collected.pickupLocation, 'pune'); // the vehicle lookup still gets the city key
  const { session } = await start();
  await say(session, 'One Way');
  const b = await say(session, 'to:r2');
  assert.equal(b.session.collected.quoteToLabel, long);
});

test('a typed city name or a row number also picks the row; an unknown reply re-asks without moving', async () => {
  const { session } = await start();
  let r = await say(session, 'One Way');
  const bad = await say(r.session, 'Atlantis');
  assert.match(bad.result, /^Please choose one of: City 1, City 2, Other route$/);
  assert.equal(bad.session.currentNodeId, PICKER);
  r = await say(bad.session, 'city 2');
  assert.equal(r.session.collected.quoteRouteId, 'r2');
  const { session: s2 } = await start();
  const r2 = await say((await say(s2, 'One Way')).session, '1');
  assert.equal(r2.session.collected.quoteRouteId, 'r1');
});

test('the "choose one of" and "tap a vehicle" replies follow the customer language; English is unchanged', async () => {
  const { session } = await start();
  const picker = await say(session, 'One Way', 'hi');
  const bad = await say(picker.session, 'Atlantis', 'hi');
  assert.equal(bad.result, 'कृपया इनमें से एक चुनें: City 1, City 2, अन्य रूट');
  const { session: s2 } = await toPassengers();
  const carousel = await say(s2, '1-4', 'mr');
  assert.equal((await say(carousel.session, 'zzz', 'mr')).result, 'कृपया वरील वाहन पर्यायांपैकी एक निवडा.');
  assert.equal((await say(carousel.session, 'zzz', 'en')).result, 'Please tap one of the vehicle options above.');
});

test('"Other route" hands off', async () => {
  const { session } = await start();
  const r = await say((await say(session, 'One Way')).session, 'other');
  assert.deepEqual(r.result, { quote: { action: 'handoff', reason: 'other_route' } });
});

test('more than 9 destinations: areas first, then that area\'s cities', async () => {
  state.routes = Array.from({ length: 11 }, (_, i) => route(i, { region: i < 6 ? 'West' : 'North' }));
  const { session } = await start();
  let r = await say(session, 'One Way');
  assert.equal(r.result.label, 'Which area do you want to go to?');
  assert.deepEqual(values(r.result), ['region:West', 'region:North', 'other']);
  r = await say(r.session, 'region:North');
  assert.equal(r.result.label, 'Where do you want to go? 🚕');
  assert.equal(r.result.options.length, 6);
  assert.equal(r.session.currentNodeId, PICKER);
  r = await say(r.session, 'to:r8');
  assert.equal(r.session.collected.quoteRouteId, 'r8');
});

test('seat filter: 1-4 shows every vehicle, 5-6 and 7+ only the 7-seater; the list is numbered again', async () => {
  const cases = { '1-4': ['Dzire', 'Etios', 'Crysta'], '5-6': ['Crysta'], '7+': ['Crysta'] };
  for (const [band, names] of Object.entries(cases)) {
    const { session } = await toPassengers();
    const r = await say(session, band);
    assert.equal(r.result.fieldType, 'vehicle_carousel', band);
    assert.deepEqual(r.result.options.map(o => o.name), names, band);
    assert.deepEqual(r.result.options.map(o => o.index), names.map((_, i) => i), band);
    assert.deepEqual(r.session.currentNodeComputedOptions.map(o => o.index), names.map((_, i) => i), band);
  }
  assert.deepEqual(state.lastLookup, { pickup: 'pune', drop: 'city1', tripType: 'One Way' });
});

test('no vehicle seats the party: the engine says so instead of falling back to the fare-less vehicle list', async () => {
  state.fares = [fare(1, 'Dzire', 4, 2500)];
  const { session } = await toPassengers();
  const r = await say(session, '7+');
  assert.deepEqual(r.result, { quote: { action: 'no_vehicle', reason: null } });
});

test('"Other options" on the carousel hands off in a quote flow', async () => {
  const { session } = await toPassengers();
  const carousel = await say(session, '1-4');
  const r = await say(carousel.session, 'other');
  assert.deepEqual(r.result, { quote: { action: 'handoff', reason: 'other_vehicle' } });
});

test('tapping a vehicle whose fare was switched off meanwhile: re-offers the rest, or no_vehicle when none is left', async () => {
  const supabaseStub = require('../config/supabase');
  const { session } = await toPassengers();
  const carousel = await say(session, '1-4');
  // the tap re-reads the fare row: make it inactive
  const original = supabaseStub.from;
  supabaseStub.from = (table) => {
    if (table !== 'route_fares') return original(table);
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { id: 'rf1', is_active: false, vehicle: { is_active: true } } }) };
    return q;
  };
  try {
    let r = await say(carousel.session, '0');
    assert.match(r.result, /no longer available/);
    state.fares = [];
    r = await say(carousel.session, '0');
    assert.deepEqual(r.result, { quote: { action: 'no_vehicle', reason: null } });
  } finally { supabaseStub.from = original; }
});

test('full path: vehicle tap -> date -> pickup time slot -> {quote: send} with the pickup minute', async () => {
  const { session } = await toPassengers();
  let r = await say(session, '1-4');
  r = await say(r.session, '2'); // Crysta
  assert.deepEqual([r.session.collected.vehicleFare, r.session.collected.vehicleName], [3500, 'Crysta']);
  assert.equal(r.result.label, 'When?');
  r = await say(r.session, 'Today');
  assert.equal(r.result.label, 'What time?');
  r = await say(r.session, '10:00 PM');
  assert.deepEqual(r.result, { quote: { action: 'send', reason: null, nodeId: QUOTE } });
  assert.equal(r.session.currentNodeId, QUOTE);
  assert.equal(r.session.collected.pickupMinute, 1320);
  assert.equal(r.session.collected.passengers, '1-4');
  assert.equal(r.session.collected.tripType, 'One Way');
});

test('a typed pickup time: unreadable is asked again (same question), readable is stored as a minute', async () => {
  const { session } = await toPassengers();
  let r = await say(session, '1-4');
  r = await say(r.session, '0');
  r = await say(r.session, 'Tomorrow');
  r = await say(r.session, 'Other time');
  assert.equal(r.result.label, 'Type the pickup time');
  const answered = r.session.answeredFields.length;
  for (const bad of ['morning', '', '6']) {
    const again = await say(r.session, bad);
    // a blank reply to a required question gets the plain question (existing rule); anything else the hint first
    const hint = "Sorry, I couldn't read that time. Please type it like 6:30 AM or 18:30.\n\nType the pickup time";
    assert.equal(again.result, bad === '' ? 'Type the pickup time' : hint, bad);
    assert.equal(again.session.currentNodeId, TIME_MANUAL);
    assert.equal(again.session.answeredFields.length, answered);
  }
  const ok = await say(r.session, '7.30 pm');
  assert.equal(ok.result.quote.action, 'send');
  assert.equal(ok.session.collected.pickupMinute, 19 * 60 + 30);
});

test('the typed-time check is Hindi / Marathi aware', async () => {
  const { session } = await toPassengers();
  let r = await say(session, '1-4');
  r = await say(r.session, '0');
  r = await say(r.session, 'Tomorrow');
  r = await say(r.session, 'Other time');
  const again = await say(r.session, 'सुबह', 'hi');
  assert.match(again.result, /^माफ़ कीजिए, मैं यह समय समझ नहीं पाया/);
});

test('switch off: entering the picker goes to the team, nothing else is asked', async () => {
  state.quotesOn = false;
  const { session } = await start();
  const r = await say(session, 'One Way');
  assert.deepEqual(r.result, { quote: { action: 'handoff', reason: 'switch_off' } });
});

test('no quotable routes (or a local rental): handoff', async () => {
  state.routes = [];
  const { session } = await start();
  const r = await say(session, 'One Way');
  assert.deepEqual(r.result, { quote: { action: 'handoff', reason: 'no_routes' } });
});

test('a flow with no quote nodes is untouched: the carousel\'s "Other options" still falls back to the static list', async () => {
  const session = {
    currentNodeId: CAR, collected: { tripType: 'One Way', pickupLocation: 'pune', dropLocation: 'city1' }, answeredFields: [],
    currentNodeComputedOptions: [{ index: 0, source: 'route_fare', routeFareId: 'rf1' }], displayOverrides: {}
  };
  const r = await say(session, 'other');
  assert.equal(r.result.fieldType, 'list');
  assert.equal(r.result.label, 'Which vehicle?');
});
