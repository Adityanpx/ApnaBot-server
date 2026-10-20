// Whole-flow auto-translate: finds every customer-facing text of a business (or of a category
// template) that has no translation in one language, translates those in a single call, and
// writes them back WITHOUT touching any text that already has one (human translations are never
// overwritten). Used by POST /api/translate/flow, the signup default-flow translation and
// POST /api/admin/category-templates/:id/translate.
//
// Writes go straight to the tables (not through the canvas save RPC), and only to the translation
// JSON columns plus auto_translations - see utils/translationSlots.js for the slot model.
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const translation = require('./translation.service');
const azure = require('./azureTranslate.service');
const slotsUtil = require('../utils/translationSlots');
const { readStatus, statusSummary, isTranslating } = require('../utils/translationStatus');

const { nodeSlots, edgeSlots, businessSlots, isMissing, markAuto, clone } = slotsUtil;

const NODE_COLUMNS = ['label_translations', 'button_text_translations', 'form_title_translations', 'carousel_cards', 'options', 'auto_translations'];
const EDGE_COLUMNS = ['label_translations', 'description_translations', 'auto_translations'];
const BUSINESS_COLUMNS = [
  'welcome_message_translations', 'stop_message_translations', 'start_message_translations',
  'cancel_message_translations', 'flow_fields', 'auto_translations'
];
const WRITE_CHUNK = 10;

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Fills the missing `lang` slots of `entries` ([{ row, slots }]) in one translation call.
 * Mutates the rows (translation JSON + auto_translations only).
 * @returns {Promise<{ filled:number, alreadyHad:number, skipped:{slot:string, reason:string}[], warnings:Object[], usage:Object|null, charged:number }>}
 */
const fillSlots = async ({ businessId, entries, lang, scope }) => {
  const todo = [];
  let alreadyHad = 0;
  for (const entry of entries) {
    for (const slot of entry.slots) {
      if (isMissing(slot, lang)) todo.push({ entry, slot }); else alreadyHad += 1;
    }
  }
  if (todo.length === 0) return { filled: 0, alreadyHad, skipped: [], warnings: [], usage: null, charged: 0 };

  const result = await translation.translateTexts({ businessId, texts: todo.map((t) => t.slot.source), to: [lang], scope });
  const translated = result.translations[lang];
  const reasonByIndex = new Map(result.warnings.map((w) => [w.index, w.reason]));

  let filled = 0;
  const skipped = [];
  todo.forEach(({ entry, slot }, i) => {
    const text = translated[i];
    if (text == null) {
      skipped.push({ slot: slot.id, reason: reasonByIndex.get(i) || 'Not translated.' });
      return;
    }
    // A button / row title over WhatsApp's limit would be cut mid-word at send time: keep English instead.
    if (slot.max != null && text.trim().length > slot.max) {
      skipped.push({ slot: slot.id, reason: `Translation is ${text.trim().length} characters, over the ${slot.max} limit.` });
      return;
    }
    slot.set(lang, text);
    markAuto(entry.row, slot.id, lang, text);
    filled += 1;
  });
  return { filled, alreadyHad, skipped, warnings: result.warnings, usage: result.usage, charged: result.charged };
};

const buildGraphEntries = (nodes, edges) => {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  return [
    ...nodes.map((row) => ({ kind: 'node', row, slots: nodeSlots(row) })),
    ...edges.map((row) => ({ kind: 'edge', row, slots: edgeSlots(row, nodeById.get(row.from_node_id)) }))
  ];
};

const writeInChunks = async (jobs) => {
  for (let i = 0; i < jobs.length; i += WRITE_CHUNK) {
    const results = await Promise.all(jobs.slice(i, i + WRITE_CHUNK).map((job) => job()));
    for (const { error } of results) if (error) throw error;
  }
};

const patchOf = (original, updated, columns) => {
  const patch = {};
  for (const column of columns) if (!same(original[column], updated[column])) patch[column] = updated[column] ?? null;
  return patch;
};

const setStatus = async (businessId, lang, status) => {
  try {
    const { data, error } = await supabase.from('businesses').select('translation_status').eq('id', businessId).maybeSingle();
    if (error) throw error;
    const next = { ...readStatus(data), [lang]: { status, at: new Date().toISOString() } };
    const { error: writeErr } = await supabase.from('businesses').update({ translation_status: next }).eq('id', businessId);
    if (writeErr) throw writeErr;
  } catch (error) {
    logger.error('translation_status write failed:', error);
  }
};

/**
 * Translates the business's whole flow into `lang`: node / edge / option texts, carousel cards,
 * the welcome / stop / start / cancel messages and the booking form (flow_fields).
 * @param {Object} args
 * @param {string} args.businessId
 * @param {string} args.lang catalog code, not 'en'
 * @param {'flow'|'system'} args.scope 'flow' = the owner asked (counts against their monthly cap);
 *   'system' = the signup run (global counter only, and translation_status is kept for the canvas)
 * @returns {Promise<{ language:string, translated:number, alreadyTranslated:number, skipped:Object[], warnings:Object[], charged:number, usage:Object|null }>}
 */
