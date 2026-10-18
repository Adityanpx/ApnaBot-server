const crypto = require('crypto');
const supabase = require('../config/supabase');
const { invalidateRulesCache } = require('./chatbot.service');
const { prepareCarouselWrite, carouselBodyError } = require('./carouselNode.service');
const { prepareReplyMediaWrite } = require('./replyMedia.service');
const { VALID_MATCH_TYPES, validateTranslationsMap } = require('./flowGraph.service');
const { validateEdgeCopy, LIMITS } = require('../utils/textLimits');
const { MAX_CARD_BUTTONS } = require('../utils/carouselPayload');
const { toCamelCase } = require('../utils/caseConvert');

// POST /api/flow-graph/carousel-bundle: a carousel reply node + the reply nodes its card buttons open +
// the edges, created ALL-OR-NOTHING by the create_carousel_bundle RPC (one transaction). Everything is
// validated here first; nothing is written until the single RPC call at the end.

// Canvas layout (flow_nodes.position_x / position_y, the same units the web canvas stores).
const H_SPACING = 450;   // carousel -> its column of target nodes, and graph max x -> the carousel
const V_SPACING = 260;   // between target nodes in the column (gallery nodes are taller)

const ACTION_TYPES = ['gallery', 'text', 'existing'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (status, message, errors = null) => ({ error: { status, message, errors } });
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';

/** Lowercase ASCII slug of the first words of a card's text; '' when nothing ASCII is left (e.g. Hindi only). */
const slugOf = (text) => String(text || '').toLowerCase().normalize('NFKD')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').filter(Boolean).slice(0, 3).join('-').slice(0, 24);

/**
 * Validates the request and builds the rows, without writing. Returns { error } or
 * { carouselId, nodeRows, edgeRows } (snake_case rows exactly as the RPC takes them).
 */
const planBundle = async (businessId, body) => {
  if (!isObject(body)) return fail(400, 'Request body must be an object.');
  const { matchType = 'contains', hindiAliases = [], textTranslations = null, buttonsPerCard, position, cards } = body;

  if (!isText(body.keyword)) return fail(400, 'keyword is required.');
  const keyword = body.keyword.toLowerCase().trim();
  if (!VALID_MATCH_TYPES.includes(matchType)) return fail(400, `matchType must be one of: ${VALID_MATCH_TYPES.join(', ')}`);
  if (!Array.isArray(hindiAliases) || !hindiAliases.every(a => typeof a === 'string')) {
    return fail(400, 'hindiAliases must be an array of strings.');
  }
  const bodyError = carouselBodyError(body.text);
  if (bodyError) return fail(400, bodyError);
  const textTranslationsError = validateTranslationsMap(textTranslations, 'textTranslations', LIMITS.INTERACTIVE_BODY);
  if (textTranslationsError) return fail(400, textTranslationsError);
  if (buttonsPerCard !== 1 && buttonsPerCard !== 2) return fail(400, 'buttonsPerCard must be 1 or 2.');
  if (position !== undefined && position !== null
      && !(isObject(position) && Number.isFinite(position.x) && Number.isFinite(position.y))) {
    return fail(400, 'position must be { x, y } with numeric values.');
  }
  if (!Array.isArray(cards)) return fail(400, 'cards must be an array.');

  // ---- the carousel's cards: count, text limits, media ownership/type, plan card/video limits -----
  const carousel = await prepareCarouselWrite({
    businessId, existing: null, contentTypeAfter: 'carousel', replyKindAfter: 'text',
    carouselCards: cards.map(c => (isObject(c)
      ? { mediaId: c.mediaId, mediaType: c.mediaType, body: c.body, bodyTranslations: c.bodyTranslations }
      : c))
  });
  if (carousel.error) return { error: carousel.error };
  const storedCards = carousel.updates.carousel_cards;

  // ---- buttons: same count on every card, label limits, action shape ---------------------------------
  const cardButtons = [];   // [cardIdx][btnIdx] -> { label, labelTranslations, action }
  for (let i = 0; i < cards.length; i++) {
    const buttons = cards[i].buttons;
    const at = `Card ${i + 1}`;
    if (!Array.isArray(buttons) || buttons.length !== buttonsPerCard || buttonsPerCard > MAX_CARD_BUTTONS) {
      return fail(400, `${at} needs exactly ${buttonsPerCard} button${buttonsPerCard === 1 ? '' : 's'} (buttonsPerCard).`);
    }
    const list = [];
    for (let j = 0; j < buttons.length; j++) {
      const btn = buttons[j];
      const where = `${at} button ${j + 1}`;
      if (!isObject(btn)) return fail(400, `${where} must be an object.`);
      if (!isText(btn.label)) return fail(400, `${where}: label is required.`);
      const labelTranslations = btn.labelTranslations ?? null;
      const mapError = validateTranslationsMap(labelTranslations, `${where} labelTranslations`);
      if (mapError) return fail(400, mapError);
      const copyError = validateEdgeCopy({
        parentNodeType: 'reply', parentContentType: 'carousel', label: btn.label.trim(), labelTranslations
      }, null, `${where}: `);
      if (copyError) return fail(400, copyError);

      const action = btn.action;
      if (!isObject(action) || !ACTION_TYPES.includes(action.type)) {
        return fail(400, `${where}: action.type must be one of: ${ACTION_TYPES.join(', ')}.`);
      }
      if (action.type === 'existing') {
        if (typeof action.nodeId !== 'string' || !UUID_RE.test(action.nodeId)) return fail(400, `${where}: action.nodeId must be a reply node id.`);
      } else {
        if (!isText(action.text)) return fail(400, `${where}: action.text is required.`);
        const tErr = validateTranslationsMap(action.textTranslations ?? null, `${where} action.textTranslations`);
        if (tErr) return fail(400, tErr);
        if (action.type === 'gallery'
            && (!Array.isArray(action.photoMediaIds) || action.photoMediaIds.length < 1
                || !action.photoMediaIds.every(id => typeof id === 'string' && id !== ''))) {
          return fail(400, `${where}: action.photoMediaIds must list at least 1 photo from your media library.`);
        }
      }
      list.push({ label: btn.label.trim(), labelTranslations, action });
    }
    cardButtons.push(list);
  }

  // ---- gallery targets: main photo is an image of this business; extras + plan photo limit --------
  const mainPhotoIds = [...new Set(cardButtons.flat().filter(b => b.action.type === 'gallery').map(b => b.action.photoMediaIds[0]))];
  const mainPhotoById = new Map();
  if (mainPhotoIds.length > 0) {
    const { data, error } = await supabase.from('business_media').select('id, url, media_type')
      .eq('business_id', businessId).in('id', mainPhotoIds);
    if (error) throw error;
    for (const m of data || []) mainPhotoById.set(m.id, m);
  }
  const galleryPlans = new Map();   // action object -> { gallery_media_ids }
  for (let i = 0; i < cardButtons.length; i++) {
    for (let j = 0; j < cardButtons[i].length; j++) {
      const { action } = cardButtons[i][j];
      if (action.type !== 'gallery') continue;
      const where = `Card ${i + 1} button ${j + 1}`;
      const main = mainPhotoById.get(action.photoMediaIds[0]);
      if (!main) return fail(400, `${where}: photoMediaIds contains an id that is not a media library asset of this business.`);
      if (main.media_type !== 'image') return fail(400, `${where}: photoMediaIds references a ${main.media_type} asset; only photos can be used here.`);
      const media = await prepareReplyMediaWrite({
        businessId, existing: null, galleryMediaIds: action.photoMediaIds.slice(1), videoMediaId: undefined,
        mainPhotoAfter: true, mainMediaIdAfter: main.id, contentTypeAfter: 'text'
      });
      if (media.error) return { error: { ...media.error, message: `${where}: ${media.error.message}` } };
      galleryPlans.set(action, { main, gallery: media.updates.gallery_media_ids || [] });
    }
  }

  // ---- 'existing' targets must be this business's reply nodes -------------------------------------
  const existingIds = [...new Set(cardButtons.flat().filter(b => b.action.type === 'existing').map(b => b.action.nodeId))];
  if (existingIds.length > 0) {
    const { data, error } = await supabase.from('flow_nodes').select('id, node_type')
      .eq('business_id', businessId).in('id', existingIds);
    if (error) throw error;
    const byId = new Map((data || []).map(n => [n.id, n]));
    for (let i = 0; i < cardButtons.length; i++) {
      for (let j = 0; j < cardButtons[i].length; j++) {
        const { action } = cardButtons[i][j];
        if (action.type !== 'existing') continue;
        const node = byId.get(action.nodeId);
        if (!node || node.node_type !== 'reply') {
          return fail(400, `Card ${i + 1} button ${j + 1}: action.nodeId is not a reply node of this business.`);
        }
      }
    }
  }

  // ---- keywords + canvas position: one read of the business's current graph ------------------------
  const { data: graphNodes, error: graphErr } = await supabase.from('flow_nodes')
    .select('id, node_type, keyword, position_x').eq('business_id', businessId);
  if (graphErr) throw graphErr;
  const usedKeywords = new Set((graphNodes || []).filter(n => n.node_type === 'reply' && n.keyword).map(n => n.keyword));
  if (usedKeywords.has(keyword)) {
    return fail(409, `A reply node with the keyword "${keyword}" already exists. Pick a different keyword.`, { code: 'KEYWORD_EXISTS', keyword });
  }
  usedKeywords.add(keyword);
  const xs = (graphNodes || []).map(n => Number(n.position_x)).filter(Number.isFinite);
  const carouselX = position ? position.x : (xs.length > 0 ? Math.max(...xs) + H_SPACING : 0);
  const carouselY = position ? position.y : 0;

  // ---- rows ----------------------------------------------------------------------------------------
  const carouselId = crypto.randomUUID();
  const nodeRows = [{
    id: carouselId, keyword, match_type: matchType,
    hindi_aliases: hindiAliases.map(a => a.trim()).filter(Boolean),
    content_type: 'carousel', label: body.text.trim(), label_translations: textTranslations || null,
    image_url: null, media_id: null, gallery_media_ids: [], carousel_cards: storedCards,
    position_x: carouselX, position_y: carouselY
  }];
  const edgeRows = [];
  let n = 0;        // running counter over generated target nodes, used in their keywords
  let slot = 0;     // row in the column of target nodes
  for (let i = 0; i < cardButtons.length; i++) {
    const slug = slugOf(cards[i].body) || `card${i + 1}`;
    for (let j = 0; j < cardButtons[i].length; j++) {
      const { label, labelTranslations, action } = cardButtons[i][j];
      let targetId = action.nodeId;
      if (action.type !== 'existing') {
        let targetKeyword;
        do { n += 1; targetKeyword = `${keyword}-${slug}-${n}`; } while (usedKeywords.has(targetKeyword));
        usedKeywords.add(targetKeyword);
        const plan = action.type === 'gallery' ? galleryPlans.get(action) : null;
        targetId = crypto.randomUUID();
        nodeRows.push({
          id: targetId, keyword: targetKeyword, match_type: 'exact', hindi_aliases: [],
          content_type: 'text', label: action.text.trim(), label_translations: textTranslationsOrNull(action.textTranslations),
          image_url: plan ? plan.main.url : null, media_id: plan ? plan.main.id : null,
          gallery_media_ids: plan ? plan.gallery : [], carousel_cards: null,
          position_x: carouselX + H_SPACING, position_y: carouselY + slot * V_SPACING
        });
        slot += 1;
      }
      edgeRows.push({
        id: crypto.randomUUID(), from_node_id: carouselId, to_node_id: targetId, label,
        label_translations: labelTranslations || null, display_order: i * buttonsPerCard + j, card_index: i
      });
    }
  }
  return { carouselId, nodeRows, edgeRows };
};

// Only non-empty translations are kept (same rule as the reply-node routes).
const textTranslationsOrNull = (translations) => {
  const entries = Object.entries(translations || {}).map(([code, text]) => [code, text.trim()]).filter(([, text]) => text);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
};

/**
 * @param {{ businessId: string, body: Object }} args
 * @returns {Promise<{ error: { status, message, errors } } | { data: { carouselNodeId, nodes, edges } }>}
 *   nodes / edges are the created rows only (carousel first), camelCase, each exactly as GET /full lists them.
 */
const createCarouselBundle = async ({ businessId, body }) => {
  const plan = await planBundle(businessId, body);
  if (plan.error) return { error: plan.error };

  const { error: rpcError } = await supabase.rpc('create_carousel_bundle', {
    p_business_id: businessId, p_nodes: plan.nodeRows, p_edges: plan.edgeRows
  });
  if (rpcError) {
    // Raised inside the function after our pre-checks: a concurrent create won the race.
    if (rpcError.message === 'bundle_keyword_exists') {
      return fail(409, 'A reply node with one of these keywords was just created. Please try again.', { code: 'KEYWORD_EXISTS', keyword: rpcError.details || null });
    }
    if (rpcError.message === 'bundle_target_missing') {
      return fail(400, 'One of the existing reply nodes no longer exists.');
    }
    throw rpcError;
  }

  await invalidateRulesCache(businessId);

  const [nodesRes, edgesRes] = await Promise.all([
    supabase.from('flow_nodes').select('*').eq('business_id', businessId).in('id', plan.nodeRows.map(r => r.id)),
    supabase.from('flow_edges').select('*').eq('business_id', businessId).in('id', plan.edgeRows.map(r => r.id))
      .order('display_order', { ascending: true })
  ]);
  if (nodesRes.error) throw nodesRes.error;
  if (edgesRes.error) throw edgesRes.error;
  const order = new Map(plan.nodeRows.map((r, i) => [r.id, i]));
  const nodes = (nodesRes.data || []).sort((a, b) => order.get(a.id) - order.get(b.id)).map(toCamelCase);
  return { data: { carouselNodeId: plan.carouselId, nodes, edges: (edgesRes.data || []).map(toCamelCase) } };
};

module.exports = { createCarouselBundle, planBundle, slugOf, H_SPACING, V_SPACING };
