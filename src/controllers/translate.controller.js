const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');
const businessService = require('../services/business.service');
const translation = require('../services/translation.service');
const flowTranslate = require('../services/flowTranslate.service');
const azure = require('../services/azureTranslate.service');
const { isValidLanguageCode } = require('../utils/languageCatalog');

const MAX_TEXTS = 100;
const MAX_TEXT_LENGTH = 4096;

const usageShape = ({ used, cap }) => ({ used, cap, remaining: Math.max(cap - used, 0) });

// TranslateError (503 not configured / unavailable, 429 cap, 400 language) -> its own status and
// { code } in `errors`; anything else is passed on.
const respondTranslateError = (error, res, next) => {
  if (error && error.name === 'TranslateError') {
    return errorResponse(res, error.statusCode, error.message, { code: error.code });
  }
  return next(error);
};

const notConfigured = (res) => errorResponse(res, 503, azure.NOT_CONFIGURED_MESSAGE, { code: 'TRANSLATE_NOT_CONFIGURED' });

// The target languages the business may use: enabled, a catalog code, not English.
const checkTargets = (codes, enabledLanguages) => {
  if (!Array.isArray(codes) || codes.length < 1) return 'to must be a non-empty array of language codes.';
  if (new Set(codes).size !== codes.length) return 'to must not contain duplicate language codes.';
  for (const code of codes) {
    if (typeof code !== 'string' || !isValidLanguageCode(code)) return `Unknown language code "${code}".`;
    if (code === 'en') return 'English is the source language and cannot be a translation target.';
    if (!enabledLanguages.includes(code)) return `"${code}" is not one of your enabled languages. Enable it first (PUT /api/business, enabledLanguages).`;
  }
  return null;
};

/**
 * POST /api/translate (owner)
 * Body: { texts: string[] (1-100, each up to 4096 chars), to: string[] (enabled, non-English codes) }
 * -> { translations: { <code>: (string|null)[] aligned with texts }, warnings: [{ index, language, reason }],
 *      usage: { used, cap, remaining } }
 * A null entry = blank text, or a translation dropped because it lost a {{placeholder}}, *bold*,
 * _italic_, line break or emoji (see warnings) - the field then falls back to English at send time.
 */
const translateTexts = async (req, res, next) => {
  try {
    const { texts, to } = req.body || {};
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > MAX_TEXTS) {
      return errorResponse(res, 400, `texts must be an array of 1 to ${MAX_TEXTS} strings.`);
    }
    const badText = texts.findIndex((t) => typeof t !== 'string' || t.length > MAX_TEXT_LENGTH);
    if (badText !== -1) return errorResponse(res, 400, `texts[${badText}] must be a string of up to ${MAX_TEXT_LENGTH} characters.`);

    const business = await businessService.getBusinessById(req.user.businessId);
    const targetProblem = checkTargets(to, (business && business.enabledLanguages) || ['en']);
    if (targetProblem) return errorResponse(res, 400, targetProblem);

    if (!azure.isConfigured()) return notConfigured(res);

    const result = await translation.translateTexts({ businessId: req.user.businessId, texts, to, scope: 'owner' });
    const usage = result.usage && result.usage.used != null ? result.usage : await translation.getUsage(req.user.businessId);
    return successResponse(res, 200, { translations: result.translations, warnings: result.warnings, usage: usageShape(usage) });
  } catch (error) {
    logger.error('Error in translateTexts:', error);
    return respondTranslateError(error, res, next);
  }
};

/**
 * POST /api/translate/flow (owner)
 * Body: { to: '<code>' } - one enabled, non-English language.
 * Translates every empty slot of the whole flow (node / edge / option / carousel texts, welcome,
 * stop / start / cancel messages, booking form labels) into `to`. Texts that already have a
 * translation in that language are never touched. All-or-nothing against the monthly cap.
 * -> { language, translated, alreadyTranslated, skipped: [{ slot, reason }], warnings, usage }
 * The canvas must reload the graph afterwards (GET /api/flow-graph/full) - saving a copy loaded before
 * this call would overwrite the new translations.
 */
const translateFlow = async (req, res, next) => {
  try {
    const { to } = req.body || {};
    const business = await businessService.getBusinessById(req.user.businessId);
    const targetProblem = typeof to === 'string' ? checkTargets([to], (business && business.enabledLanguages) || ['en']) : 'to must be a language code.';
    if (targetProblem) return errorResponse(res, 400, targetProblem);

    if (!azure.isConfigured()) return notConfigured(res);

    const result = await flowTranslate.translateBusinessFlow({ businessId: req.user.businessId, lang: to, scope: 'flow' });
    const usage = result.usage && result.usage.used != null ? result.usage : await translation.getUsage(req.user.businessId);
    return successResponse(res, 200, {
      language: result.language,
      translated: result.translated,
      alreadyTranslated: result.alreadyTranslated,
      skipped: result.skipped,
      warnings: result.warnings,
      usage: usageShape(usage)
    });
  } catch (error) {
    logger.error('Error in translateFlow:', error);
    return respondTranslateError(error, res, next);
  }
};

/** GET /api/translate/usage (owner) -> { used, cap, remaining, configured } for the current (India) month. */
const getUsage = async (req, res, next) => {
  try {
    const usage = await translation.getUsage(req.user.businessId);
    return successResponse(res, 200, { ...usage, configured: azure.isConfigured() });
  } catch (error) {
    logger.error('Error in getTranslateUsage:', error);
    next(error);
  }
};

module.exports = { translateTexts, translateFlow, getUsage };
