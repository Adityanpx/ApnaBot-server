// "I can only read text messages" reply to a voice note / photo / document / video / sticker /
// shared location that no step of the flow expects (webhook.controller.js Step 11). Sent at most
// once per customer per minute so a burst of photos gets one answer.
const logger = require('../utils/logger');

// Meta message types that get the reply. Anything else non-text (reaction, contacts, order, system,
// template button taps, ...) keeps being ignored silently.
const UNSUPPORTED_REPLY_TYPES = new Set(['audio', 'image', 'document', 'video', 'sticker', 'location']);

const COOLDOWN_SECONDS = 60;

const cooldownKey = (businessId, customerId) => `unsupported-type:${businessId}:${customerId}`;
const getRedis = () => require('../config/redis');

/**
 * Claims the right to send the reply (Redis SET NX, 60 s). False when one went out in the last
 * minute - or when Redis is unavailable, so a Redis outage never turns into a reply per message.
 * @returns {Promise<boolean>}
 */
const claimReply = async (businessId, customerId) => {
  try {
    const claimed = await getRedis().set(cooldownKey(businessId, customerId), '1', 'EX', COOLDOWN_SECONDS, 'NX');
    return claimed === 'OK';
  } catch (error) {
    logger.error(`Unsupported-type reply cooldown failed for business ${businessId}, not replying:`, error);
    return false;
  }
};

module.exports = { UNSUPPORTED_REPLY_TYPES, COOLDOWN_SECONDS, claimReply };
