const crypto = require('crypto');
const supabase = require('../config/supabase');
const { invalidateRulesCache } = require('../services/chatbot.service');
const bookingGraphService = require('../services/bookingGraph.service');
const {
  findCycles,
  findUnreachableNodes,
  findFallbackSiblingNodeIds,
  resolveBookingTriggerEntryNodeIds,
  validateConditionField
} = require('../utils/flowGraphValidation');
const { validateLabelTranslations } = require('../utils/bookingFieldValidation');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const { toCamelCase } = require('../utils/caseConvert');
const { isValidLanguageCode } = require('../utils/languageCatalog');
const logger = require('../utils/logger');

const VALID_MATCH_TYPES = ['exact', 'contains', 'startsWith'];
const VALID_CONTENT_TYPES = ['text', 'buttons', 'list', 'location'];
const VALID_REPLY_KINDS = ['text', 'booking_trigger', 'payment_trigger', 'web_form_trigger'];
// 'rentalPackage' deliberately excluded — still engine-internal/migration-only,
// per PRD.md's "NOT done yet" note. Only vehicle_carousel has a create path.
const VALID_QUESTION_NODE_TYPES = ['question', 'vehicle_carousel'];

// Ported from business.controller.js's updateBookingFields — same literal
// field_key list bookingGraph.service.js still hardcodes (OTHER_SENTINELS,
// the tripType === 'Local Rental' check, resolvePrimarySibling('dropLocation')),
// so the same guard reasoning applies to the graph engine, not just the old one.
const TRAVEL_CATEGORIES_WITH_RESERVED_FIELDS = ['cab', 'travels'];
const RESERVED_TRAVEL_FIELD_KEYS = ['tripType', 'pickupLocation', 'dropLocation', 'travelDate', 'pickupTime'];

/**
 * Loads the business's real graph, applies a hypothetical edit via
 * transformFn ({nodes, edges} -> {nodes, edges}), and checks the result is
 * still safe to commit. Never writes to Supabase itself — every mutating
 * handler below calls this BEFORE its own write and discards the
 * hypothetical result either way.
 *
 * Cycle check is ABSOLUTE (zero cycles required after the edit) — a
 * legitimately-built graph never has a pre-existing cycle (only an edge
 * write can create one; node creation can't), so there's nothing to be
 * relative to.
 *
 * Reachability check is DIFFERENTIAL, not absolute — this matters. A
 * business can legitimately have pre-existing unreachable nodes at any
 * moment: createQuestionNode deliberately does not validate reachability
 * on creation (nodes are meant to be created isolated, then wired in via
 * an edge afterward). An absolute "zero unreachable nodes after this edit"
 * check would reject every future edge write anywhere in the graph, even
 * ones completely unrelated to the orphan, for as long as that one
 * not-yet-wired-in node exists — found the hard way while testing this
 * step against a throwaway isolated node. Only reject when THIS edit newly
 * strands a node that was reachable before it ran.
 */
const assertGraphStillValid = async (businessId, transformFn) => {
  const { nodes, edges } = await bookingGraphService.loadGraph(businessId);
  const hypothetical = transformFn({ nodes, edges });

  const cyclicNodeIds = findCycles(hypothetical.nodes, hypothetical.edges);
  if (cyclicNodeIds.length > 0) {
    return `This change would create a cycle in the booking flow involving ${cyclicNodeIds.length} node(s) — a customer could get stuck answering the same questions forever.`;
  }

  const beforeEntryNodeIds = resolveBookingTriggerEntryNodeIds(nodes, edges);
  const beforeUnreachable = new Set(findUnreachableNodes(nodes, edges, beforeEntryNodeIds));

  const afterEntryNodeIds = resolveBookingTriggerEntryNodeIds(hypothetical.nodes, hypothetical.edges);
  const afterUnreachable = findUnreachableNodes(hypothetical.nodes, hypothetical.edges, afterEntryNodeIds);
  const newlyUnreachable = afterUnreachable.filter(id => !beforeUnreachable.has(id));

  if (newlyUnreachable.length > 0) {
    return `This change would make ${newlyUnreachable.length} previously-reachable booking question(s) unreachable — a customer could never reach them.`;
  }

  return null;
};

/**
 * Shape check for flow_edges.condition, mirroring the DB check constraint
 * (flow_edges_condition_shape) at the API layer so a malformed condition
 * gets a friendly 400 instead of a raw constraint-violation error.
 */
const validateConditionShape = (condition) => {
  if (condition === null || condition === undefined) return null;
  if (typeof condition !== 'object' || Array.isArray(condition) || !condition.field) {
    return 'condition must be an object with a "field" key.';
  }
  const hasEquals = condition.equals !== undefined;
  const hasIn = condition.in !== undefined;
  if (hasEquals === hasIn) {
    return 'condition must have exactly one of "equals" or "in" (not both, not neither).';
  }
  return null;
};

/**
 * Shape check for flow_edges.preset, mirroring the DB check constraint
 * (flow_edges_preset_shape) at the API layer. Unlike condition, preset.field
 * is deliberately NOT checked against this business's known question-node
 * field_keys anywhere — a preset is specifically for a field with NO
 * question node asking for it, so that check would reject every valid one.
 */
const validatePresetShape = (preset) => {
  if (preset === null || preset === undefined) return null;
  if (typeof preset !== 'object' || Array.isArray(preset)) {
    return 'preset must be an object with "field" and "value" keys.';
  }
  if (typeof preset.field !== 'string' || preset.field === '') {
    return 'preset.field must be a non-empty string.';
  }
  if (typeof preset.value !== 'string') {
    return 'preset.value must be a string.';
  }
  if (preset.summaryLabel !== undefined && typeof preset.summaryLabel !== 'string') {
    return 'preset.summaryLabel must be a string.';
  }
  return null;
};

/** field_key set among this business's question-subgraph nodes, for validateConditionField. */
const resolveKnownQuestionFieldKeys = async (businessId) => {
  const { data, error } = await supabase
    .from('flow_nodes').select('field_key').eq('business_id', businessId)
    .in('node_type', ['question', 'vehicle_carousel', 'rentalPackage']);
  if (error) throw error;
  return new Set((data || []).map(n => n.field_key).filter(Boolean));
};

/**
 * Ported verbatim from rule.controller.js's validateTranslationsMap (not
 * bookingFieldValidation.js's validateLabelTranslations — that one rejects
 * 'en' as a translation key, this one doesn't; the two existing validators
 * in this codebase already disagree on that point, pre-existing
 * inconsistency, not introduced here). Kept as its own local copy rather
 * than importing rule.controller.js's, matching this codebase's existing
 * pattern of each controller carrying its own copy rather than sharing one.
 */
const validateTranslationsMap = (translations, fieldLabel, maxLen) => {
  if (translations === null || translations === undefined) return null;
  if (typeof translations !== 'object' || Array.isArray(translations)) {
    return `${fieldLabel} must be an object.`;
  }
  for (const [code, value] of Object.entries(translations)) {
    if (!isValidLanguageCode(code)) {
      return `${fieldLabel} has an invalid language code "${code}".`;
    }
    if (typeof value !== 'string') {
      return `${fieldLabel} values must be strings.`;
    }
    if (maxLen !== undefined && value.length > maxLen) {
      return `${fieldLabel} for language "${code}" must be ${maxLen} characters or less.`;
    }
  }
  return null;
};

/**
 * GET /api/flow-graph/reply-nodes
 * List all reply-type flow_nodes for the business (paginated).
 */
const getReplyNodes = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, isActive } = req.query;
    const businessId = req.user.businessId;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    let query = supabase.from('flow_nodes').select('*', { count: 'exact' })
      .eq('business_id', businessId).eq('node_type', 'reply');
    if (isActive !== undefined) {
      query = query.eq('is_active', isActive === 'true');
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range((pageNum - 1) * limitNum, pageNum * limitNum - 1);
    if (error) throw error;

    const pagination = getPagination(count, pageNum, limitNum);

    return successResponse(res, 200, { replyNodes: (data || []).map(toCamelCase), pagination });
  } catch (error) {
    logger.error('Error in getReplyNodes:', error);
    next(error);
  }
};

/**
 * POST /api/flow-graph/reply-nodes
 * Create a reply node. Deliberately does NOT accept buttons/listOptions —
 * unlike the old rules table, a reply node's buttons/list rows are now
 * flow_edges rows with their own persistent id (the literal WhatsApp
 * interaction id a customer may already have in hand). Bundling edge
 * creation into this call the way createRule bundled buttons/listOptions
 * would make node edits and edge edits inseparable; add buttons/list rows
 * afterward via the edges endpoint instead. Body: { keyword, matchType,
 * replyKind, contentType, label, labelTranslations, imageUrl, hindiAliases }.
 */
