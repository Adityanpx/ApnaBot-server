// Pure structural checks over a business's { nodes, edges } (as returned by
// bookingGraph.service.js#loadGraph), used by flowGraph.controller.js to
// validate a hypothetical post-edit graph BEFORE committing a node/edge
// write. None of this touches Supabase — callers load the graph, apply the
// edit in memory, and pass the result in here.
//
// Scope decisions (reviewed and confirmed, see booking-graph-rewrite memory
// / the flow-graph CRUD design conversation — do not re-litigate without
// new info):
//   - findCycles is scoped to the question-node subgraph only ('question',
//     'vehicle_carousel', 'rentalPackage' node types and the edges between
//     them). Reply-node button/list chains are excluded on purpose — a
//     reply node is re-matched fresh against incoming text on every
//     customer message (chatbot.service.js#findMatchingRule), so a "Main
//     Menu" button looping back to itself is normal FAQ-style behavior,
//     not a bug. The corrupted-booking failure mode this guards against
//     (pickNextNodeId's MAX_HOPS walk silently completing a booking early)
//     only exists on the sequential question-node walk during an active
//     session.
//   - findUnreachableNodes only walks question-node-subgraph edges from
//     every booking_trigger reply node's entry point. It exempts manual/
//     computed-fallback sibling nodes (found by field_key lookup at
//     runtime, never by edge traversal — see the flow_nodes migration's
//     header comment) from being flagged as orphaned.
//   - validateConditionField is existence-only: it confirms condition.field
//     names a real field_key among the business's question-type nodes, but
//     does NOT verify the field is actually collected earlier than the
//     edge on every path (full temporal-precedence analysis would require
//     enumerating all paths through a branching graph — deliberately
//     out of scope for this pass; a wrong-but-real field_key is a logic
//     bug the owner would catch by testing their flow, not a silent
//     corruption the way a cycle or an orphaned node is).

const QUESTION_SUBGRAPH_TYPES = ['question', 'vehicle_carousel', 'rentalPackage'];

/**
 * Directed-graph cycle detection restricted to the question-node subgraph.
 * Standard DFS with a recursion stack (white/gray/black coloring) — a back
 * edge to a node currently on the stack means a cycle.
 * @param {Array} nodes - full node list (only question-subgraph types are considered)
 * @param {Array} edges - full edge list (only edges between two question-subgraph nodes are considered)
 * @returns {string[]} node ids involved in a cycle, or [] if none
 */
const findCycles = (nodes, edges) => {
  const questionNodeIds = new Set(
    nodes.filter(n => QUESTION_SUBGRAPH_TYPES.includes(n.nodeType)).map(n => n.id)
  );

  const adjacency = new Map();
  for (const id of questionNodeIds) adjacency.set(id, []);
  for (const edge of edges) {
    if (questionNodeIds.has(edge.fromNodeId) && questionNodeIds.has(edge.toNodeId)) {
      adjacency.get(edge.fromNodeId).push(edge.toNodeId);
    }
  }

  const UNVISITED = 0, IN_PROGRESS = 1, DONE = 2;
  const state = new Map(Array.from(questionNodeIds).map(id => [id, UNVISITED]));
  const cyclicNodeIds = new Set();

  const visit = (nodeId, stack) => {
    state.set(nodeId, IN_PROGRESS);
    stack.push(nodeId);

    for (const neighborId of adjacency.get(nodeId) || []) {
      const neighborState = state.get(neighborId);
      if (neighborState === IN_PROGRESS) {
        // Back edge to a node currently on the stack — every node from
        // that node onward in the stack is part of the cycle.
        const cycleStart = stack.indexOf(neighborId);
        for (let i = cycleStart; i < stack.length; i++) cyclicNodeIds.add(stack[i]);
        cyclicNodeIds.add(neighborId);
      } else if (neighborState === UNVISITED) {
        visit(neighborId, stack);
      }
    }

    stack.pop();
    state.set(nodeId, DONE);
  };

  for (const id of questionNodeIds) {
    if (state.get(id) === UNVISITED) visit(id, []);
  }

  return Array.from(cyclicNodeIds);
};

