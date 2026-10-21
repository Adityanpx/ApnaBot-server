// Run: node --test src/utils/handoffMatch.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { asksForPerson, HANDOFF_MAX_WORDS } = require('./handoffMatch');
const { DEFAULT_KEYWORDS } = require('./handoffSettings');

test('the word limit is 6', () => {
  assert.equal(HANDOFF_MAX_WORDS, 6);
});

test('default phrases match as whole words / phrases, any case and punctuation', () => {
  for (const yes of [
    'agent', 'Agent!', 'I want to talk to someone', 'please speak to owner', 'call me', 'Call me back?',
    'human', 'owner', 'customer care', 'Customer   Care please',
    'बात करनी है', 'मुझे बात करना है', 'मालक', 'मालक हवेत', 'बोलायचं आहे', 'बोलायचे आहे',
    'baat karni hai', 'baat karna hai', 'bolaycha aahe', 'malak kuthe'
  ]) assert.equal(asksForPerson(yes, DEFAULT_KEYWORDS), true, yes);
});

test('not inside another word, and not words that are no longer defaults', () => {
  for (const no of [
    'hello', 'price of innova', 'thanks', '', '   ', 'humane society', 'agents', 'the owners club', 'talking tom',
    '4 person', 'I need a person', 'बात', 'ठीक है बात ठीक है', 'मालकाशी'
  ]) assert.equal(asksForPerson(no, DEFAULT_KEYWORDS), false, no);
});

test('a message of more than 6 words is a question, not a request (falls through to rule matching)', () => {
  assert.equal(asksForPerson('can I talk to the owner', DEFAULT_KEYWORDS), true); // 6 words
  assert.equal(asksForPerson('can I talk to the owner today', DEFAULT_KEYWORDS), false); // 7 words
  assert.equal(asksForPerson('can you talk to me about the 6 seater price', DEFAULT_KEYWORDS), false);
});

test('works on a custom list, ignores blanks and non-strings', () => {
  assert.equal(asksForPerson('manager please', ['manager']), true);
  assert.equal(asksForPerson('hello', ['', null, 5, undefined]), false);
  assert.equal(asksForPerson('hello', null), false);
});
