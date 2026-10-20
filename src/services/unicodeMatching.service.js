// Effective "use the Unicode keyword matcher" flag for a business:
//   businesses.unicode_matching (true/false) wins; NULL follows app_config.unicode_matching_default.
// Read from the DB with a ~60s in-process cache (not via the 1h tenant cache) so a switch takes
// effect within a minute without any invalidation. Fails OPEN to false (legacy matching): a missing
// column, a DB error or a bad value never changes how a message is matched.
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { getBooleanSetting } = require('./appConfig.service');

const TTL_MS = 60 * 1000;
const businessCache = new Map(); // businessId -> { value: boolean|null, expiresAt }
let globalCache = null; // { value: boolean, expiresAt }

/** Pure: the business's own setting if it has one, else the global default. */
const resolveEffective = (businessValue, globalDefault) => (
  typeof businessValue === 'boolean' ? businessValue : globalDefault === true
);

const readGlobal = async () => {
  if (globalCache && globalCache.expiresAt > Date.now()) return globalCache.value;
  const value = await getBooleanSetting('unicodeMatchingDefault');
  globalCache = { value, expiresAt: Date.now() + TTL_MS };
  return value;
};

const readBusiness = async (businessId) => {
  const hit = businessCache.get(businessId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const { data, error } = await supabase.from('businesses').select('unicode_matching').eq('id', businessId).maybeSingle();
  if (error) throw error;
  const value = data && typeof data.unicode_matching === 'boolean' ? data.unicode_matching : null;
  businessCache.set(businessId, { value, expiresAt: Date.now() + TTL_MS });
  return value;
};

/** @returns {Promise<boolean>} never throws */
const isUnicodeMatchingEnabled = async (businessId) => {
  try {
    const own = await readBusiness(businessId);
    if (typeof own === 'boolean') return own;
    return resolveEffective(null, await readGlobal());
  } catch (error) {
    logger.error('Unicode matching flag read failed - using legacy matching:', error);
    businessCache.set(businessId, { value: false, expiresAt: Date.now() + TTL_MS }); // don't retry on every message
    return false;
  }
};

const clearCache = () => { businessCache.clear(); globalCache = null; };

module.exports = { isUnicodeMatchingEnabled, resolveEffective, clearCache };
