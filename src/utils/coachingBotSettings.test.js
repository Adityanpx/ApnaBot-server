// Run: node --test src/utils/coachingBotSettings.test.js
// Pure — no Supabase/Redis. Courses are passed in the shape
// botSettings.service.js#loadActiveCourses returns (active business_courses).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateCoachingSettings, validateCoursesForPublish, mapCoachingSettingsToSpec, courseIndexFromPageKeyword, formTitleForKeyword, formRequestForKeyword, FIELD_LIBRARY
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
  assert.equal(spec.greeting.text, 'Hello *{{customerName}}*, welcome to *{{businessName}}*! Abacus & Vedic Maths classes.\n\nPlease choose an option:');
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

test('welcome message: used exactly as written (placeholders kept for the send path)', () => {
  const text = 'Hello *{{customerName}}*, welcome to *{{businessName}}* Abacus & Vedic Maths classes in Hadapsar, Pune.\n\nPlease choose an option:';
  const { spec, error } = map(mutate(s => { s.welcomeMessage = `  ${text}  `; }));
  assert.equal(error, null);
  assert.equal(spec.greeting.text, text);
});

test('welcome message: empty falls back to the default (intro appended)', () => {
  const { spec } = map(mutate(s => { s.welcomeMessage = '   '; s.intro = ''; }));
  assert.equal(spec.greeting.text, 'Hello *{{customerName}}*, welcome to *{{businessName}}*!\n\nPlease choose an option:');
});

