const axios = require('axios');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const config = require('../config/env');
const { META_API_BASE } = require('./whatsapp.service');

// WhatsApp connection diagnostics: the whatsapp_connect_attempts table (one row per
// connect attempt: what the client saw + what the server did) and the Meta reads the
// Super Admin diagnostics page runs.
//
// NEVER log or store: access tokens, the exchanged code, the app secret, the
// encryption key, the system-user token. IDs and field names only. Every Graph
// call here sends its token in the Authorization header, and failures are recorded
// from the response body - never from error.config (which carries the token / PIN).

const MAX_ENTRIES = 100;
const MAX_ENTRY_BYTES = 4096;
const ATTEMPTS_KEPT = 50;
// A client log is attached to the server's attempt row when that row is this fresh.
const CLIENT_LOG_MATCH_WINDOW_MS = 10 * 60 * 1000;

// Compared lower-cased with '_' / '-' removed, so access_token, accessToken and
// Access-Token are all caught.
const FORBIDDEN_KEYS = new Set(['code', 'token', 'accesstoken', 'secret', 'clientsecret', 'appsecret', 'authorization']);

const PHONE_NODE_DIAG_FIELDS = 'is_on_biz_app,platform_type,status,code_verification_status,name_status,quality_rating,display_phone_number';
const WABA_DIAG_FIELDS = 'id,name,account_review_status,business_verification_status';

// The app-level webhook fields coexistence needs.
const REQUIRED_WEBHOOK_FIELDS = ['messages', 'account_update', 'history', 'smb_app_state_sync', 'smb_message_echoes'];

const isForbiddenKey = (key) => FORBIDDEN_KEYS.has(String(key).toLowerCase().replace(/[-_]/g, ''));

// A secret pasted into a string value (a URL the client logged, say).
const redactString = (s) => s.replace(/([?&](?:code|access_token|token|client_secret)=)[^&\s"']+/gi, '$1[redacted]');

const stripSecrets = (value, depth = 0) => {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[too deep]';
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isForbiddenKey(k)) continue;
    out[k] = stripSecrets(v, depth + 1);
  }
  return out;
};

/**
 * Validate and clean what the client posts: at most 100 entries, each at most 4 KB
 * once serialised (an oversized one is replaced by a marker with a short preview),
 * with secret-named keys removed at any depth.
 * @returns {{error:string}|{entries:Array, outcome:string|null}}
 */
const sanitizeClientLog = (body) => {
  const entries = body && body.entries;
  if (!Array.isArray(entries)) return { error: 'entries must be an array' };
  const outcome = body.outcome;
  if (outcome !== undefined && outcome !== null && typeof outcome !== 'string') return { error: 'outcome must be a string' };

  const cleaned = entries.slice(0, MAX_ENTRIES).map((entry) => {
    const stripped = stripSecrets(entry);
    const json = JSON.stringify(stripped);
    const bytes = Buffer.byteLength(json === undefined ? '' : json);
    if (bytes <= MAX_ENTRY_BYTES) return stripped === undefined ? null : stripped;
    return { truncated: true, originalBytes: bytes, preview: json.slice(0, 1000) };
  });
  return { entries: cleaned, outcome: outcome ? redactString(outcome).slice(0, 100) : null };
};

const metaErrorOf = (error) => {
  const meta = error && error.response && error.response.data && error.response.data.error;
  return {
    httpStatus: error && error.response ? error.response.status : undefined,
    message: String((meta && meta.message) || (error && error.message) || 'unknown error').slice(0, 300),
    code: meta ? meta.code : undefined,
    errorSubcode: meta ? meta.error_subcode : undefined,
    fbtraceId: meta ? meta.fbtrace_id : undefined
  };
};

const pruneAttempts = async (businessId) => {
  const { data, error } = await supabase
    .from('whatsapp_connect_attempts').select('id')
    .eq('business_id', businessId).order('created_at', { ascending: false }).range(ATTEMPTS_KEPT, ATTEMPTS_KEPT + 500);
  if (error) throw error;
  if (data && data.length) {
    const { error: delError } = await supabase.from('whatsapp_connect_attempts').delete().in('id', data.map((r) => r.id));
    if (delError) throw delError;
  }
};

