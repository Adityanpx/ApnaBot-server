// Run: node --test src/services/bookingGraph.distanceEstimate.test.js
// The distance-estimate carousel card through the real graph engine and its tap: a Round Trip card is priced
// by the quote's formula (booking.service.js), the tap prices the vehicle again with the SAME formula and the
// session carries the same fare and allowance as the card. In-memory database, no network.
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
const TRIP = id(1);
const NODES = [
  node(1, { field_key: 'tripType', content_type: 'buttons', label: 'Trip?', options: ['One Way', 'Round Trip'] }),
  node(2, { field_key: 'pickupLocation', label: 'Pickup?' }),
  node(3, { field_key: 'dropLocation', label: 'Drop?' }),
  node(4, { field_key: 'numberOfDays', content_type: 'list', label: 'How many days?', options: ['1', '2', '3', '4'] }),
  node(5, { node_type: 'vehicle_carousel', field_key: 'vehicleType', content_type: 'list', label: 'Pick a vehicle', is_computed: true }),
  node(6, { field_key: 'travelDate', content_type: 'buttons', label: 'When?', options: ['Today', 'Tomorrow'] })
];
const edge = (n, from, to) => ({ id: id(100 + n), business_id: BIZ, from_node_id: from, to_node_id: to, display_order: 0, condition: null, preset: null });
const EDGES = [edge(1, id(1), id(2)), edge(2, id(2), id(3)), edge(3, id(3), id(4)), edge(4, id(4), id(5)), edge(5, id(5), id(6))];

let db;
const from = (table) => {
  const filters = [];
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
    not: (c, _op, v) => { filters.push(r => (r[c] === undefined ? null : r[c]) !== v); return q; },
    ilike: () => q,
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
stub('./distanceMatrix.service', { getDistanceKm: async () => 187.675 });
stub('./reports.service', { getPeriodRanges: () => ({}) });
let travelSettings;
stub('./business.service', { getBusinessById: async () => ({ id: BIZ, businessCategory: 'travels', travelSettings, disabledBookingFields: [] }) });
stub('./categoryFeature.service', { isEnabled: async () => true });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

const test = require('node:test');
const assert = require('node:assert/strict');
const bookingGraph = require('./bookingGraph.service');

const vehicle = (n, name, rate, extra) => ({
  id: `v${n}`, business_id: BIZ, custom_name: name, custom_photo_url: null, is_active: true, per_km_rate: rate,
  min_km_per_day: null, driver_allowance_per_day: null, catalog: { name, photo_url: null, seats: 4 }, ...extra
});

test.beforeEach(() => {
  travelSettings = { enableDistanceFares: true, roundTripPerDayKm: 250, roundTripDriverDaEnabled: true, roundTripDriverDaAmount: 0 };
  db = {
    flow_nodes: NODES,
    flow_edges: EDGES,
    route_fares: [],
    vehicles: [
      vehicle(1, 'Innova Crysta', 23, { min_km_per_day: 250, driver_allowance_per_day: 300 }),
      vehicle(2, 'Dzire', 13) // vehicle fields null: the settings are the fallback
    ],
    travel_quote_settings: [{ business_id: BIZ, allowance_basis: 'night' }]
  };
});

const say = (session, reply) => bookingGraph.advanceGraphSession({ businessId: BIZ, session, reply, languageCode: 'en' });
const toCarousel = async (days) => {
  const { session } = await bookingGraph.startGraphSessionAtNode(BIZ, TRIP, 'rule1', 'en');
  let r = await say(session, 'Round Trip');
  r = await say(r.session, 'Pune');
  r = await say(r.session, 'Shirdi');
  return say(r.session, days);
};

test('a Round Trip estimate card is priced by the quote formula, and the tap gives the same fare and allowance', async () => {
  const carousel = await toCarousel('3');
  assert.equal(carousel.result.fieldType, 'vehicle_carousel');
  // Innova: 750 km x 23 + 2 nights x 300 = 17,850 (night basis).  Dzire: 750 x 13, no allowance.
  assert.deepEqual(carousel.result.options.map(o => [o.name, o.fare, o.source]), [
    ['Innova Crysta', 17850, 'distance_estimate'], ['Dzire', 9750, 'distance_estimate']
  ]);

  const innova = await say(carousel.session, '0');
  assert.equal(innova.result.label, 'When?');
  const c = innova.session.collected;
  assert.deepEqual([c.vehicleId, c.vehicleFare, c.fareSource, c.distanceKm], ['v1', 17850, 'distance_estimate', 750]);
  assert.deepEqual([c.driverDaTotal, c.driverDaPerDay, c.driverDaDays], [600, 300, 2]);

  const dzire = await say((await toCarousel('3')).session, '1');
  const d = dzire.session.collected;
  assert.deepEqual([d.vehicleId, d.vehicleFare, d.distanceKm, d.driverDaTotal], ['v2', 9750, 750, undefined]);
});

test('the owner changes the per-km rate between the card and the tap: the tap uses the new rate with the same formula', async () => {
  const carousel = await toCarousel('3');
  db.vehicles[0].per_km_rate = 25; // 750 x 25 + 600
  const r = await say(carousel.session, '0');
  assert.equal(r.session.collected.vehicleFare, 750 * 25 + 600);
});

test('the vehicle is switched off between the card and the tap: the cards are rebuilt, nothing is booked', async () => {
  const carousel = await toCarousel('3');
  db.vehicles[0].is_active = false;
  const r = await say(carousel.session, '0');
  assert.equal(r.session.collected.vehicleFare, undefined);
});
