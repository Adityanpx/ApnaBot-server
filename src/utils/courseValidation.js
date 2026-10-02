// Shared field validation for course_catalog (Super Admin) and
// business_courses (owners). Limits mirror the DB check constraints in
// 20260929130000_course_catalog_and_business_courses.sql (name 1..24,
// description <= 72), 20260930140000_course_structured_details.sql (age /
// duration / fees <= 100, mode enum, more details <= 800) plus the course
// page body limit the Bot Builder needs (details <= 1024, a WhatsApp
// interactive message body). Pure.

const COURSE_LIMITS = {
  NAME: 24, DESCRIPTION: 72, DETAILS: 1024, GROUP_NAME: 24,
  LINE: 100, MORE_DETAILS: 800,
  // 20260930150000_course_batches.sql
  BATCHES: 10, BATCH_LABEL: 72
};

// Group names that would clash with the bot's own list rows.
const RESERVED_GROUP_NAMES = ['main menu', 'all groups'];

// Blanks left in catalog starting text for each institute to fill in.
const PLACEHOLDER_PATTERN = /_{3,}/;

// Structured course details (API camelCase keys) and how each shows on the
// WhatsApp course page — see coursePageText.
const COURSE_MODES = { online: 'Online', offline: 'Offline', both: 'Online and offline' };
const STRUCTURED_LINES = [
  { key: 'ageGroup', label: 'Age', icon: '👦' },
  { key: 'duration', label: 'Duration', icon: '🕘' },
  { key: 'fees', label: 'Fees', icon: '💰' }
];
const STRUCTURED_KEYS = ['ageGroup', 'duration', 'fees', 'mode', 'moreDetails'];

const isFilled = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * @param {Object} body - { name?, description?, details?, groupName?,
 *   ageGroup?, duration?, fees?, mode?, moreDetails? }
 * @param {{ partial?: boolean }} [opts] - partial=true (updates): only
 *   validate keys that are present; name may not be blanked either way.
 * @returns {string|null} error message or null
 */
const validateCourseFields = (body, { partial = false } = {}) => {
  if (!body || typeof body !== 'object') return 'Request body must be an object';
  const { name, description, details, groupName, mode, moreDetails } = body;

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
  for (const { key, label } of STRUCTURED_LINES) {
    const v = body[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return `${label} must be text`;
    if (v.trim().length > COURSE_LIMITS.LINE) return `${label} must be ${COURSE_LIMITS.LINE} characters or less`;
  }
  if (mode !== undefined && mode !== null && mode !== '' && !Object.keys(COURSE_MODES).includes(mode)) {
    return `Mode must be one of: ${Object.keys(COURSE_MODES).join(', ')}`;
  }
  if (moreDetails !== undefined && moreDetails !== null) {
    if (typeof moreDetails !== 'string') return 'More details must be text';
    if (moreDetails.trim().length > COURSE_LIMITS.MORE_DETAILS) return `More details must be ${COURSE_LIMITS.MORE_DETAILS} characters or less`;
  }
  const { batches } = body;
  if (batches !== undefined && batches !== null) {
    if (!Array.isArray(batches)) return 'Batches must be a list';
    const labels = batches.filter(b => typeof b === 'string' && b.trim());
    if (labels.length !== batches.length) return 'Each batch needs a name, e.g. "Mon–Fri 5–6 pm"';
    if (labels.length > COURSE_LIMITS.BATCHES) return `A course can have at most ${COURSE_LIMITS.BATCHES} batches`;
    const tooLong = labels.find(b => b.trim().length > COURSE_LIMITS.BATCH_LABEL);
    if (tooLong) return `Batch "${tooLong.trim().slice(0, 20)}…" must be ${COURSE_LIMITS.BATCH_LABEL} characters or less`;
    const seen = new Set();
    for (const b of labels) {
      const key = b.trim().toLowerCase();
      if (seen.has(key)) return `Batch "${b.trim()}" is listed twice`;
      seen.add(key);
    }
  }
  return null;
};

/** Validated batches → trimmed labels (null/undefined → []). */
const cleanBatches = (batches) => (Array.isArray(batches) ? batches.map(b => b.trim()).filter(Boolean) : []);

/** '' / whitespace -> null, otherwise trimmed. */
const cleanText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** mode '' / null -> null, otherwise the (already validated) value. */
const cleanMode = (v) => (typeof v === 'string' && COURSE_MODES[v] ? v : null);

const hasPlaceholder = (text) => typeof text === 'string' && PLACEHOLDER_PATTERN.test(text);

// Structured details: API camelCase key → DB column (both course tables).
const STRUCTURED_COLUMNS = { ageGroup: 'age_group', duration: 'duration', fees: 'fees', mode: 'mode', moreDetails: 'more_details' };

/**
 * DB column values for the structured-detail keys (and batches) present in
 * `body` ('' clears a field), for an insert/update — validate with validateCourseFields
 * first. Used by coaching/course.controller.js and courseCatalog.controller.js.
 */
const structuredColumns = (body) => {
  const out = {};
  for (const [key, column] of Object.entries(STRUCTURED_COLUMNS)) {
    if (body[key] !== undefined) out[column] = key === 'mode' ? cleanMode(body[key]) : cleanText(body[key]);
  }
  if (body.batches !== undefined) out.batches = cleanBatches(body.batches);
  return out;
};

/** Whether a course (camelCase) uses the structured fields at all. */
const hasStructuredDetails = (course) =>
  !!course && (STRUCTURED_KEYS.some(k => k !== 'mode' && isFilled(course[k])) || !!COURSE_MODES[course.mode]);

/**
 * The WhatsApp course page text. Built from the structured fields when any is
 * set; otherwise the legacy free-text `details`, exactly as before (null when
 * neither). Keep apnabot-web courses/page.tsx and the Flutter
 * courses_screen.dart previews in step with this format.
 * @param {Object} course - camelCase course row
 * @returns {string|null}
 */
const coursePageText = (course) => {
  if (!course) return null;
  const main = coursePageMain(course);
  // Batches (when any) follow the details — on both the structured and the
  // old free-text page. No batches = the page exactly as before batches.
  const batches = Array.isArray(course.batches) ? course.batches.filter(isFilled).map(b => b.trim()) : [];
  if (batches.length === 0) return main;
  const section = `🗓 Batches:\n${batches.map(b => `• ${b}`).join('\n')}`;
  return main ? `${main}\n\n${section}` : null;
};

const coursePageMain = (course) => {
  if (!hasStructuredDetails(course)) return isFilled(course.details) ? course.details.trim() : null;
  const lines = [`*${course.name.trim()}*`];
  if (isFilled(course.description)) lines.push(course.description.trim());
  const facts = STRUCTURED_LINES.filter(l => isFilled(course[l.key])).map(l => `${l.icon} ${l.label}: ${course[l.key].trim()}`);
  if (COURSE_MODES[course.mode]) facts.push(`💻 Mode: ${COURSE_MODES[course.mode]}`);
  const body = [facts.join('\n'), isFilled(course.moreDetails) ? course.moreDetails.trim() : ''].filter(Boolean).join('\n\n');
  return body ? `${lines.join('\n')}\n\n${body}` : lines.join('\n');
};

module.exports = {
  COURSE_LIMITS, COURSE_MODES, STRUCTURED_KEYS,
  validateCourseFields, cleanText, cleanMode, cleanBatches, hasPlaceholder, hasStructuredDetails, coursePageText, structuredColumns
};
