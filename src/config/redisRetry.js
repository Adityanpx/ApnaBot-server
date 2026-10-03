// How long every Redis connection waits before reconnecting: 1 s, 2 s, 4 s …
// up to 30 s, plus up to 0.5 s of jitter so the connections don't all retry
// at the same instant — and never gives up. A short Redis outage, or Redis
// refusing new connections ("max number of clients reached", e.g. while a
// deploy runs the old and new instance side by side), heals by itself once
// Redis is reachable again, instead of the old 10 quick retries followed by
// process.exit.
const MAX_DELAY_MS = 30 * 1000;

const reconnectDelay = (times) =>
  Math.min(1000 * 2 ** Math.max(0, times - 1), MAX_DELAY_MS) + Math.floor(Math.random() * 500);

module.exports = { reconnectDelay };