const translateBusinessFlow = async ({ businessId, lang, scope }) => {
  // The status is for the background (signup) run, which the canvas has to wait out; an owner's own
  // request is synchronous and answers when it is done.
  const track = scope === 'system';
  if (track) await setStatus(businessId, lang, 'pending');
  try {
    const [nodesRes, edgesRes, businessRes] = await Promise.all([
      supabase.from('flow_nodes').select('*').eq('business_id', businessId),
      supabase.from('flow_edges').select('*').eq('business_id', businessId),
      supabase.from('businesses').select('welcome_message, welcome_message_translations, stop_message, stop_message_translations, start_message, start_message_translations, cancel_message, cancel_message_translations, flow_fields, auto_translations').eq('id', businessId).single()
    ]);
    for (const res of [nodesRes, edgesRes, businessRes]) if (res.error) throw res.error;

    const originalNodes = nodesRes.data || [];
    const originalEdges = edgesRes.data || [];
    const originalBusiness = businessRes.data;
    const nodes = clone(originalNodes);
    const edges = clone(originalEdges);
    const business = clone(originalBusiness);

    const entries = [
      ...buildGraphEntries(nodes, edges),
      { kind: 'business', row: business, slots: businessSlots(business) }
    ];
    const summary = await fillSlots({ businessId, entries, lang, scope });

    const jobs = [];
    entries.forEach((entry) => {
      const original = entry.kind === 'node' ? originalNodes.find((n) => n.id === entry.row.id)
        : entry.kind === 'edge' ? originalEdges.find((e) => e.id === entry.row.id) : originalBusiness;
      const columns = entry.kind === 'node' ? NODE_COLUMNS : entry.kind === 'edge' ? EDGE_COLUMNS : BUSINESS_COLUMNS;
      const patch = patchOf(original, entry.row, columns);
      if (Object.keys(patch).length === 0) return;
      const table = entry.kind === 'node' ? 'flow_nodes' : entry.kind === 'edge' ? 'flow_edges' : 'businesses';
      const id = entry.kind === 'business' ? businessId : entry.row.id;
      jobs.push(() => supabase.from(table).update(patch).eq('id', id));
    });
    await writeInChunks(jobs);
    // Required here, not at the top: chatbot.service opens the Redis connection on load, which the
    // controllers that merely import this module (and their tests) must not trigger.
    if (jobs.length > 0) await require('./chatbot.service').invalidateRulesCache(businessId);

    if (track) await setStatus(businessId, lang, 'done');
    return {
      language: lang, translated: summary.filled, alreadyTranslated: summary.alreadyHad,
      skipped: summary.skipped, warnings: summary.warnings, charged: summary.charged, usage: summary.usage
    };
  } catch (error) {
    if (track) await setStatus(businessId, lang, 'failed');
    throw error;
  }
};

/**
 * Super Admin: fills `lang` on a category template's stored nodes / edges (flow_snapshots row with
 * is_category_template = true), so businesses created from it arrive translated with no API call.
 * Never counted against any business cap (global counter only).
 */
const translateTemplate = async ({ template, lang }) => {
  const nodes = clone(template.nodes || []);
  const edges = clone(template.edges || []);
  const summary = await fillSlots({ businessId: null, entries: buildGraphEntries(nodes, edges), lang, scope: 'system' });
  if (summary.filled > 0) {
    const { error } = await supabase.from('flow_snapshots').update({ nodes, edges }).eq('id', template.id).eq('is_category_template', true);
    if (error) throw error;
  }
  return {
    language: lang, translated: summary.filled, alreadyTranslated: summary.alreadyHad,
    skipped: summary.skipped, warnings: summary.warnings, charged: summary.charged
  };
};

/**
 * Signup: translate a new business's freshly copied default flow into each enabled language the
 * template did not already have (a language the template covers finishes instantly: nothing is
 * missing). Marks every language 'pending' BEFORE returning - so the canvas sees "translating"
 * from its first load - then does the work in the background; the returned promise settles as soon
 * as the marks are written and never rejects. Does nothing (English fallback at send time) when
 * Azure is not configured. `done` resolves when the background work has finished (tests await it).
 * @returns {Promise<{ started:boolean, done:Promise<Object> }>}
 */
const startNewBusinessTranslation = async (businessId) => {
  const idle = { started: false, done: Promise.resolve({}) };
  try {
    if (!azure.isConfigured()) return idle;
    const { data: business, error } = await supabase.from('businesses').select('enabled_languages').eq('id', businessId).maybeSingle();
    if (error) throw error;
    const languages = ((business && business.enabled_languages) || []).filter((code) => code !== 'en');
    if (languages.length === 0) return idle;
    for (const lang of languages) await setStatus(businessId, lang, 'pending');

    const done = (async () => {
      const results = {};
      for (const lang of languages) {
        try {
          results[lang] = await translateBusinessFlow({ businessId, lang, scope: 'system' });
        } catch (langError) {
          logger.error('Signup default-flow translation failed', { businessId, lang, error: langError.message });
          results[lang] = { error: langError.message };
        }
      }
      return results;
    })();
    return { started: true, done };
  } catch (error) {
    logger.error('Signup default-flow translation could not start', { businessId, error: error.message });
    return idle;
  }
};

module.exports = {
  fillSlots, translateBusinessFlow, translateTemplate, startNewBusinessTranslation,
  statusSummary, isTranslating, setStatus
};
