// Run: node --test src/utils/quoteText.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { money, formatUntil, buildReminderText } = require('./quoteText');

const quote = (over = {}) => ({
  total_amount: 12345, advance_amount: 2469, expires_at: '2026-11-11T14:00:00.000Z',
  collected: { fromLabel: 'A City Name Here 24', toLabel: 'Another City Name 24' }, ...over
});

test('money uses Indian grouping; the time is India time', () => {
  assert.equal(money(3500), '3,500');
  assert.equal(money(1234567), '12,34,567');
  assert.match(formatUntil('2026-11-11T14:00:00.000Z'), /^11 Nov,? 7:30 pm$/i);
});

test('the reminder names the route, total, deadline and the right button, in every language, within a message body', () => {
  for (const lang of ['en', 'hi', 'mr', null]) {
    const withAdvance = buildReminderText(quote(), lang);
    const without = buildReminderText(quote({ advance_amount: null }), lang);
    for (const text of [withAdvance, without]) {
      assert.ok(text.includes('A City Name Here 24 → Another City Name 24'), lang);
      assert.ok(text.includes('12,345'), lang);
      assert.ok(!text.includes('{{'), `${lang}: unfilled placeholder`);
      assert.ok(text.length <= 1024, lang);
    }
  }
  assert.ok(buildReminderText(quote(), 'en').includes('*Confirm & pay*'));
  assert.ok(buildReminderText(quote({ advance_amount: null }), 'en').includes('*Confirm*'));
  assert.ok(buildReminderText(quote(), 'hi').includes('पुष्टि व भुगतान'));
  assert.ok(buildReminderText(quote(), 'mr').includes('पुष्टी व पेमेंट'));
});
