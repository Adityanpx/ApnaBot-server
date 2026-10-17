const trialService = require('../services/trial.service');
const { successResponse } = require('../utils/response');
const { toCamelCase } = require('../utils/caseConvert');
const logger = require('../utils/logger');

// All handlers are Super Admin only (routes/admin.routes.js). Validation errors carry a statusCode.

// GET /api/admin/trial-settings
const getSettings = async (req, res, next) => {
  try {
    return successResponse(res, 200, await trialService.getTrialSettings());
  } catch (error) {
    logger.error('Error in trial settings get:', error);
    return next(error);
  }
};

// PUT /api/admin/trial-settings - partial { trialEnabled, trialDays, trialPlanId (null = default plan) }
const updateSettings = async (req, res, next) => {
  try {
    const settings = await trialService.updateTrialSettings(req.body, req.user.userId);
    logger.info('Trial settings changed by superadmin', { userId: req.user.userId, changes: req.body });
    return successResponse(res, 200, settings, 'Trial settings updated');
  } catch (error) {
    if (!error.statusCode) logger.error('Error in trial settings update:', error);
    return next(error);
  }
};

// GET /api/admin/trial-claims?search=&limit=&offset=
const listClaims = async (req, res, next) => {
  try {
    const { claims, total } = await trialService.listTrialClaims(req.query);
    return successResponse(res, 200, { claims: claims.map(toCamelCase), total });
  } catch (error) {
    logger.error('Error in trial claims list:', error);
    return next(error);
  }
};

// DELETE /api/admin/trial-claims/:id - body { reason } is required
const deleteClaim = async (req, res, next) => {
  try {
    const claim = await trialService.deleteTrialClaim(req.params.id, req.body && req.body.reason, req.user.userId);
    return successResponse(res, 200, toCamelCase(claim), 'Trial claim deleted');
  } catch (error) {
    if (!error.statusCode) logger.error('Error in trial claim delete:', error);
    return next(error);
  }
};

module.exports = { getSettings, updateSettings, listClaims, deleteClaim };
