const supabase = require('../config/supabase');
const { invalidateRulesCache } = require('./chatbot.service');
const {
  deleteBusinessGraphRows,
  writeBusinessGraphRows,
  enforceSnapshotCap,
  setActiveSnapshot
} = require('./flowSnapshot.service');
const logger = require('../utils/logger');
const { r2KeyFromUrl } = require('../utils/r2Key');
const { transformNodesForCopy } = require('../utils/copySetup');

/**
 * Replaces a business's flow_nodes/flow_edges with a category template's
 * stored graph. Shared by the owner's "Import starter template" action
 * (flowSnapshot.controller.js#importCategoryTemplate) and the signup default
 * (defaultSetup.service.js#applyDefaultSetup) - see importCategoryTemplate's
 * doc comment for the id / trigger_count / restore-point rules, which are
 * unchanged. `template` is a flow_snapshots row (is_category_template = true).
 *
 * Throws on a graph write failure (the caller decides what to do); a failure
 * of the restore-point snapshot alone is logged and swallowed.
 * @returns {Promise<{nodeCount:number}>}
 */
const importTemplateIntoBusiness = async (businessId, template, { snapshotName }) => {
  // Templates saved before cloneFromBusiness cleaned its input may still carry the source
  // business's media_id / R2 image_url / location pins - strip them on the way in.
  const { nodes: cleanNodes } = transformNodesForCopy(template.nodes, { isStorageUrl: (url) => !!r2KeyFromUrl(url) });

  await deleteBusinessGraphRows(businessId);
  await writeBusinessGraphRows(businessId, cleanNodes, template.edges, {
    reuseIds: false,
    resetTriggerCount: true
  });
  await invalidateRulesCache(businessId);

  try {
    const { data: newSnapshot, error: snapshotErr } = await supabase.from('flow_snapshots').insert({
      business_id: businessId,
      name: snapshotName,
      nodes: cleanNodes,
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

  return { nodeCount: cleanNodes.length };
};

module.exports = { importTemplateIntoBusiness };