const insertAttempt = async (businessId, userId, fields) => {
  const { data, error } = await supabase
    .from('whatsapp_connect_attempts')
    .insert({
      business_id: businessId,
      user_id: userId || null,
      config_id: config.META_CONFIG_ID || null,
      app_id: config.META_APP_ID || null,
      ...fields
    })
    .select('id').single();
  if (error) throw error;
  try { await pruneAttempts(businessId); } catch (e) { logger.error('whatsapp_connect_attempts: prune failed', { businessId, error: e.message }); }
  return data.id;
};

/**
 * The server's record of one connect-whatsapp request. Steps are kept in a local
 * array, logged as one structured line each, and written to the attempt row
 * (created at request start, updated by finish()). Nothing here ever throws.
 */
const createConnectTrace = ({ businessId, userId }) => {
  const steps = [];
  let attemptId = null;
  let ready = null;
  let finished = false;

  const step = (name, data = {}, level = 'info') => {
    const row = { at: new Date().toISOString(), step: name, ...data };
    steps.push(row);
    try { logger[level]('whatsapp_connect_step', { businessId, ...row }); } catch (e) { /* logging never breaks a connect */ }
  };

  // A failed Graph call: method, path (no query), HTTP status, message, code, subcode, fbtrace_id.
  const fail = (name, method, path, error) => {
    step(name, { ok: false, method, path, ...metaErrorOf(error) }, 'error');
  };

  const begin = () => {
    ready = insertAttempt(businessId, userId, { outcome: 'started' })
      .then((id) => { attemptId = id; })
      .catch((e) => { logger.error('whatsapp_connect_attempts: could not create the attempt row', { businessId, error: e.message }); });
    return ready;
  };

  const finish = async (outcome) => {
    if (finished) return;
    finished = true;
    step('finished', { outcome });
    try {
      if (ready) await ready;
      if (attemptId) {
        const { error } = await supabase
          .from('whatsapp_connect_attempts').update({ outcome, server_steps: steps }).eq('id', attemptId);
        if (error) throw error;
      } else {
        await insertAttempt(businessId, userId, { outcome, server_steps: steps });
      }
    } catch (e) {
      logger.error('whatsapp_connect_attempts: could not save the server steps', { businessId, error: e.message });
    }
  };

  return { step, fail, begin, finish, steps };
};

/**
 * Store what the client logged. Attaches to the server's attempt row for the same
 * business when it is fresh and has no client entries yet; otherwise (the client
 * failed before it ever called connect-whatsapp) inserts a row of its own.
 * @returns {Promise<string>} the attempt id
 */
