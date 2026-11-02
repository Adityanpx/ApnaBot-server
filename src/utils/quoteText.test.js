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

test('carouselPriceText: formula, package and "team will confirm", in each language', () => {
  const { carouselPriceText } = require('./quoteText');
  const formula = { kind: 'formula', total: 18150, days: 3, billedKm: 750 };
  assert.equal(carouselPriceText(formula, 'en'), '₹18150 • 3 day(s) • 750 km');
  assert.equal(carouselPriceText(formula, 'hi'), '₹18150 • 3 दिन • 750 किमी');
  assert.equal(carouselPriceText(formula, 'mr'), '₹18150 • 3 दिवस • 750 किमी');
  const pkg = { kind: 'package', total: 7300, days: 2, billedKm: null };
  assert.equal(carouselPriceText(pkg, 'en'), '₹7300 • 2 day(s) • package fare');
  assert.equal(carouselPriceText({ ...pkg, days: null }, 'en'), '₹7300 • package fare');
  assert.equal(carouselPriceText({ kind: 'on_request' }, 'en'), 'Price: our team will confirm');
  assert.equal(carouselPriceText({ kind: 'on_request' }, 'mr'), 'भाडे: आमची टीम कळवेल');
  assert.equal(carouselPriceText({ kind: 'formula', total: 8810, days: 1, billedKm: 370.8 }, 'en'), '₹8810 • 1 day(s) • 370.8 km');
});
