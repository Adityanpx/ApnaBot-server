// Meta's message_template_status_update events → message_templates.status
// (check constraint: draft, pending, approved, rejected, paused, disabled —
// see 20261004170000_message_templates_paused_disabled.sql). Only 'approved'
// is sendable; 'paused' / 'disabled' are registered with Meta but blocked.
// REINSTATED is Meta un-pausing / re-enabling a template.
const TEMPLATE_EVENT_TO_STATUS = {
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PAUSED: 'paused',
  DISABLED: 'disabled',
  REINSTATED: 'approved'
};

/** The status to store for a Meta template event, or null for one we don't track. */
const templateStatusForEvent = (event) =>
  (Object.hasOwn(TEMPLATE_EVENT_TO_STATUS, event) ? TEMPLATE_EVENT_TO_STATUS[event] : null);

module.exports = { TEMPLATE_EVENT_TO_STATUS, templateStatusForEvent };
