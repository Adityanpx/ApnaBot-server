// Run: node --test src/utils/coachingBotSettings.test.js
// Pure — no Supabase/Redis.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCoachingSettings, mapCoachingSettingsToSpec, FIELD_LIBRARY } = require('./coachingBotSettings');
const { compileFlowSpecV2 } = require('./flowSpecV2');
const { validateFlowFields } = require('./flowFieldsValidation');

const CTX = { businessName: 'Daring Bee' };
const course = (id, name, extra = {}) => ({
  id, name, description: `${name} classes`, details: `${name} details`, buttons: { demo: true, admission: true }, ...extra
});
const settings = () => ({
  version: 1,
  intro: 'Abacus & Vedic Maths classes.',
  courses: [course('abacus', 'Abacus'), course('vedic', 'Vedic Maths')],
  sections: {
    fees: { enabled: true, text: 'Registration ₹500, ₹4,000 per level.' },
    timings: { enabled: true, text: 'Mon–Fri 9–10am, 6–7pm. Sat–Sun 9–11am.' },
    results: { enabled: false, text: '' },
    material: { enabled: false, text: '' },
    contact: { enabled: true, text: 'Call 98xxxxxxxx.' },
    location: { enabled: false }
  },
  demoForm: { enabled: true, fields: ['age', 'mode', 'preferredTime'], customFields: [] },
  admissionForm: {
    enabled: true, fields: ['fatherName', 'motherName', 'dob', 'school', 'standard', 'batch', 'mode', 'area'],
    customFields: [{ label: 'Blood group', type: 'text' }], note: 'Please bring 2 passport-size photos'
  }
});
const mutate = (fn) => { const s = settings(); fn(s); return s; };
const map = (s) => mapCoachingSettingsToSpec(s, CTX);
const menuTitles = (spec) => spec.menu.map(m => m.title);
const pageById = (spec, id) => spec.pages.find(p => p.id === id);
const formById = (spec, id) => spec.forms.find(f => f.id === id);

test('happy path: menu order, course list, course pages, forms', () => {
  const { spec, error } = map(settings());
  assert.equal(error, null);
  assert.equal(spec.greeting.text, 'Hello {{customerName}}, welcome to Daring Bee! Abacus & Vedic Maths classes.\n\nPlease choose an option:');
  assert.deepEqual(menuTitles(spec), ['📚 Courses', '💰 Fees', '🕘 Batches & timings', '🎓 Free demo', '📝 Admission', '📞 Contact us']);

  const courses = pageById(spec, 'courses');
  assert.deepEqual(courses.list.map(r => r.title), ['Abacus', 'Vedic Maths', 'Main menu']);
  assert.equal(courses.list[0].description, 'Abacus classes');
  assert.deepEqual(pageById(spec, 'course_abacus').buttons.map(b => b.title), ['Free demo', 'Admission', 'Main menu']);
  assert.deepEqual(pageById(spec, 'fees').buttons.map(b => b.title), ['Admission', 'Main menu']);
  assert.deepEqual(pageById(spec, 'timings').buttons.map(b => b.title), ['Free demo', 'Main menu']);
  assert.deepEqual(pageById(spec, 'contact').buttons.map(b => b.title), ['Main menu']);
  assert.equal(pageById(spec, 'results'), undefined);

  const out = compileFlowSpecV2(spec);
  assert.equal(out.questionNodes.length, 0);
  assert.equal(out.replyNodes.filter(n => n.replyKind === 'web_form_trigger').length, 2);
});

test('demo form: note-free, Student name + Course dropdown + ticked fields', () => {
  const { spec } = map(settings());
  const fields = formById(spec, 'demo').fields;
  assert.deepEqual(fields.map(f => f.name), ['studentName', 'course', 'age', 'mode', 'preferredTime']);
  assert.deepEqual(fields[1].options, ['Abacus', 'Vedic Maths']);
  assert.equal(fields[0].required, true);
  assert.equal(fields[1].required, true);
  assert.equal(validateFlowFields(fields), null);
});

test('admission form: note first, library order, custom question last', () => {
  const { spec } = map(settings());
  const fields = formById(spec, 'admission').fields;
  assert.deepEqual(fields.map(f => f.name),
    ['note', 'studentName', 'course', 'fatherName', 'motherName', 'dob', 'school', 'standard', 'batch', 'mode', 'area', 'custom1']);
  assert.equal(fields[0].type, 'display_text');
  assert.equal(fields[0].label, 'Please bring 2 passport-size photos');
  assert.equal(validateFlowFields(fields), null);
});

test('every library field produces a valid form field', () => {
  const s = mutate(x => {
    x.admissionForm.fields = FIELD_LIBRARY.map(f => f.key);
    x.admissionForm.targetExamOptions = ['JEE', 'MHT-CET', 'NEET'];
  });
  const { spec, error } = map(s);
  assert.equal(error, null);
  const fields = formById(spec, 'admission').fields;
  assert.equal(validateFlowFields(fields), null);
  assert.deepEqual(fields.find(f => f.name === 'targetExam').options, ['JEE', 'MHT-CET', 'NEET']);
});

test('single course: no Courses list, menu goes straight to the course page, course shown as info line', () => {
  const { spec, error } = map(mutate(s => { s.courses = [course('abacus', 'Abacus')]; }));
  assert.equal(error, null);
  assert.equal(pageById(spec, 'courses'), undefined);
  assert.deepEqual(spec.menu[0].target, { type: 'page', id: 'course_abacus' });
  assert.equal(pageById(spec, 'course_abacus').keyword, 'course');
  const fields = formById(spec, 'demo').fields;
  assert.deepEqual(fields.slice(0, 2).map(f => [f.name, f.type, f.label]),
    [['studentName', 'text', 'Student name'], ['courseInfo', 'display_text', 'Course: Abacus']]);
  assert.equal(validateFlowFields(fields), null);
});

