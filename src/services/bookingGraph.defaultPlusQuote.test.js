// Run: node --test src/services/bookingGraph.defaultPlusQuote.test.js
// The quote flow inside the flow a real travels business has: the "Travels default" graph (17 nodes, the legacy booking
// questions included - test-support/travelsDefaultFlowFixture.js) plus the quote nodes the seed script builds. SG Travels
// was the only business that ever got the quote flow, and it had none of the legacy questions; Search cab AI, Pradip and
// Jyotirling have all of them, with the same field keys (tripType, travelDate, pickupTime, numberOfDays, vehicleType).
// The engine finds a question's "Other ..." sibling by field key over the WHOLE business (bookingGraph.service.js
// resolveManualSibling: first text question with that key, in the order the database returns the rows), so the typed
// "Other date" / "Other time" answers can land on the legacy question instead of the quote's own.
// Each test runs the same walk with the legacy nodes listed first and last, because the database does not order them.
const path = require('path');
const stub = (relativePath, exports) => {
  const resolved = require.resolve(path.join(__dirname, relativePath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const fixture = require('../test-support/travelsDefaultFlowFixture');
const seed = require('../scripts/seedTravelQuoteFlow');
const BIZ = fixture.BIZ;
const legacyNodes = fixture.nodes();
const legacyEdges = fixture.edges();
const plan = seed.buildPlan({ businessId: BIZ, anchors: seed.findAnchors(legacyNodes, legacyEdges) });
const quoteNodes = plan.nodes.map((n) => ({ ...n, business_id: BIZ }));
const quoteEdges = plan.edges.map((e) => ({ ...e, business_id: BIZ }));

const graph = { nodes: [], edges: [] };
const state = { routes: [], fares: [] };
const from = (table) => {
  if (table === 'route_fares') {
    let wanted = null;
    const q = {
      select: () => q,
      eq: (col, val) => { if (col === 'id') wanted = val; return q; },
      maybeSingle: async () => {
        const hit = state.fares.find((f) => f.id === wanted);
        return { data: hit ? { ...hit, is_active: true } : null };
      }
    };
    return q;
  }
  const rows = () => (table === 'flow_nodes' ? graph.nodes : graph.edges);
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
stub('../services/travelQuote.service', {
  listQuotableRoutes: async () => state.routes,
  listRoundTripVehicleOptions: async () => [],
  priceRoundTripVehicle: async () => ({ stale: true })
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

const ORDERS = {
  'legacy nodes first': () => ({ nodes: [...legacyNodes, ...quoteNodes], edges: [...legacyEdges, ...quoteEdges] }),
  'quote nodes first': () => ({ nodes: [...quoteNodes, ...legacyNodes], edges: [...quoteEdges, ...legacyEdges] })
};

test.beforeEach(() => {
  state.routes = [{ id: 'r1', fromCity: 'pune', toCity: 'city1', fromLabel: 'Pune', toLabel: 'City 1', region: 'West', sortOrder: 1 }];
  state.fares = [fare(1, 'Dzire', 4, 2500)];
});

const say = (session, reply) => bookingGraph.advanceGraphSession({ businessId: BIZ, session, reply, languageCode: 'en' });

/** The customer taps "Get a quote" on the Rates reply and answers up to the date question (One Way, route, 1-4 people, first vehicle). */
const toDateQuestion = async () => {
  const started = await bookingGraph.startGraphSessionAtNode(BIZ, seed.N.tripType, fixture.RATES, 'en');
  let r = await say(started.session, 'One Way');
  r = await say(r.session, 'to:r1');
  r = await say(r.session, '1-4');
  r = await say(r.session, '0');
  assert.equal(r.result.fieldKey, 'travelDate', 'the walk reached the date question');
  return r.session;
};

// Step 2 of the quote-for-every-travel-business work fixes the lookup; until then the three walks that go wrong with the
// legacy nodes listed first are marked todo (they fail, and say so, without failing the suite).
for (const [order, build] of Object.entries(ORDERS)) {
  const knownBroken = order === 'legacy nodes first' ? { todo: 'resolveManualSibling picks the legacy question' } : {};
  test(`${order}: the quote flow reaches the date question and the quote path is intact (tripType also exists as a legacy question)`, async () => {
    Object.assign(graph, build());
    const session = await toDateQuestion();
    assert.equal(session.currentNodeId, seed.N.travelDate);
    assert.equal(session.collected.quoteRouteId, 'r1');
  });

  test(`${order}: "Other date" leads to the QUOTE flow's own typed-date question`, knownBroken, async () => {
    Object.assign(graph, build());
    const r = await say(await toDateQuestion(), 'Other date');
    assert.equal(r.session.currentNodeId, seed.N.travelDateManual);
  });

  test(`${order}: "Other time" leads to the QUOTE flow's own typed-time question`, knownBroken, async () => {
    Object.assign(graph, build());
    let r = await say(await toDateQuestion(), 'Today');
    assert.equal(r.result.fieldKey, 'pickupTime');
    r = await say(r.session, 'Other time');
    assert.equal(r.session.currentNodeId, seed.N.pickupTimeManual);
  });

  test(`${order}: a typed date and time carry on through the quote nodes to the quote`, knownBroken, async () => {
    Object.assign(graph, build());
    const tomorrow = new Date(Date.now() + 86400000);
    const typed = `${String(tomorrow.getDate()).padStart(2, '0')}/${String(tomorrow.getMonth() + 1).padStart(2, '0')}/${tomorrow.getFullYear()}`;
    let r = await say(await toDateQuestion(), 'Other date');
    r = await say(r.session, typed);
    assert.equal(r.result.fieldKey, 'pickupTime');
    r = await say(r.session, 'Other time');
    r = await say(r.session, '6:30 AM');
    assert.deepEqual(r.result, { quote: { action: 'send', reason: null, nodeId: seed.N.quote } });
  });
}
