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
