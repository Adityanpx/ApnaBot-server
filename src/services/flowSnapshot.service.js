const crypto = require('crypto');
const supabase = require('../config/supabase');

/**
 * Raw (snake_case, un-toCamelCase'd) current flow_nodes/flow_edges rows for
 * one business — shared by snapshot creation (flowSnapshot.controller.js),
 * category-template cloning (categoryTemplate.controller.js), and
 * business.service.js's createBusiness template copy. Full rows, because
 * every caller stores or reinserts these verbatim (see flow_snapshots'
 * table comment in 20260829140000_flow_nodes_edges.sql: "nodes/edges stored
 * as full row arrays, including each node/edge's original id").
 */
const readBusinessGraphRows = async (businessId) => {
  const { data: nodes, error: nodesErr } = await supabase
    .from('flow_nodes').select('*').eq('business_id', businessId);
  if (nodesErr) throw nodesErr;
  const { data: edges, error: edgesErr } = await supabase
    .from('flow_edges').select('*').eq('business_id', businessId);
  if (edgesErr) throw edgesErr;
  return { nodes: nodes || [], edges: edges || [] };
};

/**
 * Deletes a business's current flow_nodes/flow_edges rows. Edges are
 * deleted explicitly first rather than relying on flow_nodes' ON DELETE
 * CASCADE, matching this codebase's preference for explicit .eq() chains
 * over implicit cascade behavior at call sites that care about the result.
 */
const deleteBusinessGraphRows = async (businessId) => {
  const { error: edgesErr } = await supabase.from('flow_edges').delete().eq('business_id', businessId);
  if (edgesErr) throw edgesErr;
  const { error: nodesErr } = await supabase.from('flow_nodes').delete().eq('business_id', businessId);
  if (nodesErr) throw nodesErr;
};

/**
 * Recreates flow_nodes/flow_edges rows for targetBusinessId from stored
 * snapshot/template row arrays (raw snake_case shape, as returned by
 * readBusinessGraphRows / stored in flow_snapshots.nodes/.edges).
 *
 * reuseIds=true keeps each node/edge's original id — used only by restore,
 * where targetBusinessId is the SAME business the stored rows came from, so
 * there is no cross-business id-collision risk (ids are gen_random_uuid(),
 * 122 bits of randomness), and preserving ids keeps any in-flight WhatsApp
 * session's currentNodeId still resolvable after the restore.
 *
 * reuseIds=false mints fresh ids client-side (crypto.randomUUID(), so the
 * old-id -> new-id mapping is known up front rather than inferred from
 * insert-return order) and remaps from_node_id/to_node_id accordingly —
 * required whenever the same stored rows get copied into MULTIPLE
 * businesses (import-category-template, clone-derived copies, the
 * createBusiness signup copy): reusing ids there would be a real primary
 * key collision the moment a second business copies the same source rows.
 *
 * resetTriggerCount controls whether each node's trigger_count (a live
 * per-node analytics counter) carries over. false only for restore (putting
 * the graph back exactly as snapshotted, counters included); true for every
 * copy-into-a-different-context case, since another business's or a
 * template's historical trigger counts are meaningless for the target.
 */
const writeBusinessGraphRows = async (targetBusinessId, storedNodes, storedEdges, { reuseIds, resetTriggerCount }) => {
  const idMap = new Map();
  const nodesToInsert = (storedNodes || []).map(n => {
    const newId = reuseIds ? n.id : crypto.randomUUID();
    idMap.set(n.id, newId);
    const { id, created_at, updated_at, ...rest } = n;
    return {
      ...rest,
      id: newId,
      business_id: targetBusinessId,
      trigger_count: resetTriggerCount ? 0 : n.trigger_count
    };
  });

  if (nodesToInsert.length > 0) {
    const { error: nodesErr } = await supabase.from('flow_nodes').insert(nodesToInsert);
    if (nodesErr) throw nodesErr;
  }

  const edgesToInsert = (storedEdges || []).map(e => {
    const { id, created_at, updated_at, from_node_id, to_node_id, ...rest } = e;
    return {
      ...rest,
      id: reuseIds ? id : crypto.randomUUID(),
      business_id: targetBusinessId,
      from_node_id: idMap.get(from_node_id),
      to_node_id: idMap.get(to_node_id)
    };
  });

  if (edgesToInsert.length > 0) {
    const { error: edgesErr } = await supabase.from('flow_edges').insert(edgesToInsert);
    if (edgesErr) throw edgesErr;
  }
};

const MAX_SNAPSHOTS_PER_BUSINESS = 5;

/**
 * Keeps at most MAX_SNAPSHOTS_PER_BUSINESS of a business's own saved
 * snapshots (is_category_template: false), deleting the oldest ones first.
 */
const enforceSnapshotCap = async (businessId) => {
  const { data, error } = await supabase
    .from('flow_snapshots')
    .select('id')
    .eq('business_id', businessId)
    .eq('is_category_template', false)
    .order('created_at', { ascending: true });
  if (error) throw error;

  const snapshots = data || [];
  if (snapshots.length <= MAX_SNAPSHOTS_PER_BUSINESS) return;

  const idsToDelete = snapshots.slice(0, snapshots.length - MAX_SNAPSHOTS_PER_BUSINESS).map((s) => s.id);
  const { error: deleteErr } = await supabase.from('flow_snapshots').delete().in('id', idsToDelete);
  if (deleteErr) throw deleteErr;
};

/**
 * Marks snapshotId as the single active snapshot for this business's own
 * saved snapshots (is_category_template: false), unsetting every other one.
 */
const setActiveSnapshot = async (businessId, snapshotId) => {
  const { error: unsetErr } = await supabase
    .from('flow_snapshots').update({ is_active: false })
    .eq('business_id', businessId).eq('is_category_template', false).neq('id', snapshotId);
  if (unsetErr) throw unsetErr;

  const { error: setErr } = await supabase
    .from('flow_snapshots').update({ is_active: true }).eq('id', snapshotId);
  if (setErr) throw setErr;
};

/**
 * Inserts one of a business's own snapshots (is_category_template: false,
 * category null) from already-read row arrays and returns { id, name,
 * created_at, is_active }. Does NOT mark it active or enforce the cap —
 * callers decide (see setActiveSnapshot / enforceSnapshotCap above).
 */
const createSnapshotFromRows = async (businessId, name, nodes, edges) => {
  const { data, error } = await supabase.from('flow_snapshots').insert({
    business_id: businessId,
    name,
    nodes,
    edges,
    is_category_template: false,
    category: null
  }).select('id, name, created_at, is_active').single();
  if (error) throw error;
  return data;
};

module.exports = {
  MAX_SNAPSHOTS_PER_BUSINESS,
  readBusinessGraphRows,
  deleteBusinessGraphRows,
  writeBusinessGraphRows,
  enforceSnapshotCap,
  setActiveSnapshot,
  createSnapshotFromRows
};
