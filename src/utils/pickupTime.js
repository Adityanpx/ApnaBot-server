// Reads a pickup time a customer chose or typed in a quote flow and returns the minute of the day
// (0-1439), or null when it is not a clear time. The night charge is priced from this minute, so an
// unclear answer is never guessed: the flow asks again instead.
//
// Accepted: "6:30 AM", "6.30 pm", "6 am", "6pm", "18:30", "18.30", "1830", "noon", "midnight",
// and the same with Devanagari digits (Hindi / Marathi keyboards). A bare "6" is not accepted
// (morning or evening is unknown).

const DEVANAGARI_DIGITS = '०१२३४५६७८९';

const toAsciiDigits = (text) => text.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));

/** @returns {number|null} minute of the day, or null */
const parsePickupMinute = (value) => {
  if (value === null || value === undefined) return null;
  const text = toAsciiDigits(String(value)).trim().toLowerCase().replace(/\s+/g, ' ');
  if (text === 'noon' || text === 'midday') return 12 * 60;
  if (text === 'midnight') return 0;

  // 12-hour clock with am / pm: 6, 6:30, 6.30 (+ optional space) am|pm|a.m.|p.m.
  const twelve = text.match(/^(\d{1,2})(?:[:.](\d{2}))?\s?([ap])\.?m\.?$/);
  if (twelve) {
    const hour = Number(twelve[1]);
    const minute = twelve[2] === undefined ? 0 : Number(twelve[2]);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    return ((hour % 12) + (twelve[3] === 'p' ? 12 : 0)) * 60 + minute;
  }

  // 24-hour clock: 18:30, 18.30, 1830, 06:05
  const twentyFour = text.match(/^(\d{1,2})[:.](\d{2})$/) || text.match(/^(\d{2})(\d{2})$/);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    const minute = Number(twentyFour[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  }
  return null;
};

module.exports = { parsePickupMinute };
