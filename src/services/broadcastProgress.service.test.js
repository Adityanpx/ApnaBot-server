// Run: node --test src/services/broadcastProgress.service.test.js
// Broadcast delivery stats (RPC with a fallback for broadcasts sent before tracking)
// and the throttled broadcast_progress socket event. Supabase / socket stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let rpcResult; let broadcastRow; let emitted; let rpcCalls;
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('./socket.service', { emitToBusiness: (biz, ev, data) => { emitted.push([biz, ev, data]); } });
stub('../config/supabase', {
  rpc: async (name, args) => { rpcCalls.push([name, args]); return rpcResult(); },
  from: () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: broadcastRow, error: null }) };
    return q;
  }
});
const { getBroadcastStats, notifyBroadcastProgress } = require('./broadcastProgress.service');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const row = { status: 'sending', total_recipients: 10, sent_count: 7, failed_count: 1 };

test.beforeEach(() => {
  emitted = []; rpcCalls = []; broadcastRow = { ...row };
  rpcResult = async () => ({ data: { tracked: true, total: 10, queued: 2, sent: 7, delivered: 5, read: 3, failed: 1 }, error: null });
});

test('stats come from the RPC for a tracked broadcast', async () => {
  const s = await getBroadcastStats('b', 'bc', row);
  assert.deepEqual(s, { tracked: true, total: 10, queued: 2, sent: 7, delivered: 5, read: 3, failed: 1 });
  assert.deepEqual(rpcCalls[0], ['broadcast_recipient_stats', { p_broadcast_id: 'bc', p_business_id: 'b' }]);
});

test('a broadcast with no recipient rows is untracked: only the old counters, the rest unknown (null)', async () => {
  rpcResult = async () => ({ data: { tracked: false, total: 0 }, error: null });
  assert.deepEqual(await getBroadcastStats('b', 'bc', row), { tracked: false, total: 10, queued: null, sent: 7, delivered: null, read: null, failed: 1 });
});

test('an RPC error falls back to the same untracked numbers instead of failing the request', async () => {
  rpcResult = async () => ({ data: null, error: { message: 'boom' } });
  assert.equal((await getBroadcastStats('b', 'bc', row)).tracked, false);
  rpcResult = async () => { throw new Error('network'); };
  assert.equal((await getBroadcastStats('b', 'bc', row)).sent, 7);
});

test('many changes in one window give ONE broadcast_progress event, with the numbers as they are then', async () => {
  for (let i = 0; i < 25; i++) notifyBroadcastProgress('b', 'bc', 40);
  broadcastRow = { ...row, sent_count: 9 }; // changes while waiting
  await sleep(120);
  assert.equal(emitted.length, 1);
  const [biz, ev, data] = emitted[0];
  assert.deepEqual([biz, ev], ['b', 'broadcast_progress']);
  assert.equal(data.broadcastId, 'bc');
  assert.equal(data.sentCount, 9);
  assert.equal(data.status, 'sending');
  assert.equal(data.totalRecipients, 10);
  assert.equal(data.stats.delivered, 5);
});

test('a later change after the window gets its own event; other broadcasts are independent', async () => {
  notifyBroadcastProgress('b', 'bc', 30);
  notifyBroadcastProgress('b', 'other', 30);
  await sleep(100);
  assert.deepEqual(emitted.map((e) => e[2].broadcastId).sort(), ['bc', 'other']);
  notifyBroadcastProgress('b', 'bc', 30);
  await sleep(100);
  assert.equal(emitted.length, 3);
});

test('nothing is emitted for a missing id, a vanished broadcast, or a failing lookup; never throws', async () => {
  notifyBroadcastProgress(null, 'bc', 10);
  notifyBroadcastProgress('b', undefined, 10);
  broadcastRow = null;
  notifyBroadcastProgress('b', 'gone', 10);
  await sleep(60);
  assert.equal(emitted.length, 0);
  broadcastRow = { ...row };
  rpcResult = async () => { throw new Error('x'); };
  notifyBroadcastProgress('b', 'bc', 10); // stats fall back; event still goes out
  await sleep(60);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][2].stats.tracked, false);
});
