// India time (IST, UTC+05:30, no daylight saving) helpers. The product is
// India-only today (see broadcast.controller.js countryCode) and there is no
// per-business timezone, so "send hours", "the evening before" and "today"
// are all India time. Used by Free demo reminders (utils/demoReminder.js)
// and follow-up automations.

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Minutes since 00:00 India time, 0–1439. */
const istMinuteOfDay = (date) => {
  const d = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** The instant 00:00 India time began on `date`'s India-time day. */
const istDayStart = (date) => {
  const ist = new Date(date).getTime() + IST_OFFSET_MS;
  return new Date(Math.floor(ist / DAY_MS) * DAY_MS - IST_OFFSET_MS);
};

/**
 * Whether `date` falls inside the send hours [startMinute, endMinute) in
 * India time. A start after the end wraps past midnight (e.g. 1320–480 =
 * 10 PM to 8 AM); equal start and end is an empty window.
 */
const isWithinSendHours = (date, startMinute, endMinute) => {
  const m = istMinuteOfDay(date);
  if (startMinute < endMinute) return m >= startMinute && m < endMinute;
  if (startMinute > endMinute) return m >= startMinute || m < endMinute;
  return false;
};

/** The first instant at or after `date` whose India time is startMinute (00 seconds). */
const nextSendHoursStart = (date, startMinute) => {
  const at = new Date(date).getTime();
  const today = istDayStart(date).getTime() + startMinute * MINUTE_MS;
  return new Date(today >= at ? today : today + DAY_MS);
};

module.exports = {
  IST_OFFSET_MS,
  istMinuteOfDay,
  istDayStart,
  isWithinSendHours,
  nextSendHoursStart
};
