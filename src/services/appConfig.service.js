// App version gate: the app_config key/value table behind the public
// GET /api/app/version and the superadmin GET|PUT /api/admin/app-config.
//
// The public read is cached in-process for 60s (cleared on every write, so the
// instance that took the write is current at once; any other instance catches
// up within the TTL) and fails OPEN: a missing key or a DB error serves the
// defaults, so a blip can never force an update or a maintenance screen.
const supabase = require('../config/supabase');
const logger = require('../utils/logger');

const httpError = (status, message) => Object.assign(new Error(message), { statusCode: status });

const CACHE_TTL_MS = 60 * 1000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DEFAULT_STORE_URL = 'https://play.google.com/store/apps/details?id=com.averixsolutions.apnabot';

// Admin/body name -> app_config.key, type and default.
const FIELDS = {
  androidMinVersion:    { key: 'android_min_version',    type: 'version', default: '1.0.0' },
  androidLatestVersion: { key: 'android_latest_version', type: 'version', default: '1.0.0' },
  forceUpdate:          { key: 'force_update',           type: 'boolean', default: false },
  maintenanceMode:      { key: 'maintenance_mode',       type: 'boolean', default: false },
  playStoreUrl:         { key: 'play_store_url',         type: 'url',     default: DEFAULT_STORE_URL },
  // Auto-translate caps (source characters sent to Azure). Super Admin only - toPublic() below
  // never returns them, so GET /api/app/version cannot leak them.
  translateMonthlyCharCap:   { key: 'translate_monthly_char_cap',   type: 'int', default: 20000 },
  translateGlobalMonthlyCap: { key: 'translate_global_monthly_cap', type: 'int', default: 1800000 }
};
const FIELD_NAMES = Object.keys(FIELDS);

const isVersion = (v) => typeof v === 'string' && VERSION_PATTERN.test(v);
const isCount = (v) => /^\d{1,9}$/.test(String(v));
const isHttpsUrl = (v) => {
  if (typeof v !== 'string' || v.length > 2048) return false;
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
};

/** Numeric x.y.z comparison: negative if a < b, 0 if equal, positive if a > b. */
const compareVersions = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
};

