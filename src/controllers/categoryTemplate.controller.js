const supabase = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/response');
const { toCamelCase } = require('../utils/caseConvert');
const { readBusinessGraphRows, withNodeDefaults, withEdgeDefaults } = require('../services/flowSnapshot.service');
const businessCategoryService = require('../services/businessCategory.service');
const logger = require('../utils/logger');
const { r2KeyFromUrl } = require('../utils/r2Key');
const { transformNodesForCopy } = require('../utils/copySetup');
const { isValidLanguageCode } = require('../utils/languageCatalog');
const flowTranslate = require('../services/flowTranslate.service');
const azure = require('../services/azureTranslate.service');

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
      .select('id, category, name, description, is_default, is_active, created_at, updated_at')
      .eq('is_category_template', true)
      .order('category', { ascending: true });
    if (error) throw error;

    return successResponse(res, 200, { templates: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getCategoryTemplates:', error);
    next(error);
  }
};

const MIN_NAME_LENGTH = 3;

/**
 * Nodes whose text (label or any translation) contains one of the given business
 * names, case-insensitively - so Super Admin can swap it for {{businessName}}
 * before the template is copied into other businesses. Names shorter than
 * MIN_NAME_LENGTH are ignored (they'd match inside ordinary words).
 * @returns {{nodeId:string, key:string, matched:string}[]} key = keyword / field_key / id
 */
const findBusinessNameWarnings = (nodes, names) => {
  const needles = [...new Set((names || [])
    .filter((n) => typeof n === 'string')
    .map((n) => n.trim())
    .filter((n) => n.length >= MIN_NAME_LENGTH))];
  const warnings = [];
  for (const node of nodes || []) {
    const texts = [node.label, ...Object.values(node.label_translations || {})]
      .filter((t) => typeof t === 'string').map((t) => t.toLowerCase());
    const matched = needles.find((needle) => texts.some((t) => t.includes(needle.toLowerCase())));
    if (matched) warnings.push({ nodeId: node.id, key: node.keyword || node.field_key || node.id, matched });
  }
  return warnings;
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
      .from('businesses').select('id, name, display_name').eq('id', businessId).maybeSingle();
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

    // A template is copied into many businesses: store it without the source business's
    // media_id / R2 image_url / per-node location pins (same transform as Copy setup).
    const { nodes: cleanNodes } = transformNodesForCopy(nodes, { isStorageUrl: (url) => !!r2KeyFromUrl(url) });

    const { data: template, error: insertErr } = await supabase.from('flow_snapshots').insert({
      business_id: null,
      category,
      name: name.trim(),
      description: description || null,
      nodes: cleanNodes,
      edges,
      is_category_template: true,
      is_active: true
    }).select('id, category, name, description, created_at, updated_at').single();
    if (insertErr) throw insertErr;

    // Text that still names the source business would reach every new business.
    const warnings = findBusinessNameWarnings(cleanNodes, [business.name, business.display_name]);

    return successResponse(res, 201, { ...toCamelCase(template), warnings });
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
      nodes: nodes.map(withNodeDefaults),
      edges: edges.map(withEdgeDefaults),
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

/**
 * GET /api/admin/category-templates/:id
 * The whole template (raw snake_case nodes/edges, original ids) for preview.
 */
const getCategoryTemplate = async (req, res, next) => {
  try {
    const { data: template, error } = await supabase
      .from('flow_snapshots')
      .select('id, category, name, description, is_default, is_active, nodes, edges, created_at, updated_at')
      .eq('id', req.params.id).eq('is_category_template', true).maybeSingle();
    if (error) throw error;
    if (!template) {
      return errorResponse(res, 404, 'Category template not found');
    }

    // toCamelCase would also rename keys inside the stored nodes/edges.
    const { nodes, edges, ...rest } = template;
    return successResponse(res, 200, { ...toCamelCase(rest), nodes, edges });
  } catch (error) {
    logger.error('Error in getCategoryTemplate:', error);
    next(error);
  }
};

/**
 * POST /api/admin/category-templates/:id/set-default
 * Makes this template the one new businesses of its category get at signup
 * (defaultSetup.service.js). The previous default for the category is cleared
 * in the same transaction (set_default_category_template RPC).
 */
const setDefaultTemplate = async (req, res, next) => {
  try {
    const { data: category, error } = await supabase.rpc('set_default_category_template', { p_template_id: req.params.id });
    if (error) throw error;
    if (!category) {
      return errorResponse(res, 404, 'Active category template not found');
    }

    return successResponse(res, 200, { id: req.params.id, category, isDefault: true }, 'Default template set');
  } catch (error) {
    logger.error('Error in setDefaultTemplate:', error);
    next(error);
  }
};

/**
 * POST /api/admin/category-templates/:id/unset-default
 */
const unsetDefaultTemplate = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('flow_snapshots').update({ is_default: false })
      .eq('id', req.params.id).eq('is_category_template', true)
      .select('id, category');
    if (error) throw error;
    if (!data || data.length === 0) {
      return errorResponse(res, 404, 'Category template not found');
    }

    return successResponse(res, 200, { id: data[0].id, category: data[0].category, isDefault: false }, 'Default template cleared');
  } catch (error) {
    logger.error('Error in unsetDefaultTemplate:', error);
    next(error);
  }
};

const MAX_NODE_TEXT_UPDATES = 500;
const MAX_NODE_TEXT_LENGTH = 4096;

