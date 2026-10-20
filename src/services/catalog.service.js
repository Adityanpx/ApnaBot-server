const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { getActiveSubscription } = require('./subscription.service');
const { invalidateRulesCache } = require('./chatbot.service');
const { isUnicodeMatchingEnabled } = require('./unicodeMatching.service');
const { getCarouselMaxCards } = require('../utils/replyMediaLimits');
const { hasNonAsciiLetter } = require('../utils/textNormalize');
const { buildWaMeUrl } = require('../utils/optInLink');
const { SYSTEM_MESSAGES, getSystemMessage } = require('../utils/systemMessages');
const { LIMITS } = require('../utils/textLimits');
const { shapeSettingsAuto } = require('../utils/translationSlots');
const {
  DEFAULT_SETTINGS, resolveSettings, mergeSettings, normalizeWord, nodeWords
} = require('../utils/catalogSettings');
const { MAX_ITEMS_PER_COLLECTION, MAX_ITEMS_PER_REQUEST } = require('../utils/catalogValidation');

// The Catalogue's settings, its bot node and its main-menu row. Collections and items are in
// catalogCollection.service.js; what customers receive is catalogReply.service.js.
//
// THE NODE. One flow_nodes reply row with content_type 'catalog' per business. It is a PROJECTION of the
// settings (keyword / hindi_aliases / label / label_translations), written only here through the
// upsert_catalog_node RPC, so the normal keyword matcher (Unicode rules included), the rules cache and the
// canvas's menu edges work unchanged. The settings stay the source of truth; every GET re-projects a node
// that drifted (e.g. after a snapshot restore) or was deleted.

const fail = (status, message, errors = null) => ({ error: { status, message, errors } });

const DAYS_ALLOWED = [7, 30];
const MENU_NODE_KEYWORD = 'hi';
const LABEL_FALLBACK = 80;

/** The catalogs row (snake_case) or null. */
const getCatalogRow = async (businessId) => {
  const { data, error } = await supabase.from('catalogs').select('*').eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  return data || null;
};

const getCatalogNode = async (businessId) => {
  const { data, error } = await supabase
    .from('flow_nodes').select('*').eq('business_id', businessId).eq('content_type', 'catalog').maybeSingle();
  if (error) throw error;
  return data || null;
};

/** Built-in English defaults, shown by the apps as placeholders. */
const builtInDefaults = () => ({
  text: getSystemMessage('catalogDefaultText', 'en'),
  emptyText: getSystemMessage('catalogEmptyText', 'en'),
  viewButtonLabel: getSystemMessage('catalogViewButton', 'en'),
  orderButtonLabel: getSystemMessage('catalogOrderButton', 'en'),
  showMoreLabel: getSystemMessage('catalogShowMoreButton', 'en'),
  menuLabel: getSystemMessage('catalogMenuLabel', 'en')
});

/** The node's columns for these settings (label is NOT NULL: the built-in text stands in until the owner writes one). */
const nodeProjection = (settings) => {
  const { keyword, hindiAliases } = nodeWords(settings);
  return {
    keyword,
    hindi_aliases: hindiAliases,
    label: settings.text || getSystemMessage('catalogDefaultText', 'en'),
    label_translations: settings.textTranslations || null
  };
};

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const nodeMatchesSettings = (node, settings) => {
  const wanted = nodeProjection(settings);
  return node.keyword === wanted.keyword && sameJson(node.hindi_aliases || [], wanted.hindi_aliases)
    && node.label === wanted.label && sameJson(node.label_translations, wanted.label_translations)
    && node.is_active === true && node.match_type === 'contains';
};

// ---- keyword clashes ---------------------------------------------------------------------------------