const createReplyNode = async (req, res, next) => {
  try {
    const {
      keyword, matchType = 'contains', replyKind = 'text', contentType = 'text',
      imageUrl = null, hindiAliases = [], labelTranslations = null
    } = req.body;
    let { label } = req.body;
    const businessId = req.user.businessId;

    if (!keyword) {
      return errorResponse(res, 400, 'Keyword is required');
    }
    if (!VALID_MATCH_TYPES.includes(matchType)) {
      return errorResponse(res, 400, `matchType must be one of: ${VALID_MATCH_TYPES.join(', ')}`);
    }
    if (!VALID_CONTENT_TYPES.includes(contentType)) {
      return errorResponse(res, 400, `contentType must be one of: ${VALID_CONTENT_TYPES.join(', ')}`);
    }
    if (!VALID_REPLY_KINDS.includes(replyKind)) {
      return errorResponse(res, 400, `replyKind must be one of: ${VALID_REPLY_KINDS.join(', ')}`);
    }
    if (hindiAliases !== undefined && !Array.isArray(hindiAliases)) {
      return errorResponse(res, 400, 'hindiAliases must be an array of strings.');
    }
    const labelTranslationsError = validateTranslationsMap(labelTranslations, 'labelTranslations');
    if (labelTranslationsError) {
      return errorResponse(res, 400, labelTranslationsError);
    }

    // No buttons/listOptions in this call (see doc comment above), so the
    // old "reply optional if buttons/image present" carve-out is narrowed
    // to just image — flagged as a deliberate simplification from the old
    // updateRule/createRule validation, not a 1:1 port.
    if (replyKind === 'payment_trigger' && !label) {
      label = 'Please complete your payment.';
    }
    if (replyKind === 'booking_trigger' && !label) {
      label = 'Great! Let me collect your details.';
    }
    if (!label && !imageUrl && contentType !== 'location') {
      return errorResponse(res, 400, 'label is required (unless imageUrl is provided, or contentType is "location")');
    }
    if (!label) label = '';

    const normalizedKeyword = keyword.toLowerCase().trim();

    const { data: existingNode, error: existingErr } = await supabase
      .from('flow_nodes').select('id').eq('business_id', businessId).eq('node_type', 'reply')
      .eq('keyword', normalizedKeyword).maybeSingle();
    if (existingErr) throw existingErr;
    if (existingNode) {
      return errorResponse(res, 409, 'A reply node with this keyword already exists.');
    }

    const { data: node, error } = await supabase.from('flow_nodes').insert({
      business_id: businessId,
      node_type: 'reply',
      keyword: normalizedKeyword,
      match_type: matchType,
      hindi_aliases: (hindiAliases || []).map(a => a.trim()).filter(Boolean),
      reply_kind: replyKind,
      content_type: contentType,
      label,
      label_translations: labelTranslations || null,
      image_url: imageUrl || null,
      is_active: true,
      trigger_count: 0
    }).select().single();
    if (error) throw error;

    await invalidateRulesCache(businessId);

    return successResponse(res, 201, toCamelCase(node));
  } catch (error) {
    logger.error('Error in createReplyNode:', error);
    next(error);
  }
};

/**
 * PUT /api/flow-graph/reply-nodes/:id
 * Update a reply node's own fields. Buttons/list rows are edited via the
 * edges endpoint, not here (see createReplyNode's doc comment).
 */
const updateReplyNode = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { keyword, matchType, replyKind, contentType, isActive, imageUrl, hindiAliases, label, labelTranslations } = req.body;
    const businessId = req.user.businessId;

    const { data: node, error: findErr } = await supabase
      .from('flow_nodes').select('*').eq('id', id).eq('business_id', businessId).eq('node_type', 'reply').maybeSingle();
    if (findErr) throw findErr;
    if (!node) {
      return errorResponse(res, 404, 'Reply node not found');
    }

    if (matchType !== undefined && !VALID_MATCH_TYPES.includes(matchType)) {
      return errorResponse(res, 400, `matchType must be one of: ${VALID_MATCH_TYPES.join(', ')}`);
    }
    if (replyKind !== undefined && !VALID_REPLY_KINDS.includes(replyKind)) {
      return errorResponse(res, 400, `replyKind must be one of: ${VALID_REPLY_KINDS.join(', ')}`);
    }
    if (contentType !== undefined && !VALID_CONTENT_TYPES.includes(contentType)) {
      return errorResponse(res, 400, `contentType must be one of: ${VALID_CONTENT_TYPES.join(', ')}`);
    }
    if (hindiAliases !== undefined && !Array.isArray(hindiAliases)) {
      return errorResponse(res, 400, 'hindiAliases must be an array of strings.');
    }
    const labelTranslationsError = validateTranslationsMap(labelTranslations, 'labelTranslations');
    if (labelTranslationsError) {
      return errorResponse(res, 400, labelTranslationsError);
    }

    // Switching a node's contentType away from buttons/list to text would
    // leave its existing outgoing edges inert (chatbot.service.js's
    // findMatchingRule skips the edges query entirely for content_type
    // 'text' — see the `matchedNode.contentType === 'text' ? [] : ...`
    // branch), not cascade-deleted, silently orphaning working WhatsApp
    // button ids a customer could still be holding. Refuse until those
    // edges are removed/retargeted explicitly via the edges endpoint.
    if (contentType === 'text' && node.content_type !== 'text') {
      const { count: outgoingEdgeCount, error: edgeCountErr } = await supabase
        .from('flow_edges').select('*', { count: 'exact', head: true }).eq('from_node_id', id);
      if (edgeCountErr) throw edgeCountErr;
      if (outgoingEdgeCount > 0) {
        return errorResponse(res, 400,
          `Cannot switch this node's contentType to "text" while it still has ${outgoingEdgeCount} outgoing edge(s) — ` +
          'those buttons/list rows would silently stop being sent. Remove or retarget them first.'
        );
      }
    }

    // Reachability re-validation: closes the TODO from step 3 — changing
    // replyKind AWAY from 'booking_trigger' is the only reply-node field
    // edit that can remove a question-subgraph entry point (this node's own
    // unconditional edge into the first question node stops counting as an
    // entry point the moment replyKind no longer marks it as one, even
    // though the edge row itself is untouched).
    if (replyKind !== undefined && replyKind !== node.reply_kind && node.reply_kind === 'booking_trigger') {
      const validationError = await assertGraphStillValid(businessId, ({ nodes, edges }) => ({
        nodes: nodes.map(n => n.id === id ? { ...n, replyKind } : n),
        edges
      }));
      if (validationError) {
        return errorResponse(res, 400, validationError);
      }
    }

    const updateData = {};

    if (keyword) {
      const normalizedKeyword = keyword.toLowerCase().trim();
      const { data: existingNode, error: existingErr } = await supabase
        .from('flow_nodes').select('id').eq('business_id', businessId).eq('node_type', 'reply')
        .eq('keyword', normalizedKeyword).neq('id', id).maybeSingle();
      if (existingErr) throw existingErr;
      if (existingNode) {
        return errorResponse(res, 409, 'A reply node with this keyword already exists.');
      }
      updateData.keyword = normalizedKeyword;
    }

    if (matchType) updateData.match_type = matchType;
    if (replyKind !== undefined) updateData.reply_kind = replyKind;
    if (contentType !== undefined) updateData.content_type = contentType;
    if (isActive !== undefined) updateData.is_active = isActive;
    if (imageUrl !== undefined) updateData.image_url = imageUrl || null;
    if (labelTranslations !== undefined) updateData.label_translations = labelTranslations || null;
    if (label !== undefined) updateData.label = label;
    if (hindiAliases !== undefined) {
      updateData.hindi_aliases = hindiAliases.map(a => a.trim()).filter(Boolean);
    }

    const { data: updatedNode, error } = await supabase
      .from('flow_nodes').update(updateData).eq('id', id).select().single();
    if (error) throw error;

    await invalidateRulesCache(businessId);

    return successResponse(res, 200, toCamelCase(updatedNode));
  } catch (error) {
    logger.error('Error in updateReplyNode:', error);
    next(error);
  }
};

/**
 * DELETE /api/flow-graph/reply-nodes/:id
 * flow_edges.to_node_id/from_node_id both cascade-delete on their
 * referenced node — deleting this node would silently also delete any
 * OTHER node's edge that targets it (e.g. another reply node's "back to
 * FAQ" button), orphaning that node's rendered choice with no warning.
 * Block and name the referencing node(s) instead of allowing the cascade
 * to run unannounced.
 */
