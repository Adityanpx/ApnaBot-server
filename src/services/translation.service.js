// Auto-translate orchestration: global cache -> monthly caps -> Azure -> faithfulness check -> cache.
// Used by POST /api/translate, POST /api/translate/flow, the signup default-flow translation and
// the Super Admin template translation (services/flowTranslate.service.js).
//
// Cost model: a (text, language) pair that is not cached costs the English text's length in
// characters (Azure bills source characters x languages). Cache hits cost nothing. The characters
// are reserved atomically BEFORE the Azure call (reserve_translate_chars) and refunded if it fails,
// so two requests can never both slip under a cap.
const crypto = require('crypto');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { istMonthKey } = require('../utils/ist');
const { isValidLanguageCode } = require('../utils/languageCatalog');
const { protect, restore, padTerms, isFaithful } = require('../utils/translateProtect');
const azure = require('./azureTranslate.service');
const appConfig = require('./appConfig.service');
const { TranslateError } = azure;

const CACHE_LOOKUP_CHUNK = 100;
const CAP_EXCEEDED_MESSAGE = 'Monthly auto-translate limit reached, type it manually or wait until next month';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const currentMonth = () => `${istMonthKey(new Date())}-01`;

/**
 * 'owner' / 'flow': counted against the business's monthly cap (and the global one).
 * 'system': signup default-flow and Super Admin template translation - only the global counter moves.
 */
const countsForBusiness = (scope) => scope === 'owner' || scope === 'flow';

const readCache = async (hashes, langs) => {
  const found = new Map(); // `${hash}:${lang}` -> text
  for (let i = 0; i < hashes.length; i += CACHE_LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from('translation_cache').select('source_hash, target_lang, translated_text')
      .in('source_hash', hashes.slice(i, i + CACHE_LOOKUP_CHUNK)).in('target_lang', langs);
    if (error) throw error;
    for (const row of data || []) found.set(`${row.source_hash}:${row.target_lang}`, row.translated_text);
  }
  return found;
};

const writeCache = async (rows) => {
  if (rows.length === 0) return;
  const { error } = await supabase.from('translation_cache').upsert(rows, { onConflict: 'source_hash,target_lang', ignoreDuplicates: true });
  if (error) logger.error('translation_cache write failed (translations still returned):', error);
};

