// Run: node --test src/utils/quoteIds.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { quoteTapId, parseQuoteTapId } = require('./quoteIds');

const ID = '0b9c2f3e-1a4d-4e8b-9c7a-5d6e7f8a9b0c';

test('round trip for every action, and the id fits a WhatsApp button id (256)', () => {
  for (const action of ['confirm', 'change', 'talk', 'paid']) {
    const id = quoteTapId(ID, action);
    assert.deepEqual(parseQuoteTapId(id), { quoteId: ID, action });
    assert.ok(id.length <= 256);
  }
});

test('anything else is not a quote tap', () => {
  for (const bad of [null, undefined, '', 'quote:', `quote:${ID}`, `quote:${ID}:`, `quote:${ID}:delete`, `quote:${ID}:confirm:x`,
    'quote:not-a-uuid:confirm', `${ID}:confirm`, `Quote:${ID}:confirm`, 'lang_hi']) {
    assert.equal(parseQuoteTapId(bad), null, String(bad));
  }
});


test('the "Get a quote" start id round-trips an entry node and is not a quote tap', () => {
  const { quoteStartTapId, parseQuoteStartTapId, parseQuoteTapId } = require('./quoteIds');
  const entry = '0b9c2f3e-1a4d-4e8b-9c7a-5d6e7f8a9b0c';
  assert.equal(quoteStartTapId(entry), `quote:start:${entry}`);
  assert.deepEqual(parseQuoteStartTapId(quoteStartTapId(entry)), { entryNodeId: entry });
  assert.equal(parseQuoteTapId(quoteStartTapId(entry)), null);
  for (const bad of ['quote:start:', 'quote:start:nope', `quote:confirm:${entry}`, `quote:${entry}:confirm`, null, undefined]) assert.equal(parseQuoteStartTapId(bad), null, String(bad));
});