const deleteReplyNode = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: node, error: findErr } = await supabase
      .from('flow_nodes').select('id').eq('id', id).eq('business_id', businessId).eq('node_type', 'reply').maybeSingle();
    if (findErr) throw findErr;
    if (!node) {
      return errorResponse(res, 404, 'Reply node not found');
    }

    const { data: incomingEdges, error: incomingErr } = await supabase
      .from('flow_edges').select('id, from_node_id').eq('to_node_id', id);
    if (incomingErr) throw incomingErr;

    if ((incomingEdges || []).length > 0) {
      const fromNodeIds = [...new Set(incomingEdges.map(e => e.from_node_id))];
      const { data: fromNodes, error: fromNodesErr } = await supabase
        .from('flow_nodes').select('id, keyword, label').in('id', fromNodeIds);
      if (fromNodesErr) throw fromNodesErr;
      const names = (fromNodes || []).map(n => n.keyword || n.label || n.id).join(', ');
      return errorResponse(res, 400,
        `Cannot delete: ${incomingEdges.length} edge(s) from other node(s) (${names}) target this node. ` +
        'Deleting it would silently delete those edges too. Remove or retarget them first.'
      );
    }

    // Reachability re-validation: closes the TODO from step 3. Deleting a
    // booking_trigger reply node cascade-deletes its own outgoing entry
    // edge into the question subgraph — if this was the only such reply
    // node, everything downstream of that edge silently strands. Runs for
    // every reply-node delete (not just booking_trigger ones) for one
    // consistent code path rather than special-casing by replyKind; it's a
    // cheap dashboard-frequency check either way.
    const validationError = await assertGraphStillValid(businessId, ({ nodes, edges }) => ({
      nodes: nodes.filter(n => n.id !== id),
      edges: edges.filter(e => e.fromNodeId !== id && e.toNodeId !== id)
    }));
    if (validationError) {
      return errorResponse(res, 400, validationError);
    }

    const { error } = await supabase.from('flow_nodes').delete().eq('id', id);
    if (error) throw error;

    await invalidateRulesCache(businessId);

    return successResponse(res, 200, null, 'Reply node deleted successfully');
  } catch (error) {
    logger.error('Error in deleteReplyNode:', error);
    next(error);
  }
};

/**
 * PUT /api/flow-graph/reply-nodes/:id/toggle
 * Toggle isActive. Unlike question nodes (see bookingGraph.service.js's
 * isNodeEffectivelyActive), a reply node's is_active IS consulted at read
 * time (chatbot.service.js#getRulesFromCache filters .eq('is_active', true)).
 */
const toggleReplyNode = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: node, error: findErr } = await supabase
      .from('flow_nodes').select('is_active').eq('id', id).eq('business_id', businessId).eq('node_type', 'reply').maybeSingle();
    if (findErr) throw findErr;
    if (!node) {
      return errorResponse(res, 404, 'Reply node not found');
    }

    const { data: updatedNode, error } = await supabase
      .from('flow_nodes').update({ is_active: !node.is_active }).eq('id', id).select().single();
    if (error) throw error;

    await invalidateRulesCache(businessId);

    return successResponse(res, 200, toCamelCase(updatedNode));
  } catch (error) {
    logger.error('Error in toggleReplyNode:', error);
    next(error);
  }
};

/**
 * GET /api/flow-graph/question-nodes
 * List question/vehicle_carousel/rentalPackage flow_nodes for the business
 * (paginated). Computed nodes are included for visibility (the dashboard
 * needs to show them exist) but PUT/DELETE below refuse to touch them.
 */
const getQuestionNodes = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, isActive } = req.query;
    const businessId = req.user.businessId;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    let query = supabase.from('flow_nodes').select('*', { count: 'exact' })
      .eq('business_id', businessId).in('node_type', ['question', 'vehicle_carousel', 'rentalPackage']);
    if (isActive !== undefined) {
      query = query.eq('is_active', isActive === 'true');
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range((pageNum - 1) * limitNum, pageNum * limitNum - 1);
    if (error) throw error;

    const pagination = getPagination(count, pageNum, limitNum);

    return successResponse(res, 200, { questionNodes: (data || []).map(toCamelCase), pagination });
  } catch (error) {
    logger.error('Error in getQuestionNodes:', error);
    next(error);
  }
};

/**
 * POST /api/flow-graph/question-nodes
 * Create an authored question node, OR (nodeType: 'vehicle_carousel') the
 * one computed node type this surface can create. is_computed is never
 * taken from the request body — it's derived from nodeType server-side.
 * 'rentalPackage' remains engine-internal/migration-only (no create path) —
 * see VALID_QUESTION_NODE_TYPES.
 *
 * For a vehicle_carousel node: contentType is ignored and forced to 'list'
 * (cosmetic only — bookingGraph.service.js's effectiveFieldType() already
 * overrides rendering to 'vehicle_carousel' whenever node_type is that
 * value, and the DB's content_type check constraint doesn't allow the
 * literal string 'vehicle_carousel' anyway), and options must be omitted or
 * empty — a non-empty options array is rejected rather than silently
 * dropped, since the whole point of is_computed is that choices come from a
 * live route_fares/vehicles query at runtime, never from this column.
 * required has no runtime effect for this node type either (bookingGraph
 * .service.js's isNodeEffectivelyActive treats every non-'question' node as
 * always active) but is left client-settable for dashboard-display
 * consistency with authored nodes.
 *
 * The node is created isolated (no edges) — wire it into the sequence via
 * the edges endpoint afterward. Per the "zero outgoing edges" rule for
 * vehicle_carousel (the post-selection flow is handled entirely in
 * bookingGraph.service.js's fare/booking-completion logic, not by an edge),
 * createEdge rejects any edge sourced FROM a vehicle_carousel node — so
 * only an INCOMING edge should ever be added here.
 *
 * fieldKey is deliberately NOT checked against the reserved-key list here:
 * multiple nodes sharing a fieldKey is legitimate by design (an authored
 * node plus its manual-fallback sibling, or — for vehicle_carousel
 * specifically — the static non-computed fallback bookingGraph.service.js's
 * fallbackToStaticSibling requires to exist for the same fieldKey), so
 * creating another node with a reserved fieldKey is fine — only RENAMING
 * AWAY from or DELETING a reserved key is guarded (see updateQuestionNode/
 * deleteQuestionNode, both of which remain scoped to node_type='question'
 * and so cannot touch a vehicle_carousel node once created — same
 * read-only-after-creation behavior migration-script-created computed nodes
 * already had).
 */
const createQuestionNode = async (req, res, next) => {
  try {
    const {
      fieldKey, nodeType = 'question', contentType = 'text', summaryLabel = null, required = false,
      order = null, options = [], labelTranslations = null, imageUrl = null, label
    } = req.body;
    const businessId = req.user.businessId;

    if (!fieldKey || typeof fieldKey !== 'string') {
      return errorResponse(res, 400, 'fieldKey is required');
    }
    if (!VALID_QUESTION_NODE_TYPES.includes(nodeType)) {
      return errorResponse(res, 400, `nodeType must be one of: ${VALID_QUESTION_NODE_TYPES.join(', ')}`);
    }
    const isComputed = nodeType === 'vehicle_carousel';

    if (isComputed) {
      if (Array.isArray(options) && options.length > 0) {
        return errorResponse(res, 400,
          'options must not be provided for a vehicle_carousel node — its choices are computed live from route_fares/vehicles at runtime, never stored on the node.'
        );
      }
    } else if (!VALID_CONTENT_TYPES.includes(contentType)) {
      return errorResponse(res, 400, `contentType must be one of: ${VALID_CONTENT_TYPES.join(', ')}`);
    }
    // Required at the API layer because flow_nodes.label is NOT NULL at the
    // DB level and (unlike reply nodes) question nodes have no image-only
    // carve-out precedent in the old bookingFields validation to port —
    // new validation this schema requires, not a 1:1 port.
    if (!label || typeof label !== 'string') {
      return errorResponse(res, 400, 'label is required');
    }
    if (typeof required !== 'boolean') {
      return errorResponse(res, 400, 'required must be a boolean');
    }
    if (order !== null && order !== undefined && typeof order !== 'number') {
      return errorResponse(res, 400, 'order must be a number or null');
    }

    const labelTranslationsError = validateLabelTranslations(labelTranslations, 'labelTranslations');
    if (labelTranslationsError) {
      return errorResponse(res, 400, labelTranslationsError);
    }

    if (!isComputed) {
      if ((contentType === 'buttons' || contentType === 'list') && (!Array.isArray(options) || options.length === 0)) {
        return errorResponse(res, 400, `options must have at least one entry for contentType "${contentType}"`);
      }
      for (const opt of options || []) {
        if (opt && typeof opt === 'object') {
          const optErr = validateLabelTranslations(opt.labelTranslations, `option "${opt.value}" labelTranslations`);
          if (optErr) return errorResponse(res, 400, optErr);
        }
      }
    }

    const { data: node, error } = await supabase.from('flow_nodes').insert({
      business_id: businessId,
      node_type: nodeType,
      field_key: fieldKey,
      content_type: isComputed ? 'list' : contentType,
      label,
      label_translations: labelTranslations || null,
      image_url: imageUrl || null,
      summary_label: summaryLabel,
      required,
      order,
      options: isComputed ? [] : (options || []),
      is_computed: isComputed,
      is_active: true
    }).select().single();
    if (error) throw error;

    return successResponse(res, 201, toCamelCase(node));
  } catch (error) {
    logger.error('Error in createQuestionNode:', error);
    next(error);
  }
};

