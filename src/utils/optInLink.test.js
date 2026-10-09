// Run: node --test src/utils/optInLink.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CODE_ALPHABET, CODE_LENGTH, DEFAULT_GREETING, generateCode, parseJoinCode, normalizeGreeting,
  buildPrefillText, buildWaMeUrl, isSystemTapId, parseOptInTapId
} = require('./optInLink');

test('generateCode: 4 chars from the poster-friendly alphabet', () => {
  for (const ch of '01OILU') assert.ok(!CODE_ALPHABET.includes(ch), `alphabet must not contain ${ch}`);
  for (let i = 0; i < 500; i++) {
    const code = generateCode();
    assert.equal(code.length, CODE_LENGTH);
    for (const ch of code) assert.ok(CODE_ALPHABET.includes(ch), `${code} has ${ch}`);
    assert.match(code, /^[2-9A-HJKMNP-TV-Z]{4}$/); // same as the migration's check
  }
});

test('parseJoinCode: the full prefill text and customer edits', () => {
  assert.equal(parseJoinCode('Hi SG Travels 👋 Code: JOIN-K7Q2'), 'K7Q2');
  assert.equal(parseJoinCode('join-k7q2'), 'K7Q2');
  assert.equal(parseJoinCode('JOIN k7q2'), 'K7Q2');
  assert.equal(parseJoinCode('Join:K7Q2 please'), 'K7Q2');
  assert.equal(parseJoinCode('JOINK7Q2'), 'K7Q2');
  assert.equal(parseJoinCode('hello\nJOIN_K7Q2\nthanks'), 'K7Q2');
  assert.equal(parseJoinCode('Code: #JOIN #K7Q2'), 'K7Q2');
});

test('parseJoinCode: ordinary messages do not match', () => {
  assert.equal(parseJoinCode('I want to join today'), null); // 5 letters
  assert.equal(parseJoinCode('join 2pm'), null); // 3 chars
  assert.equal(parseJoinCode('join OIL1'), null); // letters outside the alphabet
  assert.equal(parseJoinCode('JOIN-K7Q2X'), null); // too long — no partial match
  assert.equal(parseJoinCode('rejoin-K7Q2'), null); // JOIN must start a word
  assert.equal(parseJoinCode('hi'), null);
  assert.equal(parseJoinCode(''), null);
  assert.equal(parseJoinCode(null), null);
});

test('normalizeGreeting: strips an owner-typed JOIN code, 1–200 chars', () => {
  assert.deepEqual(normalizeGreeting('Hi SG Travels 👋 Code: JOIN-K7Q2'), { greeting: 'Hi SG Travels 👋' });
  assert.deepEqual(normalizeGreeting('Hi code JOIN-ZZ99 bye'), { greeting: 'Hi bye' });
  assert.deepEqual(normalizeGreeting('Use promo code SAVE10'), { greeting: 'Use promo code SAVE10' }); // no JOIN — kept
  assert.deepEqual(normalizeGreeting('  Hello  join-abcd  there '), { greeting: 'Hello there' });
  assert.deepEqual(normalizeGreeting(DEFAULT_GREETING), { greeting: DEFAULT_GREETING });
  assert.ok(normalizeGreeting('').error);
  assert.ok(normalizeGreeting('   ').error);
  assert.ok(normalizeGreeting('JOIN-K7Q2').error); // nothing left
  assert.ok(normalizeGreeting('x'.repeat(201)).error);
  assert.deepEqual(normalizeGreeting('x'.repeat(200)), { greeting: 'x'.repeat(200) });
  assert.ok(normalizeGreeting(42).error);
});

test('buildPrefillText: fills {{businessName}} and appends the code', () => {
  assert.equal(buildPrefillText(DEFAULT_GREETING, 'K7Q2', 'SG Travels'), 'Hi SG Travels 👋 Code: JOIN-K7Q2');
  assert.equal(buildPrefillText('Namaste!', 'AB23', 'X'), 'Namaste! Code: JOIN-AB23');
  // The customer's message parses back to the same code.
  assert.equal(parseJoinCode(buildPrefillText(DEFAULT_GREETING, 'K7Q2', 'SG Travels')), 'K7Q2');
});

test('buildWaMeUrl: digits only, prefill URL-encoded (emoji too), null without a number', () => {
  const url = buildWaMeUrl('919876543210', 'Hi SG Travels 👋 Code: JOIN-K7Q2');
  assert.equal(url, 'https://wa.me/919876543210?text=Hi%20SG%20Travels%20%F0%9F%91%8B%20Code%3A%20JOIN-K7Q2');
  assert.equal(decodeURIComponent(url.split('?text=')[1]), 'Hi SG Travels 👋 Code: JOIN-K7Q2');
  assert.equal(buildWaMeUrl('+91 98765 43210', 'x'), 'https://wa.me/919876543210?text=x');
  assert.equal(buildWaMeUrl(null, 'x'), null);
  assert.equal(buildWaMeUrl('', 'x'), null);
});

test('isSystemTapId: lang_ and optin_ only — never flow ids', () => {
  assert.equal(isSystemTapId('lang_mr'), true);
  assert.equal(isSystemTapId('optin_yes:0b3f6c1e-1111-4222-8333-944455556666'), true);
  assert.equal(isSystemTapId('optin_no:0b3f6c1e-1111-4222-8333-944455556666'), true);
  assert.equal(isSystemTapId('0b3f6c1e-1111-4222-8333-944455556666'), false); // flow_edges id
  assert.equal(isSystemTapId('0b3f6c1e-1111-4222-8333-944455556666:2'), false); // {node_id}:{index}
  assert.equal(isSystemTapId('0b3f6c1e-1111-4222-8333-944455556666:other'), false);
  assert.equal(isSystemTapId(null), false);
  assert.equal(isSystemTapId(''), false);
});

test('parseOptInTapId', () => {
  const id = '0b3f6c1e-1111-4222-8333-944455556666';
  assert.deepEqual(parseOptInTapId(`optin_yes:${id}`), { answer: 'yes', linkId: id });
  assert.deepEqual(parseOptInTapId(`optin_no:${id}`), { answer: 'no', linkId: id });
  assert.deepEqual(parseOptInTapId('optin_yes:'), { answer: 'yes', linkId: null });
  assert.equal(parseOptInTapId('lang_hi'), null);
  assert.equal(parseOptInTapId(id), null);
  assert.equal(parseOptInTapId(null), null);
});

test('parseOptInTapId: the post-booking question ids carry no link and flag bookingPrompt', () => {
  assert.deepEqual(parseOptInTapId('optin_yes:booking'), { answer: 'yes', linkId: null, bookingPrompt: true });
  assert.deepEqual(parseOptInTapId('optin_no:booking'), { answer: 'no', linkId: null, bookingPrompt: true });
  assert.equal(isSystemTapId('optin_yes:booking'), true);
  assert.equal(isSystemTapId('optin_no:booking'), true);
  // A link-style id never takes the booking path, and "booking" is not a UUID.
  const id = '0b3f6c1e-1111-4222-8333-944455556666';
  assert.equal(parseOptInTapId(`optin_yes:${id}`).bookingPrompt, undefined);
  assert.equal(parseOptInTapId('optin_yes:bookings').bookingPrompt, undefined);
});
