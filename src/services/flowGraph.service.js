// Shared flow-graph write logic, extracted verbatim from
// flowGraph.controller.js so more than one endpoint can use it: the canvas
// editor's PUT /api/flow-graph/full and the AI-flow generator's /apply
// both commit through saveFullGraph below. The validators/constants and
// assertGraphStillValid moved here with it (every other flowGraph.controller
// .js handler still uses them, now imported from here) — moved as-is, no
// behavior change; see git history of flowGraph.controller.js for their
// original context.
const crypto = require('crypto');
const supabase = require('../config/supabase');
const { invalidateRulesCache } = require('./chatbot.service');
const bookingGraphService = require('./bookingGraph.service');
const {
  findCycles,
  findUnreachableNodes,
  findFallbackSiblingNodeIds,
  resolveBookingTriggerEntryNodeIds,
  canEnterBookingQuestions,
  validateConditionField
} = require('../utils/flowGraphValidation');
const { validateLabelTranslations } = require('../utils/bookingFieldValidation');
const { validateFlowFields } = require('../utils/flowFieldsValidation');
const { toCamelCase } = require('../utils/caseConvert');
const { isValidLanguageCode } = require('../utils/languageCatalog');

const VALID_MATCH_TYPES = ['exact', 'contains', 'startsWith'];
const VALID_CONTENT_TYPES = ['text', 'buttons', 'list', 'location', 'location_request'];
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

// Shared by deleteQuestionNode and the canvas batch save's delete path.
const reservedFieldDeleteError = (fieldKey) =>
  `Cannot delete: fieldKey "${fieldKey}" has special booking-flow behavior, and this business can ` +
  'still start the chat booking questions (a "Start a booking" reply, or a reply button that leads into them). Remove that first.';

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
 *
 * `force` (default false) downgrades a reachability violation from a
 * blocking error to a reported list the caller must log before proceeding.
 * Cycles are NEVER force-overridable — a cycle means a customer can get
 * stuck answering the same questions forever, an actual bug, not a
 * judgment call to push through deliberately.
 *
 * @returns {{ error: string|null, newlyUnreachableNodeIds: string[] }}
 */