/**
 * PUT /api/flow-graph/question-nodes/:id
 * Edit an authored question node's own fields. Scoped to node_type='question'
 * at the query level, which alone implements "computed nodes cannot be
 * edited through this endpoint" (a vehicle_carousel/rentalPackage row's id
 * simply won't be found). Deliberately does NOT accept isActive — see the
 * confirmed decision that "disable a question field" routes through
 * businesses.disabledBookingFields (PUT /api/business), not
 * flow_nodes.is_active, which pickNextNodeId never reads for question
 * nodes at all.
 */
const updateQuestionNode = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fieldKey, contentType, label, labelTranslations, summaryLabel, required, order, options, imageUrl } = req.body;
    const businessId = req.user.businessId;

    const { data: node, error: findErr } = await supabase
      .from('flow_nodes').select('*').eq('id', id).eq('business_id', businessId).eq('node_type', 'question').maybeSingle();
    if (findErr) throw findErr;
    if (!node) {
      return errorResponse(res, 404, 'Question node not found (vehicle_carousel/rentalPackage nodes cannot be edited through this endpoint)');
    }

    if (contentType !== undefined && !VALID_CONTENT_TYPES.includes(contentType)) {
      return errorResponse(res, 400, `contentType must be one of: ${VALID_CONTENT_TYPES.join(', ')}`);
    }
    if (required !== undefined && typeof required !== 'boolean') {
      return errorResponse(res, 400, 'required must be a boolean');
    }
    if (order !== undefined && order !== null && typeof order !== 'number') {
      return errorResponse(res, 400, 'order must be a number or null');
    }
    const labelTranslationsError = validateLabelTranslations(labelTranslations, 'labelTranslations');
    if (labelTranslationsError) {
      return errorResponse(res, 400, labelTranslationsError);
    }

    const effectiveContentType = contentType !== undefined ? contentType : node.content_type;
    const effectiveOptions = options !== undefined ? options : node.options;
    if ((effectiveContentType === 'buttons' || effectiveContentType === 'list') &&
        (!Array.isArray(effectiveOptions) || effectiveOptions.length === 0)) {
      return errorResponse(res, 400, `options must have at least one entry for contentType "${effectiveContentType}"`);
    }
    if (options !== undefined) {
      for (const opt of options) {
        if (opt && typeof opt === 'object') {
          const optErr = validateLabelTranslations(opt.labelTranslations, `option "${opt.value}" labelTranslations`);
          if (optErr) return errorResponse(res, 400, optErr);
        }
      }
    }

    // Decision 3 (reviewed and confirmed): reject outright, don't just warn.
    // resolveOptionsForNode overrides pickupLocation/dropLocation's options
    // with the live servedCities overlay whenever contentType is 'list' and
    // servedCities is non-empty — an edited options array would silently
    // never take effect.
    if (options !== undefined &&
        (node.field_key === 'pickupLocation' || node.field_key === 'dropLocation') &&
        effectiveContentType === 'list' &&
        req.graphBusiness.servedCities.length > 0) {
      return errorResponse(res, 400,
        `Cannot edit options on "${node.field_key}" while servedCities is configured for this business — ` +
        'the live servedCities list overrides authored options for this field at read time, so any edit here would silently have no effect. ' +
        'Clear servedCities first if you want to hand-author options for this field.'
      );
    }

    // Reserved-field-key guard (ported from business.controller.js's
    // updateBookingFields): conservative/unconditional — blocks renaming
    // AWAY from a reserved key even if another node still holds it, rather
    // than determining whether this is "the last" node with that key.
    if (fieldKey !== undefined && fieldKey !== node.field_key &&
        TRAVEL_CATEGORIES_WITH_RESERVED_FIELDS.includes(req.graphBusiness.businessCategory) &&
        RESERVED_TRAVEL_FIELD_KEYS.includes(node.field_key)) {
      return errorResponse(res, 400,
        `Cannot rename fieldKey away from "${node.field_key}" — special booking-flow behavior depends on this exact key. ` +
        'Label, options, order, required, and translations can still be changed freely.'
      );
    }

    // Reachability re-validation only matters when fieldKey changes — it's
    // the only edit here that affects findUnreachableNodes' sibling-
    // exemption pairing (see flowGraphValidation.js).
    if (fieldKey !== undefined && fieldKey !== node.field_key) {
      const validationError = await assertGraphStillValid(businessId, ({ nodes, edges }) => ({
        nodes: nodes.map(n => n.id === id ? { ...n, fieldKey } : n),
        edges
      }));
      if (validationError) {
        return errorResponse(res, 400, validationError);
      }
    }

    const updateData = {};
    if (fieldKey !== undefined) updateData.field_key = fieldKey;
    if (contentType !== undefined) updateData.content_type = contentType;
    if (label !== undefined) updateData.label = label;
    if (labelTranslations !== undefined) updateData.label_translations = labelTranslations || null;
    if (imageUrl !== undefined) updateData.image_url = imageUrl || null;
    if (summaryLabel !== undefined) updateData.summary_label = summaryLabel;
    if (required !== undefined) updateData.required = required;
    if (order !== undefined) updateData.order = order;
    if (options !== undefined) updateData.options = options;

    const { data: updatedNode, error } = await supabase
      .from('flow_nodes').update(updateData).eq('id', id).select().single();
    if (error) throw error;

    return successResponse(res, 200, toCamelCase(updatedNode));
  } catch (error) {
    logger.error('Error in updateQuestionNode:', error);
    next(error);
  }
};

/**
 * DELETE /api/flow-graph/question-nodes/:id
 * Scoped to node_type='question' — computed nodes can't be deleted through
 * this endpoint either. Three guards, in order: reserved-key, fallback-
 * sibling (a node with NO incoming edge can still be load-bearing — see
 * flowGraphValidation.js#findFallbackSiblingNodeIds), then full reachability
 * re-validation for everything else.
 *
 * Deliberately does NOT separately block "other node(s)' edges still target
 * this node, remove/retarget them first" the way deleteReplyNode does.
 * That used to be a fourth guard here too, and it deadlocked against
 * deleteEdge/updateEdge's own reachability check: retargeting/removing a
 * node's LAST incoming edge as a standalone edge operation is exactly what
 * that check blocks (the target node would go from reachable to
 * unreachable), whenever no fallback sibling exempts it — so a node with
 * exactly one incoming edge had no valid order of operations to delete it.
 * The reachability re-validation below is already correctly scoped for the
 * delete-node case (it excludes this node and its own edges from the
 * "before" graph, so it never requires the node BEING deleted to stay
 * reachable — only that deleting it doesn't strand some OTHER, still-
 * existing node), so the standalone block was redundant with it and just
 * happened to fire first. flow_edges rows referencing this node (incoming
 * AND outgoing) cascade-delete at the DB level the moment the flow_nodes
 * row itself is deleted below (from_node_id/to_node_id both `on delete
 * cascade`, see 20260829140000_flow_nodes_edges.sql), so no separate edge
 * cleanup is needed here either. (deleteReplyNode's own equivalent block is
 * NOT touched by this change — reply nodes aren't part of the question
 * subgraph findCycles/findUnreachableNodes walk at all, so retargeting an
 * edge into a reply node is never blocked on reachability grounds; that
 * guard is conservative but not a deadlock, a different situation.)
 */
const deleteQuestionNode = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: node, error: findErr } = await supabase
      .from('flow_nodes').select('*').eq('id', id).eq('business_id', businessId).eq('node_type', 'question').maybeSingle();
    if (findErr) throw findErr;
    if (!node) {
      return errorResponse(res, 404, 'Question node not found (vehicle_carousel/rentalPackage nodes cannot be deleted through this endpoint)');
    }

    if (TRAVEL_CATEGORIES_WITH_RESERVED_FIELDS.includes(req.graphBusiness.businessCategory) &&
        RESERVED_TRAVEL_FIELD_KEYS.includes(node.field_key)) {
      return errorResponse(res, 400,
        `Cannot delete: fieldKey "${node.field_key}" has special booking-flow behavior hardcoded in bookingGraph.service.js.`
      );
    }

    // A node with zero incoming edges is either the true graph entry
    // question, or a fallback sibling found by field_key lookup at runtime,
    // never by edge traversal — reachability re-validation below can't catch
    // removing one of those either (it's already unreachable by definition).
    // See findFallbackSiblingNodeIds's doc comment: this is a live,
    // crashable gap if left unguarded, not theoretical.
    const { nodes, edges } = await bookingGraphService.loadGraph(businessId);
    const entryNodeIds = resolveBookingTriggerEntryNodeIds(nodes, edges);
    const fallbackSiblingIds = findFallbackSiblingNodeIds(nodes, edges, entryNodeIds);
    if (fallbackSiblingIds.includes(id)) {
      return errorResponse(res, 400,
        `Cannot delete: this node has no incoming edge, but another node shares its fieldKey "${node.field_key}" and IS reachable. ` +
        "This check can't tell apart two different situations that look identical from here — figure out which one you're in before proceeding: " +
        "(1) this is a real fallback the engine finds at runtime by fieldKey, not by an edge (e.g. \"Other date\"/\"Other time\" manual alternatives, or vehicleType's static fallback when the live vehicle/rental-package query is empty) — deleting it removes that fallback path, which can crash a live booking the next time the primary option is unavailable; " +
        '(2) this node was just created and happens to reuse an existing fieldKey by coincidence, with no real fallback relationship intended — in that case this block is a false positive, safe to work around. ' +
        'Either way, the fix is the same: change this node\'s fieldKey to something else, then delete it.'
      );
    }

    const validationError = await assertGraphStillValid(businessId, ({ nodes: n, edges: e }) => ({
      nodes: n.filter(x => x.id !== id),
      edges: e.filter(x => x.fromNodeId !== id && x.toNodeId !== id)
    }));
    if (validationError) {
      return errorResponse(res, 400, validationError);
    }

    const { error } = await supabase.from('flow_nodes').delete().eq('id', id);
    if (error) throw error;

    return successResponse(res, 200, null, 'Question node deleted successfully');
  } catch (error) {
    logger.error('Error in deleteQuestionNode:', error);
    next(error);
  }
};

