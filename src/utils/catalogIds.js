// WhatsApp interaction ids of the Catalogue (services/catalogReply.service.js builds them, the webhook
// routes them). All start with "cat:" (utils/optInLink.js lists that prefix as a system tap, so an active
// booking session never swallows a catalogue tap as a stale answer). Ids are <= 256 characters and carry
// only uuids and short words; a tap whose collection / item no longer exists is answered with a fresh
// catalogue (catalogReply.service.js), never an error.
//
//   cat:menu                       show the catalogue (the carousel) again
//   cat:<collectionId>:p:<page>    that collection's designs, page 0-based ("View designs" = page 0)
//   cat:<collectionId>:order       order that collection
//   cat:item:<itemId>:order        order that one design
const PREFIX = 'cat:';
const MENU_ID = 'cat:menu';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pageId = (collectionId, page) => `${PREFIX}${collectionId}:p:${Math.max(0, Math.floor(page))}`;
const collectionOrderId = (collectionId) => `${PREFIX}${collectionId}:order`;
const itemOrderId = (itemId) => `${PREFIX}item:${itemId}:order`;

/**
 * @param {*} id  a button reply id / quick-reply payload
 * @returns {{ kind: 'menu' } | { kind: 'page', collectionId: string, page: number }
 *   | { kind: 'collection_order', collectionId: string } | { kind: 'item_order', itemId: string } | null}
 *   null when it is not a well-formed catalogue id
 */
const parseCatalogTapId = (id) => {
  if (typeof id !== 'string' || !id.startsWith(PREFIX) || id.length > 256) return null;
  if (id === MENU_ID) return { kind: 'menu' };
  const parts = id.slice(PREFIX.length).split(':');
  if (parts.length === 3 && parts[0] === 'item' && parts[2] === 'order' && UUID_RE.test(parts[1])) {
    return { kind: 'item_order', itemId: parts[1].toLowerCase() };
  }
  if (parts.length === 2 && parts[1] === 'order' && UUID_RE.test(parts[0])) {
    return { kind: 'collection_order', collectionId: parts[0].toLowerCase() };
  }
  if (parts.length === 3 && parts[1] === 'p' && UUID_RE.test(parts[0]) && /^\d{1,4}$/.test(parts[2])) {
    return { kind: 'page', collectionId: parts[0].toLowerCase(), page: Number(parts[2]) };
  }
  return null;
};

module.exports = { PREFIX, MENU_ID, UUID_RE, pageId, collectionOrderId, itemOrderId, parseCatalogTapId };
