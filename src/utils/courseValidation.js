// Shared field validation for course_catalog (Super Admin) and
// business_courses (owners). Limits mirror the DB check constraints in
// 20260929130000_course_catalog_and_business_courses.sql (name 1..24,
// description <= 72) plus the course page body limit the Bot Builder needs
// (details <= 1024, a WhatsApp interactive message body). Pure.

const COURSE_LIMITS = { NAME: 24, DESCRIPTION: 72, DETAILS: 1024, GROUP_NAME: 24 };

// Group names that would clash with the bot's own list rows.
const RESERVED_GROUP_NAMES = ['main menu', 'all groups'];

// Blanks left in catalog starting text for each institute to fill in.
const PLACEHOLDER_PATTERN = /_{3,}/;

/**
 * @param {Object} body - { name?, description?, details?, groupName? }
 * @param {{ partial?: boolean }} [opts] - partial=true (updates): only
 *   validate keys that are present; name may not be blanked either way.
 * @returns {string|null} error message or null
 */
const validateCourseFields = (body, { partial = false } = {}) => {
  if (!body || typeof body !== 'object') return 'Request body must be an object';
  const { name, description, details, groupName } = body;

  if (!partial || name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) return 'Course name is required';
    if (name.trim().length > COURSE_LIMITS.NAME) return `Course name must be ${COURSE_LIMITS.NAME} characters or less`;
  }
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string') return 'Short description must be text';
    if (description.trim().length > COURSE_LIMITS.DESCRIPTION) return `Short description must be ${COURSE_LIMITS.DESCRIPTION} characters or less`;
  }
  if (details !== undefined && details !== null) {
    if (typeof details !== 'string') return 'Details must be text';
    if (details.trim().length > COURSE_LIMITS.DETAILS) return `Details must be ${COURSE_LIMITS.DETAILS} characters or less`;
  }
  if (groupName !== undefined && groupName !== null) {
    if (typeof groupName !== 'string') return 'Group must be text';
    if (groupName.trim().length > COURSE_LIMITS.GROUP_NAME) return `Group must be ${COURSE_LIMITS.GROUP_NAME} characters or less`;
    if (RESERVED_GROUP_NAMES.includes(groupName.trim().toLowerCase())) return `"${groupName.trim()}" is used by the bot's own buttons — please pick another group name`;
  }
  return null;
};

/** '' / whitespace -> null, otherwise trimmed. */
const cleanText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

const hasPlaceholder = (text) => typeof text === 'string' && PLACEHOLDER_PATTERN.test(text);

module.exports = { COURSE_LIMITS, validateCourseFields, cleanText, hasPlaceholder };