/**
 * GET /api/flow-graph/full
 * Returns the business's entire graph in one response — all reply nodes,
 * all question/vehicle_carousel/rentalPackage nodes, and all edges — for
 * the upcoming flow editor, which otherwise would N+1 (fetch nodes, then
 * fetch edges per node). Three queries total, run in parallel, each
 * filtered by business_id directly (edges are NOT looked up per
 * from_node_id in a loop). Same toCamelCase per-row shape as
 * getReplyNodes/getQuestionNodes/getEdges, unpaginated — the frontend
 * builds its own node->outgoing-edges map from the flat edges array, so
 * there's no separate parsing path to support here.
 */
const getFullGraph = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const [replyNodesRes, questionNodesRes, edgesRes] = await Promise.all([
      supabase.from('flow_nodes').select('*').eq('business_id', businessId).eq('node_type', 'reply'),
      supabase.from('flow_nodes').select('*').eq('business_id', businessId).in('node_type', ['question', 'vehicle_carousel', 'rentalPackage']),
      supabase.from('flow_edges').select('*').eq('business_id', businessId).order('display_order', { ascending: true })
    ]);
    if (replyNodesRes.error) throw replyNodesRes.error;
    if (questionNodesRes.error) throw questionNodesRes.error;
    if (edgesRes.error) throw edgesRes.error;

    return successResponse(res, 200, {
      replyNodes: (replyNodesRes.data || []).map(toCamelCase),
      questionNodes: (questionNodesRes.data || []).map(toCamelCase),
      edges: (edgesRes.data || []).map(toCamelCase)
    });
  } catch (error) {
    logger.error('Error in getFullGraph:', error);
    next(error);
  }
};

/**
 * PUT /api/flow-graph/full
 * Batch-save the entire desired end state for this business's graph in one
 * round trip (the canvas editor's save button) — { replyNodes, questionNodes,
 * edges }, same node/edge shape as GET /full's response, each node also
 * optionally carrying positionX/positionY. Every node/edge either names a
 * real existing id (an edit) or omits its id / uses a client-generated temp
 * id never yet saved (a brand-new row, minted a real id here). Every current
 * DB row NOT named anywhere in the payload is deleted.
 *
 * This is a DIFF against current state, not a blind replace — see the
 * per-array loops below. The proposed end state is validated as a whole
 * (findCycles/findUnreachableNodes via assertGraphStillValid, exactly as if
 * it were the new live graph) BEFORE anything is written; on any validation
 * failure this writes nothing and returns 400. The actual write is one call
 * to save_flow_graph_full (see its migration's doc comment for why this
 * needs to be a single RPC rather than a sequence of supabase-js calls:
 * PostgREST has no cross-call transaction boundary, so a partial failure
 * here would otherwise leave flow_nodes/flow_edges — read by the live
 * booking engine mid-session — in a half-applied state).
 *
 * Deliberate deviations from a literal per-instruction port, flagged rather
 * than silently decided:
 *   - Computed nodes (is_computed=true: vehicle_carousel/rentalPackage) have
 *     no delete path ANYWHERE in this API today (createQuestionNode can
 *     create one, updateQuestionNode/deleteQuestionNode are both scoped to
 *     node_type='question' and simply 404 for one). Letting "omitted from
 *     the payload" silently delete one here would be a first-ever, unguarded
 *     way to remove a node bookingGraph.service.js's fallbackToStaticSibling
 *     can throw on mid-booking if it goes missing. Blocked outright instead
 *     (see the nodeDeletes check below) — the only edit batch save accepts
 *     for one of these is position.
 *   - findFallbackSiblingNodeIds is run against the CURRENT graph (pre-edit),
 *     not the proposed end state, then cross-referenced against this diff's
 *     node deletes — running it against the proposed state the way
 *     findCycles/findUnreachableNodes are run would never flag anything,
 *     because a node being deleted is by definition absent from the proposed
 *     state and so can never appear in a fallback-sibling id list computed
 *     from it. This mirrors exactly what deleteQuestionNode already does
 *     (compute fallback-sibling status from the graph as it stands right
 *     before the delete).
 *   - The reserved-field-key guard is re-checked for deletes only, per spec.
 *     updateQuestionNode's rename-away-from-reserved-key guard is NOT ported
 *     to batch save — a batch save could still rename tripType/pickupLocation
 *     /etc. away from their reserved key without being blocked here. Flagging
 *     this as a known gap, not fixing it silently.
 *   - The servedCities/pickupLocation-dropLocation options-override conflict
 *     guard and the "switching a reply node's contentType to text while it
 *     still has outgoing edges" guard (both in the single-node PUT handlers)
 *     are also NOT ported — neither is a data-corruption/live-crash risk the
 *     way the two guards above are, and porting them means re-deriving
 *     "what specifically changed" per node against its old row, which this
 *     diff doesn't otherwise need. Left as a follow-up candidate.
 */
