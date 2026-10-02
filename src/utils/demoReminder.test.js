// Run: node --test src/utils/demoReminder.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatDemoTime, reminderAt, demoDetails, confirmationText, reminderText, templateParams, templateText, REMINDER_TEMPLATE
} = require('./demoReminder');
const { validateCoachingSettings, demoReminderFor } = require('./coachingBotSettings');

// Sun 4 Oct 2026, 10:00 AM India time = 04:30 UTC
const DEMO = '2026-10-04T04:30:00.000Z';

test('demo time reads in India time', () => {
  assert.equal(formatDemoTime(DEMO), 'Sun 4 Oct, 10:00 AM');
  assert.equal(formatDemoTime('2026-10-04T12:45:00.000Z'), 'Sun 4 Oct, 6:15 PM');
  assert.equal(formatDemoTime('2026-10-03T18:30:00.000Z'), 'Sun 4 Oct, 12:00 AM'); // midnight IST
});

test('reminder times', () => {
  assert.equal(reminderAt(DEMO, '2h').toISOString(), '2026-10-04T02:30:00.000Z');
  // Evening before = Sat 3 Oct, 7:00 PM IST = 13:30 UTC
  assert.equal(reminderAt(DEMO, 'evening').toISOString(), '2026-10-03T13:30:00.000Z');
  // A 1 AM (IST) demo on 5 Oct is still "the evening before" = 4 Oct 7 PM IST,
  // even though in UTC the demo is on 4 Oct.
  assert.equal(reminderAt('2026-10-04T19:30:00.000Z', 'evening').toISOString(), '2026-10-04T13:30:00.000Z');
  // Month boundary: demo 1 Nov 10 AM IST → 31 Oct 7 PM IST
  assert.equal(reminderAt('2026-11-01T04:30:00.000Z', 'evening').toISOString(), '2026-10-31T13:30:00.000Z');
  assert.equal(reminderAt(DEMO, 'off'), null);
});

test('wording, with fallbacks so no template value is empty', () => {
  const d = demoDetails({ fields: { studentName: ' Aarav ', course: 'Abacus' } }, 'Bright Minds', DEMO);
  assert.equal(confirmationText(d), "✅ Aarav's free demo class for Abacus is fixed for Sun 4 Oct, 10:00 AM. Reply here if you need to change it.");
  assert.equal(reminderText(d), "⏰ Reminder: Aarav's free demo class for Abacus at Bright Minds is on Sun 4 Oct, 10:00 AM. Reply here if you can't make it.");
  assert.equal(templateText(d), "Hi! Aarav's free demo class for Abacus at Bright Minds is on Sun 4 Oct, 10:00 AM. Reply here if you need to change it.");

  const empty = demoDetails({ fields: { studentName: '  ' } }, '', DEMO);
  assert.deepEqual(templateParams(empty), ['Your child', 'the course', 'our institute', 'Sun 4 Oct, 10:00 AM']);
  assert.equal(REMINDER_TEMPLATE.variableSamples.length, (REMINDER_TEMPLATE.bodyText.match(/\{\{\d\}\}/g) || []).length);
});

const settingsWith = (demoForm, admissionForm = {}) => ({
  version: 1,
  sections: {
    fees: { enabled: false }, timings: { enabled: false }, results: { enabled: false },
    material: { enabled: false }, contact: { enabled: false }, location: { enabled: false }
  },
  demoForm: { enabled: true, fields: [], ...demoForm },
  admissionForm: { enabled: false, fields: [], ...admissionForm }
});

test('settings: reminder only on the Free demo form, one of off / 2h / evening', () => {
  for (const reminder of [undefined, null, 'off', '2h', 'evening']) {
    assert.equal(validateCoachingSettings(settingsWith({ reminder }), { forPublish: false }), null, String(reminder));
  }
  assert.match(validateCoachingSettings(settingsWith({ reminder: '1h' }), { forPublish: false }), /reminder must be one of/);
  assert.match(validateCoachingSettings(settingsWith({}, { reminder: '2h' }), { forPublish: false }), /only be set on the Free demo form/);
});

test('demoReminderFor reads the published settings', () => {
  assert.equal(demoReminderFor(settingsWith({ reminder: 'evening' })), 'evening');
  assert.equal(demoReminderFor(settingsWith({ reminder: 'off' })), null);
  assert.equal(demoReminderFor(settingsWith({ reminder: '2h', enabled: false })), null);
  assert.equal(demoReminderFor(settingsWith({})), null);
  assert.equal(demoReminderFor(null), null);
});
