// Validation of a customer's typed answers to booking-form questions, shared by the WhatsApp bot
// (services/bookingGraph.service.js) and the web-form submit endpoint
// (controllers/publicServiceForm.controller.js) so both enforce the same rules.
//
// Pure: no I/O. Every failure is { ok: false, code, messageKey, vars } - the caller renders the
// message with getSystemMessage(messageKey, language, vars) so it is localized.
//
// Dates are compared as whole India-time days (utils/ist.js: there is no per-business timezone).
const { IST_OFFSET_MS } = require('./ist');
const { DAY_KEYS } = require('./handoffHours');

const DAY_MS = 24 * 60 * 60 * 1000;

// Furthest a date answer may lie ahead of today.
const MAX_DAYS_AHEAD = 365;

const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 60;

// Letters (any script) and combining marks, plus space . ' ’ -
const NAME_ALLOWED = /^[\p{L}\p{M} .'’-]+$/u;
const HAS_LETTER = /\p{L}/u;

// "Name" questions are found by field key: a person's name. A key ending in Name that names a
// thing (shopName, courseName, ...) is free text and not validated as a person's name.
const NAME_KEY = /name$/i;
const NON_PERSON_NAME_KEY = /(shop|business|company|firm|brand|course|vehicle|hotel|college|school|institute|product|item|file|user|display|custom|route|package|plan|service|organi[sz]ation)_?name$/i;
// Date questions: travelDate, preferredDate, checkIn, checkOut, ... (not a birth date, which is in the past).
const DATE_KEY = /(date|check_?in|check_?out)$/i;
const BIRTH_KEY = /(dob|birth)/i;
const CHECK_IN_KEY = /^check_?in(date)?$/i;
const CHECK_OUT_KEY = /^check_?out(date)?$/i;

const isNameField = (key) => typeof key === 'string' && NAME_KEY.test(key) && !NON_PERSON_NAME_KEY.test(key);
const isDateField = (key) => typeof key === 'string' && DATE_KEY.test(key) && !BIRTH_KEY.test(key);
const isCheckInField = (key) => typeof key === 'string' && CHECK_IN_KEY.test(key);
const isCheckOutField = (key) => typeof key === 'string' && CHECK_OUT_KEY.test(key);

const fail = (code, messageKey, vars) => ({ ok: false, code, messageKey, ...(vars ? { vars } : {}) });

/**
 * A person's name: trimmed, repeated spaces collapsed, 2-60 characters, letters of any script
 * with space . ' - only, and at least one letter.
 * @returns {{ok: true, value: string}|{ok: false, code: 'invalid_name', messageKey: string}}
 */
const validateName = (raw) => {
  const value = String(raw ?? '').trim().replace(/\s+/g, ' ');
  const length = [...value].length;
  if (length < NAME_MIN_LENGTH || length > NAME_MAX_LENGTH || !NAME_ALLOWED.test(value) || !HAS_LETTER.test(value)) {
    return fail('invalid_name', 'invalidName');
  }
  return { ok: true, value };
};

// Whole-day numbers (days since 1970-01-01, India calendar day).
const dayNumber = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
const todayNumber = (now = new Date()) => Math.floor((new Date(now).getTime() + IST_OFFSET_MS) / DAY_MS);
const partsOf = (dayNum) => {
  const dt = new Date(dayNum * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};
const isRealDate = (y, m, d) => {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthFromName = (word) => {
  const idx = MONTHS.indexOf(String(word).slice(0, 3).toLowerCase());
  return idx === -1 || !/^[a-z]+$/i.test(word) ? 0 : idx + 1;
};
const fullYear = (y) => (y < 100 ? 2000 + y : y);

/**
 * Reads a typed date. Understands 2026-12-25, 25/12/2026, 25-12-26, 25.12.2026, 25/12 (this year),
 * 25 Dec 2026, Dec 25, "today" and "tomorrow".
 * @returns {{status: 'ok', dayNum: number}|{status: 'invalid'}|{status: 'unrecognized'}}
 *   invalid = looks like a date but is not a real one (31/02/2026); unrecognized = free text.
 */
const parseDateInput = (raw, now = new Date()) => {
  const text = String(raw ?? '').trim();
  const today = todayNumber(now);
  const thisYear = partsOf(today).y;
  const lower = text.toLowerCase();
  if (lower === 'today') return { status: 'ok', dayNum: today };
  if (lower === 'tomorrow') return { status: 'ok', dayNum: today + 1 };

  const build = (y, m, d) => (isRealDate(y, m, d) ? { status: 'ok', dayNum: dayNumber(y, m, d) } : { status: 'invalid' });
  let match;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text))) return build(+match[1], +match[2], +match[3]);
  if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(text))) return build(fullYear(+match[3]), +match[2], +match[1]);
  if ((match = /^(\d{1,2})[/.-](\d{1,2})$/.exec(text))) return build(thisYear, +match[2], +match[1]);
  if ((match = /^(\d{1,2})(?:st|nd|rd|th)?[ -]+([a-z]+)\.?(?:,?[ -]+(\d{4}|\d{2}))?$/i.exec(text)) && monthFromName(match[2])) {
    return build(match[3] ? fullYear(+match[3]) : thisYear, monthFromName(match[2]), +match[1]);
  }
  if ((match = /^([a-z]+)\.?[ -]+(\d{1,2})(?:st|nd|rd|th)?(?:,?[ -]+(\d{4}|\d{2}))?$/i.exec(text)) && monthFromName(match[1])) {
    return build(match[3] ? fullYear(+match[3]) : thisYear, monthFromName(match[1]), +match[2]);
  }
  return { status: 'unrecognized' };
};