const saveFullGraph = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { replyNodes = [], questionNodes = [], edges = [] } = req.body;

    if (!Array.isArray(replyNodes) || !Array.isArray(questionNodes) || !Array.isArray(edges)) {
      return errorResponse(res, 400, 'replyNodes, questionNodes, and edges must all be arrays.');
    }

    const [currentNodesRes, currentEdgesRes] = await Promise.all([
      supabase.from('flow_nodes').select('*').eq('business_id', businessId),
      supabase.from('flow_edges').select('*').eq('business_id', businessId)
    ]);
    if (currentNodesRes.error) throw currentNodesRes.error;
    if (currentEdgesRes.error) throw currentEdgesRes.error;
    const currentNodeById = new Map((currentNodesRes.data || []).map(n => [n.id, n]));
    const currentEdgeById = new Map((currentEdgesRes.data || []).map(e => [e.id, e]));

    const idMap = new Map();        // client-supplied temp id -> minted real id (new nodes only)
    const keepNodeIds = new Set();  // final surviving node ids (matched-existing or newly minted)
    const nodeUpserts = [];         // snake_case rows for the RPC
    const proposedNodes = [];       // camelCase {id, nodeType, fieldKey, replyKind} for validation

    const seenKeywords = new Set();
    for (let i = 0; i < replyNodes.length; i++) {
      const item = replyNodes[i] || {};
      const providedId = item.id;
      const existing = providedId ? currentNodeById.get(providedId) : undefined;
      if (existing && existing.node_type !== 'reply') {
        return errorResponse(res, 400, `replyNodes[${i}]: id "${providedId}" belongs to a non-reply node.`);
      }

      const {
        keyword, matchType = 'contains', replyKind = 'text', contentType = 'text',
        imageUrl = null, hindiAliases = [], labelTranslations = null, isActive = true,
        positionX = null, positionY = null
      } = item;
      let { label } = item;

      if (!keyword || typeof keyword !== 'string') {
        return errorResponse(res, 400, `replyNodes[${i}]: keyword is required`);
      }
      if (!VALID_MATCH_TYPES.includes(matchType)) {
        return errorResponse(res, 400, `replyNodes[${i}]: matchType must be one of: ${VALID_MATCH_TYPES.join(', ')}`);
      }
      if (!VALID_CONTENT_TYPES.includes(contentType)) {
        return errorResponse(res, 400, `replyNodes[${i}]: contentType must be one of: ${VALID_CONTENT_TYPES.join(', ')}`);
      }
      if (!VALID_REPLY_KINDS.includes(replyKind)) {
        return errorResponse(res, 400, `replyNodes[${i}]: replyKind must be one of: ${VALID_REPLY_KINDS.join(', ')}`);
      }
      if (hindiAliases !== undefined && !Array.isArray(hindiAliases)) {
        return errorResponse(res, 400, `replyNodes[${i}]: hindiAliases must be an array of strings.`);
      }
      const replyLabelTranslationsError = validateTranslationsMap(labelTranslations, `replyNodes[${i}].labelTranslations`);
      if (replyLabelTranslationsError) return errorResponse(res, 400, replyLabelTranslationsError);

      if (replyKind === 'payment_trigger' && !label) label = 'Please complete your payment.';
      if (replyKind === 'booking_trigger' && !label) label = 'Great! Let me collect your details.';
      if (!label && !imageUrl && contentType !== 'location') {
        return errorResponse(res, 400, `replyNodes[${i}]: label is required (unless imageUrl is provided, or contentType is "location")`);
      }
      if (!label) label = '';

      const normalizedKeyword = keyword.toLowerCase().trim();
      if (seenKeywords.has(normalizedKeyword)) {
        return errorResponse(res, 400, `replyNodes[${i}]: duplicate keyword "${normalizedKeyword}" among replyNodes in this save.`);
      }
      seenKeywords.add(normalizedKeyword);

      const id = existing ? existing.id : crypto.randomUUID();
      if (providedId && providedId !== id) idMap.set(providedId, id);
      keepNodeIds.add(id);

      nodeUpserts.push({
        id, node_type: 'reply', keyword: normalizedKeyword, match_type: matchType,
        hindi_aliases: (hindiAliases || []).map(a => a.trim()).filter(Boolean),
        reply_kind: replyKind, trigger_count: existing ? existing.trigger_count : 0,
        content_type: contentType, label, label_translations: labelTranslations || null,
        image_url: imageUrl || null, field_key: null, summary_label: null, required: false,
        order: null, options: [], is_computed: false, is_active: isActive,
        position_x: positionX, position_y: positionY
      });
      proposedNodes.push({ id, nodeType: 'reply', replyKind, fieldKey: null });
    }

    for (let i = 0; i < questionNodes.length; i++) {
      const item = questionNodes[i] || {};
      const providedId = item.id;
      const existing = providedId ? currentNodeById.get(providedId) : undefined;
      if (existing && existing.node_type === 'reply') {
        return errorResponse(res, 400, `questionNodes[${i}]: id "${providedId}" belongs to a reply node.`);
      }

      const nodeType = item.nodeType !== undefined ? item.nodeType : (existing ? existing.node_type : 'question');
      if (existing && existing.node_type !== nodeType) {
        return errorResponse(res, 400,
          `questionNodes[${i}]: nodeType cannot change for an existing node (was "${existing.node_type}").`);
      }

      // Computed nodes are read-only everywhere else in this API (see doc
      // comment above) — batch save only ever lets position change for one.
      if (existing && existing.is_computed) {
        const { positionX = existing.position_x ?? null, positionY = existing.position_y ?? null } = item;
        keepNodeIds.add(existing.id);
        nodeUpserts.push({ ...existing, position_x: positionX, position_y: positionY });
        proposedNodes.push({ id: existing.id, nodeType: existing.node_type, replyKind: null, fieldKey: existing.field_key });
        continue;
      }

      if (!VALID_QUESTION_NODE_TYPES.includes(nodeType)) {
        return errorResponse(res, 400, `questionNodes[${i}]: nodeType must be one of: ${VALID_QUESTION_NODE_TYPES.join(', ')}`);
      }
      const isComputed = nodeType === 'vehicle_carousel';

      const {
        fieldKey, contentType = 'text', summaryLabel = null, required = false, order = null,
        options = [], labelTranslations = null, imageUrl = null, label,
        positionX = null, positionY = null
      } = item;

      if (!fieldKey || typeof fieldKey !== 'string') {
        return errorResponse(res, 400, `questionNodes[${i}]: fieldKey is required`);
      }
      if (!label || typeof label !== 'string') {
        return errorResponse(res, 400, `questionNodes[${i}]: label is required`);
      }
      if (typeof required !== 'boolean') {
        return errorResponse(res, 400, `questionNodes[${i}]: required must be a boolean`);
      }
      if (order !== null && order !== undefined && typeof order !== 'number') {
        return errorResponse(res, 400, `questionNodes[${i}]: order must be a number or null`);
      }
      const questionLabelTranslationsError = validateLabelTranslations(labelTranslations, `questionNodes[${i}].labelTranslations`);
      if (questionLabelTranslationsError) return errorResponse(res, 400, questionLabelTranslationsError);

      if (isComputed) {
        if (Array.isArray(options) && options.length > 0) {
          return errorResponse(res, 400,
            `questionNodes[${i}]: options must not be provided for a vehicle_carousel node.`);
        }
      } else {
        if (!VALID_CONTENT_TYPES.includes(contentType)) {
          return errorResponse(res, 400, `questionNodes[${i}]: contentType must be one of: ${VALID_CONTENT_TYPES.join(', ')}`);
        }
        if ((contentType === 'buttons' || contentType === 'list') && (!Array.isArray(options) || options.length === 0)) {
          return errorResponse(res, 400, `questionNodes[${i}]: options must have at least one entry for contentType "${contentType}"`);
        }
        for (const opt of options || []) {
          if (opt && typeof opt === 'object') {
            const optErr = validateLabelTranslations(opt.labelTranslations, `questionNodes[${i}] option "${opt.value}" labelTranslations`);
            if (optErr) return errorResponse(res, 400, optErr);
          }
        }
      }

      const id = existing ? existing.id : crypto.randomUUID();
      if (providedId && providedId !== id) idMap.set(providedId, id);
      keepNodeIds.add(id);

      nodeUpserts.push({
        id, node_type: nodeType, keyword: null, match_type: null, hindi_aliases: [],
        reply_kind: null, trigger_count: existing ? existing.trigger_count : 0,
        content_type: isComputed ? 'list' : contentType,
        label, label_translations: labelTranslations || null, image_url: imageUrl || null,
        field_key: fieldKey, summary_label: summaryLabel, required, order,
        options: isComputed ? [] : (options || []), is_computed: isComputed,
        is_active: existing ? existing.is_active : true,
        position_x: positionX, position_y: positionY
      });
      proposedNodes.push({ id, nodeType, replyKind: null, fieldKey });
    }

    const proposedNodeById = new Map(proposedNodes.map(n => [n.id, n]));
    const knownFieldKeys = new Set(
      proposedNodes
        .filter(n => ['question', 'vehicle_carousel', 'rentalPackage'].includes(n.nodeType) && n.fieldKey)
        .map(n => n.fieldKey)
    );

    const edgeUpserts = [];
    const proposedEdges = [];
    const resolveNodeRef = (rawId) => {
      if (idMap.has(rawId)) return idMap.get(rawId);
      if (keepNodeIds.has(rawId)) return rawId;
      return null;
    };

    for (let i = 0; i < edges.length; i++) {
      const item = edges[i] || {};
      const providedId = item.id;
      const existingEdge = providedId ? currentEdgeById.get(providedId) : undefined;

      const {
        fromNodeId: rawFrom, toNodeId: rawTo, label = null, labelTranslations = null,
        description = null, descriptionTranslations = null, condition = null, preset = null, displayOrder
      } = item;

      if (!rawFrom || !rawTo) {
        return errorResponse(res, 400, `edges[${i}]: fromNodeId and toNodeId are required`);
      }
      const fromNodeId = resolveNodeRef(rawFrom);
      const toNodeId = resolveNodeRef(rawTo);
      if (!fromNodeId) return errorResponse(res, 400, `edges[${i}]: fromNodeId "${rawFrom}" does not resolve to any node in this save`);
      if (!toNodeId) return errorResponse(res, 400, `edges[${i}]: toNodeId "${rawTo}" does not resolve to any node in this save`);

      const fromNode = proposedNodeById.get(fromNodeId);
      if (fromNode && fromNode.nodeType === 'vehicle_carousel') {
        return errorResponse(res, 400,
          `edges[${i}]: vehicle_carousel nodes cannot have outgoing edges — the post-selection flow is handled entirely in bookingGraph.service.js, not by edges.`);
      }

      const edgeLabelTranslationsError = validateTranslationsMap(labelTranslations, `edges[${i}].labelTranslations`);
      if (edgeLabelTranslationsError) return errorResponse(res, 400, edgeLabelTranslationsError);
      const edgeDescriptionTranslationsError = validateTranslationsMap(descriptionTranslations, `edges[${i}].descriptionTranslations`);
      if (edgeDescriptionTranslationsError) return errorResponse(res, 400, edgeDescriptionTranslationsError);

      const conditionShapeError = validateConditionShape(condition);
      if (conditionShapeError) return errorResponse(res, 400, `edges[${i}]: ${conditionShapeError}`);
      if (condition) {
        const conditionFieldError = validateConditionField(condition, knownFieldKeys);
        if (conditionFieldError) return errorResponse(res, 400, `edges[${i}]: ${conditionFieldError}`);
      }

      const presetShapeError = validatePresetShape(preset);
      if (presetShapeError) return errorResponse(res, 400, `edges[${i}]: ${presetShapeError}`);

      if (displayOrder !== undefined && typeof displayOrder !== 'number') {
        return errorResponse(res, 400, `edges[${i}]: displayOrder must be a number`);
      }

      const id = existingEdge ? existingEdge.id : crypto.randomUUID();

      edgeUpserts.push({
        id, from_node_id: fromNodeId, to_node_id: toNodeId, label,
        label_translations: labelTranslations || null, description,
        description_translations: descriptionTranslations || null,
        condition: condition || null, preset: preset || null,
        display_order: displayOrder !== undefined ? displayOrder : 0
      });
      proposedEdges.push({ id, fromNodeId, toNodeId, condition: condition || null });
    }

    // ---- deletes: every current row not named anywhere in the payload ----
    const nodeDeletes = [];
    for (const row of currentNodeById.values()) {
      if (!keepNodeIds.has(row.id)) nodeDeletes.push(row);
    }
    const keepEdgeIds = new Set(proposedEdges.map(e => e.id));
    const edgeDeleteIds = [];
    for (const row of currentEdgeById.values()) {
      if (!keepEdgeIds.has(row.id)) edgeDeleteIds.push(row.id);
    }

    // Computed nodes have no delete path anywhere in this API (see doc
    // comment above) — reject outright rather than silently deleting one
    // because the payload omitted it.
    const computedDelete = nodeDeletes.find(n => n.is_computed);
    if (computedDelete) {
      return errorResponse(res, 400,
        `Cannot delete computed node (fieldKey "${computedDelete.field_key}", id ${computedDelete.id}) via batch save — ` +
        'vehicle_carousel/rentalPackage nodes have no delete path anywhere in this API. Include it in questionNodes (position-only edits are fine) rather than omitting it.'
      );
    }

    // Reserved-field-key guard, deletes only (see doc comment above).
    if (TRAVEL_CATEGORIES_WITH_RESERVED_FIELDS.includes(req.graphBusiness.businessCategory)) {
      const reservedDelete = nodeDeletes.find(n => n.field_key && RESERVED_TRAVEL_FIELD_KEYS.includes(n.field_key));
      if (reservedDelete) {
        return errorResponse(res, 400,
          `Cannot delete: fieldKey "${reservedDelete.field_key}" has special booking-flow behavior hardcoded in bookingGraph.service.js.`
        );
      }
    }

    // Fallback-sibling guard, computed against the CURRENT graph (see doc
    // comment above for why proposed-state is the wrong graph to check this
    // against), cross-referenced against this diff's node deletes.
    const currentNodesCamel = (currentNodesRes.data || []).map(toCamelCase);
    const currentEdgesCamel = (currentEdgesRes.data || []).map(toCamelCase);
    const currentEntryNodeIds = resolveBookingTriggerEntryNodeIds(currentNodesCamel, currentEdgesCamel);
    const fallbackSiblingIds = new Set(findFallbackSiblingNodeIds(currentNodesCamel, currentEdgesCamel, currentEntryNodeIds));
    const fallbackSiblingDelete = nodeDeletes.find(n => fallbackSiblingIds.has(n.id));
    if (fallbackSiblingDelete) {
      return errorResponse(res, 400,
        `Cannot delete node (fieldKey "${fallbackSiblingDelete.field_key}", id ${fallbackSiblingDelete.id}) — ` +
        'it has no incoming edge, but another node shares its fieldKey and IS reachable, meaning it may be a live runtime fallback path. ' +
        'Use the single-node delete endpoint instead, where this same check applies with a fuller explanation of the two possible situations.'
      );
    }

    // Whole-proposed-state validation — cycles (absolute) and reachability
    // (differential against the current graph), same logic every surgical
    // node/edge write already goes through. transformFn ignores the graph
    // assertGraphStillValid loads for its own "before" baseline and returns
    // this diff's already-computed proposed state instead.
    const validationError = await assertGraphStillValid(businessId, () => ({
      nodes: proposedNodes,
      edges: proposedEdges
    }));
    if (validationError) {
      return errorResponse(res, 400, validationError);
    }

    const { error: rpcError } = await supabase.rpc('save_flow_graph_full', {
      p_business_id: businessId,
      p_node_upserts: nodeUpserts,
      p_node_deletes: nodeDeletes.map(n => n.id),
      p_edge_upserts: edgeUpserts,
      p_edge_deletes: edgeDeleteIds
    });
    if (rpcError) throw rpcError;

    await invalidateRulesCache(businessId);

    // Re-fetch rather than reconstruct client-side, so the response carries
    // authoritative saved values (real ids for anything newly inserted,
    // trigger_count, timestamps) in the same shape GET /full already returns.
    return getFullGraph(req, res, next);
  } catch (error) {
    logger.error('Error in saveFullGraph:', error);
    next(error);
  }
};

