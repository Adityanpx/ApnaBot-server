const supabase = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/response');
const { toCamelCase } = require('../utils/caseConvert');
const { readBusinessGraphRows } = require('../services/flowSnapshot.service');
const businessCategoryService = require('../services/businessCategory.service');
const logger = require('../utils/logger');

/**
 * GET /api/admin/category-templates
 * List all category-template rows. Multiple templates per category are
 * expected now — business owners pick from a list of templates for their
 * category instead of getting a single fixed one (see
 * flowSnapshot.controller.js#getCategoryTemplateOptions for the
 * business-owner-facing version of this list).
 */
const getCategoryTemplates = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('flow_snapshots')
      .select('id, category, name, description, created_at, updated_at')
      .eq('is_category_template', true)
      .order('category', { ascending: true });
    if (error) throw error;

    return successResponse(res, 200, { templates: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getCategoryTemplates:', error);
    next(error);
  }
};

/**
 * POST /api/admin/category-templates/clone-from-business
 * Body: { businessId, category, name, description?, sourceSnapshotId? }.
 * When sourceSnapshotId is omitted, reads businessId's CURRENT
 * flow_nodes/flow_edges (same read helper createSnapshot uses) — unchanged
 * from before. When sourceSnapshotId is given, clones that specific
 * flow_snapshots row's stored nodes/edges instead (one of the business
 * owner's own saved Versions-tab snapshots), scoped to business_id =
 * businessId so a snapshot id can't be guessed across businesses. Either
 * way the result is stored as a NEW category-template row, alongside any
 * existing templates for that category — multiple templates per category
 * are expected now, this always ADDS one, never replaces.
 */
const cloneFromBusiness = async (req, res, next) => {
  try {
    const { businessId, category, name, description, sourceSnapshotId } = req.body;

    if (!businessId || typeof businessId !== 'string') {
      return errorResponse(res, 400, 'businessId is required');
    }
    if (!category || !(await businessCategoryService.isKnownCategory(category))) {
      return errorResponse(res, 400, `Invalid category: ${category}`);
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      return errorResponse(res, 400, 'name is required');
    }
    if (sourceSnapshotId !== undefined && (typeof sourceSnapshotId !== 'string' || !sourceSnapshotId.trim())) {
      return errorResponse(res, 400, 'sourceSnapshotId must be a string');
    }

    const { data: business, error: businessErr } = await supabase
      .from('businesses').select('id').eq('id', businessId).maybeSingle();
    if (businessErr) throw businessErr;
    if (!business) {
      return errorResponse(res, 404, 'Business not found');
    }

    let nodes, edges;
    if (sourceSnapshotId) {
      const { data: sourceSnapshot, error: snapshotErr } = await supabase
        .from('flow_snapshots').select('nodes, edges')
        .eq('id', sourceSnapshotId).eq('business_id', businessId).eq('is_category_template', false)
        .maybeSingle();
      if (snapshotErr) throw snapshotErr;
      if (!sourceSnapshot) {
        return errorResponse(res, 404, 'Source snapshot not found');
      }
      ({ nodes, edges } = sourceSnapshot);
    } else {
      ({ nodes, edges } = await readBusinessGraphRows(businessId));
    }

    const { data: template, error: insertErr } = await supabase.from('flow_snapshots').insert({
      business_id: null,
      category,
      name: name.trim(),
      description: description || null,
      nodes,
      edges,
      is_category_template: true,
      is_active: true
    }).select('id, category, name, description, created_at, updated_at').single();
    if (insertErr) throw insertErr;

    return successResponse(res, 201, toCamelCase(template));
  } catch (error) {
    logger.error('Error in cloneFromBusiness:', error);
    next(error);
  }
};

/**
 * DELETE /api/admin/category-templates/:id
 */
