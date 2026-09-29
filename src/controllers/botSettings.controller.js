const botSettingsService = require('../services/botSettings.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * GET /api/bot-settings
 * { settings: { preset, settings, publishedAt, publishedSnapshotId,
 *   hasUnpublishedChanges } | null, presets: { [name]: { category, fieldLibrary } } }
 */
const getBotSettings = async (req, res, next) => {
  try {
    const result = await botSettingsService.getSettings({ businessId: req.user.businessId });
    return successResponse(res, 200, result);
  } catch (error) {
    logger.error('Error in getBotSettings:', error);
    next(error);
  }
};

/**
 * PUT /api/bot-settings
 * Body: { preset, settings }. Saves a draft (incomplete setups allowed);
 * the live WhatsApp bot does NOT change until Publish.
 */
const saveBotSettings = async (req, res, next) => {
  try {
    const { preset, settings } = req.body || {};
    const result = await botSettingsService.saveDraft({
      businessId: req.user.businessId, graphBusiness: req.graphBusiness, preset, settings
    });
    if (result.error) return errorResponse(res, result.status, result.error);
    return successResponse(res, 200, result.saved, 'Bot settings saved (not published yet)');
  } catch (error) {
    logger.error('Error in saveBotSettings:', error);
    next(error);
  }
};

/**
 * POST /api/bot-settings/compile
 * Body: {} (use the saved draft) or { preset, settings } (preview unsaved
 * edits). Returns { spec, graph, warnings } — what Publish would produce.
 * No writes.
 */
const compileBotSettings = async (req, res, next) => {
  try {
    const { preset, settings } = req.body || {};
    const result = await botSettingsService.compile({
      businessId: req.user.businessId, graphBusiness: req.graphBusiness, preset, settings
    });
    if (result.error) return errorResponse(res, result.status, result.error);
    return successResponse(res, 200, result);
  } catch (error) {
    logger.error('Error in compileBotSettings:', error);
    next(error);
  }
};

/**
 * POST /api/bot-settings/publish
 * Publishes the SAVED settings: snapshot of the current flow, then replace
 * it. A live cutover for this business the moment it succeeds.
 * Returns { snapshot: { id, name } | null, warnings }.
 */
const publishBotSettings = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const prepared = await botSettingsService.preparePublish({ businessId, graphBusiness: req.graphBusiness });
    if (prepared.error) return errorResponse(res, prepared.status, prepared.error);

    const result = await botSettingsService.executePublish({ businessId, graphBusiness: req.graphBusiness, prepared });
    if (result.error) return errorResponse(res, result.status, result.error);

    logger.info('botSettings: published', {
      businessId, userId: req.user.userId, preset: prepared.row.preset,
      snapshotId: result.snapshot?.id || null, replyNodes: prepared.compiled.replyNodes.length
    });
    return successResponse(res, 200, result, 'Bot published');
  } catch (error) {
    logger.error('Error in publishBotSettings:', error);
    next(error);
  }
};

module.exports = { getBotSettings, saveBotSettings, compileBotSettings, publishBotSettings };