/**
 * GET /api/flow-graph/edges?fromNodeId=
 * Outgoing edges for one node, ordered by displayOrder.
 */
const getEdges = async (req, res, next) => {
  try {
    const { fromNodeId } = req.query;
    const businessId = req.user.businessId;
    if (!fromNodeId) {
      return errorResponse(res, 400, 'fromNodeId query param is required');
    }

    const { data: fromNode, error: nodeErr } = await supabase
      .from('flow_nodes').select('id').eq('id', fromNodeId).eq('business_id', businessId).maybeSingle();
    if (nodeErr) throw nodeErr;
    if (!fromNode) {
      return errorResponse(res, 404, 'fromNodeId not found for this business');
    }

    const { data, error } = await supabase
      .from('flow_edges').select('*').eq('from_node_id', fromNodeId).order('display_order', { ascending: true });
    if (error) throw error;

    return successResponse(res, 200, { edges: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getEdges:', error);
    next(error);
  }
};

/**
 * POST /api/flow-graph/edges
 * Create one edge. Body: { fromNodeId, toNodeId, label, labelTranslations,
 * description, descriptionTranslations, condition, preset, displayOrder }.
 * displayOrder defaults to appended-at-the-end (max existing + 1 among
 * fromNodeId's outgoing edges) when omitted. Runs the shared cycle/
 * reachability validator against the hypothetical post-create graph before
 * writing — findCycles/findUnreachableNodes both self-filter to
 * question-subgraph node types internally, so this is safe to call
 * unconditionally regardless of what kind of edge is being created (a
 * reply-node button edge just never trips either check).
 */
const createEdge = async (req, res, next) => {
  try {
    const {
      fromNodeId, toNodeId, label = null, labelTranslations = null,
      description = null, descriptionTranslations = null, condition = null, preset = null, displayOrder
    } = req.body;
    const businessId = req.user.businessId;

    if (!fromNodeId || !toNodeId) {
      return errorResponse(res, 400, 'fromNodeId and toNodeId are required');
    }

    const { data: endpointNodes, error: nodesErr } = await supabase
      .from('flow_nodes').select('id, node_type').eq('business_id', businessId).in('id', [fromNodeId, toNodeId]);
    if (nodesErr) throw nodesErr;
    const fromNode = (endpointNodes || []).find(n => n.id === fromNodeId);
    if (!fromNode) {
      return errorResponse(res, 404, 'fromNodeId not found for this business');
    }
    if (!(endpointNodes || []).some(n => n.id === toNodeId)) {
      return errorResponse(res, 404, 'toNodeId not found for this business');
    }
    // vehicle_carousel nodes never get an outgoing edge — what happens after
    // vehicle selection (fare lookup, booking finalization) is hardcoded in
    // bookingGraph.service.js's advanceGraphSession, not edge-driven. This
    // also keeps the frontend wiring UI from offering a "next node" for one.
    if (fromNode.node_type === 'vehicle_carousel') {
      return errorResponse(res, 400,
        'vehicle_carousel nodes cannot have outgoing edges — the post-selection flow is handled entirely in bookingGraph.service.js, not by edges.'
      );
    }

    const labelTranslationsError = validateTranslationsMap(labelTranslations, 'labelTranslations');
    if (labelTranslationsError) return errorResponse(res, 400, labelTranslationsError);
    const descriptionTranslationsError = validateTranslationsMap(descriptionTranslations, 'descriptionTranslations');
    if (descriptionTranslationsError) return errorResponse(res, 400, descriptionTranslationsError);

    const conditionShapeError = validateConditionShape(condition);
    if (conditionShapeError) return errorResponse(res, 400, conditionShapeError);
    if (condition) {
      const knownFieldKeys = await resolveKnownQuestionFieldKeys(businessId);
      const conditionFieldError = validateConditionField(condition, knownFieldKeys);
      if (conditionFieldError) return errorResponse(res, 400, conditionFieldError);
    }

    const presetShapeError = validatePresetShape(preset);
    if (presetShapeError) return errorResponse(res, 400, presetShapeError);

    let effectiveDisplayOrder = displayOrder;
    if (effectiveDisplayOrder === undefined || effectiveDisplayOrder === null) {
      const { data: siblingEdges, error: sibErr } = await supabase
        .from('flow_edges').select('display_order').eq('from_node_id', fromNodeId)
        .order('display_order', { ascending: false }).limit(1);
      if (sibErr) throw sibErr;
      effectiveDisplayOrder = siblingEdges && siblingEdges.length > 0 ? siblingEdges[0].display_order + 1 : 0;
    } else if (typeof effectiveDisplayOrder !== 'number') {
      return errorResponse(res, 400, 'displayOrder must be a number');
    }

    const validationError = await assertGraphStillValid(businessId, ({ nodes, edges }) => ({
      nodes,
      edges: [...edges, { id: '__pending__', businessId, fromNodeId, toNodeId, condition: condition || null }]
    }));
    if (validationError) {
      return errorResponse(res, 400, validationError);
    }

    const { data: edge, error } = await supabase.from('flow_edges').insert({
      business_id: businessId,
      from_node_id: fromNodeId,
      to_node_id: toNodeId,
      label,
      label_translations: labelTranslations || null,
      description,
      description_translations: descriptionTranslations || null,
      condition: condition || null,
      preset: preset || null,
      display_order: effectiveDisplayOrder
    }).select().single();
    if (error) throw error;

    // No cache to flush here: chatbot.service.js's flow:{businessId} cache
    // holds reply-type flow_nodes rows only — getOutgoingEdges queries
    // flow_edges live, uncached, every time. Only reply-NODE field writes
    // need invalidateRulesCache, not edge writes.
    return successResponse(res, 201, toCamelCase(edge));
  } catch (error) {
    logger.error('Error in createEdge:', error);
    next(error);
  }
};

/**
 * PUT /api/flow-graph/edges/:id
 * Surgical edit — retarget (toNodeId), condition, label/translations,
 * description/translations, displayOrder. Deliberately does NOT accept
 * fromNodeId (moving an edge's source is a different edge conceptually;
 * delete + create instead) — and critically, this UPDATEs the existing row
 * rather than replacing it, so the edge's id (a live WhatsApp interaction
 * id for a reply node's button/list row) never changes. This is the
 * concrete fix for Finding A from the design pass: the old rules table's
 * full-array-replace pattern would have silently rotated every button's id
 * on every edit had it been ported here as-is.
 */
const updateEdge = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { toNodeId, label, labelTranslations, description, descriptionTranslations, condition, preset, displayOrder } = req.body;
    const businessId = req.user.businessId;

    const { data: edge, error: findErr } = await supabase
      .from('flow_edges').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!edge) {
      return errorResponse(res, 404, 'Edge not found');
    }

    const updateData = {};

    if (toNodeId !== undefined && toNodeId !== edge.to_node_id) {
      const { data: toNode, error: toNodeErr } = await supabase
        .from('flow_nodes').select('id').eq('id', toNodeId).eq('business_id', businessId).maybeSingle();
      if (toNodeErr) throw toNodeErr;
      if (!toNode) {
        return errorResponse(res, 404, 'toNodeId not found for this business');
      }
      updateData.to_node_id = toNodeId;
    }

    if (labelTranslations !== undefined) {
      const err = validateTranslationsMap(labelTranslations, 'labelTranslations');
      if (err) return errorResponse(res, 400, err);
      updateData.label_translations = labelTranslations || null;
    }
    if (descriptionTranslations !== undefined) {
      const err = validateTranslationsMap(descriptionTranslations, 'descriptionTranslations');
      if (err) return errorResponse(res, 400, err);
      updateData.description_translations = descriptionTranslations || null;
    }
    if (label !== undefined) updateData.label = label;
    if (description !== undefined) updateData.description = description;
    if (displayOrder !== undefined) {
      if (typeof displayOrder !== 'number') return errorResponse(res, 400, 'displayOrder must be a number');
      updateData.display_order = displayOrder;
    }

    if (condition !== undefined) {
      const conditionShapeError = validateConditionShape(condition);
      if (conditionShapeError) return errorResponse(res, 400, conditionShapeError);
      if (condition) {
        const knownFieldKeys = await resolveKnownQuestionFieldKeys(businessId);
        const conditionFieldError = validateConditionField(condition, knownFieldKeys);
        if (conditionFieldError) return errorResponse(res, 400, conditionFieldError);
      }
      updateData.condition = condition;
    }

    if (preset !== undefined) {
      const presetShapeError = validatePresetShape(preset);
      if (presetShapeError) return errorResponse(res, 400, presetShapeError);
      updateData.preset = preset;
    }

    if (Object.keys(updateData).length === 0) {
      return errorResponse(res, 400, 'No recognized fields to update');
    }

    // Only a retarget or a condition change can affect topology/branching —
    // label/description/displayOrder edits can't create a cycle or strand a
    // node, so skip the reload+walk for those.
    if (updateData.to_node_id !== undefined || updateData.condition !== undefined) {
      const validationError = await assertGraphStillValid(businessId, ({ nodes, edges }) => ({
        nodes,
        edges: edges.map(e => e.id === id ? {
          ...e,
          toNodeId: updateData.to_node_id !== undefined ? updateData.to_node_id : e.toNodeId,
          condition: updateData.condition !== undefined ? updateData.condition : e.condition
        } : e)
      }));
      if (validationError) {
        return errorResponse(res, 400, validationError);
      }
    }

    const { data: updatedEdge, error } = await supabase
      .from('flow_edges').update(updateData).eq('id', id).select().single();
    if (error) throw error;

    return successResponse(res, 200, toCamelCase(updatedEdge));
  } catch (error) {
    logger.error('Error in updateEdge:', error);
    next(error);
  }
};

