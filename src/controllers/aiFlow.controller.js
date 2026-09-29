const aiFlowService = require('../services/aiFlow.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * POST /api/flow-graph/ai/compile
 * Body: exactly one of { spec } (a FlowSpec v1, see utils/flowSpec.js) or
 * { answers } (questionnaire answers, see utils/flowSpecQuestionnaire.js).
 * Returns { spec, graph: { replyNodes, questionNodes, edges }, warnings }
 * — the graph uses temp ids ("tmp:...") and is NOT saved. No writes.
 */
const compileFlow = async (req, res, next) => {
  try {
    const { spec, answers } = req.body || {};
    const result = await aiFlowService.compile({ businessId: req.user.businessId, spec, answers });
    if (result.error) {
      return errorResponse(res, result.status, result.error);
    }
    return successResponse(res, 200, result);
  } catch (error) {
    logger.error('Error in compileFlow:', error);
    next(error);
  }
};

/**
 * POST /api/flow-graph/ai/apply
 * Body: same as /compile. Recompiles server-side (answers re-mapped fresh),
 * then REPLACES this business's live flow: snapshot of the current graph
 * first (not marked active), then the canvas batch-save core. This is a
 * live cutover for the business the moment it succeeds — see
 * aiFlow.service.js#executeApply. 409 for cab/travels categories and for
 * graphs containing computed nodes.
 * Returns { snapshot: { id, name } | null, warnings }.
 */
const applyFlow = async (req, res, next) => {
  try {
    const { spec, answers } = req.body || {};
    const businessId = req.user.businessId;
    const prepared = await aiFlowService.prepareApply({ businessId, graphBusiness: req.graphBusiness, spec, answers });
    if (prepared.error) {
      return errorResponse(res, prepared.status, prepared.error);
    }

    const result = await aiFlowService.executeApply({ businessId, graphBusiness: req.graphBusiness, prepared });
    if (result.error) {
      return errorResponse(res, result.status, result.error);
    }

    logger.info('aiFlow: generated flow applied', {
      businessId,
      userId: req.user.userId,
      snapshotId: result.snapshot?.id || null,
      replyNodes: prepared.compiled.replyNodes.length,
      questionNodes: prepared.compiled.questionNodes.length
    });
    return successResponse(res, 200, result, 'Generated flow applied');
  } catch (error) {
    logger.error('Error in applyFlow:', error);
    next(error);
  }
};

module.exports = { compileFlow, applyFlow };