/**
 * Every question-subgraph node reachable by walking edges from the given
 * entry node ids (typically every booking_trigger reply node's single
 * unconditional entry edge target — see resolveBookingTriggerEntryNodeIds
 * below), PLUS every node exempted because it's a manual/computed-fallback
 * sibling of a reachable node (found by field_key lookup at runtime, not by
 * edge traversal — bookingGraph.service.js's resolveManualSibling/
 * resolveStaticFallback/resolvePrimarySibling).
 * @param {Array} nodes
 * @param {Array} edges
 * @param {string[]} entryNodeIds
 * @returns {string[]} ids of question-subgraph nodes NOT reachable and NOT exempt
 */
const computeReachedNodeIds = (questionNodes, questionNodeIds, edges, entryNodeIds) => {
  const adjacency = new Map();
  for (const id of questionNodeIds) adjacency.set(id, []);
  for (const edge of edges) {
    if (questionNodeIds.has(edge.fromNodeId) && questionNodeIds.has(edge.toNodeId)) {
      adjacency.get(edge.fromNodeId).push(edge.toNodeId);
    }
  }

  const reached = new Set();
  const queue = entryNodeIds.filter(id => questionNodeIds.has(id));
  for (const id of queue) reached.add(id);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const neighborId of adjacency.get(current) || []) {
      if (!reached.has(neighborId)) {
        reached.add(neighborId);
        queue.push(neighborId);
      }
    }
  }
  return reached;
};

const findUnreachableNodes = (nodes, edges, entryNodeIds) => {
  const questionNodes = nodes.filter(n => QUESTION_SUBGRAPH_TYPES.includes(n.nodeType));
  const questionNodeIds = new Set(questionNodes.map(n => n.id));
  const reached = computeReachedNodeIds(questionNodes, questionNodeIds, edges, entryNodeIds);

  // A node with an incoming edge from ANY reached node is already covered
  // above. The exemption only matters for nodes with NO incoming edge at
  // all (manual/computed-fallback siblings, by design) — exempt one of
  // those if another node sharing its field_key was reached by the walk.
  const reachedFieldKeys = new Set(
    questionNodes.filter(n => reached.has(n.id)).map(n => n.fieldKey)
  );

  const unreachable = [];
  for (const node of questionNodes) {
    if (reached.has(node.id)) continue;
    if (node.fieldKey && reachedFieldKeys.has(node.fieldKey)) continue; // exempt sibling
    unreachable.push(node.id);
  }
  return unreachable;
};

/**
 * The complement of findUnreachableNodes' exemption: ids of question-
 * subgraph nodes that are NOT reached by edge-walk but are excused because
 * they're a fallback sibling of a reached node (bookingGraph.service.js's
 * resolveManualSibling/resolveStaticFallback/resolvePrimarySibling targets
 * — found by field_key lookup at runtime, never by edge traversal, so
 * nothing in the edge graph points at them).
 *
 * Exists because these nodes are structurally invisible to a pure
 * reachability check in the OTHER direction too: deleting one doesn't
 * create an "unreachable node" for findUnreachableNodes to catch (it's
 * simply gone, not stranded), but it silently removes a real runtime
 * fallback path. bookingGraph.service.js's fallbackToStaticSibling THROWS
 * if the fallback it looks for at runtime no longer exists — for a
 * vehicle_carousel node specifically, that throw happens inside
 * advanceGraphSession during a live customer's turn, not caught anywhere
 * before webhook.controller.js's Step 12, i.e. a stray dashboard delete of
 * a fallback node can crash a real in-progress booking the next time the
 * live vehicle/rental-package query it falls back from happens to come back
 * empty. Used by flowGraph.controller.js's deleteQuestionNode to block this
 * outright, separate from (and not caught by) findUnreachableNodes.
 * @param {Array} nodes
 * @param {Array} edges
 * @param {string[]} entryNodeIds
 * @returns {string[]}
 */
