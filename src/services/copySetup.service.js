const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { r2KeyFromUrl } = require('../utils/r2Key');
const { invalidateRulesCache } = require('./chatbot.service');
const businessService = require('./business.service');
const {
  readBusinessGraphRows,
  deleteBusinessGraphRows,
  writeBusinessGraphRows,
  enforceSnapshotCap,
  setActiveSnapshot,
  createSnapshotFromRows
} = require('./flowSnapshot.service');
const {
  checkCopyCompatibility,
  findDanglingEdges,
  transformNodesForCopy,
  buildCopyWarnings
} = require('../utils/copySetup');

// Source rows a copy does not bring along (counted only to warn about them).
const NOT_COPIED_TABLES = {
  vehicles: 'vehicles',
  routeFares: 'route_fares',
  rentalPackages: 'rental_packages',
  courses: 'business_courses',
  botSettings: 'business_bot_settings',
  travelSettings: 'business_travel_settings'
};

const BUSINESS_COLUMNS = 'id, name, display_name, business_category, flow_fields';

class CopySetupError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const countRows = async (table, businessId) => {
  const { count, error } = await supabase
    .from(table).select('*', { count: 'exact', head: true }).eq('business_id', businessId);
  if (error) throw error;
  return count || 0;
};

// Date + HH:MM in IST so same-day attempts get distinguishable snapshot names.
const formatDate = () => {
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  return `${day} ${time} IST`;
};

/**
 * Reads everything a copy needs and validates it (all read-only). Throws CopySetupError for
 * 400/404 conditions. Returns the plan both the dry run and the apply work from.
 */
const buildPlan = async (targetId, request) => {
  const { source: sourceRef, include, dryRun } = request;

  const { data: targetRow, error: targetErr } = await supabase
    .from('businesses').select(BUSINESS_COLUMNS).eq('id', targetId).maybeSingle();
  if (targetErr) throw targetErr;
  if (!targetRow) throw new CopySetupError(404, 'Target business not found');

  let sourceRow;
  if (sourceRef.type === 'business') {
    const { data, error } = await supabase
      .from('businesses').select(BUSINESS_COLUMNS).eq('id', sourceRef.id).maybeSingle();
    if (error) throw error;
    sourceRow = data;
  } else {
    // Looked up by id alone so checkCopyCompatibility can tell "not a template" (404) from "inactive" (400).
    const { data, error } = await supabase
      .from('flow_snapshots').select('id, name, category, nodes, edges, is_category_template, is_active')
      .eq('id', sourceRef.id).maybeSingle();
    if (error) throw error;
    sourceRow = data;
  }

  const incompatible = checkCopyCompatibility({ sourceType: sourceRef.type, sourceRow, target: targetRow });
  if (incompatible) throw new CopySetupError(incompatible.status, incompatible.message);

  // Templates hold no flow_fields: skip (with a warning) instead of failing.
  const serviceFormSkipped = sourceRef.type === 'template' && include.serviceForm;
  const effective = { flow: include.flow, serviceForm: include.serviceForm && !serviceFormSkipped };
  if (!effective.flow && !effective.serviceForm) {
    throw new CopySetupError(400, 'Nothing to copy: templates hold no service form, so only flow can be copied from a template');
  }

  const sourceName = sourceRef.type === 'business' ? (sourceRow.display_name || sourceRow.name) : sourceRow.name;
  const targetRows = await readBusinessGraphRows(targetId);
  const targetFlowFields = Array.isArray(targetRow.flow_fields) ? targetRow.flow_fields : [];

  let sourceNodes = [];
  let sourceEdges = [];
  if (effective.flow) {
    if (sourceRef.type === 'business') {
      ({ nodes: sourceNodes, edges: sourceEdges } = await readBusinessGraphRows(sourceRef.id));
    } else {
      sourceNodes = Array.isArray(sourceRow.nodes) ? sourceRow.nodes : [];
      sourceEdges = Array.isArray(sourceRow.edges) ? sourceRow.edges : [];
    }
    if (sourceNodes.length === 0) {
      throw new CopySetupError(400, 'The source has no flow to copy (it has 0 nodes)');
    }
    // Checked up front: after the target's graph is deleted there is no clean way back.
    if (findDanglingEdges(sourceNodes, sourceEdges).length > 0) {
      throw new CopySetupError(400, 'The source flow is inconsistent (an edge points at a missing node) and cannot be copied');
    }
  }

  const transformed = transformNodesForCopy(sourceNodes, { isStorageUrl: (url) => !!r2KeyFromUrl(url) });

  const sourceFormFields = sourceRef.type === 'business' && Array.isArray(sourceRow.flow_fields) ? sourceRow.flow_fields : [];

  const sourceCounts = {};
  if (sourceRef.type === 'business') {
    for (const [key, table] of Object.entries(NOT_COPIED_TABLES)) {
      sourceCounts[key] = await countRows(table, sourceRef.id);
    }
  }

  const warnings = buildCopyWarnings({
    include: effective,
    sourceType: sourceRef.type,
    sourceNodes,
    sourceNames: sourceRef.type === 'business' ? [sourceRow.name, sourceRow.display_name] : [],
    target: {
      currentNodeCount: targetRows.nodes.length,
      hasFlowFields: targetFlowFields.length > 0,
      flowFieldsCount: targetFlowFields.length
    },
    sourceFormFields: sourceFormFields.length,
    stats: transformed,
    sourceCounts,
    serviceFormSkipped
  });

  return {
    targetId, sourceRef, sourceName, effective, dryRun,
    sourceFormFields,
    targetRows,
    copyNodes: transformed.nodes,
    copyEdges: sourceEdges,
    warnings,
    preview: {
      source: { type: sourceRef.type, id: sourceRef.id, name: sourceName },
      target: {
        id: targetRow.id,
        name: targetRow.display_name || targetRow.name,
        currentNodeCount: targetRows.nodes.length,
        currentEdgeCount: targetRows.edges.length,
        hasFlowFields: targetFlowFields.length > 0
      },
      willCopy: {
        nodes: transformed.nodes.length,
        edges: sourceEdges.length,
        webFormNodes: transformed.nodes.filter(n => n.reply_kind === 'web_form_trigger').length,
        serviceFormFields: effective.serviceForm ? sourceFormFields.length : 0
      }
    }
  };
};

