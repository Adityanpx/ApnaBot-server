// Pure helpers for a reply node with content_type 'carousel' (flow_nodes.carousel_cards +
// flow_edges.card_index). No requires outside utils, so it loads in tests without any config.
//
//   planCarouselSend      what the webhook should send for a node: a native Meta carousel, or the
//                         sequential fallback (body, then one message per card)
//   buildCarouselPayload  the Graph API `interactive` object for a native carousel
//   summarizeCarousel     the interactive_payload kept on the messages row (chat history)
//
// A card is stored as { media_id, media_type: 'image'|'video', body, body_translations }; a card's
// buttons are the node's outgoing edges with that card_index (edge.id = quick-reply id).
const { LIMITS, truncate } = require('./textLimits');

const CARD_BODY_MAX = 160;
const CARD_BODY_MAX_LINE_BREAKS = 2;
const MAX_CARD_BUTTONS = 2;
const MIN_CARDS = 2;
const MAX_CARDS = 10;
const CARD_MEDIA_TYPES = Object.freeze(['image', 'video']);

const cardsOf = (node) => {
  const list = node && (node.carousel_cards ?? node.carouselCards);
  return Array.isArray(list) ? list : [];
};

/** Meta allows at most 2 line breaks in a card body: later breaks become spaces. */
const limitLineBreaks = (text, max = CARD_BODY_MAX_LINE_BREAKS) => {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines.length - 1 <= max) return lines.join('\n');
  return [...lines.slice(0, max), lines.slice(max).join(' ')].join('\n');
};

const cleanCardText = (text) => truncate(limitLineBreaks(String(text ?? '').trim()), CARD_BODY_MAX);

/**
 * What to send for a carousel node.
 *
 * @param {Object} args
 * @param {Object} args.node           the matched reply node (camelCase or snake_case)
 * @param {Object[]} args.edges        the node's outgoing edges, camelCase, as chatbotService.getOutgoingEdges
 *   returns them (`nextKeyword` = edge id)
 * @param {Map<string, {url, media_type}>} args.mediaById  this business's library rows for the cards' media
 * @param {number} args.maxCards       the CURRENT plan's carousel_max_cards (cards beyond it are skipped)
 * @param {boolean} args.videoAllowed  the current plan's video_per_reply
 * @param {(record: Object, field: string) => string} args.localize  text in the customer's language
 * @param {(text: string) => string} [args.template]  placeholder substitution applied to card text
 * @returns {{ native: boolean, cards: Object[], skipped: { overPlan: number, noMedia: number }, reason: string|null }}
 *   cards: [{ index, mediaType, mediaUrl, text, buttons: [{ nextKeyword, title }] }]. When `native` is true every
 *   card has media and all cards carry the same number (1 or 2) of buttons; otherwise the cards are for the
 *   sequential fallback (body, then each card: its image if it has one, its text and its buttons) and
 *   cards without media are KEPT so their buttons still route. Edges with no card_index (a buttons reply
 *   just switched to carousel) are ignored and counted in skipped.unassignedButtons.
 */
const planCarouselSend = ({ node, edges, mediaById, maxCards, videoAllowed, localize, template = (t) => t }) => {
  const stored = cardsOf(node);
  const limit = Math.max(0, Math.min(Number.isFinite(maxCards) ? maxCards : MAX_CARDS, MAX_CARDS));
  const kept = stored.slice(0, limit);

  const edgesByCard = new Map();
  let unassigned = 0;
  for (const edge of edges || []) {
    const idx = edge.cardIndex ?? edge.card_index;
    if (idx === null || idx === undefined) { unassigned += 1; continue; }
    const list = edgesByCard.get(idx) || [];
    list.push(edge);
    edgesByCard.set(idx, list);
  }

  const cards = kept.map((card, index) => {
    const media = card && card.media_id ? mediaById.get(card.media_id) : null;
    const typeOk = media && media.media_type === (card.media_type || 'image') && CARD_MEDIA_TYPES.includes(media.media_type)
      && (media.media_type !== 'video' || videoAllowed);
    const buttons = (edgesByCard.get(index) || [])
      .slice()
      .sort((a, b) => (a.displayOrder ?? a.display_order ?? 0) - (b.displayOrder ?? b.display_order ?? 0))
      .map(edge => ({ nextKeyword: edge.nextKeyword ?? edge.id, title: truncate(String(localize(edge, 'label') ?? '').trim(), LIMITS.BUTTON_TITLE) }))
      .filter(b => b.title);
    return {
      index,
      mediaType: typeOk ? media.media_type : null,
      mediaUrl: typeOk ? media.url : null,
      text: cleanCardText(template(String(localize(card, 'body') ?? ''))),
      buttons
    };
  });

  const skipped = { overPlan: stored.length - kept.length, noMedia: 0, unassignedButtons: unassigned };
  const withMedia = cards.filter(c => c.mediaUrl);
  skipped.noMedia = cards.length - withMedia.length;

  // Native needs at least 2 cards WITH media; cards without media are dropped from it.
  if (withMedia.length >= MIN_CARDS) {
    const counts = new Set(withMedia.map(c => c.buttons.length));
    const uniform = counts.size === 1 && withMedia[0].buttons.length >= 1 && withMedia[0].buttons.length <= MAX_CARD_BUTTONS;
    if (uniform) return { native: true, cards: withMedia, skipped, reason: null };
    return { native: false, cards, skipped, reason: 'cards do not all have the same 1-2 buttons' };
  }
  return {
    native: false, cards, skipped,
    reason: withMedia.length === 0 ? 'no card has resolvable media' : 'fewer than 2 cards have resolvable media'
  };
};

/** The Graph API `interactive` object for a native carousel (cards from planCarouselSend). */
const buildCarouselPayload = (body, cards) => ({
  type: 'carousel',
  body: { text: truncate(body, LIMITS.INTERACTIVE_BODY) },
  action: {
    cards: cards.map((card, i) => ({
      card_index: i,
      type: 'cta_url',
      header: card.mediaType === 'video'
        ? { type: 'video', video: { link: card.mediaUrl } }
        : { type: 'image', image: { link: card.mediaUrl } },
      ...(card.text ? { body: { text: card.text } } : {}),
      action: {
        buttons: card.buttons.slice(0, MAX_CARD_BUTTONS).map(b => ({
          type: 'quick_reply',
          quick_reply: { id: b.nextKeyword, title: truncate(b.title, LIMITS.BUTTON_TITLE) }
        }))
      }
    }))
  }
});

/** The interactive_payload stored with the outbound row: body + one summary per card. */
const summarizeCarousel = (body, cards) => ({
  kind: 'carousel',
  body: truncate(body, LIMITS.INTERACTIVE_BODY),
  cards: (cards || []).map(card => ({
    mediaType: card.mediaType || null,
    mediaUrl: card.mediaUrl || null,
    text: card.text || '',
    buttons: (card.buttons || []).map(b => ({ id: b.nextKeyword, title: truncate(b.title, LIMITS.BUTTON_TITLE) }))
  }))
});

module.exports = {
  CARD_BODY_MAX,
  CARD_BODY_MAX_LINE_BREAKS,
  MAX_CARD_BUTTONS,
  MIN_CARDS,
  MAX_CARDS,
  CARD_MEDIA_TYPES,
  cardsOf,
  limitLineBreaks,
  planCarouselSend,
  buildCarouselPayload,
  summarizeCarousel
};