/** Active reply nodes (other than the catalogue's own) that use one of the settings' words. */
const findKeywordClashes = async (businessId, settings) => {
  const { data, error } = await supabase
    .from('flow_nodes').select('id, keyword, label, content_type, reply_kind, hindi_aliases')
    .eq('business_id', businessId).eq('node_type', 'reply').eq('is_active', true);
  if (error) throw error;
  const mine = new Set([...settings.keywords, ...settings.aliases]);
  const clashes = [];
  for (const node of data || []) {
    if (node.content_type === 'catalog') continue;
    const theirs = [node.keyword, ...(Array.isArray(node.hindi_aliases) ? node.hindi_aliases : [])]
      .filter(w => typeof w === 'string').map(normalizeWord);
    const matchedWords = [...new Set(theirs.filter(w => mine.has(w)))];
    if (matchedWords.length > 0) {
      clashes.push({
        id: node.id,
        keyword: node.keyword,
        label: String(node.label || '').slice(0, LABEL_FALLBACK),
        contentType: node.content_type,
        replyKind: node.reply_kind,
        matchedWords
      });
    }
  }
  return clashes;
};

// ---- the order action's node --------------------------------------------------------------------------

const checkOrderNode = async (businessId, action) => {
  if (!action || action.type === 'message') return null;
  const { data, error } = await supabase
    .from('flow_nodes').select('id, node_type, reply_kind').eq('id', action.nodeId).eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  if (!data || data.node_type !== 'reply' || data.reply_kind !== action.type) {
    return `orderAction.nodeId must be a ${action.type} reply node of this business.`;
  }
  return null;
};

// ---- main menu row -----------------------------------------------------------------------------------

const MENU_CAPACITY = { buttons: LIMITS.MAX_BUTTONS, list: LIMITS.MAX_LIST_ROWS };

/** { label, labelTranslations } of the menu row for these settings. */
const menuLabelFor = (settings) => {
  const builtIn = SYSTEM_MESSAGES.catalogMenuLabel;
  const defaultTranslations = Object.fromEntries(Object.entries(builtIn).filter(([lang]) => lang !== 'en'));
  return {
    label: settings.menuLabel || builtIn.en,
    labelTranslations: settings.menuLabel ? (settings.menuLabelTranslations || null) : (settings.menuLabelTranslations || defaultTranslations)
  };
};

/**
 * Brings the 'hi' menu node's row for the catalogue in line with the settings. Never throws.
 * @returns {Promise<{ status: 'NOT_REQUESTED'|'ADDED'|'IN_MENU'|'REMOVED'|'MENU_FULL'|'NO_MENU_NODE'|'ERROR', menuNodeId?: string }>}
 *   MENU_FULL: the menu already has 3 buttons / 10 rows (nothing is converted); NO_MENU_NODE: no active buttons /
 * list reply with the keyword "hi". The row exists only while the catalogue is enabled AND addToMainMenu is on.
 * A button the owner wired from the menu to the catalogue themselves (or one retargeted by a keyword replace) is
 * only ever removed when addToMainMenu WAS on (previousSettings, or `settings` itself on a plain re-sync), i.e.
 * when it may be the row this function added.
 */