/**
 * Writes the plan. Order: restore point -> replace graph -> flush rules cache -> "Copied from"
 * snapshot -> service form. No JS-side rollback: a failure after the graph was cleared is
 * reported with a pointer to the restore point.
 */
const applyPlan = async (plan, adminUserId) => {
  const { targetId, sourceName, effective } = plan;
  const date = formatDate();
  const warnings = [...plan.warnings];

  if (effective.flow) {
    let restoreName = null;
    if (plan.targetRows.nodes.length > 0) {
      restoreName = `Before copy from ${sourceName} — ${date}`;
      try {
        await createSnapshotFromRows(targetId, restoreName, plan.targetRows.nodes, plan.targetRows.edges);
      } catch (err) {
        logger.error('Copy setup: could not save the restore point', err);
        throw new CopySetupError(500, 'Could not save a restore point for the target\'s current flow. Nothing was changed.');
      }
    }

    try {
      await deleteBusinessGraphRows(targetId);
      await writeBusinessGraphRows(targetId, plan.copyNodes, plan.copyEdges, { reuseIds: false, resetTriggerCount: true });
    } catch (err) {
      logger.error('Copy setup: graph replace failed after the delete started', err);
      await invalidateRulesCache(targetId);
      const recovery = restoreName
        ? `Restore the target's flow from the "${restoreName}" snapshot in its Versions tab.`
        : 'No restore point was saved by this attempt because the target had no flow when it started (an earlier failed attempt may already have cleared it; check the Versions tab for a "Before copy from" snapshot). The target is now empty or partial; run the copy again.';
      throw new CopySetupError(500, `Copy failed while writing the new flow, so the target's flow may be empty or incomplete. ${recovery}`);
    }

    await invalidateRulesCache(targetId);

    // Same as importCategoryTemplate: a snapshot failure is logged, not fatal — the copy is already live.
    try {
      const live = await readBusinessGraphRows(targetId);
      const snapshot = await createSnapshotFromRows(targetId, `Copied from ${sourceName} — ${date}`, live.nodes, live.edges);
      await setActiveSnapshot(targetId, snapshot.id);
      await enforceSnapshotCap(targetId);
    } catch (err) {
      logger.error('Copy setup: could not save the "Copied from" snapshot', err);
      warnings.push('The flow was copied, but saving its version snapshot failed.');
    }
  }

  if (effective.serviceForm) {
    try {
      await businessService.updateFlowFields(targetId, plan.sourceFormFields);
    } catch (err) {
      logger.error('Copy setup: service form copy failed', err);
      const done = effective.flow ? 'The flow was copied, but ' : '';
      throw new CopySetupError(500, `${done}the service form could not be copied. Nothing about the service form was changed; retry with include.serviceForm only.`);
    }
    if (!effective.flow) await invalidateRulesCache(targetId);
  }

  logger.info(
    `Copy setup applied: admin ${adminUserId} source ${plan.sourceRef.type}:${plan.sourceRef.id} -> target ${targetId} ` +
    `nodes ${plan.preview.willCopy.nodes} edges ${plan.preview.willCopy.edges} serviceFormFields ${plan.preview.willCopy.serviceFormFields}`
  );

  return { ...plan.preview, warnings, applied: true };
};

/** Entry point: validates, then returns the dry-run preview or applies it. */
const copySetup = async (targetId, request, adminUserId) => {
  const plan = await buildPlan(targetId, request);
  if (plan.dryRun) return { ...plan.preview, warnings: plan.warnings };
  return applyPlan(plan, adminUserId);
};

module.exports = { copySetup, CopySetupError };
