const supabase = require('../config/supabase');
const { getActiveSubscription } = require('./subscription.service');
const { getReplyMediaLimits, getCarouselMaxCards } = require('../utils/replyMediaLimits');
const { isValidLanguageCode } = require('../utils/languageCatalog');
const { LIMITS, textLength } = require('../utils/textLimits');

const INTERACTIVE_BODY_MAX = LIMITS.INTERACTIVE_BODY;
const {
  CARD_BODY_MAX, CARD_BODY_MAX_LINE_BREAKS, MAX_CARD_BUTTONS, MIN_CARDS, MAX_CARDS, CARD_MEDIA_TYPES, cardsOf
} = require('../utils/carouselPayload');

// Write-path rules for a reply node with content_type 'carousel' (flow_nodes.carousel_cards, and the
// card_index of the edges leaving it). Wired into flowGraph.controller.js (single-node routes) and
// flowGraph.service.js#saveFullGraph (canvas batch save). Messages are shown to the owner as-is.
//
// A stored card is { media_id, media_type, body, body_translations }. The request may use camelCase
// (mediaId, mediaType, bodyTranslations) or the stored snake_case; both are stored as snake_case.

const fail = (status, message, errors = null) => ({ error: { status, message, errors } });

const lineBreaks = (text) => (String(text).match(/\n/g) || []).length;

/** Error text for a card body / translation that breaks Meta's card text limits, or null. */
const cardTextError = (text, where) => {
  if (typeof text !== 'string') return `${where} must be a string.`;
  if (textLength(text) > CARD_BODY_MAX) return `${where} must be ${CARD_BODY_MAX} characters or less.`;
  if (lineBreaks(text.trim()) > CARD_BODY_MAX_LINE_BREAKS) return `${where} can have at most ${CARD_BODY_MAX_LINE_BREAKS} line breaks.`;
  return null;
};

/**
 * Shape-checks the request value and returns the cards in stored form.
 * @returns {{ cards: Object[] } | { error: string }}
 */
const normalizeCards = (raw) => {
  if (!Array.isArray(raw)) return { error: 'carouselCards must be an array of cards.' };
  const cards = [];
  for (let i = 0; i < raw.length; i++) {
    const card = raw[i];
    const at = `Card ${i + 1}`;
    if (!card || typeof card !== 'object' || Array.isArray(card)) return { error: `${at} must be an object.` };

    const mediaId = card.mediaId !== undefined ? card.mediaId : card.media_id;
    if (mediaId !== null && mediaId !== undefined && (typeof mediaId !== 'string' || mediaId === '')) {
      return { error: `${at}: mediaId must be a media library id.` };
    }
    const mediaType = (card.mediaType !== undefined ? card.mediaType : card.media_type) || 'image';
    if (!CARD_MEDIA_TYPES.includes(mediaType)) return { error: `${at}: mediaType must be one of: ${CARD_MEDIA_TYPES.join(', ')}.` };

    const body = card.body === undefined || card.body === null ? '' : card.body;
    const bodyError = cardTextError(body, `${at} text`);
    if (bodyError) return { error: bodyError };

    const translations = card.bodyTranslations !== undefined ? card.bodyTranslations : card.body_translations;
    let cleanTranslations = null;
    if (translations !== null && translations !== undefined) {
      if (typeof translations !== 'object' || Array.isArray(translations)) return { error: `${at}: bodyTranslations must be an object.` };
      cleanTranslations = {};
      for (const [code, text] of Object.entries(translations)) {
        if (!isValidLanguageCode(code)) return { error: `${at}: bodyTranslations has an invalid language code "${code}".` };
        const err = cardTextError(text, `${at} text for language "${code}"`);
        if (err) return { error: err };
        if (text.trim()) cleanTranslations[code] = text.trim();
      }
      if (Object.keys(cleanTranslations).length === 0) cleanTranslations = null;
    }

    cards.push({ media_id: mediaId || null, media_type: mediaType, body: body.trim(), body_translations: cleanTranslations });
  }
  return { cards };
};

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Validates and plans the carousel part of a reply-node create or update.
 *
 * @param {Object} args
 * @param {string} args.businessId
 * @param {Object|null} args.existing       the current flow_nodes row (snake_case), null on create
 * @param {*} args.carouselCards            request value; undefined = untouched, null = clear
 * @param {string} args.contentTypeAfter    the node's content_type after this write
 * @param {string} args.replyKindAfter      the node's reply_kind after this write
 * @param {boolean} [args.hasExtraMedia]    the node will carry gallery photos / a video after this write
 * @returns {Promise<{ updates: Object, error: null } | { error: { status, message, errors } }>}
 *   updates is { carousel_cards } or empty (untouched). Cards the request leaves exactly as stored are not
 *   re-validated (a client may echo the whole node back, e.g. cards cloned without media).
 */