const syncMenuEdge = async (businessId, catalogNodeId, settings, previousSettings = null) => {
  try {
    const { data: menuNodes, error: menuErr } = await supabase
      .from('flow_nodes').select('id, content_type, keyword')
      .eq('business_id', businessId).eq('node_type', 'reply').eq('is_active', true).eq('keyword', MENU_NODE_KEYWORD)
      .in('content_type', ['buttons', 'list']);
    if (menuErr) throw menuErr;
    const menuNode = (menuNodes || [])[0] || null;

    // Every edge into the catalogue node, from any node: removing/adding concerns only the menu node's.
    const { data: intoCatalog, error: intoErr } = await supabase
      .from('flow_edges').select('id, from_node_id, label, label_translations').eq('business_id', businessId).eq('to_node_id', catalogNodeId);
    if (intoErr) throw intoErr;
    const menuEdge = menuNode ? (intoCatalog || []).find(e => e.from_node_id === menuNode.id) : null;

    const wanted = settings.enabled && settings.addToMainMenu;
    const mayRemove = previousSettings ? !!previousSettings.addToMainMenu : !!settings.addToMainMenu;
    if (!wanted) {
      if (menuEdge && mayRemove) {
        const { error } = await supabase.from('flow_edges').delete().eq('id', menuEdge.id);
        if (error) throw error;
        return { status: 'REMOVED', menuNodeId: menuNode.id };
      }
      return { status: 'NOT_REQUESTED' };
    }
    if (!menuNode) return { status: 'NO_MENU_NODE' };

    const { label, labelTranslations } = menuLabelFor(settings);
    if (menuEdge) {
      // Translations are rewritten only when the owner set them (or the label changed): a translation the
      // flow auto-translate added to the row for a language the defaults lack is left alone.
      const translationsChanged = !!settings.menuLabelTranslations && !sameJson(menuEdge.label_translations, labelTranslations);
      if (menuEdge.label !== label || translationsChanged) {
        const { error } = await supabase.from('flow_edges').update({ label, label_translations: labelTranslations }).eq('id', menuEdge.id);
        if (error) throw error;
      }
      return { status: 'IN_MENU', menuNodeId: menuNode.id };
    }

    const { data: siblings, error: sibErr } = await supabase
      .from('flow_edges').select('id, display_order').eq('from_node_id', menuNode.id);
    if (sibErr) throw sibErr;
    if ((siblings || []).length >= MENU_CAPACITY[menuNode.content_type]) return { status: 'MENU_FULL', menuNodeId: menuNode.id };

    const nextOrder = (siblings || []).reduce((max, e) => Math.max(max, e.display_order || 0), -1) + 1;
    const { error: insertErr } = await supabase.from('flow_edges').insert({
      business_id: businessId, from_node_id: menuNode.id, to_node_id: catalogNodeId,
      label, label_translations: labelTranslations, display_order: nextOrder
    });
    if (insertErr) throw insertErr;
    return { status: 'ADDED', menuNodeId: menuNode.id };
  } catch (error) {
    logger.error('Catalogue main-menu sync failed:', { businessId, message: error.message });
    return { status: 'ERROR' };
  }
};

// ---- node + row writes -------------------------------------------------------------------------------

/** Position for a brand-new node: right of the existing graph, like the carousel builder. */
const nextNodePosition = async (businessId) => {
  const { data, error } = await supabase.from('flow_nodes').select('position_x').eq('business_id', businessId);
  if (error) throw error;
  const xs = (data || []).map(n => n.position_x).filter(x => typeof x === 'number');
  return { x: (xs.length ? Math.max(...xs) : 0) + 450, y: 0 };
};

/** Calls the RPC: create/update the node, optionally replacing clashing nodes, in one transaction. */
const writeNode = async (businessId, settings, replaceIds) => {
  const existing = await getCatalogNode(businessId);
  const position = existing ? { x: null, y: null } : await nextNodePosition(businessId);
  const { data, error } = await supabase.rpc('upsert_catalog_node', {
    p_business_id: businessId,
    p_node: { ...nodeProjection(settings), position_x: position.x, position_y: position.y },
    p_replace_ids: replaceIds
  });
  if (error) throw error;
  return data;
};