const findFallbackSiblingNodeIds = (nodes, edges, entryNodeIds) => {
  const questionNodes = nodes.filter(n => QUESTION_SUBGRAPH_TYPES.includes(n.nodeType));
  const questionNodeIds = new Set(questionNodes.map(n => n.id));
  const reached = computeReachedNodeIds(questionNodes, questionNodeIds, edges, entryNodeIds);

  const reachedFieldKeys = new Set(
    questionNodes.filter(n => reached.has(n.id)).map(n => n.fieldKey)
  );

  return questionNodes
    .filter(n => !reached.has(n.id) && n.fieldKey && reachedFieldKeys.has(n.fieldKey))
    .map(n => n.id);
};

/**
 * Resolve the set of question-subgraph entry node ids: the target of every
 * booking_trigger reply node's single unconditional outgoing edge. Mirrors
 * bookingGraph.service.js#startGraphSession's own lookup, generalized to
 * every such reply node rather than assuming exactly one.
 * @param {Array} nodes
 * @param {Array} edges
 * @returns {string[]}
 */
const resolveBookingTriggerEntryNodeIds = (nodes, edges) => {
  const triggerNodeIds = new Set(
    nodes.filter(n => n.nodeType === 'reply' && n.replyKind === 'booking_trigger').map(n => n.id)
  );
  const entryNodeIds = [];
  for (const edge of edges) {
    if (triggerNodeIds.has(edge.fromNodeId) && !edge.condition) {
      entryNodeIds.push(edge.toNodeId);
    }
  }
  return entryNodeIds;
};

/**
 * Whether a customer can enter the chat booking question subgraph at all:
 * either (a) any booking_trigger reply node exists
 * (bookingGraph.service.js#startGraphSession), or (b) any edge runs from a
 * reply node (any replyKind) straight into a question-subgraph node — a
 * button/list tap on it starts the graph at that node via
 * webhook.controller.js's directBookingEntry / startGraphSessionAtNode,
 * no booking_trigger involved. Deliberately broader than
 * resolveBookingTriggerEntryNodeIds (which only covers (a)). Used to scope
 * the reserved travel field-key guard: a business that books only through
 * web_form_trigger never runs these nodes, so they're safe to delete/rename.
 * @param {Array} nodes
 * @param {Array} edges
 * @returns {boolean}
 */
const canEnterBookingQuestions = (nodes, edges) => {
  if (nodes.some(n => n.nodeType === 'reply' && n.replyKind === 'booking_trigger')) {
    return true;
  }
  const replyNodeIds = new Set(nodes.filter(n => n.nodeType === 'reply').map(n => n.id));
  const questionNodeIds = new Set(nodes.filter(n => QUESTION_SUBGRAPH_TYPES.includes(n.nodeType)).map(n => n.id));
  return edges.some(e => replyNodeIds.has(e.fromNodeId) && questionNodeIds.has(e.toNodeId));
};

/**
 * Existence-only check: condition.field must name a real field_key among
 * this business's question-subgraph nodes. Does NOT verify the field is
 * collected earlier than this edge on every path (see file header).
 * @param {Object|null} condition - a flow_edges.condition value
 * @param {Set<string>|string[]} knownFieldKeys
 * @returns {string|null} error message, or null if valid
 */
const validateConditionField = (condition, knownFieldKeys) => {
  if (!condition) return null;
  const known = knownFieldKeys instanceof Set ? knownFieldKeys : new Set(knownFieldKeys);
  if (!condition.field || !known.has(condition.field)) {
    return `condition references unknown field "${condition.field}" — must be a field_key among this business's question nodes.`;
  }
  return null;
};

module.exports = {
  findCycles,
  findUnreachableNodes,
  findFallbackSiblingNodeIds,
  resolveBookingTriggerEntryNodeIds,
  canEnterBookingQuestions,
  validateConditionField
};
