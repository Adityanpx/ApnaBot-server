const supabase = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/response');
const { toCamelCase } = require('../utils/caseConvert');
const { invalidateRulesCache } = require('../services/chatbot.service');
const {
  readBusinessGraphRows,
  deleteBusinessGraphRows,
  writeBusinessGraphRows
} = require('../services/flowSnapshot.service');
const businessCategoryService = require('../services/businessCategory.service');
const logger = require('../utils/logger');

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
 * POST /api/flow-graph/snapshots
 * Body: { name }. Copies this business's CURRENT flow_nodes/flow_edges into
 * a new flow_snapshots row (business_id = this business, is_category_template
 * = false, category = null). Full row arrays, original ids intact — see
 * flow_snapshots' table comment for why (restore needs from_node_id/
 * to_node_id to stay resolvable).
 */
const createSnapshot = async (req, res, next) => {
  try {
    const { name } = req.body;
    const businessId = req.user.businessId;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return errorResponse(res, 400, 'name is required');
    }

    const { nodes, edges } = await readBusinessGraphRows(businessId);

    const { data: snapshot, error } = await supabase.from('flow_snapshots').insert({
      business_id: businessId,
      name: name.trim(),
      nodes,
      edges,
      is_category_template: false,
      category: null
    }).select('id, name, created_at, is_active').single();
    if (error) throw error;

    await setActiveSnapshot(businessId, snapshot.id);
    await enforceSnapshotCap(businessId);

    return successResponse(res, 201, toCamelCase({ ...snapshot, is_active: true }));
  } catch (error) {
    logger.error('Error in createSnapshot:', error);
    next(error);
  }
};

/**
 * GET /api/flow-graph/snapshots
 * This business's own snapshots, most recent first. Deliberately excludes
 * the nodes/edges jsonb columns — the list view only needs enough to pick a
 * snapshot to restore/delete, and those columns can be large.
 */
const getSnapshots = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { data, error } = await supabase
      .from('flow_snapshots')
      .select('id, name, created_at, is_active')
      .eq('business_id', businessId)
      .eq('is_category_template', false)
      .order('created_at', { ascending: false });
    if (error) throw error;

    return successResponse(res, 200, { snapshots: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getSnapshots:', error);
    next(error);
  }
};

/**
 * POST /api/flow-graph/snapshots/:id/restore
 * Full replace: deletes this business's current flow_nodes/flow_edges and
 * recreates them from the snapshot's stored rows, reusing the ORIGINAL
 * node/edge ids (see flowSnapshot.service.js#writeBusinessGraphRows doc
 * comment — safe here because target and source are the same business, and
 * keeps any in-flight WhatsApp session's currentNodeId resolvable across
 * the restore). Marks this snapshot is_active=true, unsets it on every
 * other snapshot for this business.
 */
const restoreSnapshot = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: snapshot, error: findErr } = await supabase
      .from('flow_snapshots').select('*')
      .eq('id', id).eq('business_id', businessId).eq('is_category_template', false)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!snapshot) {
      return errorResponse(res, 404, 'Snapshot not found');
    }

    await deleteBusinessGraphRows(businessId);
    await writeBusinessGraphRows(businessId, snapshot.nodes, snapshot.edges, {
      reuseIds: true,
      resetTriggerCount: false
    });
    await invalidateRulesCache(businessId);

    await setActiveSnapshot(businessId, id);

    return successResponse(res, 200, toCamelCase({
      id: snapshot.id,
      name: snapshot.name,
      created_at: snapshot.created_at,
      is_active: true
    }), 'Snapshot restored successfully');
  } catch (error) {
    logger.error('Error in restoreSnapshot:', error);
    next(error);
  }
};

/**
 * DELETE /api/flow-graph/snapshots/:id
 */
const deleteSnapshot = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: snapshot, error: findErr } = await supabase
      .from('flow_snapshots').select('id')
      .eq('id', id).eq('business_id', businessId).eq('is_category_template', false)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!snapshot) {
      return errorResponse(res, 404, 'Snapshot not found');
    }

    const { error } = await supabase.from('flow_snapshots').delete().eq('id', id);
    if (error) throw error;

    return successResponse(res, 200, null, 'Snapshot deleted successfully');
  } catch (error) {
    logger.error('Error in deleteSnapshot:', error);
    next(error);
  }
};

/**
 * GET /api/flow-graph/snapshots/category-templates?category=X
 * Lists active templates for the given category as { id, name, description },
 * no nodes/edges — list view only, same "keep it light" pattern getSnapshots
 * follows. Populates the picker business owners use to choose a template
 * before calling importCategoryTemplate below.
 */
