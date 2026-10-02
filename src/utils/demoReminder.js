// Free demo reminders (coaching Bot Builder, settings.demoForm.reminder) —
// the pure parts: when a reminder goes out, how a demo time reads, the
// parent-facing wording, and the WhatsApp template used when the parent is
// outside the 24-hour window. Sending lives in demoReminder.service.js.
//
// Times are shown and "evening before" is computed in India time — the
// product is India-only today (see broadcast.controller.js countryCode).

const REMINDER_CHOICES = ['off', '2h', 'evening'];
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const EVENING_HOUR_IST = 19;
// A demo can be fixed up to this far ahead (also bounds the delayed job).
const MAX_DAYS_AHEAD = 90;

// One template per business, created + submitted to Meta on Publish when a
// reminder is switched on. Neutral wording so it also carries the
// confirmation when the parent's 24-hour window has closed.
const REMINDER_TEMPLATE = {
  name: 'apnabot_demo_class',
  category: 'UTILITY',
  language: 'en_US',
  bodyText: "Hi! {{1}}'s free demo class for {{2}} at {{3}} is on {{4}}. Reply here if you need to change it.",
  variableSamples: ['Aarav', 'Abacus', 'Bright Minds Academy', 'Sat 4 Oct, 10:00 AM']
};

/** "Sat 4 Oct, 10:00 AM" in India time. */
const formatDemoTime = (date) => {
  const d = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const h = d.getUTCHours();
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  return `${weekday} ${d.getUTCDate()} ${month}, ${hour12}:${minutes} ${h < 12 ? 'AM' : 'PM'}`;
};

/**
 * When the reminder for a demo at `demoAt` goes out, or null for 'off'.
 * 'evening' = 7 PM India time on the day before the demo.
 */
const reminderAt = (demoAt, choice) => {
  const demo = new Date(demoAt).getTime();
  if (choice === '2h') return new Date(demo - 2 * HOUR_MS);
  if (choice === 'evening') {
    const ist = new Date(demo + IST_OFFSET_MS);
    const dayBefore7pmIst = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - 1, EVENING_HOUR_IST);
    return new Date(dayBefore7pmIst - IST_OFFSET_MS);
  }
  return null;
};

/** The booking's parent-facing details, with fallbacks so no template value is ever empty. */
const demoDetails = (booking, businessName, demoAt) => {
  const fields = booking.fields || {};
  const clean = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
  return {
    student: clean(fields.studentName, 'Your child'),
    course: clean(fields.course, 'the course'),
    business: clean(businessName, 'our institute'),
    time: formatDemoTime(demoAt)
  };
};

const confirmationText = (d) =>
  `✅ ${d.student}'s free demo class for ${d.course} is fixed for ${d.time}. Reply here if you need to change it.`;

const reminderText = (d) =>
  `⏰ Reminder: ${d.student}'s free demo class for ${d.course} at ${d.business} is on ${d.time}. Reply here if you can't make it.`;

/** {{1}}..{{4}} of REMINDER_TEMPLATE, and the same message as it reads in the chat. */
const templateParams = (d) => [d.student, d.course, d.business, d.time];
const templateText = (d) => templateParams(d)
  .reduce((text, value, i) => text.replace(`{{${i + 1}}}`, value), REMINDER_TEMPLATE.bodyText);

module.exports = {
  REMINDER_CHOICES,
  REMINDER_TEMPLATE,
  MAX_DAYS_AHEAD,
  formatDemoTime,
  reminderAt,
  demoDetails,
  confirmationText,
  reminderText,
  templateParams,
  templateText
};