test('10 courses: list is full, no Main menu row', () => {
  const { spec, error } = map(mutate(s => { s.courses = Array.from({ length: 10 }, (_, i) => course(`c${i}`, `Course ${i}`)); }));
  assert.equal(error, null);
  assert.equal(pageById(spec, 'courses').list.length, 10);
  assert.ok(!pageById(spec, 'courses').list.some(r => r.title === 'Main menu'));
});

test('demo form off: no demo menu item, no Free demo buttons anywhere', () => {
  const { spec } = map(mutate(s => { s.demoForm.enabled = false; }));
  assert.ok(!menuTitles(spec).includes('🎓 Free demo'));
  assert.equal(formById(spec, 'demo'), undefined);
  assert.ok(spec.pages.every(p => !(p.buttons || []).some(b => b.title === 'Free demo')));
});

test('per-course buttons respected', () => {
  const { spec } = map(mutate(s => { s.courses[1].buttons = { demo: false, admission: false }; }));
  assert.deepEqual(pageById(spec, 'course_vedic').buttons.map(b => b.title), ['Main menu']);
});

test('all sections + location: 9 menu items, still valid', () => {
  const { spec, error } = map(mutate(s => {
    s.sections.results = { enabled: true, text: 'Our toppers…' };
    s.sections.material = { enabled: true, text: 'Notes provided.' };
    s.sections.location = { enabled: true };
  }));
  assert.equal(error, null);
  assert.equal(spec.menu.length, 9);
  assert.deepEqual(spec.location, { keyword: 'location' });
});

test('draft mode allows an incomplete setup; publish mode does not', () => {
  const draft = mutate(s => { s.courses = []; s.sections.fees.text = ''; });
  assert.equal(validateCoachingSettings(draft, { forPublish: false }), null);
  assert.match(validateCoachingSettings(draft, { forPublish: true }), /at least one course/);
  const noText = mutate(s => { s.sections.fees.text = ''; });
  assert.match(validateCoachingSettings(noText, { forPublish: true }), /Fees is switched on but has no text/);
  const noDetails = mutate(s => { s.courses[0].details = ''; });
  assert.equal(validateCoachingSettings(noDetails, { forPublish: false }), null);
  assert.match(map(noDetails).error, /Course 1: details page is required/);
});

test('compile does not mutate settings', () => {
  const s = settings();
  const before = JSON.stringify(s);
  compileFlowSpecV2(map(s).spec);
  assert.equal(JSON.stringify(s), before);
});

const rejects = (name, fn, pattern) => test(`rejects: ${name}`, () => {
  const err = map(mutate(fn)).error;
  assert.ok(err, 'expected an error');
  assert.match(err, pattern);
});
rejects('wrong version', s => { s.version = 2; }, /version must be 1/);
rejects('intro over 300', s => { s.intro = 'x'.repeat(301); }, /Intro must be 300/);
rejects('11 courses', s => { s.courses = Array.from({ length: 11 }, (_, i) => course(`c${i}`, `C${i}`)); }, /at most 10 courses/);
rejects('course name over 24', s => { s.courses[0].name = 'x'.repeat(25); }, /Course 1: name must be 24/);
rejects('duplicate course name', s => { s.courses[1].name = 'abacus'; }, /already has the name/);
rejects('course id too long', s => { s.courses[0].id = 'a'.repeat(31); }, /id must match/);
rejects('duplicate course id', s => { s.courses[1].id = 'abacus'; }, /used twice/);
rejects('course description over 72', s => { s.courses[0].description = 'x'.repeat(73); }, /72 characters/);
rejects('course details over 1024', s => { s.courses[0].details = 'x'.repeat(1025); }, /details must be 1024/);
rejects('course buttons missing', s => { delete s.courses[0].buttons; }, /buttons.demo and buttons.admission/);
rejects('section text over 1024', s => { s.sections.fees.text = 'x'.repeat(1025); }, /Fees: text must be 1024/);
rejects('unknown form field', s => { s.demoForm.fields.push('bloodGroup'); }, /unknown field "bloodGroup"/);
rejects('field ticked twice', s => { s.demoForm.fields.push('age'); }, /ticked twice/);
rejects('target exam with 1 option', s => { s.admissionForm.fields.push('targetExam'); s.admissionForm.targetExamOptions = ['JEE']; }, /at least 2 exam names/);
rejects('custom dropdown with 1 option', s => { s.admissionForm.customFields = [{ label: 'Shift', type: 'dropdown', options: ['A'] }]; }, /at least 2 options/);
rejects('custom question bad type', s => { s.admissionForm.customFields = [{ label: 'X', type: 'date' }]; }, /type must be one of/);
rejects('6 custom questions', s => { s.admissionForm.customFields = Array.from({ length: 6 }, (_, i) => ({ label: `Q${i}`, type: 'text' })); }, /at most 5 custom questions/);
rejects('note over 300', s => { s.admissionForm.note = 'x'.repeat(301); }, /note must be 300/);
rejects('course named "Main menu" clashes with the list row', s => { s.courses[1].name = 'Main menu'; }, /generated flow is invalid/);

test('rejects: missing businessName (real check)', () => {
  assert.match(mapCoachingSettingsToSpec(settings(), {}).error, /businessName is required/);
});
