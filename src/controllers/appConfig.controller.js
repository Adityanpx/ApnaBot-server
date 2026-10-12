const appConfig = require('../services/appConfig.service');
const { successResponse } = require('../utils/response');
const logger = require('../utils/logger');

// GET /api/app/version - public (no auth). Cached 60s server-side and by clients.
// A degraded answer (DB read failed, defaults served) must not be cached downstream.
const getVersion = async (req, res, next) => {
  try {
    const { config, degraded } = await appConfig.getPublicConfig();
    res.set('Cache-Control', degraded ? 'no-store' : 'public, max-age=60');
    return successResponse(res, 200, config);
  } catch (error) {
    logger.error('Error in app version get:', error);
    return next(error);
  }
};

// GET /api/admin/app-config - superadmin only (routes/appConfigAdmin.routes.js).
const getAdminConfig = async (req, res, next) => {
  try {
    return successResponse(res, 200, await appConfig.getAdminConfig());
  } catch (error) {
    logger.error('Error in app config get:', error);
    return next(error);
  }
};

// PUT /api/admin/app-config - superadmin only. Partial body; validation errors carry a statusCode.
const updateAdminConfig = async (req, res, next) => {
  try {
    const { config, changed } = await appConfig.updateConfig(req.body, req.user.userId);
    if (Object.keys(changed).length > 0) {
      logger.info('App config changed by superadmin', { userId: req.user.userId, changes: changed });
    }
    return successResponse(res, 200, config, 'App config updated');
  } catch (error) {
    if (!error.statusCode) logger.error('Error in app config update:', error);
    return next(error);
  }
};

module.exports = { getVersion, getAdminConfig, updateAdminConfig };
