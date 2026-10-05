// Meta template status → message_templates.status
// (check constraint: draft, pending, approved, rejected, paused, disabled,
// deleted — see 20261004170000_message_templates_paused_disabled.sql and
// 20261005100000_message_templates_sync.sql). Only 'approved' (and
// send_support 'ok') is sendable; 'paused' / 'disabled' are registered with
// Meta but blocked, 'deleted' is gone from WhatsApp.
const { computeSendSupport } = require('./templateSendSupport');

// message_template_status_update webhook events. REINSTATED is Meta
// un-pausing / re-enabling a template.
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

// `status` field of GET /{waba}/message_templates. Not the same set as the
// webhook events: it has PENDING / IN_APPEAL / PENDING_DELETION / DELETED and
// no REINSTATED. FLAGGED still sends (Meta only warns that the template will
// be disabled if its quality doesn't recover), so it stays 'approved'.
const META_LISTING_STATUS_TO_STATUS = {
  APPROVED: 'approved',
  FLAGGED: 'approved',
  PENDING: 'pending',
  IN_APPEAL: 'pending',
  REJECTED: 'rejected',
  PAUSED: 'paused',
  DISABLED: 'disabled',
  LIMIT_EXCEEDED: 'disabled', // can't send; ARCHIVED stays unmapped
  PENDING_DELETION: 'deleted',
  DELETED: 'deleted'
};

/** The status to store for a listed template's Meta status, or null for one we don't map. */
const templateStatusFromMeta = (metaStatus) =>
  (Object.hasOwn(META_LISTING_STATUS_TO_STATUS, metaStatus) ? META_LISTING_STATUS_TO_STATUS[metaStatus] : null);

// send_support: can ApnaBot's sender send this template? Anything but 'ok' is
// blocked from broadcasts and follow-ups.
const SEND_SUPPORT_REASON = {
  needs_header_media: 'its header needs an image, video or PDF attached in ApnaBot first',
  unsupported_named_params: "it uses named variables ({{name}}), which ApnaBot can't fill yet",
  unsupported_component: "it has buttons (copy code, flow, ...) or another part ApnaBot can't send yet"
};

/**
 * The template's current send_support: the stored column AND a fresh
 * computeSendSupport of the stored row, whichever blocks. The stored column
 * alone can be stale (header media removed, components changed by a sync
 * after the column was last written). A row fetched without the column
 * (undefined) counts as 'ok' for the stored half — the DB default — so narrow
 * selects and older fixtures keep working. Callers must select the columns
 * computeSendSupport reads (meta_components, header_type, body_text,
 * header_media_url, header_image_url) or the recomputed half can't see them.
 */
const effectiveSendSupport = (row) => {
  if (row.send_support !== undefined && row.send_support !== 'ok') return row.send_support;
  return computeSendSupport(row);
};

/** Sendable as far as the template itself goes (see effectiveSendSupport). */
const isSendSupported = (row) => effectiveSendSupport(row) === 'ok';

/** approved on WhatsApp AND something ApnaBot's sender can send. */
const isTemplateUsable = (row) => !!row && row.status === 'approved' && isSendSupported(row);

/** Why an approved template can't be sent (for error messages), or null when it can. */
const sendSupportBlockReason = (row) => {
  const support = effectiveSendSupport(row);
  return support === 'ok' ? null : (SEND_SUPPORT_REASON[support] || "ApnaBot can't send it yet");
};

module.exports = {
  TEMPLATE_EVENT_TO_STATUS,
  templateStatusForEvent,
  META_LISTING_STATUS_TO_STATUS,
  templateStatusFromMeta,
  effectiveSendSupport,
  isSendSupported,
  isTemplateUsable,
  sendSupportBlockReason
};
