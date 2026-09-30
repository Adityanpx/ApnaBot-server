// Run: node --test src/utils/courseValidation.test.js
// Pure. Also covers the 'business_courses' dropdown source rule added to
// flowFieldsValidation.js for the service form's "Course list".
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCourseFields, cleanText, hasPlaceholder } = require('./courseValidation');
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
