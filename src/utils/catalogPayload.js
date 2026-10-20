// What the bot sends for a catalogue, as pure functions (no database, no sending), so the rules are
// testable and the sender (services/catalogReply.service.js) only does I/O.
//
//   composeCardText   a collection's carousel card text: *title*, body, price label (<= 160, <= 2 line breaks)
//   planCatalogueCards the carousel's cards (the same shape the outbound worker's `carousel` job takes) and
//                     whether Meta's native carousel can be used
//   photoCaption      "design no · price · caption" for one photo
//   paginate          which items a page shows and whether there is more
const { LIMITS, truncate } = require('./textLimits');
const { CARD_BODY_MAX, MIN_CARDS, MAX_CARDS } = require('./carouselPayload');
const { pageId, collectionOrderId } = require('./catalogIds');

const oneLine = (text) => String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();

/**
 * *title* / body / price label, one per line (2 line breaks at most). The title and price label are always
 * kept (they are short: 60 and 30 characters); the body is shortened to fit the card's 160 characters.
 */
const composeCardText = ({ title, body, priceLabel }) => {
  const head = `*${oneLine(title).replace(/\*/g, '')}*`;
  const price = oneLine(priceLabel);
  const fixed = [head, price].filter(Boolean);
  const reserved = fixed.join('\n').length + (oneLine(body) ? 1 : 0);
  const room = CARD_BODY_MAX - reserved;
  const bodyText = room > 0 ? truncate(oneLine(body), room).trim() : '';
  const lines = [head, bodyText, price].filter(Boolean);
  return truncate(lines.join('\n'), CARD_BODY_MAX);
};

/**
 * @param {Object} args
 * @param {Object[]} args.collections  ACTIVE collections in display order, each
 *   { id, title, body, priceLabel, mediaUrl|null } already in the customer's language
 * @param {number} args.maxCards       the plan's carousel_max_cards
 * @param {string} args.viewLabel      "View designs" button title
 * @param {string|null} args.orderLabel "Order" button title, or null when the catalogue has no order action
 * @returns {{ native: boolean, cards: Object[], skipped: { overPlan: number } }}
 *   cards: [{ index, mediaType, mediaUrl, text, buttons: [{ nextKeyword, title }] }] - every card has the SAME
 *   buttons (1 or 2). native = 2+ cards have a photo (only those are sent natively); otherwise every card is
 *   kept for the one-message-per-card fallback.
 */
const planCatalogueCards = ({ collections, maxCards, viewLabel, orderLabel }) => {
  const limit = Math.max(0, Math.min(Number.isFinite(maxCards) ? maxCards : MAX_CARDS, MAX_CARDS));
  const kept = collections.slice(0, limit);
  const cards = kept.map((collection, index) => ({
    index,
    mediaType: collection.mediaUrl ? 'image' : null,
    mediaUrl: collection.mediaUrl || null,
    text: composeCardText(collection),
    buttons: [
      { nextKeyword: pageId(collection.id, 0), title: truncate(viewLabel, LIMITS.BUTTON_TITLE) },
      ...(orderLabel ? [{ nextKeyword: collectionOrderId(collection.id), title: truncate(orderLabel, LIMITS.BUTTON_TITLE) }] : [])
    ]
  }));
  const withMedia = cards.filter(c => c.mediaUrl);
  const skipped = { overPlan: collections.length - kept.length };
  if (withMedia.length >= MIN_CARDS) {
    // Native cards are re-indexed 0..n-1 by the sender; the ids on the buttons keep pointing at the collection.
    return { native: true, cards: withMedia, skipped };
  }
  return { native: false, cards, skipped };
};

/** "A-102 · ₹1,499 · Pure cotton" - only the parts that exist; '' when none. */
const photoCaption = ({ designNo, priceText, caption }) =>
  [designNo, priceText, caption].map(oneLine).filter(Boolean).join(' · ');

/**
 * @param {number} total   items in the collection
 * @param {number} page    requested page, 0-based (clamped into range)
 * @param {number} perPage 1..10
 * @returns {{ page: number, offset: number, limit: number, from: number, to: number, hasMore: boolean, pages: number }}
 *   from / to are 1-based for "Showing 11-20 of 34"; with no items from = to = 0
 */
const paginate = (total, page, perPage) => {
  const size = Math.max(1, Math.min(10, Math.floor(perPage) || 10));
  const pages = Math.max(1, Math.ceil(total / size));
  const clamped = Math.min(Math.max(0, Math.floor(page) || 0), pages - 1);
  const offset = clamped * size;
  const shown = Math.max(0, Math.min(size, total - offset));
  return {
    page: clamped, offset, limit: size,
    from: shown === 0 ? 0 : offset + 1, to: offset + shown,
    hasMore: offset + shown < total, pages
  };
};

module.exports = { composeCardText, planCatalogueCards, photoCaption, paginate, oneLine };