const getCategoryTemplateOptions = async (req, res, next) => {
  try {
    const { category } = req.query;

    if (!category || typeof category !== 'string') {
      return errorResponse(res, 400, 'category is required');
    }

    const { data, error } = await supabase
      .from('flow_snapshots')
      .select('id, name, description')
      .eq('category', category).eq('is_category_template', true).eq('is_active', true)
      .order('created_at', { ascending: false });
    if (error) throw error;

    return successResponse(res, 200, { templates: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getCategoryTemplateOptions:', error);
    next(error);
  }
};

/**
 * POST /api/flow-graph/snapshots/import-category-template
 * Body: { templateId }. Full replace of this business's current graph with
 * the chosen category-template's stored nodes/edges, minting FRESH ids
 * (writeBusinessGraphRows reuseIds:false — the same template row is copied
 * into many businesses, so reusing its stored ids would collide the moment
 * a second business imports it) and resetting trigger_count (the source is
 * a template or another business, not this one — its historical counts are
 * meaningless here).
 *
 * Looks up the template by id only (not by category) — this deliberately
 * trusts the caller to have picked a templateId whose category matches
 * their own business (via the filtered list from getCategoryTemplateOptions
 * above) rather than re-validating the category server-side. Flagged as a
 * deliberate simplification, not an oversight.
 *
 * Deliberately does NOT refuse when this business's graph is already
 * non-empty — always replaces. Confirmed with the requester: the guard
 * against accidentally wiping a business's in-progress graph belongs in the
 * frontend as an explicit confirmation step before this endpoint is called,
 * not as a backend precondition.
 *
 * On success, also auto-saves a flow_snapshots restore point from
 * template.nodes/.edges directly (not re-read from flow_nodes — same
 * values just written, no redundant round-trip; note the snapshot's stored
 * ids are therefore the template's original ids, not the fresh ones
 * writeBusinessGraphRows minted for this business's live rows — harmless
 * since restore only needs the stored nodes/edges to be internally
 * consistent, same as any other snapshot). Snapshot-save failures are
 * logged and swallowed — the import having succeeded is what matters.
 */
const importCategoryTemplate = async (req, res, next) => {
  try {
    const { templateId } = req.body;
    const businessId = req.user.businessId;

    if (!templateId || typeof templateId !== 'string') {
      return errorResponse(res, 400, 'templateId is required');
    }

    const { data: template, error: findErr } = await supabase
      .from('flow_snapshots').select('*')
      .eq('id', templateId).eq('is_category_template', true).eq('is_active', true)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!template) {
      return errorResponse(res, 404, 'Template not found');
    }

    await deleteBusinessGraphRows(businessId);
    await writeBusinessGraphRows(businessId, template.nodes, template.edges, {
      reuseIds: false,
      resetTriggerCount: true
    });
    await invalidateRulesCache(businessId);

    try {
      const categories = await businessCategoryService.getAllCategories();
      const categoryLabel = categories.find((c) => c.value === template.category)?.label || template.category;
      const formattedDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

      const { data: newSnapshot, error: snapshotErr } = await supabase.from('flow_snapshots').insert({
        business_id: businessId,
        name: `Imported ${categoryLabel} template — ${formattedDate}`,
        nodes: template.nodes,
        edges: template.edges,
        is_category_template: false,
        is_active: true
      }).select('id').single();
      if (snapshotErr) throw snapshotErr;

      await setActiveSnapshot(businessId, newSnapshot.id);
      await enforceSnapshotCap(businessId);
    } catch (snapshotError) {
      logger.error('Error auto-snapshotting imported category template:', snapshotError);
    }

    return successResponse(res, 200, null, 'Category template imported successfully');
  } catch (error) {
    logger.error('Error in importCategoryTemplate:', error);
    next(error);
  }
};

/**
 * POST /api/flow-graph/snapshots/start-blank
 * Wipes this business's current flow_nodes/flow_edges rows and leaves it
 * with a literal empty graph — the explicit "create a new flow from
 * scratch" action for the Versions tab, for businesses that want a
 * different flow for a different occasion. Deliberately mirrors
 * restoreSnapshot/importCategoryTemplate: same raw deleteBusinessGraphRows
 * call, no reserved-fieldKey / incoming-edge / fallback-sibling guard
 * checks (those exist to stop an accidental single-node/batch delete from
 * silently breaking a live booking flow — an explicit, confirmed "start
 * blank" from the owner is exactly the case they don't apply to). The
 * frontend confirm dialog is what protects against doing this by accident;
 * this endpoint does not ask the caller to save a version first, matching
 * every other destructive action here (frontend nudges, backend doesn't
 * enforce).
 *
 * Also unsets is_active on every snapshot for this business — none of them
 * describe the current (now blank) live graph anymore.
 */
const startBlankFlow = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    await deleteBusinessGraphRows(businessId);
    await invalidateRulesCache(businessId);

    const { error: unsetErr } = await supabase
      .from('flow_snapshots').update({ is_active: false })
      .eq('business_id', businessId).eq('is_category_template', false);
    if (unsetErr) throw unsetErr;

    return successResponse(res, 200, null, 'Started a new blank flow');
  } catch (error) {
    logger.error('Error in startBlankFlow:', error);
    next(error);
  }
};

module.exports = {
  // Shared with aiFlow.service.js's pre-apply snapshot cap (additive export only).
  MAX_SNAPSHOTS_PER_BUSINESS,
  createSnapshot,
  getSnapshots,
  restoreSnapshot,
  deleteSnapshot,
  getCategoryTemplateOptions,
  importCategoryTemplate,
  startBlankFlow
};