const assertGraphStillValid = async (businessId, transformFn, { force = false } = {}) => {
  const { nodes, edges } = await bookingGraphService.loadGraph(businessId);
  const hypothetical = transformFn({ nodes, edges });

  const cyclicNodeIds = findCycles(hypothetical.nodes, hypothetical.edges);
  if (cyclicNodeIds.length > 0) {
    return {
      error: `This change would create a cycle in the booking flow involving ${cyclicNodeIds.length} node(s) — a customer could get stuck answering the same questions forever.`,
      newlyUnreachableNodeIds: []
    };
  }

  const beforeEntryNodeIds = resolveBookingTriggerEntryNodeIds(nodes, edges);
  const beforeUnreachable = new Set(findUnreachableNodes(nodes, edges, beforeEntryNodeIds));

  const afterEntryNodeIds = resolveBookingTriggerEntryNodeIds(hypothetical.nodes, hypothetical.edges);
  const afterUnreachable = findUnreachableNodes(hypothetical.nodes, hypothetical.edges, afterEntryNodeIds);
  const newlyUnreachable = afterUnreachable.filter(id => !beforeUnreachable.has(id));

  if (newlyUnreachable.length > 0 && !force) {
    return {
      error: `This change would make ${newlyUnreachable.length} previously-reachable booking question(s) unreachable — a customer could never reach them.`,
      newlyUnreachableNodeIds: newlyUnreachable
    };
  }

  return { error: null, newlyUnreachableNodeIds: newlyUnreachable };
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
 * Per-node location-override validation for reply nodes (contentType=
 * 'location'). latitude/longitude are otherwise unconstrained at the DB
 * layer (plain numeric columns, no CHECK) — range-checked here because a
 * bad value here sends a customer a wrong map pin in production, unlike
 * e.g. `order`/`displayOrder` elsewhere in this file where a bad number is
 * just cosmetic.
 */
const validateLatLng = (latitude, longitude) => {
  if (latitude !== null && latitude !== undefined) {
    if (typeof latitude !== 'number') return 'latitude must be a number';
    if (latitude < -90 || latitude > 90) return 'latitude must be between -90 and 90';
  }
  if (longitude !== null && longitude !== undefined) {
    if (typeof longitude !== 'number') return 'longitude must be a number';
    if (longitude < -180 || longitude > 180) return 'longitude must be between -180 and 180';
  }
  return null;
};

/**
 * Core of PUT /api/flow-graph/full (flowGraph.controller.js#saveFullGraph),
 * extracted so the AI-flow /apply endpoint can share it. Returns
 * { error: string } (the handler maps it to a 400) or { error: null } on a
 * successful write; throws on any Supabase/RPC error, same as before.
 *
 * Original handler doc comment follows unchanged:
 *
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
 *   - Computed nodes (is_computed=true: vehicle_carousel/rentalPackage) can
 *     now be deleted via the single-node deleteQuestionNode endpoint (with
 *     its reachability-guard + force flow), but batch save still has no
 *     delete path for one — letting "omitted from the payload" silently
 *     delete one here, with no explicit per-node confirmation and no force
 *     flag threaded through this diff logic, would be a much easier way to
 *     accidentally remove a node bookingGraph.service.js's
 *     fallbackToStaticSibling can throw on mid-booking if it goes missing.
 *     Blocked outright instead (see the nodeDeletes check below) — the only
 *     edit batch save accepts for one of these is position. Revisit if the
 *     canvas editor ever needs to delete one; not done as part of adding
 *     force to the single-node endpoints (different risk shape — deletes
 *     here are implicit-by-omission, not an explicit DELETE call).
 *   - findFallbackSiblingNodeIds is run against the CURRENT graph (pre-edit),
 *     not the proposed end state, then cross-referenced against this diff's
 *     node deletes — running it against the proposed state the way
 *     findCycles/findUnreachableNodes are run would never flag anything,
 *     because a node being deleted is by definition absent from the proposed
 *     state and so can never appear in a fallback-sibling id list computed
 *     from it. This mirrors exactly what deleteQuestionNode already does
 *     (compute fallback-sibling status from the graph as it stands right
 *     before the delete).
 *   - The reserved-field-key guard is re-checked for deletes only, per spec,
 *     and only while the pre-save graph can still enter the chat booking
 *     questions (flowGraphValidation.js#canEnterBookingQuestions).
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
const saveFullGraph = async ({ businessId, graphBusiness, replyNodes, questionNodes, edges }) => {
  if (!Array.isArray(replyNodes) || !Array.isArray(questionNodes) || !Array.isArray(edges)) {
    return { error: 'replyNodes, questionNodes, and edges must all be arrays.' };
  }

  const [currentNodesRes, currentEdgesRes] = await Promise.all([
    supabase.from('flow_nodes').select('*').eq('business_id', businessId),
    supabase.from('flow_edges').select('*').eq('business_id', businessId)
  ]);
  if (currentNodesRes.error) throw currentNodesRes.error;
  if (currentEdgesRes.error) throw currentEdgesRes.error;
  const currentNodeById = new Map((currentNodesRes.data || []).map(n => [n.id, n]));
  const currentEdgeById = new Map((currentEdgesRes.data || []).map(e => [e.id, e]));

  // Batch-resolve every mediaId referenced across replyNodes/questionNodes
  // in one query, rather than one query per item inside the loops below —
  // this endpoint already does its current-state reads this way.
  const referencedMediaIds = [...new Set(
    [...replyNodes, ...questionNodes].map(item => item && item.mediaId).filter(Boolean)
  )];
  const mediaUrlById = new Map();
  if (referencedMediaIds.length > 0) {
    const { data: mediaRows, error: mediaErr } = await supabase
      .from('business_media').select('id, url, media_type').eq('business_id', businessId).in('id', referencedMediaIds);
    if (mediaErr) throw mediaErr;
    for (const m of mediaRows || []) {
      if (m.media_type === 'image') mediaUrlById.set(m.id, m.url);
    }
    const missing = referencedMediaIds.filter(id => !mediaUrlById.has(id));
    if (missing.length > 0) {
      return { error:
        `mediaId(s) not found, not belonging to this business, or not an image asset: ${missing.join(', ')}` };
    }
  }

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
      return { error: `replyNodes[${i}]: id "${providedId}" belongs to a non-reply node.` };
    }

    const {
      keyword, matchType = 'contains', replyKind = 'text', contentType = 'text',
      imageUrl = null, mediaId = null, hindiAliases = [], labelTranslations = null, isActive = true,
      positionX = null, positionY = null
    } = item;
    let { label } = item;
    const resolvedImageUrl = mediaId ? mediaUrlById.get(mediaId) : imageUrl;

    if (!keyword || typeof keyword !== 'string') {
      return { error: `replyNodes[${i}]: keyword is required` };
    }
    if (!VALID_MATCH_TYPES.includes(matchType)) {
      return { error: `replyNodes[${i}]: matchType must be one of: ${VALID_MATCH_TYPES.join(', ')}` };
    }
    if (!VALID_CONTENT_TYPES.includes(contentType)) {
      return { error: `replyNodes[${i}]: contentType must be one of: ${VALID_CONTENT_TYPES.join(', ')}` };
    }
    if (!VALID_REPLY_KINDS.includes(replyKind)) {
      return { error: `replyNodes[${i}]: replyKind must be one of: ${VALID_REPLY_KINDS.join(', ')}` };
    }
    if (hindiAliases !== undefined && !Array.isArray(hindiAliases)) {
      return { error: `replyNodes[${i}]: hindiAliases must be an array of strings.` };
    }
    const replyLabelTranslationsError = validateTranslationsMap(labelTranslations, `replyNodes[${i}].labelTranslations`);
    if (replyLabelTranslationsError) return { error: replyLabelTranslationsError };

    // buttonText/buttonTextTranslations/formFields/latitude/longitude/
    // locationName/address: preserve-on-omit for EXISTING nodes — a key
    // absent from the item keeps the current row's value, so a canvas
    // client that doesn't send these can't null them out (the RPC sets
    // every column unconditionally). New nodes: omitted → null. A key
    // present with null still clears it, same as the single-node PUT.
    const pickReplyField = (key, column) => (
      Object.prototype.hasOwnProperty.call(item, key) ? item[key] : (existing ? existing[column] : null)
    );
    const buttonText = pickReplyField('buttonText', 'button_text');
    const buttonTextTranslations = pickReplyField('buttonTextTranslations', 'button_text_translations');
    const formFields = pickReplyField('formFields', 'form_fields');
    const latitude = pickReplyField('latitude', 'latitude');
    const longitude = pickReplyField('longitude', 'longitude');
    const locationName = pickReplyField('locationName', 'location_name');
    const address = pickReplyField('address', 'address');

    const replyButtonTextTranslationsError = validateTranslationsMap(buttonTextTranslations, `replyNodes[${i}].buttonTextTranslations`);
    if (replyButtonTextTranslationsError) return { error: replyButtonTextTranslationsError };
    // null is accepted here (unlike PUT, which rejects formFields: null) —
    // GET /full returns formFields: null for every node without fields, and
    // the canvas echoes that back on every save.
    if (formFields !== null && formFields !== undefined) {
      const formFieldsError = validateFlowFields(formFields);
      if (formFieldsError) return { error: `replyNodes[${i}]: ${formFieldsError}` };
    }
    const replyLatLngError = validateLatLng(latitude, longitude);
    if (replyLatLngError) return { error: `replyNodes[${i}]: ${replyLatLngError}` };

    if (replyKind === 'payment_trigger' && !label) label = 'Please complete your payment.';
    if (replyKind === 'booking_trigger' && !label) label = 'Great! Let me collect your details.';
    if (!label && !resolvedImageUrl && contentType !== 'location') {
      return { error: `replyNodes[${i}]: label is required (unless imageUrl/mediaId is provided, or contentType is "location")` };
    }
    if (!label) label = '';

    const normalizedKeyword = keyword.toLowerCase().trim();
    if (seenKeywords.has(normalizedKeyword)) {
      return { error: `replyNodes[${i}]: duplicate keyword "${normalizedKeyword}" among replyNodes in this save.` };
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
      image_url: resolvedImageUrl || null, media_id: mediaId || null, field_key: null, summary_label: null, required: false,
      order: null, options: [], is_computed: false, is_active: isActive,
      position_x: positionX, position_y: positionY,
      button_text: buttonText ?? null, button_text_translations: buttonTextTranslations || null,
      form_fields: formFields ?? null, latitude: latitude ?? null, longitude: longitude ?? null,
      location_name: locationName || null, address: address || null
    });
    proposedNodes.push({ id, nodeType: 'reply', replyKind, fieldKey: null });
  }

  for (let i = 0; i < questionNodes.length; i++) {
    const item = questionNodes[i] || {};
    const providedId = item.id;
    const existing = providedId ? currentNodeById.get(providedId) : undefined;
    if (existing && existing.node_type === 'reply') {
      return { error: `questionNodes[${i}]: id "${providedId}" belongs to a reply node.` };
    }

    const nodeType = item.nodeType !== undefined ? item.nodeType : (existing ? existing.node_type : 'question');
    if (existing && existing.node_type !== nodeType) {
      return { error:
        `questionNodes[${i}]: nodeType cannot change for an existing node (was "${existing.node_type}").` };
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
      return { error: `questionNodes[${i}]: nodeType must be one of: ${VALID_QUESTION_NODE_TYPES.join(', ')}` };
    }
    const isComputed = nodeType === 'vehicle_carousel';

    const {
      fieldKey, contentType = 'text', summaryLabel = null, required = false, order = null,
      options = [], labelTranslations = null, imageUrl = null, mediaId = null, label,
      positionX = null, positionY = null
    } = item;
    const resolvedImageUrl = mediaId ? mediaUrlById.get(mediaId) : imageUrl;

    if (!fieldKey || typeof fieldKey !== 'string') {
      return { error: `questionNodes[${i}]: fieldKey is required` };
    }
    if (!label || typeof label !== 'string') {
      return { error: `questionNodes[${i}]: label is required` };
    }
    if (typeof required !== 'boolean') {
      return { error: `questionNodes[${i}]: required must be a boolean` };
    }
    if (order !== null && order !== undefined && typeof order !== 'number') {
      return { error: `questionNodes[${i}]: order must be a number or null` };
    }
    const questionLabelTranslationsError = validateLabelTranslations(labelTranslations, `questionNodes[${i}].labelTranslations`);
    if (questionLabelTranslationsError) return { error: questionLabelTranslationsError };

    if (isComputed) {
      if (Array.isArray(options) && options.length > 0) {
        return { error:
          `questionNodes[${i}]: options must not be provided for a vehicle_carousel node.` };
      }
    } else {
      if (!VALID_CONTENT_TYPES.includes(contentType)) {
        return { error: `questionNodes[${i}]: contentType must be one of: ${VALID_CONTENT_TYPES.join(', ')}` };
      }
      if ((contentType === 'buttons' || contentType === 'list') && (!Array.isArray(options) || options.length === 0)) {
        return { error: `questionNodes[${i}]: options must have at least one entry for contentType "${contentType}"` };
      }
      for (const opt of options || []) {
        if (opt && typeof opt === 'object') {
          const optErr = validateLabelTranslations(opt.labelTranslations, `questionNodes[${i}] option "${opt.value}" labelTranslations`);
          if (optErr) return { error: optErr };
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
      label, label_translations: labelTranslations || null, image_url: resolvedImageUrl || null,
      media_id: mediaId || null,
      field_key: fieldKey, summary_label: summaryLabel, required, order,
      options: isComputed ? [] : (options || []), is_computed: isComputed,
      is_active: existing ? existing.is_active : true,
      position_x: positionX, position_y: positionY,
      // Reply-node-only columns — not accepted for question nodes; carried
      // over unchanged so the RPC's unconditional UPDATE SET can't null them.
      button_text: existing ? existing.button_text : null,
      button_text_translations: existing ? existing.button_text_translations : null,
      form_fields: existing ? existing.form_fields : null,
      latitude: existing ? existing.latitude : null,
      longitude: existing ? existing.longitude : null,
      location_name: existing ? existing.location_name : null,
      address: existing ? existing.address : null
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
      return { error: `edges[${i}]: fromNodeId and toNodeId are required` };
    }
    const fromNodeId = resolveNodeRef(rawFrom);
    const toNodeId = resolveNodeRef(rawTo);
    if (!fromNodeId) return { error: `edges[${i}]: fromNodeId "${rawFrom}" does not resolve to any node in this save` };
    if (!toNodeId) return { error: `edges[${i}]: toNodeId "${rawTo}" does not resolve to any node in this save` };

    const fromNode = proposedNodeById.get(fromNodeId);
    if (fromNode && fromNode.nodeType === 'vehicle_carousel') {
      return { error:
        `edges[${i}]: vehicle_carousel nodes cannot have outgoing edges — the post-selection flow is handled entirely in bookingGraph.service.js, not by edges.` };
    }

    const edgeLabelTranslationsError = validateTranslationsMap(labelTranslations, `edges[${i}].labelTranslations`);
    if (edgeLabelTranslationsError) return { error: edgeLabelTranslationsError };
    const edgeDescriptionTranslationsError = validateTranslationsMap(descriptionTranslations, `edges[${i}].descriptionTranslations`);
    if (edgeDescriptionTranslationsError) return { error: edgeDescriptionTranslationsError };

    const conditionShapeError = validateConditionShape(condition);
    if (conditionShapeError) return { error: `edges[${i}]: ${conditionShapeError}` };
    if (condition) {
      const conditionFieldError = validateConditionField(condition, knownFieldKeys);
      if (conditionFieldError) return { error: `edges[${i}]: ${conditionFieldError}` };
    }

    const presetShapeError = validatePresetShape(preset);
    if (presetShapeError) return { error: `edges[${i}]: ${presetShapeError}` };

    if (displayOrder !== undefined && typeof displayOrder !== 'number') {
      return { error: `edges[${i}]: displayOrder must be a number` };
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
    return { error:
      `Cannot delete computed node (fieldKey "${computedDelete.field_key}", id ${computedDelete.id}) via batch save — ` +
      'vehicle_carousel/rentalPackage nodes have no delete path anywhere in this API. Include it in questionNodes (position-only edits are fine) rather than omitting it.'
    };
  }

  const currentNodesCamel = (currentNodesRes.data || []).map(toCamelCase);
  const currentEdgesCamel = (currentEdgesRes.data || []).map(toCamelCase);

  // Reserved-field-key guard, deletes only (see doc comment above).
  // Evaluated against the PRE-save graph (conservative): removing the last
  // chat booking entry and deleting reserved nodes takes two saves.
  if (TRAVEL_CATEGORIES_WITH_RESERVED_FIELDS.includes(graphBusiness.businessCategory) &&
      canEnterBookingQuestions(currentNodesCamel, currentEdgesCamel)) {
    const reservedDelete = nodeDeletes.find(n => n.field_key && RESERVED_TRAVEL_FIELD_KEYS.includes(n.field_key));
    if (reservedDelete) {
      return { error: reservedFieldDeleteError(reservedDelete.field_key) };
    }
  }

  // Fallback-sibling guard, computed against the CURRENT graph (see doc
  // comment above for why proposed-state is the wrong graph to check this
  // against), cross-referenced against this diff's node deletes.
  const currentEntryNodeIds = resolveBookingTriggerEntryNodeIds(currentNodesCamel, currentEdgesCamel);
  const fallbackSiblingIds = new Set(findFallbackSiblingNodeIds(currentNodesCamel, currentEdgesCamel, currentEntryNodeIds));
  const fallbackSiblingDelete = nodeDeletes.find(n => fallbackSiblingIds.has(n.id));
  if (fallbackSiblingDelete) {
    return { error:
      `Cannot delete node (fieldKey "${fallbackSiblingDelete.field_key}", id ${fallbackSiblingDelete.id}) — ` +
      'it has no incoming edge, but another node shares its fieldKey and IS reachable, meaning it may be a live runtime fallback path. ' +
      'Use the single-node delete endpoint instead, where this same check applies with a fuller explanation of the two possible situations.'
    };
  }

  // Whole-proposed-state validation — cycles (absolute) and reachability
  // (differential against the current graph), same logic every surgical
  // node/edge write already goes through. transformFn ignores the graph
  // assertGraphStillValid loads for its own "before" baseline and returns
  // this diff's already-computed proposed state instead.
  // No force option here — batch save is intentionally out of scope for
  // the force-override flow added to the 7 surgical endpoints (see
  // deleteQuestionNode's doc comment for why); this call site otherwise
  // must still adapt to assertGraphStillValid's { error, ... } return
  // shape like every other caller.
  const { error: validationError } = await assertGraphStillValid(businessId, () => ({
    nodes: proposedNodes,
    edges: proposedEdges
  }));
  if (validationError) {
    return { error: validationError };
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
  return { error: null };
};

module.exports = {
  VALID_MATCH_TYPES,
  VALID_CONTENT_TYPES,
  VALID_REPLY_KINDS,
  VALID_QUESTION_NODE_TYPES,
  TRAVEL_CATEGORIES_WITH_RESERVED_FIELDS,
  RESERVED_TRAVEL_FIELD_KEYS,
  reservedFieldDeleteError,
  assertGraphStillValid,
  validateConditionShape,
  validatePresetShape,
  validateTranslationsMap,
  validateLatLng,
  saveFullGraph
};