const deleteCategoryTemplate = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: template, error: findErr } = await supabase
      .from('flow_snapshots').select('id').eq('id', id).eq('is_category_template', true).maybeSingle();
    if (findErr) throw findErr;
    if (!template) {
      return errorResponse(res, 404, 'Category template not found');
    }

    const { error } = await supabase.from('flow_snapshots').delete().eq('id', id);
    if (error) throw error;

    return successResponse(res, 200, null, 'Category template deleted successfully');
  } catch (error) {
    logger.error('Error in deleteCategoryTemplate:', error);
    next(error);
  }
};

/**
 * GET /api/admin/category-templates/:id/export
 * Direct passthrough of the stored flow_snapshots row's nodes/edges
 * columns (raw snake_case, original ids) — same shape readBusinessGraphRows
 * / cloneFromBusiness already work with. No transformation needed.
 */
const exportTemplateJson = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: template, error } = await supabase
      .from('flow_snapshots')
      .select('category, name, nodes, edges')
      .eq('id', id).eq('is_category_template', true).maybeSingle();
    if (error) throw error;
    if (!template) {
      return errorResponse(res, 404, 'Category template not found');
    }

    return successResponse(res, 200, {
      category: template.category,
      name: template.name,
      nodes: template.nodes,
      edges: template.edges
    });
  } catch (error) {
    logger.error('Error in exportTemplateJson:', error);
    next(error);
  }
};

const KNOWN_NODE_TYPES = ['reply', 'question', 'vehicle_carousel', 'rentalPackage'];

/**
 * POST /api/admin/category-templates/import-json
 * Body: { category, name, nodes, edges, description? }. Counterpart to
 * exportTemplateJson — takes the same raw row-array shape (hand-edited or
 * round-tripped from an export) and stores it as a NEW category template,
 * alongside any existing templates for that category — multiple templates
 * per category are expected now, this always ADDS one, never replaces.
 * Deliberately does NOT re-mint node/edge ids: this is a fresh template
 * being defined from scratch, not copied from a live business, so the ids
 * in the JSON are the template's canonical ids. Businesses importing the
 * template later mint their own fresh ids (writeBusinessGraphRows
 * reuseIds:false), so there's no collision risk.
 */
const importTemplateJson = async (req, res, next) => {
  try {
    const { category, name, nodes, edges, description } = req.body;

    if (!category || !(await businessCategoryService.isKnownCategory(category))) {
      return errorResponse(res, 400, `Invalid category: ${category}`);
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      return errorResponse(res, 400, 'name is required');
    }
    if (!Array.isArray(nodes) || !Array.isArray(edges)) {
      return errorResponse(res, 400, 'nodes and edges must be arrays');
    }

    const nodeIds = new Set();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n || typeof n.id !== 'string' || !KNOWN_NODE_TYPES.includes(n.node_type)) {
        return errorResponse(res, 400, `nodes[${i}]: missing or invalid id/node_type`);
      }
      nodeIds.add(n.id);
    }

    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (!e || typeof e.id !== 'string' || typeof e.from_node_id !== 'string' || typeof e.to_node_id !== 'string') {
        return errorResponse(res, 400, `edges[${i}]: missing or invalid id/from_node_id/to_node_id`);
      }
      if (!nodeIds.has(e.from_node_id) || !nodeIds.has(e.to_node_id)) {
        return errorResponse(res, 400, `edges[${i}]: from_node_id/to_node_id does not match any node in nodes`);
      }
    }

    const { data: template, error: insertErr } = await supabase.from('flow_snapshots').insert({
      business_id: null,
      category,
      name: name.trim(),
      description: description || null,
      nodes,
      edges,
      is_category_template: true,
      is_active: true
    }).select('id, category, name, description, created_at, updated_at').single();
    if (insertErr) throw insertErr;

    return successResponse(res, 201, toCamelCase(template));
  } catch (error) {
    logger.error('Error in importTemplateJson:', error);
    next(error);
  }
};

module.exports = {
  getCategoryTemplates,
  cloneFromBusiness,
  deleteCategoryTemplate,
  exportTemplateJson,
  importTemplateJson
};
