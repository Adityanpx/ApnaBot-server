// Run: node --test src/services/socket.newMessageTime.test.js
// The socket new_message event carries waTimestamp and messageTime on its message, whatever
// shape the emitting site had (camelCase row, snake_case row, or a fallback with neither).
const test = require('node:test');
const assert = require('node:assert/strict');

const emitted = [];
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('socket.io', { Server: class { use() {} on() {} to(room) { return { emit: (event, data) => emitted.push([room, event, data]) }; } } });
stub('../config/env', {});
stub('./auth.service', {});
stub('../config/supabase', {});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
const socketService = require('./socket.service');
socketService.initialize({});

const lastMessage = () => emitted[emitted.length - 1][2].message;

test('new_message: a delayed inbound row carries waTimestamp and messageTime = waTimestamp', () => {
  socketService.emitToBusiness('b1', 'new_message', { customerNumber: '91', message: { id: 'm', createdAt: '2026-10-01T10:30:00Z', waTimestamp: '2026-10-01T10:01:00Z' } });
  assert.equal(lastMessage().waTimestamp, '2026-10-01T10:01:00Z');
  assert.equal(lastMessage().messageTime, '2026-10-01T10:01:00Z');
  assert.equal(lastMessage().createdAt, '2026-10-01T10:30:00Z'); // untouched
});

test('new_message: an ApnaBot send has no waTimestamp, messageTime = createdAt; snake_case rows work too', () => {
  socketService.emitToBusiness('b1', 'new_message', { message: { id: 'o', createdAt: '2026-10-01T10:03:00Z' } });
  assert.equal(lastMessage().waTimestamp, null);
  assert.equal(lastMessage().messageTime, '2026-10-01T10:03:00Z');
  socketService.emitToBusiness('b1', 'new_message', { message: { id: 's', created_at: '2026-10-01T10:04:00Z', wa_timestamp: '2026-10-01T10:03:30Z' } });
  assert.equal(lastMessage().messageTime, '2026-10-01T10:03:30Z');
});

test('other events, and new_message without a message, are passed through unchanged', () => {
  const data = { customerId: 'c1' };
  socketService.emitToBusiness('b1', 'conversation:viewer:joined', data);
  assert.equal(emitted[emitted.length - 1][2], data);
  const noMsg = { customer: {} };
  socketService.emitToBusiness('b1', 'new_message', noMsg);
  assert.equal(emitted[emitted.length - 1][2], noMsg);
});