const recordClientLog = async ({ businessId, userId, entries, outcome }) => {
  const stored = outcome ? [...entries, { kind: 'client_outcome', outcome }] : entries;
  const since = new Date(Date.now() - CLIENT_LOG_MATCH_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from('whatsapp_connect_attempts').select('id, entries')
    .eq('business_id', businessId).gte('created_at', since)
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw error;

  const row = data && data[0];
  if (row && Array.isArray(row.entries) && row.entries.length === 0) {
    const { error: updateError } = await supabase
      .from('whatsapp_connect_attempts').update({ entries: stored }).eq('id', row.id);
    if (updateError) throw updateError;
    return row.id;
  }
  return insertAttempt(businessId, userId, { entries: stored, outcome: outcome || 'client_only' });
};

const listAttempts = async (businessId, limit = ATTEMPTS_KEPT) => {
  const { data, error } = await supabase
    .from('whatsapp_connect_attempts').select('*')
    .eq('business_id', businessId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
};

// --- Meta reads --------------------------------------------------------------

const appAccessToken = () => `${config.META_APP_ID}|${config.META_APP_SECRET}`;

/**
 * GET /debug_token for `inputToken`, authorised with the app access token.
 * Returns only app, type, validity, expiry and scopes - never a token.
 */
const debugToken = async (inputToken) => {
  const response = await axios.get(`${META_API_BASE}/debug_token`, {
    params: { input_token: inputToken },
    headers: { Authorization: `Bearer ${appAccessToken()}` }
  });
  const d = (response.data && response.data.data) || {};
  return {
    appId: d.app_id,
    type: d.type,
    isValid: d.is_valid,
    expiresAt: d.expires_at,
    scopes: d.scopes || [],
    granularScopes: (d.granular_scopes || []).map((g) => ({ scope: g.scope, targetIds: g.target_ids || [] }))
  };
};

/**
 * GET /{phone-number-id} with the diagnostic field list; every returned field is
 * kept. is_on_biz_app is undocumented, so a 400 re-reads without it.
 * @param {Function} [onFail] - called with the axios error of a rejected first read
 */
const readPhoneNode = async (phoneNumberId, accessToken, onFail) => {
  const get = (fields) => axios.get(`${META_API_BASE}/${phoneNumberId}`, {
    params: { fields },
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  try {
    return (await get(PHONE_NODE_DIAG_FIELDS)).data;
  } catch (error) {
    if (error.response && error.response.status === 400) {
      if (onFail) onFail(error);
      return (await get(PHONE_NODE_DIAG_FIELDS.replace('is_on_biz_app,', ''))).data;
    }
    throw error;
  }
};

const readWaba = async (wabaId, accessToken) => (await axios.get(`${META_API_BASE}/${wabaId}`, {
  params: { fields: WABA_DIAG_FIELDS },
  headers: { Authorization: `Bearer ${accessToken}` }
})).data;

// Runs a Graph read, recording its result (or its failure) as a trace step. Never throws.
const tracedRead = async (trace, name, method, path, fn) => {
  try {
    const result = await fn();
    return { ok: true, result };
  } catch (error) {
    trace.fail(name, method, path, error);
    return { ok: false, error };
  }
};

/** debug_token step of a connect. Returns what it read (null on failure) for the WABA resolver. */
const traceDebugToken = async (trace, accessToken) => {
  const out = await tracedRead(trace, 'debug_token', 'GET', '/debug_token', () => debugToken(accessToken));
  if (out.ok) trace.step('debug_token', { ok: true, ...out.result });
  return out.ok ? out.result : null;
};

/** Phone node + WABA reads of a connect (steps phone_node and waba). */
const traceNodeReads = async (trace, { accessToken, wabaId, phoneNumberId }) => {
  const phonePath = `/${phoneNumberId}`;
  const wabaPath = `/${wabaId}`;
  const [phone, waba] = await Promise.all([
    tracedRead(trace, 'phone_node', 'GET', phonePath, () => readPhoneNode(
      phoneNumberId, accessToken, (error) => trace.fail('phone_node_first_read', 'GET', phonePath, error)
    )),
    tracedRead(trace, 'waba', 'GET', wabaPath, () => readWaba(wabaId, accessToken))
  ]);
  if (phone.ok) trace.step('phone_node', { ok: true, phoneNumberId, fields: phone.result });
  if (waba.ok) trace.step('waba', { ok: true, wabaId, fields: waba.result });
};

/**
 * Super Admin check of the app's webhook subscription: which fields the app is
 * subscribed to for whatsapp_business_account, with pass/fail per required field.
 */
const checkAppSubscriptions = async () => {
  const response = await axios.get(`${META_API_BASE}/${config.META_APP_ID}/subscriptions`, {
    headers: { Authorization: `Bearer ${appAccessToken()}` }
  });
  const list = (response.data && response.data.data) || [];
  const waba = list.find((s) => s.object === 'whatsapp_business_account');
  const subscribed = waba ? (waba.fields || []).map((f) => f.name) : [];
  return {
    objectSubscribed: !!waba,
    active: waba ? waba.active : undefined,
    subscribedFields: subscribed,
    required: REQUIRED_WEBHOOK_FIELDS.map((field) => ({ field, status: subscribed.includes(field) ? 'pass' : 'fail' })),
    allRequiredPass: REQUIRED_WEBHOOK_FIELDS.every((f) => subscribed.includes(f))
  };
};

module.exports = {
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  ATTEMPTS_KEPT,
  REQUIRED_WEBHOOK_FIELDS,
  sanitizeClientLog,
  stripSecrets,
  metaErrorOf,
  createConnectTrace,
  recordClientLog,
  listAttempts,
  debugToken,
  readPhoneNode,
  readWaba,
  traceDebugToken,
  traceNodeReads,
  checkAppSubscriptions
};
