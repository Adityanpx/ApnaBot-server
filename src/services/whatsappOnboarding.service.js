const axios = require('axios');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { encrypt, decrypt } = require('../utils/crypto');
const { META_API_BASE } = require('./whatsapp.service');

// Meta's two ways a number reaches us: a fresh Cloud API number (we must
// /register it) or a number already on the WhatsApp Business app, onboarded
// alongside the app ("coexistence" - Meta registers it, we must NOT).
const ONBOARDING_TYPES = ['cloud_api', 'coexistence'];

const SYNC_WINDOW_MS = 24 * 60 * 60 * 1000; // Meta: sync within 24h of onboarding

const PHONE_NODE_FIELDS = 'display_phone_number,verified_name,name_status,code_verification_status,quality_rating,platform_type,throughput';

const isNumericId = (v) => typeof v === 'string' && /^[0-9]+$/.test(v);

const pick = (obj, ...keys) => {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return undefined;
};

/**
 * Validate and normalise the connect-whatsapp body (camelCase or snake_case).
 * @param {Object} body
 * @returns {{error:string}|{code:string, wabaId:string, phoneNumberId:string|undefined, onboardingHint:string|undefined}}
 */
const parseConnectBody = (body) => {
  const code = pick(body, 'code');
  const wabaId = pick(body, 'wabaId', 'waba_id');
  const phoneNumberId = pick(body, 'phoneNumberId', 'phone_number_id');
  const onboardingHint = pick(body, 'onboardingType', 'onboarding_type');

  if (!code || typeof code !== 'string') return { error: 'Authorization code is required' };
  if (!wabaId) return { error: 'WhatsApp Business Account ID is required' };
  if (!isNumericId(String(wabaId))) return { error: 'WhatsApp Business Account ID must be numeric' };
  if (phoneNumberId !== undefined && !isNumericId(String(phoneNumberId))) return { error: 'Phone number ID must be numeric' };
  if (onboardingHint !== undefined && !ONBOARDING_TYPES.includes(onboardingHint)) {
    return { error: `onboardingType must be one of: ${ONBOARDING_TYPES.join(', ')}` };
  }
  return {
    code,
    wabaId: String(wabaId),
    phoneNumberId: phoneNumberId === undefined ? undefined : String(phoneNumberId),
    onboardingHint
  };
};

/**
 * Which onboarding path a connect is on. Meta's phone-number node is the truth
 * (is_on_biz_app); the client's hint (from the postMessage event) is the
 * fallback; coexistence is the final default (what every connect was before).
 * @param {boolean|null|undefined} isOnBizApp - from the node; missing = unknown
 * @param {string|undefined} clientHint
 * @returns {{type:'cloud_api'|'coexistence', source:'meta'|'client'|'default'}}
 */
const deriveOnboardingType = (isOnBizApp, clientHint) => {
  if (isOnBizApp === true) return { type: 'coexistence', source: 'meta' };
  if (isOnBizApp === false) return { type: 'cloud_api', source: 'meta' };
  if (ONBOARDING_TYPES.includes(clientHint)) return { type: clientHint, source: 'client' };
  return { type: 'coexistence', source: 'default' };
};

/**
 * Only a Cloud API onboarding registers the number, and only while Meta does
 * not already report it as CLOUD_API (a repeat connect must not re-register:
 * Meta rate-limits /register to 10 per number per 72h).
 */
const shouldRegister = (type, platformType) => type === 'cloud_api' && platformType !== 'CLOUD_API';

/**
 * GET /{phone-number-id}. is_on_biz_app is not in Meta's documented field
 * list, so if Meta ever rejects it the node is re-read without it.
 * @returns {Promise<Object>} the node (is_on_biz_app absent = unknown)
 */