const prepareCarouselWrite = async ({ businessId, existing, carouselCards, contentTypeAfter, replyKindAfter, hasExtraMedia = false }) => {
  const touched = carouselCards !== undefined;
  const existingCards = existing && Array.isArray(existing.carousel_cards) ? existing.carousel_cards : null;
  const isCarouselAfter = contentTypeAfter === 'carousel';
  const wasCarousel = !!existing && existing.content_type === 'carousel';

  // Not (or no longer) a carousel: cards may only be cleared, and are cleared along with the type.
  if (!isCarouselAfter) {
    if (touched && carouselCards !== null && !(Array.isArray(carouselCards) && carouselCards.length === 0)) {
      return fail(400, 'carouselCards only apply to a carousel reply (contentType "carousel").');
    }
    return { updates: existingCards || touched ? { carousel_cards: null } : {}, error: null };
  }

  if (replyKindAfter !== 'text') {
    return fail(400, 'A carousel reply must have replyKind "text".');
  }
  if (hasExtraMedia) {
    return fail(400, 'A carousel reply cannot carry extra photos or a video; the cards hold the media.');
  }
  // Switching to carousel without supplying cards is not valid; an untouched, already-carousel node is left alone.
  if (!touched && wasCarousel) return { updates: {}, error: null };

  const normalized = normalizeCards(touched && carouselCards !== null ? carouselCards : []);
  if (normalized.error) return fail(400, normalized.error);
  const cards = normalized.cards;

  if (touched && existingCards && sameJson(cards, existingCards.map(storedForm))) {
    return { updates: {}, error: null };
  }

  if (cards.length < MIN_CARDS) return fail(400, `A carousel needs at least ${MIN_CARDS} cards.`);
  if (cards.length > MAX_CARDS) return fail(400, `A carousel can have at most ${MAX_CARDS} cards.`);

  // ---- every card has media: a media library row of this business with the right type ----------
  const missing = cards.findIndex(c => !c.media_id);
  if (missing !== -1) return fail(400, `Card ${missing + 1} needs a photo or video from your media library.`);

  const ids = [...new Set(cards.map(c => c.media_id))];
  const { data: rows, error } = await supabase
    .from('business_media').select('id, media_type').eq('business_id', businessId).in('id', ids);
  if (error) throw error;
  const byId = new Map((rows || []).map(r => [r.id, r]));
  for (let i = 0; i < cards.length; i++) {
    const media = byId.get(cards[i].media_id);
    if (!media) return fail(400, `Card ${i + 1}: mediaId is not a media library asset of this business.`);
    if (media.media_type !== cards[i].media_type) {
      return fail(400, `Card ${i + 1}: that file is a ${media.media_type}, not a ${cards[i].media_type}. Only photos and videos can be used.`);
    }
  }

  // ---- plan limits: only when the write INCREASES what the carousel carries --------------------
  // (an owner who downgraded must still be able to edit text, swap or remove cards)
  const before = existingCards || [];
  const cardIncrease = cards.length > before.length;
  const beforeVideoIds = new Set(before.filter(c => c && c.media_type === 'video').map(c => c.media_id));
  const newVideo = cards.some(c => c.media_type === 'video' && !beforeVideoIds.has(c.media_id));
  if (cardIncrease || newVideo) {
    const subscription = await getActiveSubscription(businessId);
    const plan = subscription && subscription.plan ? subscription.plan : null;
    const planName = (plan && (plan.display_name || plan.name)) || 'Basic';
    const maxCards = getCarouselMaxCards(plan);
    if (cardIncrease && cards.length > maxCards) {
      return fail(403, `Your ${planName} plan allows up to ${maxCards} cards per carousel.`,
        { code: 'PLAN_LIMIT_CAROUSEL_CARDS', limit: maxCards, plan: planName });
    }
    if (newVideo && !getReplyMediaLimits(plan).videoAllowed) {
      return fail(403, 'Video cards are not available on your plan.', { code: 'PLAN_LIMIT_VIDEO', limit: 0, plan: planName });
    }
  }

  return { updates: { carousel_cards: cards }, error: null };
};

