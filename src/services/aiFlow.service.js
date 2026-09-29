// AI flow generation, Phase 1 (no LLM): FlowSpec or questionnaire answers
// -> compiled graph -> committed through flowGraph.service.js#saveFullGraph,
// the same core the canvas editor's PUT /api/flow-graph/full uses. Shared by
// aiFlow.controller.js (POST /api/flow-graph/ai/compile|apply) and
// src/scripts/applyAiFlow.js, so the endpoint and the dry-run/--confirm
// script can never drift apart.
//
// prepareApply is read-only (DB/Redis reads only); executeApply is the only
// function here that writes. Every apply recomputes the spec from the
// request body (answers are re-mapped with the business row as it is NOW)
// and recompiles server-side — a client-compiled graph is never trusted.
const supabase = require('../config/supabase');
const redis = require('../config/redis');
const flowGraphService = require('./flowGraph.service');
const { readBusinessGraphRows } = require('./flowSnapshot.service');
const { MAX_SNAPSHOTS_PER_BUSINESS } = require('../controllers/flowSnapshot.controller');
const { validateFlowSpec, compileFlowSpec } = require('../utils/flowSpec');
const { mapAnswersToFlowSpec } = require('../utils/flowSpecQuestionnaire');
const logger = require('../utils/logger');

const loadBusiness = async (businessId) => {
  const { data, error } = await supabase
    .from('businesses')
    .select('id, name, display_name, business_category, welcome_message, welcome_message_translations, disabled_booking_fields')
    .eq('id', businessId)
    .maybeSingle();
  if (error) throw error;
  return data;
};

/**
 * Exactly one of spec/answers. answers are mapped fresh on every call, with
 * the business name read from the business row at call time.
 * @returns {{ spec: Object|null, status: number|null, error: string|null }}
 */
const resolveSpec = ({ business, spec, answers }) => {
  const hasSpec = spec !== undefined && spec !== null;
  const hasAnswers = answers !== undefined && answers !== null;
  if (hasSpec === hasAnswers) {
    return { spec: null, status: 400, error: 'Provide exactly one of "spec" or "answers".' };
  }
  if (hasAnswers) {
    const { spec: mapped, error } = mapAnswersToFlowSpec(answers, { businessName: business.display_name || business.name });
    if (error) return { spec: null, status: 400, error };
    return { spec: mapped, status: null, error: null };
  }
  const specError = validateFlowSpec(spec);
  if (specError) return { spec: null, status: 400, error: specError };
  return { spec, status: null, error: null };
};

/**
 * POST /compile core: resolve + compile, no writes.
 * @returns {{ status, error } | { spec, graph, warnings }}
 */
const compile = async ({ businessId, spec, answers }) => {
  const business = await loadBusiness(businessId);
  if (!business) return { status: 404, error: 'Business not found' };
  const resolved = resolveSpec({ business, spec, answers });
  if (resolved.error) return { status: resolved.status, error: resolved.error };
  const { warnings, ...graph } = compileFlowSpec(resolved.spec);
  return { spec: resolved.spec, graph, warnings };
};

/**
 * Counts live booking sessions for this business. Key format mirrors
 * booking.service.js#getSessionKey (`booking_session:{businessId}:{number}`,
 * not exported there). SCAN, not KEYS, so it never blocks Redis. Returns
 * null if Redis can't be read — callers warn generically then.
 */
const countBookingSessions = async (businessId) => {
  try {
    let cursor = '0';
    let count = 0;
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `booking_session:${businessId}:*`, 'COUNT', 200);
      cursor = next;
      count += keys.length;
    } while (cursor !== '0');
    return count;
  } catch (error) {
    logger.error('aiFlow: could not count booking sessions', { businessId, message: error.message });
    return null;
  }
};

const hasWelcomeMessage = (business) => {
  if (typeof business.welcome_message === 'string' && business.welcome_message.trim() !== '') return true;
  const translations = business.welcome_message_translations;
  return !!translations && typeof translations === 'object' &&
    Object.values(translations).some(v => typeof v === 'string' && v.trim() !== '');
};

/**
 * Everything /apply decides BEFORE writing: spec resolution, compile, the
 * 409 refusals, and the warnings list. Read-only.
 * @returns {{ status, error } | { spec, compiled, currentRows, warnings }}
 */
const prepareApply = async ({ businessId, graphBusiness, spec, answers }) => {
  const business = await loadBusiness(businessId);
  if (!business) return { status: 404, error: 'Business not found' };

  // Locked decision: travel categories are out of Phase 1 — the reserved
  // travel field keys and computed nodes can't be generated or safely
  // replaced by a full-replace apply.
  if (flowGraphService.TRAVEL_CATEGORIES_WITH_RESERVED_FIELDS.includes(graphBusiness.businessCategory)) {
    return { status: 409, error: `AI flow generation is not available for the "${graphBusiness.businessCategory}" category yet.` };
  }

  const resolved = resolveSpec({ business, spec, answers });
  if (resolved.error) return { status: resolved.status, error: resolved.error };

  const currentRows = await readBusinessGraphRows(businessId);
  const computed = currentRows.nodes.find(n => n.is_computed);
  if (computed) {
    return {
      status: 409,
      error: `This business's flow contains a computed node (fieldKey "${computed.field_key}") that a generated flow can't replace. Edit the flow in the canvas editor instead.`
    };
  }

  const { warnings: compileWarnings, ...compiled } = compileFlowSpec(resolved.spec);
  const warnings = [...compileWarnings];

  if (hasWelcomeMessage(business)) {
    warnings.push('This business has a welcome message set. Greeting words (hi, hello, menu, …) will keep sending that message instead of the generated menu — clear the welcome message in the business profile if you want the menu to show.');
  }

  const disabled = graphBusiness.disabledBookingFields || [];
  const skipped = compiled.questionNodes.filter(q => !q.required && disabled.includes(q.fieldKey));
  if (skipped.length > 0) {
    warnings.push(`These optional booking questions are switched off for this business and will be skipped: ${skipped.map(q => q.fieldKey).join(', ')}.`);
  }

  if (currentRows.nodes.length > 0) {
    const sessions = await countBookingSessions(businessId);
    if (sessions === null) {
      warnings.push('Any customer who is in the middle of a booking right now will have that booking ended, and buttons already sent in old messages will stop working.');
    } else if (sessions > 0) {
      warnings.push(`${sessions} customer(s) are in the middle of a booking right now — those bookings will end, and buttons already sent in old messages will stop working.`);
    }
  }

  return { spec: resolved.spec, compiled, currentRows, warnings };
};