const fetchPhoneNode = async (phoneNumberId, accessToken) => {
  const get = (fields) => axios.get(`${META_API_BASE}/${phoneNumberId}`, {
    params: { fields },
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  try {
    return (await get(`${PHONE_NODE_FIELDS},is_on_biz_app`)).data;
  } catch (error) {
    if (error.response && error.response.status === 400) {
      logger.warn('fetchPhoneNode: is_on_biz_app rejected, re-reading without it', {
        phoneNumberId,
        error: error.response.data
      });
      return (await get(PHONE_NODE_FIELDS)).data;
    }
    throw error;
  }
};

const generatePin = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

/**
 * The 2-step-verification PIN for this business, creating (and storing,
 * encrypted) one first if needed. Stored BEFORE /register is called so a crash
 * after a successful register can never leave a number with a PIN we lost.
 * The PIN is never logged.
 * @returns {Promise<string>} the plain 6-digit PIN
 */
const ensureRegisterPin = async (businessId) => {
  const read = async () => {
    const { data, error } = await supabase
      .from('businesses').select('whatsapp_register_pin').eq('id', businessId).maybeSingle();
    if (error) throw error;
    return data ? data.whatsapp_register_pin : null;
  };

  const existing = await read();
  if (existing) return decrypt(existing);

  const pin = generatePin();
  // Only fills an empty column, so two concurrent connects can't overwrite each other's PIN.
  const { error } = await supabase
    .from('businesses').update({ whatsapp_register_pin: encrypt(pin) })
    .eq('id', businessId).is('whatsapp_register_pin', null);
  if (error) throw error;

  const stored = await read();
  return decrypt(stored);
};

/**
 * Meta's /register failure -> an HTTP status and a message the owner can act on.
 * Codes are from Meta's Cloud API error-code page.
 * @param {Error} error - axios error
 * @returns {{status:number, message:string, metaCode:number|undefined}}
 */
const mapRegisterError = (error) => {
  const meta = error && error.response && error.response.data && error.response.data.error;
  const metaCode = meta ? meta.code : undefined;
  switch (metaCode) {
    case 133005:
      return {
        status: 409, metaCode,
        message: 'This number already has two-step verification turned on with a different PIN. Turn off two-step verification for this number in WhatsApp Manager, then connect again.'
      };
    case 133008:
    case 133009:
      return { status: 429, metaCode, message: 'WhatsApp has temporarily blocked PIN attempts for this number. Wait a while, then connect again.' };
    case 133016:
      return { status: 429, metaCode, message: 'Too many registration attempts for this number in a short time (WhatsApp allows 10 every 72 hours). Try again later.' };
    case 133015:
      return { status: 409, metaCode, message: 'This number was deleted from WhatsApp recently and the deletion has not finished. Wait 5 minutes, then connect again.' };
    default: {
      const detail = meta && (meta.error_user_msg || meta.message);
      return { status: 502, metaCode, message: `WhatsApp could not register this number${detail ? `: ${detail}` : '.'}` };
    }
  }
};

/**
 * POST /{phone-number-id}/register. Throws the raw axios error; the caller maps
 * it with mapRegisterError. Never log the request (it carries the PIN).
 */
const registerNumber = async (phoneNumberId, accessToken, pin) => {
  const response = await axios.post(
    `${META_API_BASE}/${phoneNumberId}/register`,
    { messaging_product: 'whatsapp', pin },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return response.data;
};

/**
 * Which coexistence data syncs to request now. Meta allows each once, within
 * 24h of onboarding, and the data arrives by webhook - so they stay off until
 * the handlers exist (COEXISTENCE_SYNC_ENABLED).
 * @param {Object} p
 * @param {boolean} p.flagOn
 * @param {'cloud_api'|'coexistence'} p.type
 * @param {Object|null} p.existing - the business row before this connect (camelCase)
 * @param {string} p.phoneNumberId
 * @param {number} p.nowMs
 * @returns {{contacts:boolean, history:boolean, reason:string|null}}
 */
const decideSyncs = ({ flagOn, type, existing, phoneNumberId, nowMs }) => {
  const none = (reason) => ({ contacts: false, history: false, reason });
  if (type !== 'coexistence') return none('not a coexistence onboarding');
  if (!flagOn) return none('flag off');

  const samePhone = !!existing && existing.phoneNumberId === phoneNumberId;
  if (samePhone) {
    // A reconnect of the same number: only inside the original 24h window, and
    // only what was never requested.
    const connectedAt = existing.whatsappConnectedAt ? new Date(existing.whatsappConnectedAt).getTime() : null;
    if (!connectedAt) return none('reconnect with no recorded connect time');
    if (nowMs - connectedAt >= SYNC_WINDOW_MS) return none('24h window since onboarding has passed');
    return {
      contacts: !existing.coexContactsSyncRequestedAt,
      history: !existing.coexHistorySyncRequestedAt,
      reason: null
    };
  }
  return { contacts: true, history: true, reason: null };
};

/**
 * Request the contacts and history syncs. A failure of either is logged and
 * never fails the onboarding.
 * @param {{contacts:boolean, history:boolean}} which
 * @returns {Promise<{contacts:boolean, history:boolean}>} which requests Meta accepted
 */
const requestCoexistenceSyncs = async (phoneNumberId, accessToken, which) => {
  const accepted = { contacts: false, history: false };
  const post = async (syncType) => {
    const response = await axios.post(
      `${META_API_BASE}/${phoneNumberId}/smb_app_data`,
      { messaging_product: 'whatsapp', sync_type: syncType },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return response.data;
  };

  for (const [key, syncType] of [['contacts', 'smb_app_state_sync'], ['history', 'history']]) {
    if (!which[key]) continue;
    try {
      const data = await post(syncType);
      accepted[key] = true;
      logger.info(`coexistence ${syncType} sync requested`, { phoneNumberId, requestId: data && data.request_id });
    } catch (error) {
      logger.error(`coexistence ${syncType} sync request failed (onboarding continues)`, {
        phoneNumberId,
        error: error.response ? error.response.data : error.message
      });
    }
  }
  return accepted;
};

module.exports = {
  ONBOARDING_TYPES,
  SYNC_WINDOW_MS,
  parseConnectBody,
  deriveOnboardingType,
  shouldRegister,
  fetchPhoneNode,
  ensureRegisterPin,
  mapRegisterError,
  registerNumber,
  decideSyncs,
  requestCoexistenceSyncs
};
