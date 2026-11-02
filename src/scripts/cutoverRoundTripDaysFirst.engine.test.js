// Run: node --test src/scripts/cutoverRoundTripDaysFirst.engine.test.js
// The seeded SG Travels quote flow AFTER the days-first cutover, walked by the real booking graph engine: Round
// Trip asks the days right after the passengers and the vehicle carousel is built for those days; One Way, the
// typed "Other date" / "Other time" answers and the quote step are unchanged. The graph is SG Travels' flow + the
// seed plan + the cutover's edge changes, served from memory; the route list and the pricing are stubbed.
const path = require('path');
const stub = (relativePath, exports) => {
  const resolved = require.resolve(path.join(__dirname, relativePath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const fixture = require('../test-support/sgTravelsFlowFixture');
const seed = require('./seedTravelQuoteFlow');
const cutover = require('./cutoverRoundTripDaysFirst');
const BIZ = fixture.SG;
const plan = seed.buildPlan({ businessId: BIZ, anchors: seed.findAnchors(fixture.nodes(), fixture.edges()) });
const { remove, add } = cutover.buildCutover();
const removeIds = new Set(remove.map((e) => e.id));
const NODES = [...fixture.nodes(), ...plan.nodes].map((n) => ({ ...n, business_id: BIZ }));
const EDGES = [...fixture.edges(), ...plan.edges.filter((e) => !removeIds.has(e.id)), ...add].map((e) => ({ ...e, business_id: BIZ }));

const state = { daysSeen: [] };
const vehicleRow = { id: 'v1', custom_name: 'Crysta', custom_photo_url: null, is_active: true, catalog: { name: 'Crysta', photo_url: null, seats: 7 } };
const from = (table) => {
  if (table === 'route_fares') {
    // a One Way tap re-reads the chosen fare row (stale check)
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { id: 'rf1', fare: 3500, is_active: true, vehicle: vehicleRow } }) };
    return q;
  }
  const rows = () => (table === 'flow_nodes' ? NODES : EDGES);
  const q = { select: () => q, eq: () => q, then: (resolve, reject) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject) };
  return q;
};
stub('../config/redis', {});
stub('../config/supabase', { from });
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {} });
stub('../queues/sessionTimeout.queue', { addToSessionTimeoutQueue: async () => {} });
stub('../services/socket.service', {});
stub('../services/payment.service', {});
stub('../services/distanceMatrix.service', {});
stub('../services/business.service', { getBusinessById: async () => ({ id: BIZ, businessCategory: 'travels', travelSettings: {}, disabledBookingFields: [] }) });
stub('../services/categoryFeature.service', { isEnabled: async () => true });
// Round Trip cards: price = 1000 x days, so the test sees the carousel was built for the days the customer gave
const vehicle = { id: 'v1', custom_name: 'Crysta', custom_photo_url: null, is_active: true, catalog: { name: 'Crysta', photo_url: null, seats: 7 } };
stub('../services/travelQuote.service', {
  listQuotableRoutes: async () => [{ id: 'r1', fromCity: 'pune', toCity: 'shirdi', fromLabel: 'Pune', toLabel: 'Shirdi', region: null, sortOrder: 0 }],
  listRoundTripVehicleOptions: async (businessId, routeId, days) => {
    state.daysSeen.push(days);
    return [{ index: 0, routeFareId: 'rf1', vehicleId: vehicle.id, name: 'Crysta', photoUrl: null, seats: 7, fare: days * 1000, source: 'quote_vehicle', priceDisplay: { kind: 'formula', total: days * 1000, days, billedKm: 250 * days } }];
  },
  priceRoundTripVehicle: async (businessId, routeId, vehicleId, days) => ({
    stale: false, priced: { ok: true, method: 'formula', baseFare: days * 1000, total: days * 1000, days }, vehicleName: 'Crysta', packageRowId: null
  })
});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

const test = require('node:test');
const assert = require('node:assert/strict');
const bookingService = require('../services/booking.service');
const bookingGraph = require('../services/bookingGraph.service');
bookingService.findMatchingVehicleOptions = async () => [{ id: 'rf1', fare: 3500, vehicle }];

test.beforeEach(() => { state.daysSeen = []; });

const say = (session, reply, lang = 'en') => bookingGraph.advanceGraphSession({ businessId: BIZ, session, reply, languageCode: lang });
const start = () => bookingGraph.startGraphSessionAtNode(BIZ, seed.N.tripType, fixture.RATES, 'en');
const tomorrow = () => {
  const d = new Date(Date.now() + 86400000);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

test('Round Trip: passengers -> days -> the carousel built for those days -> date -> time -> quote (no second days question)', async () => {
  let { session } = await start();
  let r = await say(session, 'Round Trip');
  r = await say(r.session, 'to:r1');
  r = await say(r.session, '1-4');
  assert.equal(r.result.fieldKey, 'numberOfDays', 'the days come right after the passengers');
  assert.equal(r.result.options.length, 9);
  r = await say(r.session, '3');
  assert.equal(r.result.fieldType, 'vehicle_carousel');
  assert.deepEqual(state.daysSeen, [3], 'the carousel was built for 3 days');
  assert.deepEqual(r.result.options.map((o) => [o.name, o.fare]), [['Crysta', 3000]]);
  r = await say(r.session, '0');
  assert.equal(r.result.fieldKey, 'travelDate');
  assert.equal(r.session.collected.vehicleFare, 3000);
  r = await say(r.session, 'Today');
  assert.equal(r.result.fieldKey, 'pickupTime');
  r = await say(r.session, '10:00 AM');
  assert.deepEqual(r.result, { quote: { action: 'send', reason: null, nodeId: seed.N.quote } });
  assert.equal(r.session.collected.numberOfDays, '3');
});

test('Round Trip with the typed "Other date" and "Other time": still no days question after the time', async () => {
  let { session } = await start();
  let r = await say(session, 'Round Trip');
  r = await say(r.session, 'to:r1');
  r = await say(r.session, '1-4');
  r = await say(r.session, '2');
  r = await say(r.session, '0');
  r = await say(r.session, 'Other date');
  assert.equal(r.result.fieldType, 'text');
  r = await say(r.session, tomorrow());
  assert.equal(r.result.fieldKey, 'pickupTime');
  r = await say(r.session, 'Other time');
  r = await say(r.session, '6:30 AM');
  assert.deepEqual(r.result, { quote: { action: 'send', reason: null, nodeId: seed.N.quote } });
  assert.equal(r.session.collected.numberOfDays, '2');
});

test('One Way is unchanged: passengers -> the carousel straight away, no days question at all', async () => {
  let { session } = await start();
  let r = await say(session, 'One Way');
  r = await say(r.session, 'to:r1');
  r = await say(r.session, '1-4');
  assert.equal(r.result.fieldType, 'vehicle_carousel');
  assert.deepEqual(state.daysSeen, [], 'the Round Trip pricing was not involved');
  r = await say(r.session, '0');
  r = await say(r.session, 'Today');
  r = await say(r.session, '10:00 AM');
  assert.equal(r.result.quote.action, 'send');
  assert.equal(r.session.collected.numberOfDays, undefined);
});