// Stored text -> typed value; anything missing or malformed falls back to the default.
const parseValue = (field, raw) => {
  if (raw === undefined || raw === null) return field.default;
  if (field.type === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : field.default;
  if (field.type === 'version') return isVersion(raw) ? raw : field.default;
  if (field.type === 'int') return isCount(raw) ? Number(raw) : field.default;
  return isHttpsUrl(raw) ? raw : field.default;
};

const readRows = async () => {
  const { data, error } = await supabase.from('app_config').select('key, value, updated_at, updated_by');
  if (error) throw error;
  return data || [];
};

const effectiveValues = (rows) => {
  const byKey = new Map(rows.map(r => [r.key, r]));
  const values = {};
  for (const name of FIELD_NAMES) {
    const field = FIELDS[name];
    const row = byKey.get(field.key);
    values[name] = parseValue(field, row ? row.value : undefined);
  }
  return values;
};

const toPublic = (v) => ({
  minimumVersion: v.androidMinVersion,
  latestVersion: v.androidLatestVersion,
  forceUpdate: v.forceUpdate,
  maintenanceMode: v.maintenanceMode,
  storeUrl: v.playStoreUrl
});

const defaultsPublic = () => toPublic(effectiveValues([]));

let cache = null; // { config, expiresAt }
const clearCache = () => { cache = null; };

/** Public app-version payload. `degraded` = the DB read failed and defaults were served (not cached). */
const getPublicConfig = async () => {
  if (cache && cache.expiresAt > Date.now()) return { config: cache.config, degraded: false };
  try {
    const config = toPublic(effectiveValues(await readRows()));
    cache = { config, expiresAt: Date.now() + CACHE_TTL_MS };
    return { config, degraded: false };
  } catch (error) {
    logger.error('App version config read failed - serving defaults:', error);
    return { config: defaultsPublic(), degraded: true };
  }
};

// Display name (falling back to email) of each user id, in one query.
const loadUserNames = async (ids) => {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const { data, error } = await supabase.from('users').select('id, name, email').in('id', unique);
  if (error) throw error;
  return new Map((data || []).map(u => [u.id, u.name || u.email || null]));
};

/**
 * Superadmin view (never cached): the five values, per-key change info, and the
 * top-level updatedAt / updatedBy = the most recent change by a user across keys
 * (both null when no key has ever been changed through PUT; the seed rows have
 * no updated_by).
 */
const getAdminConfig = async () => {
  const rows = await readRows();
  const names = await loadUserNames(rows.map(r => r.updated_by));
  const byKey = new Map(rows.map(r => [r.key, r]));

  const keys = {};
  let latest = null;
  for (const name of FIELD_NAMES) {
    const row = byKey.get(FIELDS[name].key);
    keys[name] = {
      updatedAt: row ? row.updated_at : null,
      updatedBy: row && row.updated_by ? (names.get(row.updated_by) || null) : null
    };
    if (row && row.updated_by && (!latest || new Date(row.updated_at) > new Date(latest.updated_at))) latest = row;
  }

  return {
    ...effectiveValues(rows),
    updatedAt: latest ? latest.updated_at : null,
    updatedBy: latest ? (names.get(latest.updated_by) || null) : null,
    keys
  };
};

/** Validates a PUT body; returns the normalised { fieldName: value } changes or throws a 400. */
const validateChanges = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Request body must be an object');
  const names = Object.keys(body);
  if (names.length === 0) throw httpError(400, `Provide at least one of: ${FIELD_NAMES.join(', ')}`);
  const unknown = names.filter(n => !FIELDS[n]);
  if (unknown.length > 0) throw httpError(400, `Unknown field(s): ${unknown.join(', ')}. Allowed: ${FIELD_NAMES.join(', ')}`);

  const changes = {};
  for (const name of names) {
    const { type } = FIELDS[name];
    const v = body[name];
    if (type === 'version' && !isVersion(v)) throw httpError(400, `${name} must be a version like 1.2.3`);
    if (type === 'boolean' && typeof v !== 'boolean') throw httpError(400, `${name} must be true or false`);
    if (type === 'url' && !isHttpsUrl(v)) throw httpError(400, `${name} must be an https:// URL`);
    if (type === 'int' && !(Number.isInteger(v) && v >= 0 && v <= 999999999)) throw httpError(400, `${name} must be a whole number of 0 or more`);
    changes[name] = v;
  }
  return changes;
};

/**
 * Applies a partial change set as `userId`. Returns { config, changed } where
 * `changed` is { fieldName: [old, new] } for the values that actually differed
 * (unchanged values are not rewritten, so they don't count as a change).
 */
const updateConfig = async (body, userId) => {
  const changes = validateChanges(body);
  const current = effectiveValues(await readRows());
  const next = { ...current, ...changes };
  if (compareVersions(next.androidMinVersion, next.androidLatestVersion) > 0) {
    throw httpError(400, `androidMinVersion (${next.androidMinVersion}) cannot be higher than androidLatestVersion (${next.androidLatestVersion})`);
  }

  const changed = {};
  const upserts = [];
  for (const name of Object.keys(changes)) {
    if (changes[name] === current[name]) continue;
    changed[name] = [current[name], changes[name]];
    upserts.push({ key: FIELDS[name].key, value: String(changes[name]), updated_by: userId });
  }

  if (upserts.length > 0) {
    const { error } = await supabase.from('app_config').upsert(upserts, { onConflict: 'key' });
    if (error) throw error;
    clearCache();
  }
  return { config: await getAdminConfig(), changed };
};

/** Integer setting (translate caps) read straight from app_config, default when missing/malformed. Not cached: callers are per-request and rare. */
const getIntSetting = async (name) => {
  const field = FIELDS[name];
  try {
    const { data, error } = await supabase.from('app_config').select('value').eq('key', field.key).maybeSingle();
    if (error) throw error;
    return parseValue(field, data ? data.value : undefined);
  } catch (error) {
    logger.error(`app_config read of ${field.key} failed - using default:`, error);
    return field.default;
  }
};

module.exports = {
  FIELD_NAMES,
  getIntSetting,
  compareVersions,
  getPublicConfig,
  getAdminConfig,
  updateConfig,
  clearCache
};
