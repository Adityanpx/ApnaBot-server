const optInLinkService = require('../services/optInLink.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

// Services return { status, error } for problems the owner can fix.
const send = (res, result, okStatus = 200, message) => (result && result.error
  ? errorResponse(res, result.status, result.error)
  : successResponse(res, okStatus, result, message));

/**
 * GET /api/opt-in-links
 * Every link, newest first: { id, name, code, greeting, prefillText, waMeUrl,
 * isActive, createdAt, updatedAt, stats: { last30Days, allTime } } where each
 * stats block is { messages, optedIn, declined } — distinct customers.
 */
const listOptInLinks = async (req, res, next) => {
  try {
    return send(res, await optInLinkService.list(req.user.businessId));
  } catch (error) {
    logger.error('Error in listOptInLinks:', error);
    next(error);
  }
};

/** GET /api/opt-in-links/:id */
const getOptInLink = async (req, res, next) => {
  try {
    return send(res, await optInLinkService.get(req.user.businessId, req.params.id));
  } catch (error) {
    logger.error('Error in getOptInLink:', error);
    next(error);
  }
};

/**
 * POST /api/opt-in-links
 * Body: { name, greeting? } — greeting defaults to "Hi {{businessName}} 👋";
 * the server adds " Code: JOIN-<code>" itself.
 */
const createOptInLink = async (req, res, next) => {
  try {
    return send(res, await optInLinkService.create(req.user.businessId, req.user.userId, req.body), 201, 'Opt-in link created');
  } catch (error) {
    logger.error('Error in createOptInLink:', error);
    next(error);
  }
};

/** PUT /api/opt-in-links/:id — Body: any of { name, greeting, isActive }. */
const updateOptInLink = async (req, res, next) => {
  try {
    return send(res, await optInLinkService.update(req.user.businessId, req.params.id, req.body), 200, 'Opt-in link saved');
  } catch (error) {
    logger.error('Error in updateOptInLink:', error);
    next(error);
  }
};

module.exports = {
  listOptInLinks,
  getOptInLink,
  createOptInLink,
  updateOptInLink
};
