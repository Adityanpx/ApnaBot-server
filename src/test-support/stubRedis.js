// Stubs the shared Redis client and the BullMQ queue modules with inert objects, for tests that load
// controllers whose services create queues at require time (an open ioredis connection would keep
// `node --test` from exiting and could take a slot on the shared Redis Cloud). Require this BEFORE
// the controller, after storageHarness.
const path = require('node:path');

const inert = new Proxy(function inertFn() {}, {
  get: (_t, prop) => (prop === 'then' ? undefined : inert),
  apply: () => Promise.resolve(null)
});

for (const rel of ['config/redis.js', 'config/queueConnection.js', 'queues/whatsapp.queue.js', 'queues/broadcast.queue.js',
  'queues/demoReminder.queue.js', 'queues/sessionTimeout.queue.js']) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: inert };
}
