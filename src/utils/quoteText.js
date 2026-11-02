// Text pieces of a travel quote shared by the quote service (the quote message) and the quote sweep
// (the reminder): money and the "valid until" time as customers read them, and the reminder itself.
// No requires beyond systemMessages, so both load it without config.
const { getSystemMessage } = require('./systemMessages');

/** 3500 -> "3,500" (Indian grouping). */
const money = (amount) => Number(amount).toLocaleString('en-IN');

/** "2 Nov, 7:30 pm" in India time. */
const formatUntil = (date) => new Date(date).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true
});

/**
 * The price part of a vehicle card in a Round Trip quote, joined with " • " like the rest of the caption.
 * @param {{ kind:'package'|'formula'|'on_request', total?:number, days?:number|null, billedKm?:number|null }} display
 * @param {string|null} lang
 */
const carouselPriceText = (display, lang) => {
  const msg = (key, vars) => getSystemMessage(key, lang, vars);
  if (display.kind === 'on_request') return msg('quoteCardOnRequest');
  const parts = [`₹${display.total}`];
  if (display.days) parts.push(msg('quoteCardDays', { days: display.days }));
  if (display.kind === 'formula') parts.push(msg('quoteCardKm', { km: money(display.billedKm) }));
  else parts.push(msg('quoteCardPackage'));
  return parts.join(' • ');
};

/**
 * The plain-text reminder sent a few hours after a quote: route, total, how long it is open, and which
 * button of the quote above books it ("Confirm & pay" when an advance is asked, else "Confirm").
 * @param {Object} quote  a travel_quotes row (snake_case)
 * @param {string|null} lang
 */
const buildReminderText = (quote, lang) => {
  const c = quote.collected || {};
  const hasAdvance = quote.advance_amount !== null && quote.advance_amount !== undefined;
  return getSystemMessage('quoteReminder', lang, {
    route: `${c.fromLabel} → ${c.toLabel}`,
    total: money(quote.total_amount),
    until: formatUntil(quote.expires_at),
    button: getSystemMessage(hasAdvance ? 'quoteBtnConfirmPay' : 'quoteBtnConfirm', lang)
  });
};

module.exports = { money, formatUntil, carouselPriceText, buildReminderText };