test('welcome message: over 1024 characters or not text is rejected', () => {
  assert.match(map(mutate(s => { s.welcomeMessage = 'x'.repeat(1025); })).error, /Welcome message must be 1024/);
  assert.match(map(mutate(s => { s.welcomeMessage = 5; })).error, /Welcome message must be text/);
  assert.equal(validateCoachingSettings(mutate(s => { s.welcomeMessage = 'x'.repeat(1025); })), 'Welcome message must be 1024 characters or less');
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

test('courseIndexFromPageKeyword: compiled course page keyword → that course', () => {
  const courses = [course('Abacus', { details: 'Abacus page' }), course('Vedic Maths', { details: 'Vedic page' }), course('Chess', { details: 'Chess page' })];
  const { replyNodes } = compileFlowSpecV2(map(settings(), courses).spec);
  const found = replyNodes
    .map(n => ({ n, i: courseIndexFromPageKeyword(n.keyword) }))
    .filter(x => x.i !== null);
  assert.equal(found.length, 3);
  for (const { n, i } of found) assert.equal(n.label, courses[i].details);
  // every other node (menu, course list, sections, forms) maps to nothing
  assert.equal(replyNodes.length - found.length, replyNodes.filter(n => courseIndexFromPageKeyword(n.keyword) === null).length);
});

test('courseIndexFromPageKeyword: single course and junk keywords → null', () => {
  const { replyNodes } = compileFlowSpecV2(map(settings(), [course('Abacus')]).spec);
  assert.ok(replyNodes.every(n => courseIndexFromPageKeyword(n.keyword) === null));
  for (const k of ['page_course_0', 'page_course_', 'page_course_1x', 'course_1', 'page_courses', null, undefined, 3]) {
    assert.equal(courseIndexFromPageKeyword(k), null, String(k));
  }
  assert.equal(courseIndexFromPageKeyword('page_course_10'), 9);
});

test('formTitleForKeyword: each compiled form node has its own page title', () => {
  const { replyNodes } = compileFlowSpecV2(map(settings()).spec);
  const formNodes = replyNodes.filter(n => n.replyKind === 'web_form_trigger');
  assert.equal(formNodes.length, 2);
  const titles = formNodes.map(n => formTitleForKeyword(n.keyword));
  assert.deepEqual(titles.map(t => t && t.title).sort(), ['Admission form', 'Book a free demo class']);
  assert.ok(titles.every(t => t.subtitle));
  // other nodes and unknown keywords → no title
  assert.ok(replyNodes.filter(n => n.replyKind !== 'web_form_trigger').every(n => formTitleForKeyword(n.keyword) === null));
  for (const k of ['book', 'form_demo', 'Demo', null, undefined]) assert.equal(formTitleForKeyword(k), null, String(k));
});

test('formRequestForKeyword: each compiled form node → its booking key + short name', () => {
  const { replyNodes } = compileFlowSpecV2(map(settings()).spec);
  const requests = replyNodes.filter(n => n.replyKind === 'web_form_trigger').map(n => formRequestForKeyword(n.keyword));
  assert.deepEqual(requests.sort((a, b) => a.key.localeCompare(b.key)), [
    { key: 'admission', title: 'Admission' },
    { key: 'demo', title: 'Free demo' }
  ]);
  for (const k of ['book', 'form_demo', 'fees', null, undefined]) assert.equal(formRequestForKeyword(k), null, String(k));
});

// ---- FAQ ----
const withFaq = (items, extra = {}) => mutate(s => { s.faq = { enabled: true, items, ...extra }; });
const qa = (question, answer = `${question} answer`) => ({ question, answer });

test('FAQ: menu item before Contact, question list + one answer page each', () => {
  const { spec, error } = map(withFaq([qa('Online classes?', 'Yes, on Zoom.'), qa('Age limit?')]));
  assert.equal(error, null);
  const titles = menuTitles(spec);
  assert.ok(titles.indexOf('❓ FAQ') !== -1 && titles.indexOf('❓ FAQ') === titles.indexOf('📞 Contact us') - 1);
  const list = pageById(spec, 'faq');
  assert.equal(list.keyword, 'faqs');
  assert.deepEqual(list.aliases, ['doubt']);
  assert.deepEqual(list.list.map(r => r.title), ['Online classes?', 'Age limit?', 'Main menu']);
  const answer = pageById(spec, 'faq_1');
  assert.equal(answer.text, '*Online classes?*\n\nYes, on Zoom.');
  assert.deepEqual(answer.buttons.map(b => b.title), ['More questions', 'Free demo', 'Main menu']);
  const { replyNodes } = compileFlowSpecV2(spec);
  assert.ok(replyNodes.some(n => n.keyword === 'faqs' && n.contentType === 'list'));
});

test('FAQ: no Free demo button when the demo form is off', () => {
  const s = withFaq([qa('Age limit?')]);
  s.demoForm.enabled = false;
  assert.deepEqual(pageById(map(s).spec, 'faq_1').buttons.map(b => b.title), ['More questions', 'Main menu']);
});

test('FAQ: everything on = 10 menu items, still valid', () => {
  const s = withFaq([qa('Age limit?')]);
  for (const k of ['fees', 'timings', 'results', 'material', 'contact']) { s.sections[k] = { enabled: true, text: `${k} text` }; }
  s.sections.location.enabled = true;
  const { spec, error } = map(s);
  assert.equal(error, null);
  assert.equal(spec.menu.length, 10);
});

test('FAQ: absent or switched off → exactly the flow without it', () => {
  const without = JSON.stringify(map(settings()).spec);
  assert.equal(JSON.stringify(map(withFaq([qa('Age limit?')], { enabled: false })).spec), without);
  assert.equal(JSON.stringify(map(mutate(s => { s.faq = null; })).spec), without);
});

test('FAQ: a draft may be incomplete; publish may not', () => {
  const incomplete = withFaq([{ question: 'Age limit?', answer: '' }]);
  assert.equal(validateCoachingSettings(incomplete), null);
  assert.match(map(incomplete).error, /needs both a question and an answer/);
  assert.equal(validateCoachingSettings(withFaq([])), null);
  assert.match(map(withFaq([])).error, /switched on but has no questions/);
});

rejects('FAQ question over 24 characters', s => { s.faq = { enabled: true, items: [qa('Do you have online classes?')] }; }, /24 characters or less/);
rejects('FAQ answer too long', s => { s.faq = { enabled: true, items: [qa('Age limit?', 'x'.repeat(997))] }; }, /answer must be 996 characters/);
rejects('FAQ question listed twice', s => { s.faq = { enabled: true, items: [qa('Age limit?'), qa('age limit?')] }; }, /listed twice/);
rejects('FAQ question uses a reserved title', s => { s.faq = { enabled: true, items: [qa('Main menu')] }; }, /bot's own buttons/);
rejects('FAQ over 9 questions', s => { s.faq = { enabled: true, items: Array.from({ length: 10 }, (_, i) => qa(`Question ${i}?`)) }; }, /at most 9 questions/);
rejects('FAQ enabled not boolean', s => { s.faq = { enabled: 'yes', items: [] }; }, /FAQ: enabled must be true or false/);

// ---- Course groups ----
const grouped = (name, groupName) => course(name, { groupName });

test('groups: Courses → groups (with counts) → group course list → course page', () => {
  const courses = [grouped('JEE Main', 'JEE / NEET'), grouped('Abacus', 'Skill classes'), grouped('NEET', 'JEE / NEET'), course('Chess')];
  const { spec, error } = map(settings(), courses);
  assert.equal(error, null);
  const top = pageById(spec, 'courses');
  assert.equal(top.keyword, 'course');
  assert.deepEqual(top.list.map(r => [r.title, r.description || null]), [
    ['JEE / NEET', '2 courses'], ['Skill classes', '1 course'], ['Other courses', '1 course'], ['Main menu', null]
  ]);
  const jee = pageById(spec, 'group_1');
  assert.deepEqual(jee.list.map(r => r.title), ['JEE Main', 'NEET', 'All groups', 'Main menu']);
  // course pages keep their global index (form prefill relies on it)
  assert.deepEqual(jee.list.slice(0, 2).map(r => r.target.id), ['course_1', 'course_3']);
  assert.deepEqual(pageById(spec, 'group_3').list.map(r => r.target.id || r.target.type), ['course_4', 'courses', 'menu']);
  const { replyNodes } = compileFlowSpecV2(spec);
  const idx = replyNodes.map(n => courseIndexFromPageKeyword(n.keyword)).filter(i => i !== null).sort();
  assert.deepEqual(idx, [0, 1, 2, 3]);
});

test('groups: one group only (or none) → the flat list, exactly as before', () => {
  const flat = JSON.stringify(map(settings(), [course('Abacus'), course('Vedic Maths')]).spec);
  const oneGroup = map(settings(), [grouped('Abacus', 'Skill'), grouped('Vedic Maths', 'Skill')]).spec;
  assert.equal(pageById(oneGroup, 'courses').list.map(r => r.title).join('|'), 'Abacus|Vedic Maths|Main menu');
  assert.equal(pageById(oneGroup, 'group_1'), undefined);
  assert.equal(JSON.stringify(map(settings(), [course('Abacus'), course('Vedic Maths')]).spec), flat);
});

test('groups: a group named "Other courses" merges with ungrouped courses, listed last', () => {
  const { spec } = map(settings(), [grouped('Chess', 'Other courses'), grouped('JEE', 'JEE'), course('Art')]);
  assert.deepEqual(pageById(spec, 'courses').list.map(r => r.title), ['JEE', 'Other courses', 'Main menu']);
  assert.deepEqual(pageById(spec, 'group_2').list.map(r => r.title), ['Chess', 'Art', 'All groups', 'Main menu']);
});

test('groups: more than 10 courses publish once grouped', () => {
  const many = Array.from({ length: 18 }, (_, i) => grouped(`Course ${i + 1}`, i < 9 ? 'Group A' : 'Group B'));
  assert.equal(map(settings(), many).error, null);
  assert.match(map(settings(), many.map(c => course(c.name))).error, /at most 10 courses in one list/);
});

test('groups: limits — 9 groups, 9 courses per group', () => {
  const tenGroups = Array.from({ length: 10 }, (_, i) => grouped(`Course ${i + 1}`, `Group ${i + 1}`));
  assert.match(validateCoursesForPublish(tenGroups), /at most 9 course groups/);
  const crowded = [...Array.from({ length: 10 }, (_, i) => grouped(`A${i}`, 'Big')), grouped('B', 'Small')];
  assert.match(validateCoursesForPublish(crowded), /Group "Big" has 10 courses/);
});

// ---- Structured course details ----
test('course page uses the structured fields when set, old details otherwise', () => {
  const structured = course('Abacus', { details: 'OLD', ageGroup: '6+', fees: '₹4,000', mode: 'offline' });
  const { spec, error } = map(settings(), [structured, course('Vedic Maths')]);
  assert.equal(error, null);
  assert.equal(pageById(spec, 'course_1').text, '*Abacus*\nAbacus classes\n\n👦 Age: 6+\n💰 Fees: ₹4,000\n💻 Mode: Offline');
  assert.equal(pageById(spec, 'course_2').text, 'Vedic Maths details');
});

test('publish: blanks in a structured field, and an over-long built page, are caught', () => {
  assert.match(map(settings(), [course('JEE', { details: null, fees: '₹____' })]).error, /Course "JEE": fill in the blanks/);
  // every field at its own maximum still overflows one WhatsApp message
  const full = { details: null, ageGroup: 'a'.repeat(100), duration: 'd'.repeat(100), fees: 'f'.repeat(100), mode: 'both', moreDetails: 'm'.repeat(800) };
  assert.match(map(settings(), [course('JEE', full)]).error, /the course page is \d+ characters — WhatsApp allows 1024/);
  assert.equal(map(settings(), [course('JEE', { details: null, duration: '2 years' })]).error, null);
});

// ---- Course batches ----
test('forms: Batch lists the picked course\'s batches (Weekday/Weekend when none), after Course', () => {
  const fields = formById(map(settings()).spec, 'admission').fields;
  const batch = fields.find(f => f.name === 'batch');
  assert.deepEqual(batch, { name: 'batch', label: 'Batch', type: 'dropdown', source: 'course_batches', dependsOn: 'course', options: ['Weekday', 'Weekend'] });
  assert.ok(fields.findIndex(f => f.name === 'course') < fields.findIndex(f => f.name === 'batch'));
  assert.equal(validateFlowFields(fields), null);
});

test('course page shows its batches', () => {
  const { spec } = map(settings(), [course('Abacus', { batches: ['Mon–Fri 5–6 pm'] }), course('Vedic Maths')]);
  assert.equal(pageById(spec, 'course_1').text, 'Abacus details\n\n🗓 Batches:\n• Mon–Fri 5–6 pm');
  assert.equal(pageById(spec, 'course_2').text, 'Vedic Maths details');
});

// ---- Course photos ----
test('course photo: sent above the course page; not on the course list', () => {
  const photo = '11111111-2222-4333-8444-555555555555';
  const { spec, error } = map(settings(), [course('Abacus', { imageMediaId: photo }), course('Vedic Maths')]);
  assert.equal(error, null);
  assert.equal(pageById(spec, 'course_1').mediaId, photo);
  assert.equal(pageById(spec, 'course_2').mediaId, undefined);
  assert.equal(pageById(spec, 'courses').mediaId, undefined);
  const node = compileFlowSpecV2(spec).replyNodes.find(n => courseIndexFromPageKeyword(n.keyword) === 0);
  assert.equal(node.mediaId, photo);
  assert.equal(node.contentType, 'buttons');
});