const reserve = async ({ businessId, chars, scope }) => {
  const [cap, globalCap] = await Promise.all([
    appConfig.getIntSetting('translateMonthlyCharCap'),
    appConfig.getIntSetting('translateGlobalMonthlyCap')
  ]);
  const { data, error } = await supabase.rpc('reserve_translate_chars', {
    p_business: businessId, p_month: currentMonth(), p_chars: chars, p_cap: cap,
    p_global_cap: globalCap, p_count_business: countsForBusiness(scope)
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || row.result === 'business_cap') {
    throw new TranslateError(429, CAP_EXCEEDED_MESSAGE, 'TRANSLATE_CAP_EXCEEDED');
  }
  if (row.result === 'global_cap') {
    logger.error('Azure translate global monthly cap reached', { globalUsed: row.global_used });
    throw new TranslateError(503, 'Auto-translate is temporarily unavailable. You can still type translations manually.', 'TRANSLATE_UNAVAILABLE');
  }
  return { used: row.business_used, cap };
};

const refund = async ({ businessId, chars, scope }) => {
  if (chars <= 0) return;
  try {
    const { error } = await supabase.rpc('refund_translate_chars', {
      p_business: businessId, p_month: currentMonth(), p_chars: chars, p_count_business: countsForBusiness(scope)
    });
    if (error) throw error;
  } catch (error) {
    logger.error('refund_translate_chars failed:', error);
  }
};

/** { used, cap, remaining } for the business this month (what the apps show next to the translate button). */
const getUsage = async (businessId) => {
  const cap = await appConfig.getIntSetting('translateMonthlyCharCap');
  const { data, error } = await supabase
    .from('translate_usage').select('chars_used').eq('business_id', businessId).eq('month', currentMonth()).maybeSingle();
  if (error) throw error;
  const used = data ? data.chars_used : 0;
  return { used, cap, remaining: Math.max(cap - used, 0) };
};

/**
 * Translates English `texts` into every language in `to`.
 * @param {Object} args
 * @param {string} args.businessId
 * @param {string[]} args.texts  English source texts (blank strings are returned as null)
 * @param {string[]} args.to     catalog codes, not 'en'
 * @param {'owner'|'flow'|'system'} args.scope
 * @param {string[]} [args.protectTerms] whole words to leave untranslated. When set the shared cache is neither
 *   read nor written: a cached translation was made without this protection, and this one must not leak into it.
 * @returns {Promise<{ translations: Object<string,(string|null)[]>, warnings: {index:number, language:string, reason:string}[],
 *   cacheHits: number, charged: number, usage: {used:number|null, cap:number}|null }>}
 *   translations[lang][i] aligns with texts[i]; null = not translated (blank, or dropped as unfaithful).
 * @throws {TranslateError} 429 cap, 503 not configured / unavailable
 */
const translateTexts = async ({ businessId, texts, to, scope, protectTerms }) => {
  const useCache = !(protectTerms && protectTerms.length);
  for (const code of to) {
    if (code === 'en' || !isValidLanguageCode(code)) throw new TranslateError(400, `Cannot translate into "${code}".`, 'TRANSLATE_BAD_LANGUAGE');
  }

  const unique = [...new Set(texts.filter((t) => typeof t === 'string' && t.trim() !== ''))];
  const hashOf = new Map(unique.map((t) => [t, sha256(t)]));
  const cache = useCache && unique.length > 0 && to.length > 0 ? await readCache([...hashOf.values()], to) : new Map();

  // What Azure still has to translate, per language.
  const missing = new Map(to.map((lang) => [lang, unique.filter((t) => !cache.has(`${hashOf.get(t)}:${lang}`))]));
  const charges = new Map([...missing].map(([lang, list]) => [lang, list.reduce((sum, t) => sum + t.length, 0)]));
  const charged = [...charges.values()].reduce((a, b) => a + b, 0);
  const cacheHits = unique.length * to.length - [...missing.values()].reduce((a, l) => a + l.length, 0);

  const failures = new Map(); // `${lang}:${text}` -> reason
  let usage = null;
  if (charged > 0) {
    azure.assertConfigured();
    usage = await reserve({ businessId, chars: charged, scope });

    let spent = 0;
    const cacheRows = [];
    try {
      for (const [lang, list] of missing) {
        if (list.length === 0) continue;
        const raw = await azure.translateHtml(list.map((source) => protect(source, { terms: protectTerms })), lang);
        list.forEach((source, i) => {
          const restored = raw[i] == null ? null : padTerms(restore(raw[i]), protectTerms);
          const problem = restored == null ? 'No translation returned.' : isFaithful(source, restored);
          if (problem) {
            failures.set(`${lang}:${source}`, problem);
            return;
          }
          cache.set(`${hashOf.get(source)}:${lang}`, restored);
          if (useCache) cacheRows.push({ source_hash: hashOf.get(source), target_lang: lang, translated_text: restored });
        });
        spent += charges.get(lang);
      }
    } catch (error) {
      await refund({ businessId, chars: charged - spent, scope });
      await writeCache(cacheRows);
      throw error;
    }
    await writeCache(cacheRows);
  }

  const warnings = [];
  const translations = {};
  for (const lang of to) {
    translations[lang] = texts.map((text, index) => {
      if (typeof text !== 'string' || text.trim() === '') return null;
      const hit = cache.get(`${hashOf.get(text)}:${lang}`);
      if (hit !== undefined) return hit;
      warnings.push({ index, language: lang, reason: failures.get(`${lang}:${text}`) || 'Not translated.' });
      return null;
    });
  }
  return { translations, warnings, cacheHits, charged, usage };
};

module.exports = { translateTexts, getUsage, countsForBusiness, CAP_EXCEEDED_MESSAGE, currentMonth, sha256 };