/** A carousel's main message is required and at most 1024 characters (Meta's carousel body limit). */
const carouselBodyError = (label) => {
  if (!label || !String(label).trim()) return 'A carousel needs a message (the text shown above the cards).';
  if (textLength(label) > INTERACTIVE_BODY_MAX) return `The carousel message must be ${INTERACTIVE_BODY_MAX} characters or less.`;
  return null;
};

const storedForm = (c) => ({
  media_id: (c && (c.media_id ?? c.mediaId)) || null,
  media_type: (c && (c.media_type ?? c.mediaType)) || 'image',
  body: (c && c.body) || '',
  body_translations: (c && (c.body_translations ?? c.bodyTranslations)) || null
});

/**
 * Whole-carousel check: every card has the same number (1 or 2) of quick-reply buttons, and every edge
 * leaving the node belongs to a real card. Used by the canvas batch save, where the end state is known.
 * @param {number} cardCount
 * @param {Array<{ cardIndex: number|null|undefined }>} edges  the edges leaving the carousel node
 * @returns {string|null}
 */
const carouselParityError = (cardCount, edges) => {
  const counts = new Array(cardCount).fill(0);
  for (const edge of edges) {
    const idx = edge.cardIndex;
    if (!Number.isInteger(idx) || idx < 0 || idx >= cardCount) {
      return `A carousel button must belong to one of its ${cardCount} cards (cardIndex 0 to ${cardCount - 1}).`;
    }
    counts[idx] += 1;
  }
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] < 1) return `Card ${i + 1} needs at least 1 button.`;
    if (counts[i] > MAX_CARD_BUTTONS) return `Card ${i + 1} can have at most ${MAX_CARD_BUTTONS} buttons.`;
  }
  if (new Set(counts).size !== 1) return 'Every card in a carousel must have the same number of buttons (all 1 or all 2).';
  return null;
};

/**
 * Single-edge check for POST/PUT /edges. `parent` is the edge's from-node row (snake_case); `siblings` the
 * other edges (snake_case) leaving it. Parity across cards is NOT checked here (edges arrive one at a
 * time); the send path falls back to separate messages for an uneven carousel.
 * @returns {string|null}
 */
const carouselEdgeError = ({ parent, cardIndex, siblings }) => {
  const isCarousel = !!parent && parent.content_type === 'carousel';
  if (!isCarousel) {
    return cardIndex === null || cardIndex === undefined ? null : 'cardIndex only applies to buttons of a carousel reply.';
  }
  const cards = cardsOf(parent);
  if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= Math.max(cards.length, 1)) {
    return `cardIndex is required for a carousel button, from 0 to ${Math.max(cards.length, 1) - 1}.`;
  }
  const onCard = (siblings || []).filter(e => e.card_index === cardIndex).length;
  if (onCard >= MAX_CARD_BUTTONS) return `Card ${cardIndex + 1} already has ${MAX_CARD_BUTTONS} buttons.`;
  return null;
};

module.exports = { normalizeCards, prepareCarouselWrite, carouselBodyError, carouselParityError, carouselEdgeError };
