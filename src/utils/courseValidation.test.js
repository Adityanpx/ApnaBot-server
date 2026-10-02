// Run: node --test src/utils/courseValidation.test.js
// Pure. Also covers the 'business_courses' dropdown source rule added to
// flowFieldsValidation.js for the service form's "Course list".
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCourseFields, cleanText, hasPlaceholder, coursePageText, hasStructuredDetails, structuredColumns } = require('./courseValidation');
const { validateFlowFields, BUSINESS_COURSES_SOURCE } = require('./flowFieldsValidation');

test('valid course (full and partial)', () => {
  assert.equal(validateCourseFields({ name: 'JEE Main + Advanced', description: 'Two years', details: 'Fees ₹85,000' }), null);
  assert.equal(validateCourseFields({ details: 'Only details' }, { partial: true }), null);
  assert.equal(validateCourseFields({ name: 'Abacus', description: null, details: null }), null);
});
test('name required, max 24', () => {
  assert.match(validateCourseFields({}), /name is required/);
  assert.match(validateCourseFields({ name: '   ' }), /name is required/);
  assert.match(validateCourseFields({ name: 'x'.repeat(25) }), /24 characters/);
  assert.match(validateCourseFields({ name: '' }, { partial: true }), /name is required/);
});
test('description max 72, details max 1024, must be text', () => {
  assert.match(validateCourseFields({ name: 'A', description: 'x'.repeat(73) }), /72 characters/);
  assert.match(validateCourseFields({ name: 'A', details: 'x'.repeat(1025) }), /1024 characters/);
  assert.match(validateCourseFields({ name: 'A', details: 5 }), /must be text/);
});
test('cleanText / hasPlaceholder', () => {
  assert.equal(cleanText('  '), null);
  assert.equal(cleanText(' Hi '), 'Hi');
  assert.equal(hasPlaceholder('Fees: ₹____'), true);
  assert.equal(hasPlaceholder('Fees: ₹__'), false);
  assert.equal(hasPlaceholder(null), false);
});

