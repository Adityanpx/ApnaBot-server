const catalogBroadcastService = require('../services/catalogBroadcast.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

// "Send catalogue" broadcast API (mounted at /api/catalog/broadcast, routes/catalogBroadcast.routes.js). The service
// answers { status, message, data?, errors? }; anything thrown goes to the error handler.

const respond = (res, result) => (result.status < 400
  ? successResponse(res, result.status, result.data === undefined ? null : result.data, result.message)
  : errorResponse(res, result.status, result.message, result.errors || null));

const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

/** POST /api/catalog/broadcast/preview  Body { collectionIds, audienceFilter?, audienceParams? } -> 200 { cards, skipped, errors, ..., audience, cost } */
const preview = async (req, res, next) => {
  try {
    respond(res, await catalogBroadcastService.previewCatalogBroadcast(req.user.businessId, body(req)));
  } catch (error) {
    logger.error('Error in previewCatalogBroadcast:', error);
    next(error);
  }
};

/**
 * POST /api/catalog/broadcast  Body { collectionIds, audienceFilter?, audienceParams?, name?, prepareOnly? }
 * -> 201 { broadcastId, ... } | 202 { templatesPending, templates } | 400 | 404 | 502
 */
const send = async (req, res, next) => {
  try {
    respond(res, await catalogBroadcastService.sendCatalogBroadcast(req.user.businessId, body(req)));
  } catch (error) {
    logger.error('Error in sendCatalogBroadcast:', error);
    next(error);
  }
};

module.exports = { preview, send };
