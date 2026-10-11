const { successResponse, errorResponse } = require('../utils/response');
const copySetupService = require('../services/copySetup.service');
const { isUuid, parseCopySetupRequest } = require('../utils/copySetup');
const logger = require('../utils/logger');

/**
 * POST /api/admin/businesses/:id/copy-setup
 * Body: { source: { type: 'business' | 'template', id }, include: { flow, serviceForm }, dryRun }
 * Copies a same-category business's (or a category template's) auto-reply flow and/or
 * service form into business :id. dryRun defaults to true — only dryRun:false writes.
 * See services/copySetup.service.js for the apply order and utils/copySetup.js for what is
 * transformed/dropped on the way.
 */
const copySetup = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return errorResponse(res, 400, 'Invalid business id');

    const parsed = parseCopySetupRequest(req.body);
    if (parsed.error) return errorResponse(res, parsed.error.status, parsed.error.message);

    const result = await copySetupService.copySetup(id, parsed.value, req.user.userId);
    return successResponse(res, 200, result, result.applied ? 'Setup copied' : 'Dry run — nothing was changed');
  } catch (error) {
    if (error instanceof copySetupService.CopySetupError) {
      return errorResponse(res, error.statusCode, error.message);
    }
    logger.error('Error in copySetup:', error);
    next(error);
  }
};

module.exports = { copySetup };
