const crypto = require('crypto');
const supabase = require('../config/supabase');
const { invalidateRulesCache } = require('../services/chatbot.service');
const { writeBusinessGraphRows } = require('../services/flowSnapshot.service');
const businessCategoryService = require('../services/businessCategory.service');
const { successResponse, errorResponse } = require('../utils/response');
const { toCamelCase } = require('../utils/caseConvert');
const logger = require('../utils/logger');

/**
 * GET /api/flow-graph/library?category=<businessCategory>
 * Library entries for that category, projected down to just what a browser
 * UI needs to display a pick list. Deliberately excludes source_business_id/
 * source_node_id (SuperAdmin-internal provenance, not for business owners)
 * and the rest of node_data - full node_data is only read server-side, at
 * insert time.
 */
const getLibraryForCategory = async (req, res, next) => {
  try {
    const { category } = req.query;

    if (!category || !(await businessCategoryService.isKnownCategory(category))) {
      return errorResponse(res, 400, `Invalid category: ${category}`);
    }

    const { data, error } = await supabase
      .from('node_library_entries')
      .select('id, node_type, node_data, created_at')
      .eq('category', category)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const entries = (data || []).map(e => ({
      id: e.id,
      nodeType: e.node_type,
      label: e.node_data.label || null,
      keyword: e.node_data.keyword || null
    }));

    return successResponse(res, 200, { entries });
  } catch (error) {
    logger.error('Error in getLibraryForCategory:', error);
    next(error);
  }
};

/**
 * POST /api/flow-graph/library/insert
 * Body: { entryId }. Inserts a fresh flow_nodes row for the calling
 * business from the library entry's node_data - new id, this business's
 * business_id, zero edges (matching writeBusinessGraphRows's reuseIds:false
 * "copied into a different business" semantics: a fresh id, not the
 * original source node's id). The new id is minted up front so the created
 * row can be read back and returned - writeBusinessGraphRows itself doesn't
 * return inserted rows (it's built for bulk snapshot/template restores).
 *
 * For a question node, rejects on a field_key collision against this
 * business's existing flow_nodes rather than silently creating a confusing
 * duplicate - matches this task's spec, and mirrors createReplyNode's own
 * duplicate-keyword guard in flowGraph.controller.js, though NOTE this path
 * does not itself re-check keyword collisions for reply nodes (only
 * field_key, for question nodes, was in scope here).
 */
const insertNodeFromLibrary = async (req, res, next) => {
  try {
    const { entryId } = req.body;
    const businessId = req.user.businessId;

    if (!entryId || typeof entryId !== 'string') {
      return errorResponse(res, 400, 'entryId is required');
    }

    const { data: entry, error: findErr } = await supabase
      .from('node_library_entries').select('*').eq('id', entryId).maybeSingle();
    if (findErr) throw findErr;
    if (!entry) {
      return errorResponse(res, 404, 'Library entry not found');
    }

    const nodeData = entry.node_data;

    if (entry.node_type === 'question' && nodeData.field_key) {
      const { data: existingField, error: fieldErr } = await supabase
        .from('flow_nodes').select('id')
        .eq('business_id', businessId).eq('field_key', nodeData.field_key).maybeSingle();
      if (fieldErr) throw fieldErr;
      if (existingField) {
        return errorResponse(res, 400,
          `A question with field key "${nodeData.field_key}" already exists in your flow.`);
      }
    }

    const newNodeId = crypto.randomUUID();
    await writeBusinessGraphRows(businessId, [{ ...nodeData, id: newNodeId }], [], {
      reuseIds: true,
      resetTriggerCount: true
    });

    const { data: newNode, error: fetchErr } = await supabase
      .from('flow_nodes').select('*').eq('id', newNodeId).single();
    if (fetchErr) throw fetchErr;

    await invalidateRulesCache(businessId);

    return successResponse(res, 201, toCamelCase(newNode));
  } catch (error) {
    logger.error('Error in insertNodeFromLibrary:', error);
    next(error);
  }
};

module.exports = {
  getLibraryForCategory,
  insertNodeFromLibrary
};
