// Pure helpers for "the customer answered a quote-flow question after the booking session ended".
// A booking question's tap id is "{nodeId}:{index}" (or ":other"); the same ids are saved in the outbound message's
// interactive_payload, so the question a customer is answering can be read back from either.
const { findFlowEntryNodeId } = require('./flowGraphValidation');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TAP = new RegExp(`^(${UUID}):(?:\\d+|other)$`, 'i');
const IN_PAYLOAD = new RegExp(`"id":"(${UUID}):(?:\\d+|other)"`, 'i');

/** The node id inside a question tap id ("{nodeId}:2"), or null for any other id (an edge id, a quote tap, a language tap). */
const tapNodeId = (id) => {
  const match = typeof id === 'string' ? TAP.exec(id) : null;
  return match ? match[1].toLowerCase() : null;
};

/** The question a saved outbound interactive_payload (buttons / list) was asking, or null. */
const payloadNodeId = (payload) => {
  if (!payload || typeof payload !== 'object') return null;
  const match = IN_PAYLOAD.exec(JSON.stringify(payload));
  return match ? match[1].toLowerCase() : null;
};

/**
 * The entry question of the quote flow that `nodeId` belongs to, or null when it is a question of any other flow
 * (or not an entered question at all). A quote flow is one whose entry can reach a route_picker node.
 * @param {{ id:string, nodeType:string }[]} nodes
 * @param {{ fromNodeId:string, toNodeId:string }[]} edges
 */
const quoteFlowEntry = (nodes, edges, nodeId) => {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node || node.nodeType === 'reply') return null;
  const entry = findFlowEntryNodeId(nodes, edges, nodeId);
  if (!entry) return null;
  const typeOf = new Map(nodes.map((n) => [n.id, n.nodeType]));
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift();
    if (typeOf.get(current) === 'route_picker') return entry;
    for (const edge of edges) {
      if (edge.fromNodeId === current && !seen.has(edge.toNodeId)) {
        seen.add(edge.toNodeId);
        queue.push(edge.toNodeId);
      }
    }
  }
  return null;
};

module.exports = { tapNodeId, payloadNodeId, quoteFlowEntry };
