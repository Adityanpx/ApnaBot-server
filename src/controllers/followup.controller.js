const followupService = require('../services/followup.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

// Services return { status, error } for problems the owner can fix.
const send = (res, result, okStatus = 200, message) => (result && result.error
  ? errorResponse(res, result.status, result.error)
  : successResponse(res, okStatus, result, message));

/**
 * GET /api/followups
 * Every automation, newest first, each with stats { sentToday, sent7d, skipped7d }.
 */
const listFollowups = async (req, res, next) => {
  try {
    return successResponse(res, 200, { automations: await followupService.list(req.user.businessId) });
  } catch (error) {
    logger.error('Error in listFollowups:', error);
    next(error);
  }
};

/**
 * GET /api/followups/presets — preset limits, defaults, default texts and
 * templateFilter (custom: templateFilterByTrigger) for the wizard.
 */
const getPresets = async (req, res, next) => {
  try {
    return successResponse(res, 200, { presets: followupService.presets() });
  } catch (error) {
    logger.error('Error in getPresets:', error);
    next(error);
  }
};

/**
 * GET /api/followups/templates — the business's approved, body-only templates
 * { id, name, category, language, bodyText, variableCount } for the template dropdown.
 */
const listFollowupTemplates = async (req, res, next) => {
  try {
    return successResponse(res, 200, { templates: await followupService.listTemplates(req.user.businessId) });
  } catch (error) {
    logger.error('Error in listFollowupTemplates:', error);
    next(error);
  }
};

/**
 * POST /api/followups/preview-audience
 * Body: { preset, triggerType?, delayMinutes?, triggerParams?, messageCategory? }
 * → { count, capped }: customers due right now (no caps / send hours).
 */
const previewAudience = async (req, res, next) => {
  try {
    return send(res, await followupService.previewAudience(req.user.businessId, req.body));
  } catch (error) {
    logger.error('Error in previewAudience:', error);
    next(error);
  }
};

/** GET /api/followups/:id */
const getFollowup = async (req, res, next) => {
  try {
    return send(res, await followupService.get(req.user.businessId, req.params.id));
  } catch (error) {
    logger.error('Error in getFollowup:', error);
    next(error);
  }
};

/**
 * POST /api/followups
 * Body: { preset, name, triggerType?, delayMinutes?, triggerParams?, messageCategory?,
 *   messageText?, messageTextTranslations?, templateId?, templateVariableMapping?,
 *   sendStartMinute?, sendEndMinute?, dailyCap?, perCustomerCap? }
 * Created switched off.
 */
const createFollowup = async (req, res, next) => {
  try {
    return send(res, await followupService.create(req.user.businessId, req.user.userId, req.body), 201, 'Follow-up created (switched off)');
  } catch (error) {
    logger.error('Error in createFollowup:', error);
    next(error);
  }
};

/** PUT /api/followups/:id — same body as create (any subset); checked again. */
const updateFollowup = async (req, res, next) => {
  try {
    return send(res, await followupService.update(req.user.businessId, req.params.id, req.body), 200, 'Follow-up saved');
  } catch (error) {
    logger.error('Error in updateFollowup:', error);
    next(error);
  }
};

/** PATCH /api/followups/:id/active — Body: { isActive }. Switching on re-checks the template. */
const setFollowupActive = async (req, res, next) => {
  try {
    const { isActive } = req.body || {};
    const result = await followupService.setActive(req.user.businessId, req.params.id, isActive);
    return send(res, result, 200, isActive ? 'Follow-up switched on' : 'Follow-up switched off');
  } catch (error) {
    logger.error('Error in setFollowupActive:', error);
    next(error);
  }
};

/** DELETE /api/followups/:id — also deletes its send log. */
const deleteFollowup = async (req, res, next) => {
  try {
    return send(res, await followupService.remove(req.user.businessId, req.params.id), 200, 'Follow-up deleted');
  } catch (error) {
    logger.error('Error in deleteFollowup:', error);
    next(error);
  }
};

/** GET /api/followups/:id/sends?page=&limit= — send log, newest first, numbers masked. */
const listFollowupSends = async (req, res, next) => {
  try {
    const { page, limit } = req.query;
    return send(res, await followupService.listSends(req.user.businessId, req.params.id, { page, limit }));
  } catch (error) {
    logger.error('Error in listFollowupSends:', error);
    next(error);
  }
};

module.exports = {
  listFollowups,
  getPresets,
  listFollowupTemplates,
  previewAudience,
  getFollowup,
  createFollowup,
  updateFollowup,
  setFollowupActive,
  deleteFollowup,
  listFollowupSends
};
