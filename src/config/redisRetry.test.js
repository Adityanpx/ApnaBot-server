// Run: node --test src/config/redisRetry.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const Redis = require('ioredis');
const { reconnectDelay } = require('./redisRetry');

test('reconnectDelay: 1 s, 2 s, 4 s … capped at 30 s (+ <0.5 s jitter), never gives up', () => {
  const base = (times) => {
    const d = reconnectDelay(times);
    assert.ok(typeof d === 'number', `attempt ${times} must return a delay, not null`);
    return d;
  };
  for (const [times, min] of [[1, 1000], [2, 2000], [3, 4000], [5, 16000], [6, 30000], [50, 30000], [10000, 30000]]) {
    const d = base(times);
    assert.ok(d >= min && d < min + 500, `attempt ${times}: ${d} not in [${min}, ${min + 500})`);
  }
});

test('a client that cannot reach Redis keeps retrying instead of ending', async () => {
  // A port nothing listens on: grab a free one and close it again.
  const port = await new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
  const client = new Redis({ host: '127.0.0.1', port, retryStrategy: reconnectDelay, maxRetriesPerRequest: null, lazyConnect: true });
  let ended = false;
  client.on('end', () => { ended = true; });
  client.on('error', () => {});
  client.connect().catch(() => {});
  await new Promise((r) => setTimeout(r, 3500)); // long enough for several attempts
  assert.equal(ended, false);
  assert.ok(['connecting', 'reconnecting'].includes(client.status), `status ${client.status}`);
  client.disconnect();
});
