// Public, unauthenticated Help Center support endpoints (mounted under
// /api/public — see public.routes.js). The Help Center itself is static
// content on the web app; the server only tells clients where it lives and
// records "Was this helpful?" votes.
const supabase = require('../config/supabase');
const config = require('../config/env');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

const HELP_LANGUAGES = ['en'];
const FEEDBACK_LOCALES = ['en', 'hi', 'mr'];
// Same pattern + length as the help_feedback.slug CHECK constraint.
const SLUG_PATTERN = /^[a-z0-9-]+(\/[a-z0-9-]+){1,2}$/;
const SLUG_MAX_LENGTH = 120;

const helpBaseUrl = () =>
  (config.HELP_BASE_URL || `${String(config.FRONTEND_URL).replace(/\/+$/, '')}/help`);

/**
 * GET /api/public/app-config
 * Non-secret client config. Cache-friendly: the values only change with an
 * env var + redeploy.
 */
const getAppConfig = (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  return successResponse(res, 200, {
    helpBaseUrl: helpBaseUrl(),
    helpLanguages: HELP_LANGUAGES
  });
};

/**
 * Validates a help-feedback body.
 * @param {Object} body
 * @returns {string|null} error message, or null when valid
 */
const validateFeedback = (body) => {
  const { slug, locale, helpful } = body || {};
  if (typeof slug !== 'string' || slug.length > SLUG_MAX_LENGTH || !SLUG_PATTERN.test(slug)) return 'Invalid slug';
  if (!FEEDBACK_LOCALES.includes(locale)) return 'Invalid locale';
  if (typeof helpful !== 'boolean') return 'helpful must be a boolean';
  return null;
};

/**
 * POST /api/public/help-feedback
 * Body: { slug, locale, helpful } → 204.
 */
const submitHelpFeedback = async (req, res) => {
  const message = validateFeedback(req.body);
  if (message) return errorResponse(res, 400, message);

  const { slug, locale, helpful } = req.body;
  try {
    const { error } = await supabase.from('help_feedback').insert({ slug, locale, helpful });
    if (error) throw error;
    return res.status(204).end();
  } catch (error) {
    logger.error('Error saving help feedback:', error);
    return errorResponse(res, 500, 'Could not save feedback');
  }
};

module.exports = {
  getAppConfig,
  submitHelpFeedback,
  validateFeedback
};
