// Helpers for Meta's message status webhooks (value.statuses[]).

const { statusesBefore } = require('./messageStatus');
const { fromStatusErrors } = require('./whatsappErrors');

/**
 * The events to hand apply_message_statuses for one change's statuses[]:
 * only statuses the messages table stores and that can change a row ('sent'
 * can't - rows start there). Meta's own timestamp (epoch seconds) is kept.
 * @returns {{events: Object[], ignored: Object[]}} ignored = statuses not stored (e.g. 'deleted')
 */
const buildStatusEvents = (statuses) => {
  const events = [];
  const ignored = [];
  for (const s of Array.isArray(statuses) ? statuses : []) {
    if (!s || typeof s.id !== 'string' || !s.id) continue;
    const allowedFrom = statusesBefore(s.status);
    if (allowedFrom === null) { ignored.push(s); continue; }
    if (allowedFrom.length === 0) continue;
    const ts = Number(s.timestamp);
    const err = s.status === 'failed' ? fromStatusErrors(s.errors) : {};
    events.push({
      wamid: s.id,
      status: s.status,
      ts: Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : null,
      error_code: err.errorCode ?? null,
      error_title: err.errorTitle ?? null,
      error_details: err.errorDetails ?? null
    });
  }
  return { events, ignored };
};

/**
 * One log line for a webhook body that carries only statuses (no phone numbers
 * or message text), or null for any other body. Failed codes are listed.
 * e.g. "WEBHOOK POST received (statuses only): 3 - delivered x2, failed x1 [131026]"
 */
const statusOnlySummary = (body) => {
  const entries = Array.isArray(body && body.entry) ? body.entry : [];
  const counts = {};
  const failedCodes = [];
  let total = 0;
  for (const entry of entries) {
    for (const change of Array.isArray(entry && entry.changes) ? entry.changes : []) {
      const v = change && change.value;
      if (!v || !Array.isArray(v.statuses) || v.statuses.length === 0) return null;
      if (Array.isArray(v.messages) && v.messages.length > 0) return null;
      for (const s of v.statuses) {
        total += 1;
        const name = s && s.status ? String(s.status) : 'unknown';
        counts[name] = (counts[name] || 0) + 1;
        if (name === 'failed') {
          const code = fromStatusErrors(s.errors).errorCode;
          if (code !== null) failedCodes.push(code);
        }
      }
    }
  }
  if (total === 0) return null;
  const parts = Object.entries(counts).map(([k, n]) => `${k} x${n}`).join(', ');
  const codes = failedCodes.length ? ` [${[...new Set(failedCodes)].join(', ')}]` : '';
  return `WEBHOOK POST received (statuses only): ${total} - ${parts}${codes}`;
};

module.exports = { buildStatusEvents, statusOnlySummary };
