// Run: node --test src/utils/coachingBotSettings.test.js
// Pure — no Supabase/Redis. Courses are passed in the shape
// botSettings.service.js#loadActiveCourses returns (active business_courses).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateCoachingSettings, validateCoursesForPublish, mapCoachingSettingsToSpec, FIELD_LIBRARY
} = require('./coachingBotSettings');
const { compileFlowSpecV2 } = require('./flowSpecV2');
const { validateFlowFields, BUSINESS_COURSES_SOURCE } = require('./flowFieldsValidation');

const course = (name, extra = {}) => ({
  name, description: `${name} classes`, details: `${name} details`,
  showDemoButton: true, showAdmissionButton: true, ...extra
});
const coursesFixture = () => [course('Abacus'), course('Vedic Maths')];
const settings = () => ({
  version: 1,
  intro: 'Abacus & Vedic Maths classes.',
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
const map = (s, courses = coursesFixture()) => mapCoachingSettingsToSpec(s, { businessName: 'Daring Bee', courses });
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
  assert.deepEqual(courses.list.map(r => r.target), [{ type: 'page', id: 'course_1' }, { type: 'page', id: 'course_2' }, { type: 'menu' }]);
  assert.equal(courses.list[0].description, 'Abacus classes');
  assert.equal(pageById(spec, 'course_1').text, 'Abacus details');
  assert.deepEqual(pageById(spec, 'course_1').buttons.map(b => b.title), ['Free demo', 'Admission', 'Main menu']);
  assert.deepEqual(pageById(spec, 'fees').buttons.map(b => b.title), ['Admission', 'Main menu']);
  assert.deepEqual(pageById(spec, 'timings').buttons.map(b => b.title), ['Free demo', 'Main menu']);
  assert.deepEqual(pageById(spec, 'contact').buttons.map(b => b.title), ['Main menu']);
  assert.equal(pageById(spec, 'results'), undefined);

  const out = compileFlowSpecV2(spec);
  assert.equal(out.questionNodes.length, 0);
  assert.equal(out.replyNodes.filter(n => n.replyKind === 'web_form_trigger').length, 2);
});

test('Course field is a course-list dropdown (options filled when the form opens)', () => {
  const { spec } = map(settings());
  for (const id of ['demo', 'admission']) {
    const field = formById(spec, id).fields.find(f => f.name === 'course');
    assert.deepEqual(field, { name: 'course', label: 'Course', type: 'dropdown', source: BUSINESS_COURSES_SOURCE, required: true });
    assert.equal(validateFlowFields(formById(spec, id).fields), null);
  }
});

test('demo form: Student name + Course + ticked fields', () => {
  const { spec } = map(settings());
  assert.deepEqual(formById(spec, 'demo').fields.map(f => f.name), ['studentName', 'course', 'age', 'mode', 'preferredTime']);
});

test('admission form: note first, library order, custom question last', () => {
  const { spec } = map(settings());
  const fields = formById(spec, 'admission').fields;
  assert.deepEqual(fields.map(f => f.name),
    ['note', 'studentName', 'course', 'fatherName', 'motherName', 'dob', 'school', 'standard', 'batch', 'mode', 'area', 'custom1']);
  assert.equal(fields[0].type, 'display_text');
  assert.equal(validateFlowFields(fields), null);
});

test('every library field produces a valid form field', () => {
  const { spec, error } = map(mutate(x => {
    x.admissionForm.fields = FIELD_LIBRARY.map(f => f.key);
    x.admissionForm.targetExamOptions = ['JEE', 'MHT-CET', 'NEET'];
  }));
  assert.equal(error, null);
  const fields = formById(spec, 'admission').fields;
  assert.equal(validateFlowFields(fields), null);
  assert.deepEqual(fields.find(f => f.name === 'targetExam').options, ['JEE', 'MHT-CET', 'NEET']);
});

test('single course: no Courses list, menu goes straight to its page; Course is still a course-list dropdown', () => {
  const { spec, error } = map(settings(), [course('Abacus')]);
  assert.equal(error, null);
  assert.equal(pageById(spec, 'courses'), undefined);
  assert.deepEqual(spec.menu[0].target, { type: 'page', id: 'course_1' });
  assert.equal(pageById(spec, 'course_1').keyword, 'course');
  assert.equal(formById(spec, 'demo').fields[1].source, BUSINESS_COURSES_SOURCE);
});

