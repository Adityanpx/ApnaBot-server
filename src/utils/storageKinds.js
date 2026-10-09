// What each R2 folder holds - the folders r2.uploadImage is called with across
// the server. Storage cleanup only ever looks at these ("known prefixes").
const config = require('../config/env');

const PREFIX_KIND = {
  'inbound-media/': 'chat_inbound',     // customer photos           inbound-media/{businessId}/{messageId}.ext
  'echo-media/': 'chat_echo',           // owner phone-app media     echo-media/{businessId}/{messageId}.ext
  'business-media/': 'library',         // media library             business-media/{businessId}-{ts}-{n}.ext
  'template-headers/': 'template_header', // legacy template header image
  'payment-qr/': 'payment_qr',          // payment-qr/business-{businessId}-{ts}.ext
  'business-profiles/': 'logo',         // business-profiles/business-{businessId}.ext
  'vehicle-photos/': 'vehicle_photo',   // vehicle-photos/vehicle-{businessId}-{ts}.ext
  'vehicle-catalog/': 'vehicle_photo'   // platform-wide catalog photos
};
const KNOWN_PREFIXES = Object.keys(PREFIX_KIND);

const KINDS = [
  'chat_inbound', 'chat_echo', 'library', 'template_header', 'bot_node_image',
  'payment_qr', 'logo', 'vehicle_photo', 'course_image', 'orphan'
];
const CHAT_KINDS = ['chat_inbound', 'chat_echo'];

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const prefixOf = (key) => KNOWN_PREFIXES.find(p => key.startsWith(p)) || null;

/**
 * What the key itself says: its folder's kind, and the business / message ids
 * encoded in the path (chat files, QR, profile image, vehicle photos).
 * @returns {{prefix:string, prefixKind:string, businessId:string|null, messageId:string|null}|null}
 *   null for a key outside the known folders
 */
const parseKey = (key) => {
  const prefix = prefixOf(key);
  if (!prefix) return null;
  const prefixKind = PREFIX_KIND[prefix];
  const rest = key.slice(prefix.length);
  const isChat = CHAT_KINDS.includes(prefixKind);
  let businessId = null;
  let messageId = null;
  if (isChat) {
    const [biz, file] = rest.split('/');
    businessId = UUID_RE.test(biz || '') ? biz : null;
    const m = (file || '').match(UUID_RE);
    messageId = m ? m[0] : null;
  } else if (['payment_qr', 'logo', 'vehicle_photo'].includes(prefixKind) && prefix !== 'vehicle-catalog/') {
    const m = rest.match(UUID_RE);
    businessId = m ? m[0] : null;
  }
  return { prefix, prefixKind, businessId, messageId };
};

const publicUrlOf = (key) => `${config.R2_PUBLIC_URL}/${key}`;

module.exports = { PREFIX_KIND, KNOWN_PREFIXES, KINDS, CHAT_KINDS, parseKey, prefixOf, publicUrlOf };
