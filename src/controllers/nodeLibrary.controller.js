const supabase = require('../config/supabase');
const businessCategoryService = require('../services/businessCategory.service');
const { successResponse, errorResponse } = require('../utils/response');
const { toCamelCase } = require('../utils/caseConvert');
const logger = require('../utils/logger');

const LIBRARY_NODE_TYPES = ['reply', 'question'];

/**
 * GET /api/admin/node-library/businesses/:businessId/nodes
 * That business's current active reply/question flow_nodes, each annotated
 * with whether it's already in the library (and under which category), so
 * the admin UI can grey out/relabel already-added nodes without a separate
 * lookup call.
 */
const getBusinessNodes = async (req, res, next) => {
  try {
    const { businessId } = req.params;

    const { data: business, error: businessErr } = await supabase
      .from('businesses').select('id').eq('id', businessId).maybeSingle();
    if (businessErr) throw businessErr;
    if (!business) {
      return errorResponse(res, 404, 'Business not found');
    }

    const { data: nodes, error: nodesErr } = await supabase
      .from('flow_nodes').select('*')
      .eq('business_id', businessId).eq('is_active', true)
      .in('node_type', LIBRARY_NODE_TYPES)
      .order('created_at', { ascending: false });
    if (nodesErr) throw nodesErr;

    const { data: existingEntries, error: entriesErr } = await supabase
      .from('node_library_entries').select('source_node_id, category')
      .eq('source_business_id', businessId);
    if (entriesErr) throw entriesErr;

    const categoryBySourceNodeId = new Map((existingEntries || []).map(e => [e.source_node_id, e.category]));

    const result = (nodes || []).map(n => {
      const libraryCategory = categoryBySourceNodeId.get(n.id) || null;
      return {
        ...toCamelCase(n),
        alreadyInLibrary: libraryCategory !== null,
        libraryCategory
      };
    });

    return successResponse(res, 200, { nodes: result });
  } catch (error) {
    logger.error('Error in getBusinessNodes:', error);
    next(error);
  }
};

/**
 * POST /api/admin/node-library
 * Body: { sourceBusinessId, sourceNodeId, category }. Reads the live
 * flow_nodes row (must belong to sourceBusinessId), snapshots it into
 * node_data minus id/business_id/created_at/updated_at/trigger_count, and
 * inserts a library entry. The unique dedup index is the actual enforcement
 * of "not added twice" — this just turns that constraint violation into a
 * friendly 409 instead of a raw DB error.
 */
const addNodeToLibrary = async (req, res, next) => {
  try {
    const { sourceBusinessId, sourceNodeId, category } = req.body;

    if (!sourceBusinessId || typeof sourceBusinessId !== 'string') {
      return errorResponse(res, 400, 'sourceBusinessId is required');
    }
    if (!sourceNodeId || typeof sourceNodeId !== 'string') {
      return errorResponse(res, 400, 'sourceNodeId is required');
    }
    if (!category || !(await businessCategoryService.isKnownCategory(category))) {
      return errorResponse(res, 400, `Invalid category: ${category}`);
    }

    const { data: sourceNode, error: nodeErr } = await supabase
      .from('flow_nodes').select('*')
      .eq('id', sourceNodeId).eq('business_id', sourceBusinessId).maybeSingle();
    if (nodeErr) throw nodeErr;
    if (!sourceNode) {
      return errorResponse(res, 404, 'Source node not found for this business');
    }
    if (!LIBRARY_NODE_TYPES.includes(sourceNode.node_type)) {
      return errorResponse(res, 400,
        `Only reply/question nodes can be added to the library (this node is "${sourceNode.node_type}")`);
    }

    const { id, business_id, created_at, updated_at, trigger_count, ...node_data } = sourceNode;

    const { data: entry, error: insertErr } = await supabase.from('node_library_entries').insert({
      category,
      node_type: sourceNode.node_type,
      node_data,
      source_business_id: sourceBusinessId,
      source_node_id: sourceNodeId,
      added_by_admin_id: req.user.userId
    }).select().single();

    if (insertErr) {
      if (insertErr.code === '23505') {
        const { data: existing } = await supabase
          .from('node_library_entries').select('category')
          .eq('source_business_id', sourceBusinessId).eq('source_node_id', sourceNodeId).maybeSingle();
        return errorResponse(res, 409,
          `This node is already in the library (category: ${existing ? existing.category : 'unknown'})`);
      }
      throw insertErr;
    }

    return successResponse(res, 201, toCamelCase(entry));
  } catch (error) {
    logger.error('Error in addNodeToLibrary:', error);
    next(error);
  }
};

/**
 * GET /api/admin/node-library
 * Optional ?category= filter, for the library browser.
 */
const listLibraryEntries = async (req, res, next) => {
  try {
    const { category } = req.query;

    let query = supabase.from('node_library_entries').select('*');
    if (category !== undefined) {
      if (!(await businessCategoryService.isKnownCategory(category))) {
        return errorResponse(res, 400, `Invalid category: ${category}`);
      }
      query = query.eq('category', category);
    }

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;

    return successResponse(res, 200, { entries: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in listLibraryEntries:', error);
    next(error);
  }
};

/**
 * DELETE /api/admin/node-library/:id
 */
const deleteLibraryEntry = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: entry, error: findErr } = await supabase
      .from('node_library_entries').select('id').eq('id', id).maybeSingle();
    if (findErr) throw findErr;
    if (!entry) {
      return errorResponse(res, 404, 'Library entry not found');
    }

    const { error } = await supabase.from('node_library_entries').delete().eq('id', id);
    if (error) throw error;

    return successResponse(res, 200, null, 'Library entry deleted successfully');
  } catch (error) {
    logger.error('Error in deleteLibraryEntry:', error);
    next(error);
  }
};

module.exports = {
  getBusinessNodes,
  addNodeToLibrary,
  listLibraryEntries,
  deleteLibraryEntry
};