/**
 * Keeps at most MAX_SNAPSHOTS_PER_BUSINESS own snapshots, oldest deleted
 * first — same rule as flowSnapshot.controller.js#enforceSnapshotCap, but
 * returns what it evicted so /apply can warn about it.
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
const enforceSnapshotCapReporting = async (businessId) => {
  const { data, error } = await supabase
    .from('flow_snapshots').select('id, name')
    .eq('business_id', businessId).eq('is_category_template', false)
    .order('created_at', { ascending: true });
  if (error) throw error;
  const snapshots = data || [];
  if (snapshots.length <= MAX_SNAPSHOTS_PER_BUSINESS) return [];
  const evicted = snapshots.slice(0, snapshots.length - MAX_SNAPSHOTS_PER_BUSINESS);
  const { error: deleteErr } = await supabase.from('flow_snapshots').delete().in('id', evicted.map(s => s.id));
  if (deleteErr) throw deleteErr;
  return evicted;
};

/**
 * The write half of /apply, given prepareApply's successful result:
 *   1. snapshot the current graph (skipped if it's empty) — never marked
 *      active; a failure here throws BEFORE anything else is written;
 *   2. full-replace the graph via flowGraph.service.js#saveFullGraph
 *      (validates, one atomic RPC, invalidates the reply cache) — on a
 *      validation failure the just-made snapshot is removed again so a
 *      rejected apply leaves no trace and evicts nothing;
 *   3. only after a successful save: unset is_active on this business's
 *      snapshots (none describes the live graph any more — same as
 *      flowSnapshot.controller.js#startBlankFlow) and enforce the snapshot
 *      cap, warning if that evicted anything. Failures in step 3 are logged
 *      and reported as warnings — the apply itself already succeeded.
 * @returns {{ status, error } | { snapshot, warnings }}
 */
// snapshotLabel: prefix of the pre-apply snapshot's name — botSettings.service.js
// publishes through this same function with its own label.
const executeApply = async ({ businessId, graphBusiness, prepared, snapshotLabel = 'Before AI flow' }) => {
  const warnings = [...prepared.warnings];
  let snapshot = null;

  if (prepared.currentRows.nodes.length > 0) {
    const formattedDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const { data, error } = await supabase.from('flow_snapshots').insert({
      business_id: businessId,
      name: `${snapshotLabel} — ${formattedDate}`,
      nodes: prepared.currentRows.nodes,
      edges: prepared.currentRows.edges,
      is_category_template: false,
      category: null,
      is_active: false
    }).select('id, name').single();
    if (error) throw error; // abort: nothing else has been written yet
    snapshot = data;
  }

  const { error: saveError } = await flowGraphService.saveFullGraph({
    businessId,
    graphBusiness,
    replyNodes: prepared.compiled.replyNodes,
    questionNodes: prepared.compiled.questionNodes,
    edges: prepared.compiled.edges
  });
  if (saveError) {
    if (snapshot) {
      const { error: cleanupErr } = await supabase.from('flow_snapshots').delete().eq('id', snapshot.id);
      if (cleanupErr) logger.error('aiFlow: failed to remove pre-apply snapshot after a rejected apply', { businessId, snapshotId: snapshot.id, cleanupErr });
    }
    return { status: 400, error: saveError };
  }

  try {
    const { error: unsetErr } = await supabase
      .from('flow_snapshots').update({ is_active: false })
      .eq('business_id', businessId).eq('is_category_template', false);
    if (unsetErr) throw unsetErr;
  } catch (error) {
    logger.error('aiFlow: failed to unset active snapshot after apply', { businessId, message: error.message });
  }

  try {
    const evicted = await enforceSnapshotCapReporting(businessId);
    if (evicted.length > 0) {
      warnings.push(`Only ${MAX_SNAPSHOTS_PER_BUSINESS} saved versions are kept, so the oldest was deleted: ${evicted.map(s => `"${s.name}"`).join(', ')}.`);
    }
  } catch (error) {
    logger.error('aiFlow: failed to enforce snapshot cap after apply', { businessId, message: error.message });
    warnings.push(`Could not tidy up old saved versions (more than ${MAX_SNAPSHOTS_PER_BUSINESS} may be kept for now).`);
  }

  return { snapshot, warnings };
};

module.exports = {
  // Shared with botSettings.service.js (additive exports only).
  countBookingSessions,
  hasWelcomeMessage,
  compile,
  prepareApply,
  executeApply
};
