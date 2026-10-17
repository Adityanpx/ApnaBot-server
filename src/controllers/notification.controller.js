const supabase = require('../config/supabase');
const notificationService = require('../services/notification.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

const PLATFORMS = ['android', 'ios'];
const MAX_TOKEN_LENGTH = 4096;

/**
 * POST /api/notifications/devices
 * Body: { token, platform?, language?, appVersion? }
 * Registers (or re-registers) this phone for push. A token belongs to one user: signing in
 * as someone else on the same phone moves it.
 */
const registerDevice = async (req, res, next) => {
  try {
    const { token, platform = 'android', language = 'en', appVersion = null } = req.body || {};
    if (typeof token !== 'string' || !token.trim() || token.length > MAX_TOKEN_LENGTH) {
      return errorResponse(res, 400, 'token is required');
    }
    if (!PLATFORMS.includes(platform)) return errorResponse(res, 400, `platform must be one of: ${PLATFORMS.join(', ')}`);
    if (appVersion !== null && (typeof appVersion !== 'string' || appVersion.length > 32)) {
      return errorResponse(res, 400, 'appVersion must be a short string');
    }

    const { error } = await supabase.from('device_tokens').upsert({
      user_id: req.user.userId,
      business_id: req.user.businessId,
      token: token.trim(),
      platform,
      language: notificationService.normalizeLanguage(language),
      app_version: appVersion,
      last_seen_at: new Date().toISOString()
    }, { onConflict: 'token' });
    if (error) throw error;

    return successResponse(res, 200, null, 'Device registered');
  } catch (error) {
    logger.error('Error in registerDevice:', error);
    return next(error);
  }
};

/**
 * DELETE /api/notifications/devices
 * Body: { token } - signing out. Only the caller's own token row is removed.
 */
const unregisterDevice = async (req, res, next) => {
  try {
    const { token } = req.body || {};
    if (typeof token !== 'string' || !token.trim()) return errorResponse(res, 400, 'token is required');

    const { error } = await supabase.from('device_tokens').delete()
      .eq('token', token.trim()).eq('user_id', req.user.userId);
    if (error) throw error;

    return successResponse(res, 200, null, 'Device removed');
  } catch (error) {
    logger.error('Error in unregisterDevice:', error);
    return next(error);
  }
};

/** GET /api/notifications/preferences -> the caller's full settings with defaults filled in. */
const getPreferences = async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('notification_preferences').select('prefs')
      .eq('user_id', req.user.userId).eq('business_id', req.user.businessId).maybeSingle();
    if (error) throw error;
    return successResponse(res, 200, notificationService.resolvePrefs(data && data.prefs));
  } catch (error) {
    logger.error('Error in getPreferences:', error);
    return next(error);
  }
};

/**
 * PUT /api/notifications/preferences
 * Body: { types?: { <type>: bool }, voiceEnabled?: bool, quietHours?: { enabled?, start?: 'HH:mm', end?: 'HH:mm' } }
 * Replaces the caller's settings; whatever is left out goes back to its default. 400 names the bad field.
 */
const updatePreferences = async (req, res, next) => {
  try {
    const checked = notificationService.validatePrefs(req.body);
    if (!checked.ok) return errorResponse(res, 400, checked.error, { field: checked.field });

    const { error } = await supabase.from('notification_preferences').upsert({
      user_id: req.user.userId,
      business_id: req.user.businessId,
      prefs: checked.prefs
    }, { onConflict: 'user_id,business_id' });
    if (error) throw error;

    return successResponse(res, 200, notificationService.resolvePrefs(checked.prefs), 'Preferences saved');
  } catch (error) {
    logger.error('Error in updatePreferences:', error);
    return next(error);
  }
};

/**
 * POST /api/notifications/test
 * Body: { type? } (default booking_new) - sends a sample of that type to the caller's own devices.
 */
const sendTestNotification = async (req, res, next) => {
  try {
    const type = (req.body && req.body.type) || 'booking_new';
    if (!notificationService.TYPE_NAMES.includes(type)) {
      return errorResponse(res, 400, `type must be one of: ${notificationService.TYPE_NAMES.join(', ')}`);
    }
    await notificationService.sendTest(req.user.businessId, req.user.userId, type);
    return successResponse(res, 200, { type }, 'Test notification sent');
  } catch (error) {
    logger.error('Error in sendTestNotification:', error);
    return next(error);
  }
};

module.exports = { registerDevice, unregisterDevice, getPreferences, updatePreferences, sendTestNotification };
