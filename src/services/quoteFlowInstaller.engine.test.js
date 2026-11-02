// Run: node --test src/services/quoteFlowInstaller.engine.test.js
// The installed quote flow, walked by the real booking graph engine inside the real "Travels default" flow (legacy booking
// questions included): every answer a customer can give, both entries (the Rates button and the "quote" keyword), One Way
// and Round Trip (days first, so the carousel is priced for the days), the "Other date" / "Other time" typed siblings, and
// the languages. The graph is served from memory; the route list, fares and the feature switch are stubbed.
const path = require('path');
const stub = (relativePath, exports) => {
  const resolved = require.resolve(path.join(__dirname, relativePath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const fixture = require('../test-support/travelsDefaultFlowFixture');
const installer = require('./quoteFlowInstaller.service');
const { derive } = require('../utils/quoteFlowIds');
const BIZ = fixture.BIZ;
const ids = derive(BIZ);
const plan = installer.buildPlan({ businessId: BIZ, anchors: installer.findAnchors(fixture.nodes(), fixture.edges()) });
const NODES = [...fixture.nodes(), ...plan.nodes].map((n) => ({ ...n, business_id: BIZ }));
const EDGES = [...fixture.edges(), ...plan.edges].map((e) => ({ ...e, business_id: BIZ }));
const LEGACY_VEHICLE_QUESTION = fixture.nodes().find((n) => n.node_type === 'question' && n.field_key === 'vehicleType').id;

const state = { routes: [], fares: [], daysSeen: [] };
const from = (table) => {
  if (table === 'route_fares') {
    let wanted = null;
    const q = {
      select: () => q,
      eq: (col, val) => { if (col === 'id') wanted = val; return q; },
      maybeSingle: async () => ({ data: (state.fares.find((f) => f.id === wanted) && { ...state.fares.find((f) => f.id === wanted), is_active: true }) || null })
    };
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
// Round Trip cards: price = fare x days, so the test sees the carousel was built for the days the customer gave (the real
// pricing is covered by bookingGraph.roundTripQuote.test.js)
stub('../services/travelQuote.service', {
  listQuotableRoutes: async () => state.routes,
  listRoundTripVehicleOptions: async (businessId, routeId, days) => {
    state.daysSeen.push(days);
    return state.fares.map((f, index) => ({
      index, routeFareId: f.id, vehicleId: f.vehicle.id, name: f.vehicle.custom_name, photoUrl: null, seats: f.vehicle.catalog.seats,
      fare: f.fare * days, source: 'quote_vehicle', priceDisplay: { kind: 'formula', total: f.fare * days, days, billedKm: 250 * days }
    }));
  },
  priceRoundTripVehicle: async (businessId, routeId, vehicleId, days) => {
    const f = state.fares.find((x) => x.vehicle.id === vehicleId);
    return f
      ? { stale: false, priced: { ok: true, method: 'formula', baseFare: f.fare * days, total: f.fare * days, days }, vehicleName: f.vehicle.custom_name, packageRowId: null }
      : { stale: true };
  }
});
stub('../services/handoff.service', { getSettings: async () => null });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

const test = require('node:test');
const assert = require('node:assert/strict');
const bookingService = require('./booking.service');
const bookingGraph = require('./bookingGraph.service');

const fare = (n, name, seats, amount) => ({
  id: `rf${n}`, fare: amount, vehicle: { id: `v${n}`, custom_name: name, custom_photo_url: null, is_active: true, catalog: { name, photo_url: null, seats } }
});
bookingService.findMatchingVehicleOptions = async () => state.fares;
const route = (n, extra) => ({ id: `r${n}`, fromCity: 'pune', toCity: `city${n}`, fromLabel: 'Pune', toLabel: `City ${n}`, region: 'West', sortOrder: n, ...extra });

test.beforeEach(() => {
  state.routes = [route(1), route(2)];
  state.fares = [fare(1, 'Dzire', 4, 2500), fare(2, 'Crysta', 7, 3500)];
  state.daysSeen = [];
});

const say = (session, reply, lang = 'en') => bookingGraph.advanceGraphSession({ businessId: BIZ, session, reply, languageCode: lang });
const tomorrow = () => {
  const d = new Date(Date.now() + 86400000);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};
const labels = (field) => field.options.map((o) => o.label);

// Rates button -> trip type
const startFromButton = (lang = 'en') => bookingGraph.startGraphSessionAtNode(BIZ, ids.N.tripType, fixture.RATES, lang);

test('the Rates button and the "quote" keyword both land on the trip type question', async () => {
  const viaButton = await startFromButton();
  assert.equal(viaButton.field.fieldKey, 'tripType');
  assert.equal(viaButton.session.currentNodeId, ids.N.tripType, 'the quote flow\'s own question, not the legacy tripType question');
  assert.deepEqual(labels(viaButton.field), ['One Way', 'Round Trip']);
  const viaKeyword = await bookingGraph.startGraphSession(BIZ, ids.N.trigger, 'en');
  assert.equal(viaKeyword.result.fieldKey, 'tripType');
  assert.equal(viaKeyword.session.currentNodeId, ids.N.tripType);
});

test('One Way end to end: route -> passengers -> vehicles -> date -> time -> quote (no days question)', async () => {
  const { session } = await startFromButton();
  let r = await say(session, 'One Way');
  assert.equal(r.result.fieldKey, 'routePicker');
  assert.deepEqual(r.result.options.map((o) => o.value), ['to:r1', 'to:r2', 'other']);
  r = await say(r.session, 'to:r1');
  assert.equal(r.result.fieldKey, 'passengers');
  assert.deepEqual(labels(r.result), ['1-4 people', '5-6 people', '7 or more']);
  r = await say(r.session, '5-6');
  assert.equal(r.result.fieldType, 'vehicle_carousel');
  assert.deepEqual(state.daysSeen, [], 'the Round Trip pricing was not involved');
  assert.deepEqual(r.result.options.map((o) => o.name), ['Crysta'], 'seat filter: 5-6 people need 6+ seats');
  r = await say(r.session, '0');
  assert.equal(r.result.fieldKey, 'travelDate');
  assert.deepEqual(r.session.collected.vehicleFare, 3500);
  r = await say(r.session, 'Today');
  assert.equal(r.result.fieldKey, 'pickupTime');
  assert.equal(r.result.options.length, 9);
  assert.ok(r.result.options.every((o) => o.label.length <= 24));
  r = await say(r.session, '11:00 PM');
  assert.deepEqual(r.result, { quote: { action: 'send', reason: null, nodeId: ids.N.quote } });
  assert.equal(r.session.collected.pickupMinute, 23 * 60);
  assert.equal(r.session.collected.numberOfDays, undefined);
  assert.equal(r.session.collected.quoteRouteId, 'r1');
});

test('Round Trip end to end: the days come right after the passengers, the carousel is built for those days, then date -> time -> quote', async () => {
  const { session } = await startFromButton();
  let r = await say(session, 'Round Trip');
  r = await say(r.session, 'to:r2');
  r = await say(r.session, '1-4');
  assert.equal(r.result.fieldKey, 'numberOfDays', 'the days are asked before the vehicles');
  assert.equal(r.result.options.length, 9);
  assert.deepEqual(r.result.options.slice(0, 2).map((o) => o.label), ['1 day', '2 days']);
  r = await say(r.session, '3');
  assert.equal(r.result.fieldType, 'vehicle_carousel');
  assert.deepEqual(state.daysSeen, [3], 'the carousel was built for 3 days');
  assert.deepEqual(r.result.options.map((o) => [o.name, o.fare]), [['Dzire', 7500], ['Crysta', 10500]]);
  r = await say(r.session, '1');
  assert.equal(r.result.fieldKey, 'travelDate');
  assert.equal(r.session.collected.vehicleFare, 10500);
  r = await say(r.session, 'Tomorrow');
  assert.equal(r.result.fieldKey, 'pickupTime');
  r = await say(r.session, '6:00 AM');
  assert.deepEqual(r.result, { quote: { action: 'send', reason: null, nodeId: ids.N.quote } }, 'no second days question');
  assert.deepEqual([r.session.collected.numberOfDays, r.session.collected.tripType], ['3', 'Round Trip']);
});

test('"Other date" and "Other time" take typed answers inside the quote flow, and each sibling continues to the right next step', async () => {
  const { session } = await startFromButton();
  let r = await say(session, 'Round Trip');
  r = await say(r.session, 'to:r1');
  r = await say(r.session, '1-4');
  r = await say(r.session, '2');
  r = await say(r.session, '0');
  r = await say(r.session, 'Other date');
  assert.equal(r.session.currentNodeId, ids.N.travelDateManual);
  assert.equal(r.result.fieldType, 'text');
  r = await say(r.session, tomorrow());
  assert.equal(r.result.fieldKey, 'pickupTime');
  assert.equal(r.session.collected.travelDate, tomorrow());
  r = await say(r.session, 'Other time');
  assert.equal(r.result.fieldType, 'text');
  const bad = await say(r.session, 'in the morning');
  assert.match(bad.result, /couldn't read that time/);
  assert.equal(bad.session.currentNodeId, ids.N.pickupTimeManual);
  r = await say(r.session, '19.30');
  assert.deepEqual(r.result, { quote: { action: 'send', reason: null, nodeId: ids.N.quote } }, 'straight to the quote');
  assert.equal(r.session.collected.pickupMinute, 19 * 60 + 30);
  assert.equal(r.session.collected.numberOfDays, '2');
});

test('"Other time" on a one-way trip goes straight to the quote', async () => {
  const { session } = await startFromButton();
  let r = await say(session, 'One Way');
  r = await say(r.session, 'to:r1');
  r = await say(r.session, '1-4');
  r = await say(r.session, '0');
  r = await say(r.session, 'Today');
  r = await say(r.session, 'Other time');
  r = await say(r.session, '5:30 am');
  assert.equal(r.result.quote.action, 'send');
  assert.equal(r.session.collected.pickupMinute, 330);
});

test('Hindi and Marathi customers get every question, option and the route prompts in their language', async () => {
  for (const [lang, expectTrip, expectPax, expectTo] of [
    ['hi', 'आपको किस तरह की यात्रा चाहिए?', '1-4 लोग', 'आप कहाँ जाना चाहते हैं? 🚕'],
    ['mr', 'तुम्हाला कोणत्या प्रकारचा प्रवास हवा आहे?', '1-4 लोक', 'तुम्हाला कुठे जायचे आहे? 🚕']
  ]) {
    const { session, field } = await startFromButton(lang);
    assert.equal(field.label, expectTrip, lang);
    assert.deepEqual(labels(field), ['वन वे', 'राउंड ट्रिप']);
    let r = await say(session, 'One Way', lang);
    assert.equal(r.result.label, expectTo, lang);
    r = await say(r.session, 'to:r1', lang);
    assert.equal(labels(r.result)[0], expectPax, lang);
    r = await say(r.session, '1-4', lang);
    r = await say(r.session, '0', lang);
    assert.ok(labels(r.result).includes(lang === 'hi' ? 'दूसरी तारीख' : 'दुसरी तारीख'), lang);
  }
});

test('Other route, no fitting vehicle and the carousel\'s Other options all leave through a handoff / no_vehicle result', async () => {
  let { session } = await startFromButton();
  let r = await say(session, 'One Way');
  assert.equal((await say(r.session, 'other')).result.quote.reason, 'other_route');

  ({ session } = await startFromButton());
  r = await say(session, 'One Way');
  r = await say(r.session, 'to:r1');
  state.fares = [fare(1, 'Dzire', 4, 2500)];
  assert.deepEqual((await say(r.session, '7+')).result, { quote: { action: 'no_vehicle', reason: null } });
  state.fares = [fare(1, 'Dzire', 4, 2500), fare(2, 'Crysta', 7, 3500)];
  const carousel = await say(r.session, '1-4');
  assert.equal((await say(carousel.session, 'other')).result.quote.reason, 'other_vehicle');
});

test('the legacy booking questions (fare-less vehicleType, tripType, dates, time) are never shown in the quote flow', async () => {
  const legacyIds = new Set(fixture.nodes().filter((n) => n.node_type !== 'reply').map((n) => n.id));
  const { session, field } = await startFromButton();
  const seen = new Set([field.nodeId]);
  let r = { session };
  for (const reply of ['Round Trip', 'to:r1', '1-4', '2', '0', 'Other date', tomorrow(), 'Other time', '6:30 AM']) {
    r = await say(r.session, reply);
    if (r.result && r.result.nodeId) seen.add(r.result.nodeId);
    assert.ok(!legacyIds.has(r.session.currentNodeId), `after "${reply}" the customer is still in the quote flow`);
  }
  assert.ok(![...seen].some((id) => legacyIds.has(id)));
  assert.ok(!seen.has(LEGACY_VEHICLE_QUESTION));
  assert.equal(r.result.quote.action, 'send');
});
