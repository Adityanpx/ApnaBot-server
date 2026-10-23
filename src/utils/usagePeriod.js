// Which usage period a subscription is in right now. Pure: no I/O.
//
// A period is not a calendar month - it starts when the subscription's current billing period
// starts (subscriptions.current_period_start) and the message counter restarts with it.
//   - autopay: Razorpay's real cycle - current_period_start .. end_date. Until the activated webhook
//     sets current_period_start, end_date is only the 48-hour placeholder, so periodEnd is null.
//   - everything else (one-time purchase, trial, admin grant): one-month windows counted from
//     current_period_start, so a 3-month purchase, or an early renewal stacked on the remaining time,
//     still resets each month; a window never runs past end_date.
//   - no subscription: the India-time calendar month (the bot is gated off anyway).
const { istMonthStart } = require('./ist');

const addMonthsUtc = (date, months) => {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
};

const toDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * @param {Object|null} subscription snake_case subscriptions row
 * @param {Date} [now]
 * @returns {{ periodStart: Date, periodEnd: Date|null }}
 */
const resolvePeriod = (subscription, now = new Date()) => {
  const anchor = toDate(subscription?.current_period_start) || toDate(subscription?.start_date);
  if (!anchor) return { periodStart: istMonthStart(now), periodEnd: istMonthStart(now, 1) };

  const subEnd = toDate(subscription.end_date);

  if (subscription.is_autopay) {
    const hasRealCycle = !!toDate(subscription.current_period_start);
    return { periodStart: anchor, periodEnd: hasRealCycle ? subEnd : null };
  }

  let k = 0;
  if (anchor.getTime() < now.getTime()) {
    const monthsApart = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
    k = Math.max(monthsApart, 0);
    while (k > 0 && addMonthsUtc(anchor, k).getTime() > now.getTime()) k -= 1;
    while (addMonthsUtc(anchor, k + 1).getTime() <= now.getTime()) k += 1;
  }
  const periodStart = addMonthsUtc(anchor, k);
  const nextStart = addMonthsUtc(anchor, k + 1);
  const periodEnd = subEnd && subEnd.getTime() < nextStart.getTime() ? subEnd : nextStart;
  return { periodStart, periodEnd };
};

module.exports = { resolvePeriod, addMonthsUtc };