test('flow fields: course-list dropdown needs no options', () => {
  assert.equal(validateFlowFields([{ name: 'course', label: 'Course', type: 'dropdown', source: BUSINESS_COURSES_SOURCE }]), null);
  assert.equal(validateFlowFields([{ name: 'course', label: 'Course', type: 'dropdown', source: BUSINESS_COURSES_SOURCE, options: [] }]), null);
});
test('flow fields: course-list dropdown must not carry its own options', () => {
  assert.match(validateFlowFields([{ name: 'course', label: 'Course', type: 'dropdown', source: BUSINESS_COURSES_SOURCE, options: ['A', 'B'] }]),
    /takes its options from your course list/);
});
test('flow fields: a plain dropdown still needs 2+ options (unchanged)', () => {
  assert.match(validateFlowFields([{ name: 'x', label: 'X', type: 'dropdown' }]), /at least 2 non-empty options/);
  assert.match(validateFlowFields([{ name: 'x', label: 'X', type: 'dropdown', source: 'something_else' }]), /at least 2 non-empty options/);
});
test('flow fields: visibleWhen may reference a course-list dropdown', () => {
  assert.equal(validateFlowFields([
    { name: 'course', label: 'Course', type: 'dropdown', source: BUSINESS_COURSES_SOURCE },
    { name: 'exam', label: 'Exam', type: 'text', visibleWhen: { field: 'course', equals: 'JEE Main + Advanced' } }
  ]), null);
});
test('flow fields: visibleWhen on a plain dropdown still checks its options (unchanged)', () => {
  assert.match(validateFlowFields([
    { name: 'trip', label: 'Trip', type: 'dropdown', options: ['One Way', 'Round Trip'] },
    { name: 'days', label: 'Days', type: 'text', visibleWhen: { field: 'trip', equals: 'Local' } }
  ]), /must be one of "trip"'s options/);
});

test('course group name: optional, max 24, not a reserved bot row', () => {
  assert.equal(validateCourseFields({ name: 'JEE', groupName: 'JEE / NEET' }), null);
  assert.equal(validateCourseFields({ name: 'JEE', groupName: null }), null);
  assert.equal(validateCourseFields({ name: 'JEE', groupName: '' }), null);
  assert.equal(validateCourseFields({ groupName: 'Skill classes' }, { partial: true }), null);
  assert.match(validateCourseFields({ name: 'JEE', groupName: 'x'.repeat(25) }), /Group must be 24 characters or less/);
  assert.match(validateCourseFields({ name: 'JEE', groupName: 'All groups' }), /bot's own buttons/);
  assert.match(validateCourseFields({ name: 'JEE', groupName: 5 }), /Group must be text/);
});

test('structured details: fields validated (lines ≤100, mode enum, more details ≤800)', () => {
  assert.equal(validateCourseFields({ name: 'Abacus', ageGroup: '6+', duration: '3 months', fees: '₹4,000', mode: 'both', moreDetails: 'Kit included' }), null);
  assert.equal(validateCourseFields({ mode: '' }, { partial: true }), null);
  assert.equal(validateCourseFields({ mode: null }, { partial: true }), null);
  assert.match(validateCourseFields({ name: 'A', fees: 'x'.repeat(101) }), /Fees must be 100 characters or less/);
  assert.match(validateCourseFields({ name: 'A', ageGroup: 7 }), /Age must be text/);
  assert.match(validateCourseFields({ name: 'A', mode: 'hybrid' }), /Mode must be one of: online, offline, both/);
  assert.match(validateCourseFields({ name: 'A', moreDetails: 'x'.repeat(801) }), /More details must be 800/);
});

test('coursePageText: built from the fields, in a fixed order', () => {
  const page = coursePageText({
    name: 'Abacus', description: 'Mental maths for kids', details: 'OLD TEXT (ignored)',
    ageGroup: '6 years and above', duration: '3 months per level', fees: '₹4,000 per level', mode: 'both', moreDetails: 'Kit included.'
  });
  assert.equal(page, '*Abacus*\nMental maths for kids\n\n👦 Age: 6 years and above\n🕘 Duration: 3 months per level\n💰 Fees: ₹4,000 per level\n💻 Mode: Online and offline\n\nKit included.');
  assert.equal(coursePageText({ name: 'Chess', fees: '₹2,000' }), '*Chess*\n\n💰 Fees: ₹2,000');
  assert.equal(coursePageText({ name: 'Chess', mode: 'online' }), '*Chess*\n\n💻 Mode: Online');
  assert.equal(coursePageText({ name: 'Chess', moreDetails: 'Weekend only.' }), '*Chess*\n\nWeekend only.');
});

test('coursePageText: no fields → the old free-text details, exactly as before', () => {
  assert.equal(coursePageText({ name: 'Abacus', details: '  🧮 Abacus classes\nFees: ₹4,000  ' }), '🧮 Abacus classes\nFees: ₹4,000');
  assert.equal(coursePageText({ name: 'Abacus', details: null }), null);
  assert.equal(coursePageText({ name: 'Abacus', details: 'x', mode: 'nonsense', fees: '  ' }), 'x');
  assert.equal(hasStructuredDetails({ name: 'A', details: 'x' }), false);
  assert.equal(hasStructuredDetails({ name: 'A', mode: 'offline' }), true);
});

test('structuredColumns: only present keys, "" clears, mode cleaned', () => {
  assert.deepEqual(structuredColumns({ fees: ' ₹500 ', mode: 'online' }), { fees: '₹500', mode: 'online' });
  assert.deepEqual(structuredColumns({ duration: '', mode: '' }), { duration: null, mode: null });
  assert.deepEqual(structuredColumns({ name: 'x' }), {});
});

test('batches: list of up to 10 labels, each ≤72, no blanks or duplicates', () => {
  assert.equal(validateCourseFields({ name: 'Abacus', batches: ['Mon–Fri 5–6 pm', 'Sat–Sun 10–11 am (online)'] }), null);
  assert.equal(validateCourseFields({ batches: [] }, { partial: true }), null);
  assert.match(validateCourseFields({ name: 'A', batches: 'Mon' }), /Batches must be a list/);
  assert.match(validateCourseFields({ name: 'A', batches: ['Mon', ' '] }), /Each batch needs a name/);
  assert.match(validateCourseFields({ name: 'A', batches: Array.from({ length: 11 }, (_, i) => `B${i}`) }), /at most 10 batches/);
  assert.match(validateCourseFields({ name: 'A', batches: ['x'.repeat(73)] }), /72 characters or less/);
  assert.match(validateCourseFields({ name: 'A', batches: ['Mon 5 pm', 'mon 5 pm'] }), /listed twice/);
  assert.deepEqual(structuredColumns({ batches: [' Mon 5 pm ', 'Sat 10 am'] }), { batches: ['Mon 5 pm', 'Sat 10 am'] });
});

test('coursePageText: batches section after the details (structured and old text); none = unchanged', () => {
  assert.equal(coursePageText({ name: 'Chess', fees: '₹2,000', batches: ['Sat 10–11 am', 'Sun 4–5 pm'] }),
    '*Chess*\n\n💰 Fees: ₹2,000\n\n🗓 Batches:\n• Sat 10–11 am\n• Sun 4–5 pm');
  assert.equal(coursePageText({ name: 'Chess', details: 'Old text', batches: ['Sat 10 am'] }), 'Old text\n\n🗓 Batches:\n• Sat 10 am');
  assert.equal(coursePageText({ name: 'Chess', details: 'Old text', batches: [] }), 'Old text');
  assert.equal(coursePageText({ name: 'Chess', batches: ['Sat 10 am'] }), null); // batches alone are not a page
});

test('flow fields: a course_batches dropdown must depend on an EARLIER course-list field', () => {
  const course = { name: 'course', label: 'Course', type: 'dropdown', source: BUSINESS_COURSES_SOURCE, required: true };
  const batch = { name: 'batch', label: 'Batch', type: 'dropdown', source: 'course_batches', dependsOn: 'course', options: ['Weekday', 'Weekend'] };
  assert.equal(validateFlowFields([course, batch]), null);
  assert.match(validateFlowFields([batch, course]), /dependsOn must name an earlier course-list field/);
  assert.match(validateFlowFields([course, { ...batch, dependsOn: 'nope' }]), /dependsOn must name an earlier course-list field/);
  assert.match(validateFlowFields([{ name: 'x', label: 'X', type: 'dropdown', options: ['a', 'b'] }, { ...batch, dependsOn: 'x' }]),
    /dependsOn must name an earlier course-list field/);
  assert.match(validateFlowFields([course, { ...batch, options: [] }]), /needs at least 2 non-empty options/);
});
