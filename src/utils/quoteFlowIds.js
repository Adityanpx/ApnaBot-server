// The ids of the rows the travel-quote flow installer writes (flow_nodes / flow_edges), in ONE place.
//
// flow_nodes.id / flow_edges.id are global primary keys, and save_flow_graph_full upserts with
// "on conflict (id) do update set business_id = excluded.business_id": writing an id that another business already
// owns would MOVE that business's row. So every business gets its own ids, and the installer must be able to tell
// afterwards which rows are its own (rollback, "already installed", byte-identical check of everything else).
//
// The ids are UUIDv5 of (businessId, kind, slot) under a fixed namespace. Pure: the same business always gets the
// same ids, two businesses never share one, and no database read is needed to know them.
const { v5 } = require('uuid');

// Fixed namespace of the ids. Never change it: every installed business's ids come from it.
const NAMESPACE = '6f1c3a52-7d0e-5b3a-9a64-2f0c8d4e71b9';

// Never rename or remove a slot of an installed flow: the slot name is part of the id.
const NODE_SLOTS = [
  'trigger', 'tripType', 'routePicker', 'passengers', 'vehicle', 'travelDate', 'travelDateManual',
  'pickupTime', 'pickupTimeManual', 'numberOfDays', 'quote'
];
const EDGE_SLOTS = [
  'rates', 'menu', 'triggerToTrip', 'tripToPicker', 'pickerToPax', 'paxToDays', 'daysToVehicle', 'paxToVehicle',
  'vehicleToDate', 'dateToTime', 'dateManualToTime', 'timeToQuote', 'timeManualToQuote'
];

/**
 * The ids of a business's quote flow: `N` / `E` map slot -> id, `nodeIds` / `edgeIds` list them.
 * @param {string} businessId
 */
const derive = (businessId) => {
  if (typeof businessId !== 'string' || businessId === '') throw new Error('quoteFlowIds: a business id is required');
  const N = Object.fromEntries(NODE_SLOTS.map((slot) => [slot, v5(`${businessId}:node:${slot}`, NAMESPACE)]));
  const E = Object.fromEntries(EDGE_SLOTS.map((slot) => [slot, v5(`${businessId}:edge:${slot}`, NAMESPACE)]));
  return { N, E, nodeIds: Object.values(N), edgeIds: Object.values(E) };
};

/** Whether `id` is one of the quote flow's own node / edge ids of `businessId` (the same derivation the installer writes with). */
const isOurNode = (businessId, id) => derive(businessId).nodeIds.includes(id);
const isOurEdge = (businessId, id) => derive(businessId).edgeIds.includes(id);
const isOurs = (businessId, id) => isOurNode(businessId, id) || isOurEdge(businessId, id);

module.exports = { NAMESPACE, NODE_SLOTS, EDGE_SLOTS, derive, isOurs, isOurNode, isOurEdge };
