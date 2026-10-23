// Run: node --test src/utils/answerValidation.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_DAYS_AHEAD, isNameField, isDateField, isCheckInField, isCheckOutField, validateName, parseDateInput, validateDateAnswer
} = require('./answerValidation');

// Tuesday 2026-10-20 10:00 IST
const NOW = new Date('2026-10-20T04:30:00Z');
const MON_TO_SAT = { sun: [], mon: [{ open: '09:00', close: '18:00' }], tue: [{ open: '09:00', close: '18:00' }], wed: [{ open: '09:00', close: '18:00' }], thu: [{ open: '09:00', close: '18:00' }], fri: [{ open: '09:00', close: '18:00' }], sat: [{ open: '09:00', close: '18:00' }] };

test('names: trimmed, collapsed, accepted', () => {
  assert.deepEqual(validateName('  Suresh   Kumar '), { ok: true, value: 'Suresh Kumar' });
  assert.equal(validateName("O'Brien-Smith Jr.").ok, true);
  assert.equal(validateName('सुरेश कुमार').ok, true);
  assert.equal(validateName('अनुराग').ok, true); // combining marks
  assert.equal(validateName('Ab').ok, true);
});

test('names: rejected', () => {
  for (const bad of ['', '   ', 'A', '1234', '@#$%', "' OR 1=1;", '😊🎉', '...', '- -', 'Ravi123', 'a'.repeat(61), 'Suresh <b>']) {
    const r = validateName(bad);
    assert.equal(r.ok, false, `should reject ${JSON.stringify(bad)}`);
    assert.equal(r.code, 'invalid_name');
    assert.equal(r.messageKey, 'invalidName');
  }
  assert.equal(validateName('a'.repeat(60)).ok, true);
});

test('field detection by key', () => {
  for (const k of ['customerName', 'studentName', 'name', 'yourFullName', 'patientName']) assert.equal(isNameField(k), true, k);
  for (const k of ['shopName', 'courseName', 'business_name', 'phone', 'nameless']) assert.equal(isNameField(k), false, k);
  for (const k of ['travelDate', 'preferredDate', 'checkIn', 'checkOut', 'returnDate']) assert.equal(isDateField(k), true, k);
  for (const k of ['dateOfBirth', 'dob', 'name', 'updated']) assert.equal(isDateField(k), false, k);
  assert.equal(isCheckInField('checkIn'), true);
  assert.equal(isCheckOutField('checkOut'), true);
  assert.equal(isCheckOutField('checkIn'), false);
});

test('parseDateInput formats', () => {
  const day = (s) => { const r = parseDateInput(s, NOW); assert.equal(r.status, 'ok', s); return new Date(r.dayNum * 86400000).toISOString().slice(0, 10); };
  assert.equal(day('2026-12-25'), '2026-12-25');
  assert.equal(day('25/12/2026'), '2026-12-25');
  assert.equal(day('25-12-26'), '2026-12-25');
  assert.equal(day('25.12.2026'), '2026-12-25');
  assert.equal(day('25/12'), '2026-12-25');
  assert.equal(day('25 Dec 2026'), '2026-12-25');
  assert.equal(day('Dec 25'), '2026-12-25');
  assert.equal(day('25th December'), '2026-12-25');
  assert.equal(day('today'), '2026-10-20');
  assert.equal(day('Tomorrow'), '2026-10-21');
  assert.equal(parseDateInput('31/02/2026', NOW).status, 'invalid');
  assert.equal(parseDateInput('next friday', NOW).status, 'unrecognized');
});

test('dates: today is allowed, yesterday is not, IST day boundary', () => {
  assert.equal(validateDateAnswer('20/10/2026', { now: NOW }).ok, true);
  assert.equal(validateDateAnswer('19/10/2026', { now: NOW }).code, 'date_in_past');
  // 23:30 UTC on the 19th is already 05:00 IST on the 20th
  const lateUtc = new Date('2026-10-19T23:30:00Z');
  assert.equal(validateDateAnswer('20/10/2026', { now: lateUtc }).ok, true);
  assert.equal(validateDateAnswer('19/10/2026', { now: lateUtc }).code, 'date_in_past');
});

test('dates: 365-day horizon', () => {
  assert.equal(MAX_DAYS_AHEAD, 365);
  assert.equal(validateDateAnswer('20/10/2027', { now: NOW }).ok, true);   // exactly +365
  const far = validateDateAnswer('21/10/2027', { now: NOW });
  assert.equal(far.code, 'date_too_far');
  assert.deepEqual(far.vars, { days: 365 });
});

test('dates: unrecognized text is accepted in the bot but rejected strictly (web form)', () => {
  assert.deepEqual(validateDateAnswer('next friday', { now: NOW }), { ok: true, value: 'next friday' });
  assert.equal(validateDateAnswer('next friday', { now: NOW, strict: true }).code, 'invalid_date');
  assert.equal(validateDateAnswer('31/02/2026', { now: NOW }).code, 'invalid_date');
});

test('check-out must be at least 1 night after check-in', () => {
  const o = { now: NOW, checkIn: '25/10/2026' };
  assert.equal(validateDateAnswer('25/10/2026', o).code, 'checkout_not_after_checkin');
  assert.equal(validateDateAnswer('24/10/2026', o).code, 'checkout_not_after_checkin');
  assert.equal(validateDateAnswer('26/10/2026', o).ok, true);
});

test('closed day: rejected with the day and the next open date; none configured = fine', () => {
  // Sunday 2026-10-25
  const r = validateDateAnswer('25/10/2026', { now: NOW, hours: MON_TO_SAT });
  assert.equal(r.code, 'closed_day');
  assert.equal(r.vars.day, 'Sunday');
  assert.match(r.vars.date, /26/);
  assert.match(r.vars.date, /Oct/);
  assert.equal(validateDateAnswer('26/10/2026', { now: NOW, hours: MON_TO_SAT }).ok, true);
  assert.equal(validateDateAnswer('25/10/2026', { now: NOW, hours: null }).ok, true);
  assert.equal(validateDateAnswer('25/10/2026', { now: NOW, hours: {} }).ok, true);
  assert.equal(validateDateAnswer('25/10/2026', { now: NOW, hours: MON_TO_SAT, checkClosed: false }).ok, true);
});

test('closed day names are localized', () => {
  const r = validateDateAnswer('25/10/2026', { now: NOW, hours: MON_TO_SAT, language: 'hi' });
  assert.equal(r.code, 'closed_day');
  assert.match(r.vars.day, /रविवार/);
  assert.equal(validateDateAnswer('25/10/2026', { now: NOW, hours: MON_TO_SAT, language: 'zz-bad' }).vars.day, 'Sunday');
});