// Validates one translations object ({ hi: 'text', ... }) or null; returns an error string or null.
const translationsError = (value) => {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'must be an object or null';
  for (const [lang, text] of Object.entries(value)) {
    if (!isValidLanguageCode(lang)) return `unknown language "${lang}"`;
    if (typeof text !== 'string' || text.length > MAX_NODE_TEXT_LENGTH) return `"${lang}" must be text up to ${MAX_NODE_TEXT_LENGTH} characters`;
  }
  return null;
};

const translationsOf = (u) => (u.labelTranslations !== undefined ? u.labelTranslations : u.label_translations);

/**
 * PATCH /api/admin/category-templates/:id/node-texts
 * Body: { nodes: [{ id, label?, labelTranslations? }] } - `id` is the node's id
 * inside the template (the id GET /:id and /export show; nodes have no other
 * unique key). Updates ONLY label (the reply / question text) and
 * label_translations; every other column, the node order and the edges are left
 * exactly as stored, so this can never change the template's structure.
 * Businesses that already imported the template are unaffected.
 */
const updateTemplateNodeTexts = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body && req.body.nodes;
    if (!Array.isArray(updates) || updates.length === 0 || updates.length > MAX_NODE_TEXT_UPDATES) {
      return errorResponse(res, 400, `nodes must be an array of 1 to ${MAX_NODE_TEXT_UPDATES} items`);
    }

    const seen = new Set();
    for (let i = 0; i < updates.length; i++) {
      const u = updates[i];
      if (!u || typeof u !== 'object' || typeof u.id !== 'string') {
        return errorResponse(res, 400, `nodes[${i}]: id is required`);
      }
      if (seen.has(u.id)) return errorResponse(res, 400, `nodes[${i}]: duplicate id`);
      seen.add(u.id);
      const translations = translationsOf(u);
      if (u.label === undefined && translations === undefined) {
        return errorResponse(res, 400, `nodes[${i}]: provide label and/or labelTranslations`);
      }
      if (u.label !== undefined && (typeof u.label !== 'string' || !u.label.trim() || u.label.length > MAX_NODE_TEXT_LENGTH)) {
        return errorResponse(res, 400, `nodes[${i}]: label must be non-empty text up to ${MAX_NODE_TEXT_LENGTH} characters`);
      }
      if (translations !== undefined) {
        const problem = translationsError(translations);
        if (problem) return errorResponse(res, 400, `nodes[${i}]: labelTranslations ${problem}`);
      }
    }

    const { data: template, error: findErr } = await supabase
      .from('flow_snapshots').select('nodes').eq('id', id).eq('is_category_template', true).maybeSingle();
    if (findErr) throw findErr;
    if (!template) {
      return errorResponse(res, 404, 'Category template not found');
    }

    const known = new Set((template.nodes || []).map((n) => n.id));
    const missing = updates.filter((u) => !known.has(u.id)).map((u) => u.id);
    if (missing.length > 0) {
      return errorResponse(res, 400, `Unknown node id(s): ${missing.join(', ')}`);
    }

    const byId = new Map(updates.map((u) => [u.id, u]));
    const nodes = (template.nodes || []).map((n) => {
      const u = byId.get(n.id);
      if (!u) return n;
      const translations = translationsOf(u);
      return {
        ...n,
        ...(u.label !== undefined ? { label: u.label.trim() } : {}),
        ...(translations !== undefined ? { label_translations: translations } : {})
      };
    });

    const { error: updateErr } = await supabase
      .from('flow_snapshots').update({ nodes }).eq('id', id).eq('is_category_template', true);
    if (updateErr) throw updateErr;

    return successResponse(res, 200, { id, updated: updates.length }, 'Template texts updated');
  } catch (error) {
    logger.error('Error in updateTemplateNodeTexts:', error);
    next(error);
  }
};

/**
 * POST /api/admin/category-templates/:id/translate
 * Body: { to: '<code>' } - any catalog language except English (not limited to a business's enabled ones).
 * Fills that language's empty texts on the template's stored nodes and edges (labels, button text, form
 * titles, carousel card bodies, choice-question options, edge labels and descriptions), so a business
 * created from the template arrives pre-translated with zero API calls. Existing translations are never
 * overwritten. Not counted against any business cap (only the global Azure counter).
 * -> { language, translated, alreadyTranslated, skipped: [{ slot, reason }], warnings, charged }
 */
const translateTemplate = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { to } = req.body || {};
    if (typeof to !== 'string' || !isValidLanguageCode(to)) return errorResponse(res, 400, 'to must be a language code.');
    if (to === 'en') return errorResponse(res, 400, 'English is the source language and cannot be a translation target.');

    const { data: template, error } = await supabase
      .from('flow_snapshots').select('id, nodes, edges').eq('id', id).eq('is_category_template', true).maybeSingle();
    if (error) throw error;
    if (!template) return errorResponse(res, 404, 'Template not found');

    if (!azure.isConfigured()) {
      return errorResponse(res, 503, azure.NOT_CONFIGURED_MESSAGE, { code: 'TRANSLATE_NOT_CONFIGURED' });
    }

    const result = await flowTranslate.translateTemplate({ template, lang: to });
    return successResponse(res, 200, result);
  } catch (error) {
    if (error && error.name === 'TranslateError') {
      return errorResponse(res, error.statusCode, error.message, { code: error.code });
    }
    logger.error('Error in translateTemplate:', error);
    next(error);
  }
};

module.exports = {
  findBusinessNameWarnings,
  translateTemplate,
  getCategoryTemplate,
  setDefaultTemplate,
  unsetDefaultTemplate,
  updateTemplateNodeTexts,
  getCategoryTemplates,
  cloneFromBusiness,
  deleteCategoryTemplate,
  exportTemplateJson,
  importTemplateJson
};
