// Run: node --test src/utils/coachingInstitutePresets.test.js
// Pure — no Supabase/Redis.
const test = require('node:test');
const assert = require('node:assert/strict');
const { INSTITUTE_PRESETS, INSTITUTE_TYPES, listInstitutePresets } = require('./coachingInstitutePresets');
const { validateCoachingSettings, mapCoachingSettingsToSpec } = require('./coachingBotSettings');
const { hasPlaceholder } = require('./courseValidation');

const welcome = 'Hello *{{customerName}}*!\n\nPlease choose an option:';
// What the Bot Builder page saves after applying a preset: its settings +
// the owner's own welcome message + instituteType.
const applied = (key) => ({ version: 1, welcomeMessage: welcome, intro: '', ...INSTITUTE_PRESETS[key].settings, instituteType: key });
const fillBlanks = (v) => JSON.parse(JSON.stringify(v).replace(/_{3,}/g, '5'));
const courses = [{ name: 'Abacus', details: 'Abacus details', showDemoButton: true, showAdmissionButton: true }];

test('three presets, listed in order with title, hint, suggested courses', () => {
  assert.deepEqual(INSTITUTE_TYPES, ['skill', 'competitive', 'tuition']);
  for (const p of listInstitutePresets()) {
    assert.ok(p.key && p.title && p.hint && p.suggestedCourses.length > 0, p.key);
  }
});

for (const key of ['skill', 'competitive', 'tuition']) {
  test(`${key}: saves as a draft, but publish refuses its ____ blanks until filled in`, () => {
    const s = applied(key);
    assert.equal(validateCoachingSettings(s), null);
    assert.ok(hasPlaceholder(JSON.stringify(s.sections)) || hasPlaceholder(JSON.stringify(s.faq)));
    assert.match(mapCoachingSettingsToSpec(s, { businessName: 'Test Classes', courses }).error, /fill in the blanks \(____\)/);
    const filled = fillBlanks(s);
    assert.equal(mapCoachingSettingsToSpec(filled, { businessName: 'Test Classes', courses }).error, null);
  });
}

test('instituteType: optional, one of the presets', () => {
  const s = applied('skill');
  assert.equal(validateCoachingSettings({ ...s, instituteType: undefined }), null);
  assert.equal(validateCoachingSettings({ ...s, instituteType: null }), null);
  assert.match(validateCoachingSettings({ ...s, instituteType: 'gym' }), /instituteType must be one of: skill, competitive, tuition/);
});

test('publish refuses ____ in a section, the welcome message, a form note and an FAQ answer', () => {
  const base = fillBlanks(applied('tuition'));
  const ctx = { businessName: 'Test Classes', courses };
  assert.equal(mapCoachingSettingsToSpec(base, ctx).error, null);
  const withBlank = (fn) => { const s = JSON.parse(JSON.stringify(base)); fn(s); return mapCoachingSettingsToSpec(s, ctx).error; };
  assert.match(withBlank(s => { s.sections.fees.text = 'Fees ₹____'; }), /Fees: fill in the blanks/);
  assert.match(withBlank(s => { s.welcomeMessage = 'Hi ____'; }), /Welcome message: fill in the blanks/);
  assert.match(withBlank(s => { s.admissionForm.note = 'Bring ____ photos'; }), /Admission form: fill in the blanks \(____\) in the note/);
  assert.match(withBlank(s => { s.faq.items[0].answer = '____'; }), /FAQ question 1: fill in the blanks/);
  // a switched-off section may keep blanks
  assert.equal(withBlank(s => { s.sections.results = { enabled: false, text: 'Top rank ____' }; }), null);
});
