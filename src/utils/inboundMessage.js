// Pure helpers for the inbound webhook's duplicate handling.
//
// Meta can deliver the same wamid more than once: retries, and (seen live on
// a coexistence number) an 'unsupported' placeholder and the real message
// under the same id, in either order, minutes apart. A stored 'unsupported'
// row is therefore "weak" - a real delivery of the same id replaces it -
// while anything else is final.

const WEAK_TYPE = 'unsupported';

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

module.exports = { WEAK_TYPE, decideDuplicate, unsupportedLabel };
