const businessService = require('../services/business.service');
const handoffService = require('../services/handoff.service');
const { DEFAULTS, toApi, validateSettingsInput } = require('../utils/handoffSettings');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * GET /api/business/handoff-settings (owner)
 * The human-needed alert settings (see utils/handoffSettings.js for the exact shape). A business with
 * no row gets the defaults with enabled false - which is also what the server treats it as.
 */
const getHandoffSettings = async (req, res, next) => {
  try {
    const settings = await handoffService.getSettings(req.user.businessId);
    return successResponse(res, 200, toApi(settings || DEFAULTS));
  } catch (error) {
    logger.error('Error in getHandoffSettings:', error);
    next(error);
  }
};

/**
 * PUT /api/business/handoff-settings (owner)
 * Any subset of the settings; the rest keeps its stored value. Unknown keys and bad types answer 400
 * naming the field. `keywords: null` goes back to the built-in phrases.
 */
const updateHandoffSettings = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const business = await businessService.getBusinessById(businessId);
    if (!business) return errorResponse(res, 404, 'Business not found');

    const checked = validateSettingsInput(req.body, business);
    if (!checked.ok) return errorResponse(res, 400, checked.error);

    const saved = await handoffService.saveSettings(businessId, checked.patch);
    return successResponse(res, 200, toApi(saved), 'Handoff settings saved');
  } catch (error) {
    logger.error('Error in updateHandoffSettings:', error);
    next(error);
  }
};

module.exports = { getHandoffSettings, updateHandoffSettings };
