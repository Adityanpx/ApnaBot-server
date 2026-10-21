// Weekly opening hours for the human-needed alert ("we're closed, we'll reply <nextOpening>").
// India time only (utils/ist.js: there is no per-business timezone). Pure: no I/O.
//
// hours = { mon: [{ open: '09:00', close: '13:00' }, { open: '15:00', close: '19:00' }], tue: [], ... }
// A day that is missing or [] is closed. hours === null means "unknown": isClosedNow() is false and
// nextOpening() is null, so the closed text is never sent for such a business.
const { IST_OFFSET_MS, istMinuteOfDay } = require('./ist');

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // Date#getUTCDay order
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_RANGES_PER_DAY = 4;

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

const istDayIndex = (date) => new Date(new Date(date).getTime() + IST_OFFSET_MS).getUTCDay();

// A day's ranges as [openMinute, closeMinute] pairs, sorted.
const rangesOf = (hours, dayKey) => (Array.isArray(hours[dayKey]) ? hours[dayKey] : [])
  .map((r) => [toMinutes(r.open), toMinutes(r.close)])
  .sort((a, b) => a[0] - b[0]);

/**
 * Checks a PUT body's hours. `null` is valid (hours unknown).
 * @returns {{ok: true, hours: object|null}|{ok: false, field: string, error: string}}
 */
const validateHours = (hours) => {
  if (hours === null) return { ok: true, hours: null };
  const bad = (field, error) => ({ ok: false, field, error: `${field}: ${error}` });
  if (typeof hours !== 'object' || Array.isArray(hours)) return bad('hours', 'must be an object or null');
  const clean = {};
  for (const [day, ranges] of Object.entries(hours)) {
    if (!DAY_KEYS.includes(day)) return bad(`hours.${day}`, `unknown day (use ${DAY_KEYS.slice(1).concat('sun').join(', ')})`);
    if (!Array.isArray(ranges)) return bad(`hours.${day}`, 'must be a list of { open, close }');
    if (ranges.length > MAX_RANGES_PER_DAY) return bad(`hours.${day}`, `at most ${MAX_RANGES_PER_DAY} ranges a day`);
    const cleanRanges = [];
    for (let i = 0; i < ranges.length; i += 1) {
      const r = ranges[i];
      const where = `hours.${day}[${i}]`;
      if (r === null || typeof r !== 'object' || Array.isArray(r)) return bad(where, 'must be { open, close }');
      for (const key of Object.keys(r)) {
        if (key !== 'open' && key !== 'close') return bad(`${where}.${key}`, 'unknown setting');
      }
      for (const key of ['open', 'close']) {
        if (typeof r[key] !== 'string' || !HHMM.test(r[key])) return bad(`${where}.${key}`, 'must be HH:mm (24-hour)');
      }
      if (toMinutes(r.open) >= toMinutes(r.close)) return bad(where, 'close must be after open on the same day');
      cleanRanges.push({ open: r.open, close: r.close });
    }
    cleanRanges.sort((a, b) => toMinutes(a.open) - toMinutes(b.open));
    for (let i = 1; i < cleanRanges.length; i += 1) {
      if (toMinutes(cleanRanges[i].open) < toMinutes(cleanRanges[i - 1].close)) return bad(`hours.${day}`, 'ranges must not overlap');
    }
    clean[day] = cleanRanges;
  }
  return { ok: true, hours: clean };
};

/** True when hours are set and `now` (India time) is outside every range. hours null -> false. */
const isClosedNow = (hours, now = new Date()) => {
  if (!hours) return false;
  const minute = istMinuteOfDay(now);
  return !rangesOf(hours, DAY_KEYS[istDayIndex(now)]).some(([open, close]) => minute >= open && minute < close);
};

/**
 * The next time the business opens after `now`.
 * @returns {{dayOffset: number, dayKey: string, minute: number}|null} dayOffset 0 = today, 1 = tomorrow,
 *   ...; null when hours is null or no day has any range
 */
const nextOpening = (hours, now = new Date()) => {
  if (!hours) return null;
  const nowMinute = istMinuteOfDay(now);
  const today = istDayIndex(now);
  for (let offset = 0; offset <= 7; offset += 1) {
    const dayKey = DAY_KEYS[(today + offset) % 7];
    const opens = rangesOf(hours, dayKey).map(([open]) => open).filter((open) => offset > 0 || open > nowMinute);
    if (opens.length > 0) return { dayOffset: offset, dayKey, minute: Math.min(...opens) };
  }
  return null;
};

// ── Wording: "today at 10:00 am" / "tomorrow at 9:00 am" / "Monday at 10:00 am" ──────────────────
const WORDS = {
  en: {
    today: 'today', tomorrow: 'tomorrow',
    days: { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' }
  },
  hi: {
    today: 'आज', tomorrow: 'कल',
    days: { sun: 'रविवार को', mon: 'सोमवार को', tue: 'मंगलवार को', wed: 'बुधवार को', thu: 'गुरुवार को', fri: 'शुक्रवार को', sat: 'शनिवार को' }
  },
  mr: {
    today: 'आज', tomorrow: 'उद्या',
    days: { sun: 'रविवारी', mon: 'सोमवारी', tue: 'मंगळवारी', wed: 'बुधवारी', thu: 'गुरुवारी', fri: 'शुक्रवारी', sat: 'शनिवारी' }
  }
};
const PERIODS = {
  hi: { morning: 'सुबह', afternoon: 'दोपहर', evening: 'शाम', night: 'रात' },
  mr: { morning: 'सकाळी', afternoon: 'दुपारी', evening: 'संध्याकाळी', night: 'रात्री' }
};

const periodOf = (hour) => {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 16) return 'afternoon';
  if (hour >= 16 && hour < 20) return 'evening';
  return 'night';
};

/**
 * "today at 10:00 am" style text for nextOpening(), in en / hi / mr (any other language gets en).
 * @param {{dayOffset: number, dayKey: string, minute: number}} opening
 */
const formatOpening = (opening, language = 'en') => {
  const lang = WORDS[language] ? language : 'en';
  const words = WORDS[lang];
  const hour = Math.floor(opening.minute / 60);
  const mm = String(opening.minute % 60).padStart(2, '0');
  const day = opening.dayOffset === 0 ? words.today : opening.dayOffset === 1 ? words.tomorrow : words.days[opening.dayKey];
  if (lang === 'en') {
    return `${day} at ${hour % 12 === 0 ? 12 : hour % 12}:${mm} ${hour < 12 ? 'am' : 'pm'}`;
  }
  const clock = `${hour % 12 === 0 ? 12 : hour % 12}:${mm}`;
  return `${day} ${PERIODS[lang][periodOf(hour)]} ${clock} ${lang === 'hi' ? 'बजे' : 'वाजता'}`;
};

module.exports = { DAY_KEYS, MAX_RANGES_PER_DAY, validateHours, isClosedNow, nextOpening, formatOpening };