test('10 courses: list is full, no Main menu row', () => {
  const { spec, error } = map(settings(), Array.from({ length: 10 }, (_, i) => course(`Course ${i}`)));
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
  const { spec } = map(settings(), [course('Abacus'), course('Vedic Maths', { showDemoButton: false, showAdmissionButton: false })]);
  assert.deepEqual(pageById(spec, 'course_2').buttons.map(b => b.title), ['Main menu']);
});

test('all sections + location: 9 menu items, still valid', () => {
  const { spec, error } = map(mutate(s => {
    s.sections.results = { enabled: true, text: 'Our toppers…' };
    s.sections.material = { enabled: true, text: 'Notes provided.' };
    s.sections.location = { enabled: true };
  }));
  assert.equal(error, null);
  assert.equal(spec.menu.length, 9);
});

test('draft mode allows missing section text; publish mode does not', () => {
  const draft = mutate(s => { s.sections.fees.text = ''; });
  assert.equal(validateCoachingSettings(draft, { forPublish: false }), null);
  assert.match(validateCoachingSettings(draft, { forPublish: true }), /Fees is switched on but has no text/);
});

test('settings may not carry courses (they live in My courses)', () => {
  assert.match(validateCoachingSettings(mutate(s => { s.courses = []; })), /managed in "My courses"/);
});

// ---- course checks at publish ----
test('publish: no courses', () => assert.match(map(settings(), []).error, /Add at least one course/));
test('publish: more than 10 courses', () => assert.match(
  map(settings(), Array.from({ length: 11 }, (_, i) => course(`C${i}`))).error, /at most 10 courses.*11 shown/));
test('publish: course without details', () => assert.match(map(settings(), [course('Abacus', { details: null })]).error, /Course "Abacus": add the details page text/));
test('publish: course details over 1024', () => assert.match(map(settings(), [course('Abacus', { details: 'x'.repeat(1025) })]).error, /1024/));
test('publish: unfilled catalog blanks in details', () => assert.match(
  map(settings(), [course('JEE', { details: 'Fees: ₹____' })]).error, /Course "JEE": fill in the blanks/));
test('publish: unfilled blanks in description', () => assert.match(
  map(settings(), [course('JEE', { description: 'Batch starts ____' })]).error, /fill in the blanks/));
test('validateCoursesForPublish accepts a normal list', () => assert.equal(validateCoursesForPublish(coursesFixture()), null));
test('publish: a course named "Main menu" clashes with the list row', () => assert.match(
  map(settings(), [course('Abacus'), course('Main menu')]).error, /generated flow is invalid/));

// ---- settings rejections ----
const rejects = (name, fn, pattern) => test(`rejects: ${name}`, () => {
  const err = map(mutate(fn)).error;
  assert.ok(err, 'expected an error');
  assert.match(err, pattern);
});
rejects('wrong version', s => { s.version = 2; }, /version must be 1/);
rejects('intro over 300', s => { s.intro = 'x'.repeat(301); }, /Intro must be 300/);
rejects('section text over 1024', s => { s.sections.fees.text = 'x'.repeat(1025); }, /Fees: text must be 1024/);
rejects('unknown form field', s => { s.demoForm.fields.push('bloodGroup'); }, /unknown field "bloodGroup"/);
rejects('field ticked twice', s => { s.demoForm.fields.push('age'); }, /ticked twice/);
rejects('target exam with 1 option', s => { s.admissionForm.fields.push('targetExam'); s.admissionForm.targetExamOptions = ['JEE']; }, /at least 2 exam names/);
rejects('custom dropdown with 1 option', s => { s.admissionForm.customFields = [{ label: 'Shift', type: 'dropdown', options: ['A'] }]; }, /at least 2 options/);
rejects('custom question bad type', s => { s.admissionForm.customFields = [{ label: 'X', type: 'date' }]; }, /type must be one of/);
rejects('6 custom questions', s => { s.admissionForm.customFields = Array.from({ length: 6 }, (_, i) => ({ label: `Q${i}`, type: 'text' })); }, /at most 5 custom questions/);
rejects('note over 300', s => { s.admissionForm.note = 'x'.repeat(301); }, /note must be 300/);

test('rejects: missing businessName', () => {
  assert.match(mapCoachingSettingsToSpec(settings(), { courses: coursesFixture() }).error, /businessName is required/);
});

test('mapping does not mutate settings or courses', () => {
  const s = settings();
  const c = coursesFixture();
  const before = JSON.stringify([s, c]);
  compileFlowSpecV2(map(s, c).spec);
  assert.equal(JSON.stringify([s, c]), before);
});
