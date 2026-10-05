// Pure helpers for inbound WhatsApp messages: duplicate handling (Meta can
// deliver the same wamid more than once) and what the inbox shows for them.
//
// A stored 'unsupported' row is "weak" - a real delivery of the same id
// replaces it - while anything else is final.

const WEAK_TYPE = 'unsupported';

// Mirrors messages_type_check (migration 20260928120000). Anything Meta adds
// later is stored as 'unsupported' rather than failing the insert — which
// used to drop the whole inbound message (e.g. a shared location).
const INBOUND_MESSAGE_TYPES = new Set([
  'text', 'image', 'document', 'audio', 'interactive', 'video', 'sticker',
  'location', 'contacts', 'button', 'reaction', 'order', 'system', 'unsupported'
]);

/**
 * What to do with an incoming delivery given the row already stored for its id.
 * @param {string|null|undefined} existingType - type of the stored row, null/undefined if none
 * @param {string} incomingType - the type this delivery would be stored as
 * @returns {'insert'|'ignore'|'replace'}
 */
const decideDuplicate = (existingType, incomingType) => {
  if (!existingType) return 'insert';
  if (incomingType === WEAK_TYPE) return 'ignore';
  if (existingType === WEAK_TYPE) return 'replace';
  return 'ignore';
};

/**
 * Inbox text for an unsupported inbound message, so the owner sees a reason
 * instead of a blank bubble.
 * @param {Object} message - Meta webhook message object
 * @returns {string}
 */
const unsupportedLabel = (message) => {
  const rawType = String(message?.type || 'unknown').slice(0, 40);
  const code = message?.errors?.[0]?.code;
  const detail = code ? `type: ${rawType}, error ${code}` : `type: ${rawType}`;
  return `⚠️ Message couldn't be displayed (${detail}) - ask the customer to resend`;
};

/**
 * Inbox text for an inbound message that has no text body — without it,
 * photos (e.g. a customer's payment screenshot), documents and voice notes
 * were stored with empty content and showed as blank bubbles. Photos are
 * additionally copied to R2 (storeInboundImage); other media isn't stored.
 * @param {Object} message - Meta webhook message object
 * @returns {string|null}
 */
const inboundMediaLabel = (message) => {
  const withCaption = (label, caption) => (caption ? `${label}: ${caption}` : label);
  switch (message.type) {
    case 'image': return withCaption('📷 Photo', message.image?.caption);
    case 'video': return withCaption('🎥 Video', message.video?.caption);
    case 'document': return withCaption(`📄 ${message.document?.filename || 'Document'}`, message.document?.caption);
    case 'audio': return message.audio?.voice ? '🎤 Voice message' : '🎵 Audio';
    case 'sticker': return 'Sticker';
    case 'unsupported': return unsupportedLabel(message);
    case 'location': {
      const loc = message.location || {};
      return ['📍 Location', loc.name, loc.address].filter(Boolean).join(' · ');
    }
    case 'contacts': return '👤 Contact card';
    // A template quick-reply tap: show the label the customer tapped.
    case 'button': return message.button?.text || null;
    case 'interactive':
      // WhatsApp Flow form submission (nfm_reply) — no title to show.
      return message.interactive?.nfm_reply ? '📝 Form submitted' : null;
    // A type we don't parse is stored as 'unsupported' (see INBOUND_MESSAGE_TYPES).
    default: return INBOUND_MESSAGE_TYPES.has(message.type) ? null : unsupportedLabel(message);
  }
};

module.exports = { WEAK_TYPE, INBOUND_MESSAGE_TYPES, decideDuplicate, unsupportedLabel, inboundMediaLabel };
