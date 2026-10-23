// Run: node --test src/services/unsupportedMessage.service.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const redisPath = require.resolve('../config/redis');
let store = new Map();
let down = false;
require.cache[redisPath] = {
  id: redisPath, filename: redisPath, loaded: true,
  exports: {
    set: async (key, value, ex, seconds, nx) => {
      if (down) throw new Error('redis down');
      assert.equal(ex, 'EX'); assert.equal(seconds, 60); assert.equal(nx, 'NX');
      if (store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }
  }
};
const { claimReply, UNSUPPORTED_REPLY_TYPES } = require('./unsupportedMessage.service');
const { getSystemMessage } = require('../utils/systemMessages');

test('first reply is allowed, the next within the minute is not, per customer', async () => {
  store = new Map();
  assert.equal(await claimReply('b1', 'c1'), true);
  assert.equal(await claimReply('b1', 'c1'), false);
  assert.equal(await claimReply('b1', 'c2'), true);
});

test('a Redis failure sends nothing instead of a reply per message', async () => {
  down = true;
  assert.equal(await claimReply('b1', 'c9'), false);
  down = false;
});

test('types: media and location are answered, reactions and the like are not', () => {
  for (const t of ['audio', 'image', 'document', 'video', 'sticker', 'location']) assert.ok(UNSUPPORTED_REPLY_TYPES.has(t), t);
  for (const t of ['text', 'reaction', 'contacts', 'order', 'system', 'unsupported', 'interactive', 'button']) assert.ok(!UNSUPPORTED_REPLY_TYPES.has(t), t);
});

test('the notice is localized', () => {
  assert.equal(getSystemMessage('unsupportedMessageType', 'en'), 'Sorry, I can only read text messages. Please type your reply or pick an option below.');
  assert.notEqual(getSystemMessage('unsupportedMessageType', 'hi'), getSystemMessage('unsupportedMessageType', 'en'));
  assert.notEqual(getSystemMessage('unsupportedMessageType', 'mr'), getSystemMessage('unsupportedMessageType', 'en'));
});
