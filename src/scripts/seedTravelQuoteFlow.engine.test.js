// Run: node --test src/scripts/seedTravelQuoteFlow.engine.test.js
// The seeded flow, walked by the real booking graph engine: every answer a customer can give, both entries (the
// Rates button and the "quote" keyword), One Way and Round Trip, the "Other date" / "Other time" manual siblings,
// and the languages. The graph is SG Travels' flow + the seed plan, served from memory; the route list, fares and
// the feature switch are stubbed.
const path = require('path');
const stub = (relativePath, exports) => {
  const resolved = require.resolve(path.join(__dirname, relativePath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const fixture = require('../test-support/sgTravelsFlowFixture');
const seed = require('./seedTravelQuoteFlow');
const BIZ = fixture.SG;
const plan = seed.buildPlan({ businessId: BIZ, anchors: seed.findAnchors(fixture.nodes(), fixture.edges()) });
const NODES = [...fixture.nodes(), ...plan.nodes].map((n) => ({ ...n, business_id: BIZ }));
const EDGES = [...fixture.edges(), ...plan.edges].map((e) => ({ ...e, business_id: BIZ }));

const state = { routes: [], fares: [] };
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
stub('../services/travelQuote.service', { listQuotableRoutes: async () => state.routes });
stub('../services/handoff.service', { getSettings: async () => null });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

const test = require('node:test');
const assert = require('node:assert/strict');
const bookingService = require('../services/booking.service');
const bookingGraph = require('../services/bookingGraph.service');

const fare = (n, name, seats, amount) => ({
  id: `rf${n}`, fare: amount, vehicle: { id: `v${n}`, custom_name: name, custom_photo_url: null, is_active: true, catalog: { name, photo_url: null, seats } }
});
bookingService.findMatchingVehicleOptions = async () => state.fares;
const route = (n, extra) => ({ id: `r${n}`, fromCity: 'pune', toCity: `city${n}`, fromLabel: 'Pune', toLabel: `City ${n}`, region: 'West', sortOrder: n, ...extra });

test.beforeEach(() => {
  state.routes = [route(1), route(2)];
  state.fares = [fare(1, 'Dzire', 4, 2500), fare(2, 'Crysta', 7, 3500)];
});

const say = (session, reply, lang = 'en') => bookingGraph.advanceGraphSession({ businessId: BIZ, session, reply, languageCode: lang });
const tomorrow = () => {
  const d = new Date(Date.now() + 86400000);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};
const labels = (field) => field.options.map((o) => o.label);

// Rates button -> trip type
const startFromButton = (lang = 'en') => bookingGraph.startGraphSessionAtNode(BIZ, seed.N.tripType, fixture.RATES, lang);

test('the Rates button and the "quote" keyword both land on the trip type question', async () => {
  const viaButton = await startFromButton();
  assert.equal(viaButton.field.fieldKey, 'tripType');
  assert.deepEqual(labels(viaButton.field), ['One Way', 'Round Trip']);
  const viaKeyword = await bookingGraph.startGraphSession(BIZ, seed.N.trigger, 'en');
  assert.equal(viaKeyword.result.fieldKey, 'tripType');
  assert.equal(viaKeyword.session.currentNodeId, seed.N.tripType);
});

test('One Way end to end: route -> passengers -> vehicles -> date -> time -> quote (no days question)', async () => {
  let { session, field } = await startFromButton();
  let r = await say(session, 'One Way');
  assert.equal(r.result.fieldKey, 'routePicker');
  assert.deepEqual(r.result.options.map((o) => o.value), ['to:r1', 'to:r2', 'other']);
  r = await say(r.session, 'to:r1');
  assert.equal(r.result.fieldKey, 'passengers');
  assert.deepEqual(labels(r.result), ['1-4 people', '5-6 people', '7 or more']);
  r = await say(r.session, '5-6');
  assert.equal(r.result.fieldType, 'vehicle_carousel');
  assert.deepEqual(r.result.options.map((o) => o.name), ['Crysta'], 'seat filter: 5-6 people need 6+ seats');
  r = await say(r.session, '0');
  assert.equal(r.result.fieldKey, 'travelDate');
  assert.deepEqual(r.session.collected.vehicleFare, 3500);
  r = await say(r.session, 'Today');
  assert.equal(r.result.fieldKey, 'pickupTime');
  assert.equal(r.result.options.length, 9);
  assert.ok(r.result.options.every((o) => o.label.length <= 24));
  r = await say(r.session, '11:00 PM');
  assert.deepEqual(r.result, { quote: { action: 'send', reason: null, nodeId: seed.N.quote } });
  assert.equal(r.session.collected.pickupMinute, 23 * 60);
  assert.equal(r.session.collected.numberOfDays, undefined);
  assert.equal(r.session.collected.quoteRouteId, 'r1');
});

test('Round Trip end to end: the days question comes after the time, then the quote', async () => {
  let { session } = await startFromButton();
  let r = await say(session, 'Round Trip');
  r = await say(r.session, 'to:r2');
  r = await say(r.session, '1-4');
  assert.deepEqual(r.result.options.map((o) => o.name), ['Dzire', 'Crysta']);
  r = await say(r.session, '1');
  r = await say(r.session, 'Tomorrow');
  r = await say(r.session, '6:00 AM');
  assert.equal(r.result.fieldKey, 'numberOfDays');
  assert.equal(r.result.options.length, 9);
  assert.deepEqual(r.result.options.slice(0, 2).map((o) => o.label), ['1 day', '2 days']);
  r = await say(r.session, '3');
  assert.equal(r.result.quote.action, 'send');
  assert.deepEqual([r.session.collected.numberOfDays, r.session.collected.tripType], ['3', 'Round Trip']);
});

test('"Other date" and "Other time" take typed answers, and each sibling continues to the right next step', async () => {
  let { session } = await startFromButton();
  let r = await say(session, 'Round Trip');
  r = await say(r.session, 'to:r1');
  r = await say(r.session, '1-4');
  r = await say(r.session, '0');
  r = await say(r.session, 'Other date');
  assert.equal(r.result.fieldKey, 'travelDate');
  assert.equal(r.result.fieldType, 'text');
  r = await say(r.session, tomorrow());
  assert.equal(r.result.fieldKey, 'pickupTime');
  assert.equal(r.session.collected.travelDate, tomorrow());
  r = await say(r.session, 'Other time');
  assert.equal(r.result.fieldType, 'text');
  const bad = await say(r.session, 'in the morning');
  assert.match(bad.result, /couldn't read that time/);
  assert.equal(bad.session.currentNodeId, seed.N.pickupTimeManual);
  r = await say(r.session, '19.30');
  assert.equal(r.result.fieldKey, 'numberOfDays', 'the manual time sibling also continues to days for a round trip');
  assert.equal(r.session.collected.pickupMinute, 19 * 60 + 30);
  r = await say(r.session, '2');
  assert.equal(r.result.quote.action, 'send');
});

test('"Other time" on a one-way trip goes straight to the quote', async () => {
  let { session } = await startFromButton();
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
    assert.deepEqual(labels(field), lang === 'hi' ? ['वन वे', 'राउंड ट्रिप'] : ['वन वे', 'राउंड ट्रिप']);
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

test('the old fare-less vehicleType question is never shown in the quote flow', async () => {
  let { session } = await startFromButton();
  const seen = new Set();
  let r = { session };
  for (const reply of ['One Way', 'to:r1', '1-4', '0', 'Today', '10:00 AM']) {
    r = await say(r.session, reply);
    if (r.result && r.result.nodeId) seen.add(r.result.nodeId);
  }
  assert.ok(!seen.has(fixture.VEHICLE_TYPE));
  assert.equal(r.result.quote.action, 'send');
});