/**
 * DELETE /api/flow-graph/edges/:id
 * Deleting an edge can only ever LOSE reachability, never create a cycle —
 * still runs the same shared validator for one consistent code path, and
 * because losing reachability is exactly the failure mode this guards
 * against.
 */
const deleteEdge = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: edge, error: findErr } = await supabase
      .from('flow_edges').select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!edge) {
      return errorResponse(res, 404, 'Edge not found');
    }

    const validationError = await assertGraphStillValid(businessId, ({ nodes, edges }) => ({
      nodes,
      edges: edges.filter(e => e.id !== id)
    }));
    if (validationError) {
      return errorResponse(res, 400, validationError);
    }

    const { error } = await supabase.from('flow_edges').delete().eq('id', id);
    if (error) throw error;

    return successResponse(res, 200, null, 'Edge deleted successfully');
  } catch (error) {
    logger.error('Error in deleteEdge:', error);
    next(error);
  }
};

/**
 * PUT /api/flow-graph/edges/reorder
 * Body: { fromNodeId, orderedEdgeIds: [...] } — must contain exactly
 * fromNodeId's current outgoing edges, no more, no fewer. Writes
 * display_order sequentially (0-indexed). Pure reordering never changes
 * from/to/condition, so no cycle/reachability re-check is needed.
 */
const reorderEdges = async (req, res, next) => {
  try {
    const { fromNodeId, orderedEdgeIds } = req.body;
    const businessId = req.user.businessId;

    if (!fromNodeId || !Array.isArray(orderedEdgeIds) || orderedEdgeIds.length === 0) {
      return errorResponse(res, 400, 'fromNodeId and a non-empty orderedEdgeIds array are required');
    }

    const { data: existingEdges, error: fetchErr } = await supabase
      .from('flow_edges').select('id').eq('from_node_id', fromNodeId).eq('business_id', businessId);
    if (fetchErr) throw fetchErr;

    const existingIds = new Set((existingEdges || []).map(e => e.id));
    const requestedIds = new Set(orderedEdgeIds);
    if (existingIds.size !== orderedEdgeIds.length || requestedIds.size !== orderedEdgeIds.length ||
        !orderedEdgeIds.every(id => existingIds.has(id))) {
      return errorResponse(res, 400, 'orderedEdgeIds must contain exactly the current outgoing edges of fromNodeId, no more, no fewer, no duplicates');
    }

    for (let i = 0; i < orderedEdgeIds.length; i++) {
      const { error } = await supabase.from('flow_edges').update({ display_order: i }).eq('id', orderedEdgeIds[i]);
      if (error) throw error;
    }

    const { data: reordered, error: reErr } = await supabase
      .from('flow_edges').select('*').eq('from_node_id', fromNodeId).order('display_order', { ascending: true });
    if (reErr) throw reErr;

    return successResponse(res, 200, { edges: (reordered || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in reorderEdges:', error);
    next(error);
  }
};

module.exports = {
  getReplyNodes,
  createReplyNode,
  updateReplyNode,
  deleteReplyNode,
  toggleReplyNode,
  getQuestionNodes,
  createQuestionNode,
  updateQuestionNode,
  deleteQuestionNode,
  getFullGraph,
  saveFullGraph,
  getEdges,
  createEdge,
  updateEdge,
  deleteEdge,
  reorderEdges
};
