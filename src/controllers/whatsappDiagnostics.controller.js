const supabase = require('../config/supabase');
const config = require('../config/env');
const logger = require('../utils/logger');
const { decrypt } = require('../utils/crypto');
const { successResponse, errorResponse } = require('../utils/response');
const diagnostics = require('../services/whatsappDiagnostics.service');

// Runs one Meta read for the report: { ok:true, ...result } or { ok:false, <error fields> }.
// Never throws, never returns a token.
const attempt = async (fn) => {
  try {
    return { ok: true, result: await fn() };
  } catch (error) {
    return { ok: false, error: diagnostics.metaErrorOf(error) };
  }
};

const businessReads = async (businessId) => {
  const { data: row, error } = await supabase
    .from('businesses').select('id, waba_id, phone_number_id, access_token').eq('id', businessId).maybeSingle();
  if (error) throw error;
  if (!row) return null;

  const out = { businessId: row.id, wabaId: row.waba_id, phoneNumberId: row.phone_number_id };
  if (!row.access_token) return { ...out, error: 'business has no stored access token' };

  let token;
  try {
    token = decrypt(row.access_token);
  } catch (e) {
    return { ...out, error: 'stored access token could not be decrypted' };
  }
  const [phoneNode, waba] = await Promise.all([
    row.phone_number_id ? attempt(() => diagnostics.readPhoneNode(row.phone_number_id, token)) : { ok: false, error: { message: 'no phone_number_id' } },
    row.waba_id ? attempt(() => diagnostics.readWaba(row.waba_id, token)) : { ok: false, error: { message: 'no waba_id' } }
  ]);
  return { ...out, phoneNode, waba };
};

/**
 * GET /api/super-admin/whatsapp-diagnostics[?businessId=]
 * Runs live Meta checks and returns them; stores nothing.
 */
const getDiagnostics = async (req, res, next) => {
  try {
    const businessId = req.query.businessId;

    const [subscriptions, systemUserToken] = await Promise.all([
      attempt(() => diagnostics.checkAppSubscriptions()),
      // PLATFORM_WHATSAPP_ACCESS_TOKEN is the only platform-level (system-user) token in config.
      config.PLATFORM_WHATSAPP_ACCESS_TOKEN
        ? attempt(() => diagnostics.debugToken(config.PLATFORM_WHATSAPP_ACCESS_TOKEN))
        : { ok: false, error: { message: 'PLATFORM_WHATSAPP_ACCESS_TOKEN is not set' } }
    ]);

    const report = {
      appSubscriptions: subscriptions.ok ? { ok: true, ...subscriptions.result } : subscriptions,
      systemUserToken: systemUserToken.ok ? { ok: true, ...systemUserToken.result } : systemUserToken,
      config: {
        META_APP_ID: config.META_APP_ID,
        META_CONFIG_ID: config.META_CONFIG_ID,
        GRAPH_API_VERSION: config.GRAPH_API_VERSION,
        COEXISTENCE_SYNC_ENABLED: !!config.COEXISTENCE_SYNC_ENABLED,
        ECHO_AUTO_PAUSE: !!config.ECHO_AUTO_PAUSE
      }
    };

    if (businessId) {
      const reads = await businessReads(businessId);
      if (!reads) return errorResponse(res, 404, 'Business not found');
      report.business = reads;
    }

    return successResponse(res, 200, report);
  } catch (error) {
    logger.error('Error in getDiagnostics:', { error: error.message });
    next(error);
  }
};

/**
 * GET /api/super-admin/whatsapp-connect-attempts?businessId=
 * The last connect attempts (client entries + server steps) for a business.
 */
const listConnectAttempts = async (req, res, next) => {
  try {
    const { businessId } = req.query;
    if (!businessId) return errorResponse(res, 400, 'businessId is required');
    const attempts = await diagnostics.listAttempts(businessId);
    return successResponse(res, 200, { attempts });
  } catch (error) {
    logger.error('Error in listConnectAttempts:', { error: error.message });
    next(error);
  }
};

module.exports = { getDiagnostics, listConnectAttempts };
