// The one log line for an incoming webhook POST. A webhook body is never logged
// whole: it carries customers' message text, captions, contact names and phone
// numbers. Only these are logged: object, field / event type, waba_id,
// phone_number_id, message ids, message types, status values (and the Meta error
// code of a failed one), and counts.

const list = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined);

const countBy = (items, pick) => {
  const counts = {};
  for (const item of items) {
    const key = str(pick(item)) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
};

const summariseChange = (change) => {
  const value = (change && change.value) || {};
  const out = { field: str(change && change.field) || 'unknown' };

  const phoneNumberId = str(value.metadata && value.metadata.phone_number_id);
  if (phoneNumberId) out.phone_number_id = phoneNumberId;
  if (str(value.event)) out.event = str(value.event); // account_update, template status events

  const messages = list(value.messages);
  if (messages.length) {
    out.messages = messages.length;
    out.message_ids = messages.map((m) => str(m && m.id)).filter(Boolean);
    out.message_types = countBy(messages, (m) => m && m.type);
  }

  const statuses = list(value.statuses);
  if (statuses.length) {
    out.statuses = countBy(statuses, (s) => s && s.status);
    out.status_ids = statuses.map((s) => str(s && s.id)).filter(Boolean);
    const codes = statuses.flatMap((s) => list(s && s.errors).map((e) => str(e && e.code))).filter(Boolean);
    if (codes.length) out.error_codes = [...new Set(codes)];
  }

  const echoes = list(value.message_echoes);
  if (echoes.length) {
    out.message_echoes = echoes.length;
    out.message_ids = (out.message_ids || []).concat(echoes.map((m) => str(m && m.id)).filter(Boolean));
    out.message_types = countBy(echoes, (m) => m && m.type);
  }

  const history = list(value.history);
  if (history.length) {
    out.history_chunks = history.length;
    out.history_threads = history.reduce((n, h) => n + list(h && h.threads).length, 0);
    out.history_messages = history.reduce((n, h) => n + list(h && h.threads).reduce((m, t) => m + list(t && t.messages).length, 0), 0);
  }

  const contacts = list(value.state_sync);
  if (contacts.length) out.state_sync = contacts.length;

  return out;
};

/**
 * @param {Object} body - the parsed webhook body
 * @returns {string} one line, safe to log
 */
const webhookLogSummary = (body) => {
  const entries = list(body && body.entry).map((entry) => ({
    waba_id: str(entry && entry.id),
    changes: list(entry && entry.changes).map(summariseChange)
  }));
  return `WEBHOOK POST received: ${JSON.stringify({ object: str(body && body.object), entries })}`;
};

module.exports = { webhookLogSummary };
