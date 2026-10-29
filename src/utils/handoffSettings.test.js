// Run: node --test src/utils/handoffSettings.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_KEYWORDS, DEFAULTS, fromRow, toRow, toApi, effectiveKeywords, validateSettingsInput } = require('./handoffSettings');

const BIZ = { enabledLanguages: ['en', 'hi'] };
const check = (body) => validateSettingsInput(body, BIZ);

test('default keywords are the agreed list, without "person" and bare "बात"', () => {
  assert.deepEqual(DEFAULT_KEYWORDS, [
    'talk to', 'speak to', 'call me', 'agent', 'human', 'owner', 'customer care',
    'बात करनी है', 'बात करना', 'बोलायचं आहे', 'बोलायचे आहे', 'मालक',
    'baat karni', 'baat karna', 'bolaycha', 'malak'
  ]);
  assert.equal(DEFAULT_KEYWORDS.includes('person'), false);
  assert.equal(DEFAULT_KEYWORDS.includes('बात'), false);
});

test('defaults: off, 3 unmatched, no pause, 15-minute reminder, no hours', () => {
  assert.deepEqual(DEFAULTS, {
    enabled: false, keywords: null, unmatchedThreshold: 3, replyText: '', replyTextTranslations: {},
    closedText: '', closedTextTranslations: {}, pauseBotMinutes: 0, reminderMinutes: 15, autoResumeBot: false,
    mediaReplyMode: 'default', mediaReplyText: '', mediaReplyTextTranslations: {}, hours: null
  });
});

test('row <-> settings round trip; the GET body carries the keywords in effect', () => {
  const settings = { ...DEFAULTS, enabled: true, keywords: ['manager'], replyText: 'Hi', hours: { mon: [] }, pauseBotMinutes: 30 };
  assert.deepEqual(fromRow({ ...toRow(settings), business_id: 'b' }), settings);
  assert.deepEqual(effectiveKeywords(DEFAULTS), DEFAULT_KEYWORDS);
  assert.deepEqual(toApi(DEFAULTS).keywords, DEFAULT_KEYWORDS);
  assert.deepEqual(toApi(settings).keywords, ['manager']);
  assert.equal(fromRow({ enabled: true }).unmatchedThreshold, 3);
});

test('validate: a good partial body becomes a patch of only what was sent', () => {
  const r = check({
    enabled: true, keywords: [' talk  to ', 'Agent', 'agent'], unmatchedThreshold: 0, replyText: ' Hello ',
    replyTextTranslations: { hi: ' नमस्ते ' }, closedText: 'Closed {{nextOpening}}', pauseBotMinutes: 60,
    reminderMinutes: 0, autoResumeBot: true, hours: { mon: [{ open: '09:00', close: '18:00' }] }
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.patch, {
    enabled: true, keywords: ['talk to', 'Agent'], unmatchedThreshold: 0, replyText: 'Hello',
    replyTextTranslations: { hi: 'नमस्ते' }, closedText: 'Closed {{nextOpening}}', pauseBotMinutes: 60,
    reminderMinutes: 0, autoResumeBot: true, hours: { mon: [{ open: '09:00', close: '18:00' }] }
  });
  assert.deepEqual(check({}).patch, {});
  assert.equal(check({ keywords: null }).patch.keywords, null);
  assert.equal(check({ hours: null }).patch.hours, null);
});

test('validate: unknown keys and bad values are refused, naming the field', () => {
  const field = (body) => {
    const r = check(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.ok(r.error.startsWith(`${r.field}:`));
    return r.field;
  };
  assert.equal(field('x'), 'body');
  assert.equal(field([]), 'body');
  assert.equal(field({ nope: 1 }), 'nope');
  assert.equal(field({ enabled: 'yes' }), 'enabled');
  assert.equal(field({ autoResumeBot: 1 }), 'autoResumeBot');
  assert.equal(field({ keywords: 'agent' }), 'keywords');
  assert.equal(field({ keywords: [''] }), 'keywords[0]');
  assert.equal(field({ keywords: [5] }), 'keywords[0]');
  assert.equal(field({ keywords: ['one two three four five six seven'] }), 'keywords[0]');
  assert.equal(field({ keywords: Array.from({ length: 51 }, (_, i) => `k${i}`) }), 'keywords');
  assert.equal(field({ unmatchedThreshold: 11 }), 'unmatchedThreshold');
  assert.equal(field({ unmatchedThreshold: -1 }), 'unmatchedThreshold');
  assert.equal(field({ unmatchedThreshold: 2.5 }), 'unmatchedThreshold');
  assert.equal(field({ pauseBotMinutes: 10081 }), 'pauseBotMinutes');
  assert.equal(field({ reminderMinutes: '15' }), 'reminderMinutes');
  assert.equal(field({ reminderMinutes: 1441 }), 'reminderMinutes');
  assert.equal(field({ replyText: 5 }), 'replyText');
  assert.equal(field({ closedText: 'x'.repeat(1001) }), 'closedText');
  assert.equal(field({ replyTextTranslations: [] }), 'replyTextTranslations');
  assert.equal(field({ replyTextTranslations: { mr: 'x' } }), 'replyTextTranslations.mr'); // mr not enabled for this business
  assert.equal(field({ replyTextTranslations: { zz: 'x' } }), 'replyTextTranslations.zz');
  assert.equal(field({ closedTextTranslations: { hi: 5 } }), 'closedTextTranslations.hi');
  assert.equal(field({ hours: { mon: [{ open: '09:00' }] } }), 'hours.mon[0].close');
});

test('media reply setting: default mode, round trip, validation', () => {
  assert.equal(DEFAULTS.mediaReplyMode, 'default');
  // A row from before the columns existed reads as the default mode.
  assert.equal(fromRow({ enabled: true }).mediaReplyMode, 'default');
  const settings = { ...DEFAULTS, mediaReplyMode: 'thank_and_alert', mediaReplyText: 'Got it', mediaReplyTextTranslations: { hi: 'ठीक है' } };
  assert.deepEqual(fromRow({ ...toRow(settings), business_id: 'b' }), settings);
  assert.equal(toRow(settings).media_reply_mode, 'thank_and_alert');

  const ok = check({ mediaReplyMode: 'thank_and_alert', mediaReplyText: ' Thanks ', mediaReplyTextTranslations: { hi: ' शुक्रिया ' } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.patch, { mediaReplyMode: 'thank_and_alert', mediaReplyText: 'Thanks', mediaReplyTextTranslations: { hi: 'शुक्रिया' } });

  assert.equal(check({ mediaReplyMode: 'always' }).field, 'mediaReplyMode');
  assert.equal(check({ mediaReplyMode: true }).field, 'mediaReplyMode');
  assert.equal(check({ mediaReplyText: 5 }).field, 'mediaReplyText');
  assert.equal(check({ mediaReplyText: 'x'.repeat(1001) }).field, 'mediaReplyText');
  assert.equal(check({ mediaReplyTextTranslations: { mr: 'x' } }).field, 'mediaReplyTextTranslations.mr');
});