// A business's weekly hours (handoffHours.js shape) count only when at least one day is open;
// {} or all-empty days means "not really configured".
const hasWeeklyHours = (hours) => !!hours && typeof hours === 'object' && !Array.isArray(hours) &&
  DAY_KEYS.some((key) => Array.isArray(hours[key]) && hours[key].length > 0);
const isClosedOn = (hours, dayNum) => {
  const key = DAY_KEYS[new Date(dayNum * DAY_MS).getUTCDay()];
  return !(Array.isArray(hours[key]) && hours[key].length > 0);
};

const localeFor = (languageCode) => `${languageCode || 'en'}-IN`;
const formatDay = (dayNum, options, languageCode) => {
  const dt = new Date(dayNum * DAY_MS);
  try {
    return new Intl.DateTimeFormat(localeFor(languageCode), { ...options, timeZone: 'UTC' }).format(dt);
  } catch {
    return new Intl.DateTimeFormat('en-IN', { ...options, timeZone: 'UTC' }).format(dt);
  }
};

/**
 * Checks a typed date answer.
 * @param {string} raw - what the customer typed / the form sent
 * @param {Object} [opts]
 * @param {Date} [opts.now]
 * @param {boolean} [opts.strict=false] - true: text that is not a date at all is invalid (the web
 *   form's date picker always sends one). false: it is accepted as typed (a WhatsApp customer's
 *   free text such as "next Friday" cannot be checked).
 * @param {Object|null} [opts.hours] - weekly opening hours; a day with no range is closed
 * @param {boolean} [opts.checkClosed=true] - false for a check-out / departure day
 * @param {string} [opts.checkIn] - the already-given check-in answer, when this is the check-out
 * @param {string|null} [opts.language] - for the day/date names in the closed-day message
 * @returns {{ok: true, value: string}|{ok: false, code: string, messageKey: string, vars?: Object}}
 */
const validateDateAnswer = (raw, opts = {}) => {
  const { now = new Date(), strict = false, hours = null, checkClosed = true, checkIn = null, language = null } = opts;
  const value = String(raw ?? '').trim();
  const parsed = parseDateInput(value, now);
  if (parsed.status === 'invalid' || (parsed.status === 'unrecognized' && strict)) {
    return fail('invalid_date', 'invalidDate');
  }
  if (parsed.status === 'unrecognized') return { ok: true, value };

  const today = todayNumber(now);
  if (parsed.dayNum < today) return fail('date_in_past', 'datePast');
  if (parsed.dayNum > today + MAX_DAYS_AHEAD) return fail('date_too_far', 'dateTooFar', { days: MAX_DAYS_AHEAD });

  if (checkIn) {
    const inDate = parseDateInput(checkIn, now);
    if (inDate.status === 'ok' && parsed.dayNum <= inDate.dayNum) {
      return fail('checkout_not_after_checkin', 'checkoutNotAfterCheckin');
    }
  }

  if (checkClosed && hasWeeklyHours(hours) && isClosedOn(hours, parsed.dayNum)) {
    let next = parsed.dayNum + 1;
    while (next <= today + MAX_DAYS_AHEAD && isClosedOn(hours, next)) next += 1;
    return fail('closed_day', 'dateClosed', {
      day: formatDay(parsed.dayNum, { weekday: 'long' }, language),
      date: formatDay(next, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }, language)
    });
  }
  return { ok: true, value };
};

module.exports = {
  MAX_DAYS_AHEAD,
  NAME_MIN_LENGTH,
  NAME_MAX_LENGTH,
  isNameField,
  isDateField,
  isCheckInField,
  isCheckOutField,
  validateName,
  parseDateInput,
  validateDateAnswer
};