const saveRow = async (businessId, row, settings) => {
  if (row) {
    const { error } = await supabase.from('catalogs').update({ settings }).eq('id', row.id);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from('catalogs').insert({ business_id: businessId, settings });
  if (error) throw error;
};

// ---- the view ----------------------------------------------------------------------------------------

const planOf = async (businessId) => {
  const subscription = await getActiveSubscription(businessId);
  const plan = subscription && subscription.plan ? subscription.plan : null;
  return { plan, name: (plan && (plan.display_name || plan.name)) || 'Basic', carouselMaxCards: getCarouselMaxCards(plan) };
};

const collectionCounts = async (businessId, carouselMaxCards) => {
  const { data, error } = await supabase
    .from('catalog_collections').select('id, is_active, sort_order').eq('business_id', businessId);
  if (error) throw error;
  const rows = data || [];
  const active = rows.filter(c => c.is_active).length;
  return {
    total: rows.length, active, shownInCarousel: Math.min(active, carouselMaxCards),
    hiddenByPlan: Math.max(0, active - carouselMaxCards)
  };
};

const warningsFor = async (businessId, settings) => {
  const warnings = [];
  const words = [...settings.keywords, ...settings.aliases];
  if (words.some(w => hasNonAsciiLetter(w)) && !(await isUnicodeMatchingEnabled(businessId))) {
    warnings.push({
      code: 'NATIVE_KEYWORD_NEEDS_UNICODE_MATCHING',
      message: 'A keyword is in a native script (for example Hindi). Customers typing it will only be matched once native-script matching is switched on for your business.'
    });
  }
  return warnings;
};

/**
 * What GET /api/catalog and PUT /api/catalog answer. Re-projects a missing / drifted node and the menu row
 * first (the settings are the source of truth).
 */
const loadCatalogView = async (businessId, { menuResult = null, replaced = [] } = {}) => {
  let row = await getCatalogRow(businessId);
  let node = await getCatalogNode(businessId);
  const settings = resolveSettings(row ? row.settings : null);
  let menu = menuResult;

  if (row && (!node || !nodeMatchesSettings(node, settings))) {
    try {
      await writeNode(businessId, settings, []);
      await invalidateRulesCache(businessId);
      node = await getCatalogNode(businessId);
    } catch (error) {
      logger.error('Catalogue node re-projection failed:', { businessId, message: error.message });
    }
  }
  if (row && node && !menu) menu = await syncMenuEdge(businessId, node.id, settings);

  const { plan, name, carouselMaxCards } = await planOf(businessId);
  const counts = await collectionCounts(businessId, carouselMaxCards);
  return {
    exists: !!row,
    settings,
    defaults: builtInDefaults(),
    node: node ? { id: node.id, keyword: node.keyword, hindiAliases: node.hindi_aliases || [], isActive: node.is_active } : null,
    menu: menu ? { requested: settings.addToMainMenu, status: menu.status } : { requested: settings.addToMainMenu, status: 'NOT_REQUESTED' },
    plan: { name, carouselMaxCards, planKnown: !!plan },
    counts,
    limits: { maxItemsPerCollection: MAX_ITEMS_PER_COLLECTION, maxItemsPerRequest: MAX_ITEMS_PER_REQUEST, maxPhotosPerPage: 10 },
    autoTranslated: row ? shapeSettingsAuto(row) : {},
    warnings: await warningsFor(businessId, settings),
    replaced
  };
};

/**
 * PUT /api/catalog. Validates, resolves keyword clashes (409, or replaced with replaceKeywordNodes), writes the
 * node (RPC, one transaction) and the settings row, then the menu row.
 * @returns {Promise<{ view: Object } | { error: { status, message, errors } }>}
 */
const updateSettings = async (businessId, patch, { replaceKeywordNodes = false } = {}) => {
  const row = await getCatalogRow(businessId);
  const merged = mergeSettings(row ? row.settings : null, patch);
  if (merged.error) return fail(400, merged.error);
  const settings = merged.settings;

  const orderError = await checkOrderNode(businessId, settings.orderAction);
  if (orderError) return fail(400, orderError);

  const clashes = await findKeywordClashes(businessId, settings);
  if (clashes.length > 0 && !replaceKeywordNodes) {
    const words = [...new Set(clashes.flatMap(c => c.matchedWords))];
    return fail(409,
      `${words.map(w => `"${w}"`).join(', ')} ${words.length > 1 ? 'are' : 'is'} already used by another reply. Replace it, or pick a different word.`,
      { code: 'KEYWORD_EXISTS', keywords: words, nodes: clashes });
  }

  const result = await writeNode(businessId, settings, replaceKeywordNodes ? clashes.map(c => c.id) : []);
  await saveRow(businessId, row, settings);
  await invalidateRulesCache(businessId);
  const menu = await syncMenuEdge(businessId, result.nodeId, settings, resolveSettings(row ? row.settings : null));
  const replaced = (result.replaced || []).map(r => ({
    id: r.id, keyword: r.keyword, label: String(r.label || '').slice(0, LABEL_FALLBACK), retargetedEdges: r.retargetedEdges
  }));
  return { view: await loadCatalogView(businessId, { menuResult: menu, replaced }) };
};

/**
 * After something replaced the whole flow graph (snapshot restore, template import, copy setup) the catalogue
 * node and its menu row are gone: put them back from the settings. Best effort, never throws.
 */
const healAfterGraphReplace = async (businessId) => {
  try {
    const row = await getCatalogRow(businessId);
    if (!row) return;
    const settings = resolveSettings(row.settings);
    const clashes = await findKeywordClashes(businessId, settings);
    if (clashes.length > 0) {
      // Never silently take over a word the restored flow now uses: leave the catalogue unreachable by that
      // word until the owner opens the Catalogue page (which asks).
      logger.warn('Catalogue node not restored: keyword used by another reply', { businessId, words: clashes.flatMap(c => c.matchedWords) });
      return;
    }
    const result = await writeNode(businessId, settings, []);
    await invalidateRulesCache(businessId);
    await syncMenuEdge(businessId, result.nodeId, settings);
  } catch (error) {
    logger.error('Catalogue heal after graph replace failed:', { businessId, message: error.message });
  }
};

// ---- share + insights --------------------------------------------------------------------------------

/** GET /api/catalog/share: the wa.me link with the first keyword prefilled (the QR is drawn by the apps). */
const getShareInfo = async (businessId) => {
  const [row, bizRes] = await Promise.all([
    getCatalogRow(businessId),
    supabase.from('businesses').select('name, display_name, whatsapp_number').eq('id', businessId).maybeSingle()
  ]);
  if (bizRes.error) throw bizRes.error;
  const settings = resolveSettings(row ? row.settings : null);
  const keyword = settings.keywords[0] || DEFAULT_SETTINGS.keywords[0];
  const number = bizRes.data ? bizRes.data.whatsapp_number : null;
  const waLink = buildWaMeUrl(number, keyword);
  return {
    keyword,
    whatsappNumber: number ? String(number).replace(/[^0-9]/g, '') : null,
    businessName: bizRes.data ? (bizRes.data.display_name || bizRes.data.name) : null,
    waLink,
    reason: waLink ? null : 'WHATSAPP_NOT_CONNECTED',
    catalogueEnabled: !!row && settings.enabled
  };
};

const EVENT_FIELD = {
  catalogue_open: 'catalogueOpens', collection_view: 'collectionViews', designs_view: 'designsViews',
  designs_more: 'designsMore', order_collection: 'collectionOrders', order_item: 'itemOrders'
};
const emptyCounts = () => Object.fromEntries(Object.values(EVENT_FIELD).map(f => [f, 0]));

/** GET /api/catalog/insights?days=7|30 */
const getInsights = async (businessId, days) => {
  if (!DAYS_ALLOWED.includes(days)) return fail(400, `days must be one of: ${DAYS_ALLOWED.join(', ')}.`);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const [rpc, collectionsRes] = await Promise.all([
    supabase.rpc('catalog_insights', { p_business_id: businessId, p_since: since }),
    supabase.from('catalog_collections').select('id, title').eq('business_id', businessId)
  ]);
  if (rpc.error) throw rpc.error;
  if (collectionsRes.error) throw collectionsRes.error;
  const titleById = new Map((collectionsRes.data || []).map(c => [c.id, c.title]));

  const totals = emptyCounts();
  const byCollection = new Map();
  for (const r of rpc.data || []) {
    const field = EVENT_FIELD[r.event];
    if (!field) continue;
    const count = Number(r.total) || 0;
    totals[field] += count;
    if (r.collection_id) {
      const entry = byCollection.get(r.collection_id) || {
        collectionId: r.collection_id, title: titleById.get(r.collection_id) || null, ...emptyCounts()
      };
      entry[field] += count;
      byCollection.set(r.collection_id, entry);
    }
  }
  const collections = [...byCollection.values()]
    .map(c => ({ ...c, orders: c.collectionOrders + c.itemOrders }))
    .sort((a, b) => (b.orders - a.orders) || (b.designsViews - a.designsViews) || (b.collectionViews - a.collectionViews));
  return { insights: { days, since, totals: { ...totals, orders: totals.collectionOrders + totals.itemOrders }, collections } };
};

module.exports = {
  getCatalogRow, getCatalogNode, loadCatalogView, updateSettings, healAfterGraphReplace,
  syncMenuEdge, findKeywordClashes, getShareInfo, getInsights, planOf, fail,
  // exported for tests
  nodeProjection, nodeMatchesSettings, menuLabelFor
};
