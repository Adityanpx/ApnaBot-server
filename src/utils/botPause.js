// Sentinel used for "paused indefinitely" instead of a separate boolean
// column — keeps bot_paused_until a single nullable timestamp: null/past
// means active, this far-future value means paused until manually resumed,
// anything else in between is a normal timed pause.
const INDEFINITE_PAUSE_SENTINEL = '9999-12-31T00:00:00.000Z';

const isIndefinitePause = (botPausedUntil) => {
  if (!botPausedUntil) return false;
  return new Date(botPausedUntil).getTime() === new Date(INDEFINITE_PAUSE_SENTINEL).getTime();
};

// How long a pause lasts when it is implied by a staff reply (dashboard send,
// or the owner replying from the WhatsApp Business app) rather than set
// explicitly through the pause endpoint.
const BOT_PAUSE_DURATION_MS = 24 * 60 * 60 * 1000;

module.exports = { INDEFINITE_PAUSE_SENTINEL, BOT_PAUSE_DURATION_MS, isIndefinitePause };
