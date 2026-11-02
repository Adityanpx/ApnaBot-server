// The "Travels default" flow every new travels business starts from (flow_snapshots, category 'travels', is_default),
// read from production on 2026-11-02 and copied unchanged: 17 nodes, 22 edges. Search cab AI, Pradip and Jyotirling
// run exactly this graph (checked by a select-only comparison; only Search cab AI's display_order values differ).
// It is the shape a quote flow has to be installed into: a 3-button "hi" menu, a "rates" reply with one button, the
// "book" web-form reply, and the legacy booking questions (tripType, travelDate x2, pickupTime x2, numberOfDays,
// vehicleType, ...) that no edge from a live entry reaches any more. Test data only - never written anywhere.
// Rows are snake_case, as flow_nodes / flow_edges return them.
const snapshot = require('./travelsDefaultFlow.json');

const BIZ = '00000000-0000-4000-8000-0000000000aa';
const byKeyword = (keyword) => snapshot.nodes.find((n) => n.node_type === 'reply' && n.keyword === keyword).id;

const nodes = () => snapshot.nodes.map((n) => ({ ...n, business_id: BIZ }));
const edges = () => snapshot.edges.map((e) => ({ ...e, business_id: BIZ }));

module.exports = {
  BIZ, nodes, edges,
  HI: byKeyword('hi'), RATES: byKeyword('rates'), BOOK: byKeyword('book'), CONTACT: byKeyword('contactinfo')
};
