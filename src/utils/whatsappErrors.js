// Plain-words reasons for the error codes Meta reports when a WhatsApp message
// fails - either in the send response (error.response.data.error) or in a
// `failed` status webhook (statuses[].errors[]). We store the raw code and
// Meta's own title and map to wording only when a response is built, so the
// wording can change without a migration.
//
// Codes and meanings are checked against Meta's Cloud API error-code page
// (developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes).
// `kind` groups reasons for the UI: recipient | window | limit | template | account | other.

const REASONS = {
  131026: { kind: 'recipient', reason: "Couldn't be delivered: the number may not be on WhatsApp, or the customer hasn't accepted WhatsApp's latest terms or uses an outdated app." },
  131050: { kind: 'recipient', reason: 'The customer has opted out of marketing messages from your business.' },
  131049: { kind: 'recipient', reason: 'WhatsApp chose not to deliver this marketing message to this customer, to keep engagement healthy. Retrying will not help.' },
  131047: { kind: 'window', reason: 'The 24-hour reply window had closed. Only an approved template can be sent now.' },
  131048: { kind: 'limit', reason: 'Sending from your number is restricted because earlier messages were flagged as spam. Review your message quality.' },
  131056: { kind: 'limit', reason: 'Too many messages were sent to this same customer in a short time. Try again later.' },
  130429: { kind: 'limit', reason: 'Sending too fast: the WhatsApp throughput limit was reached. Try again shortly.' },
  131042: { kind: 'account', reason: "There is a problem with your WhatsApp payment method. Fix it in Meta's billing settings." },
  132000: { kind: 'template', reason: "The number of template variables doesn't match the approved template." },
  132001: { kind: 'template', reason: "This template doesn't exist in that language or isn't approved." },
  132005: { kind: 'template', reason: 'The translated template text is too long.' },
  132007: { kind: 'template', reason: "The template content breaks WhatsApp's formatting policy." },
  132012: { kind: 'template', reason: "A template variable is in the wrong format for the template." },
  132015: { kind: 'template', reason: 'This template is paused by WhatsApp because of low quality, so it cannot be sent.' },
  132016: { kind: 'template', reason: 'This template was disabled by WhatsApp after repeated low quality. Create a new template.' },
  133010: { kind: 'account', reason: "Your WhatsApp number isn't registered on the WhatsApp Business Platform." },
  190: { kind: 'account', reason: 'Your WhatsApp connection has expired. Reconnect WhatsApp in settings.' },
  131000: { kind: 'other', reason: 'WhatsApp failed to send this message because of an unknown error. Try again.' },
  131016: { kind: 'other', reason: 'A WhatsApp service is temporarily unavailable. Try again later.' },
  133004: { kind: 'other', reason: 'WhatsApp servers are temporarily unavailable. Try again later.' },
  130472: { kind: 'recipient', reason: 'WhatsApp did not send this message to this customer as part of an experiment.' },
  131053: { kind: 'other', reason: "WhatsApp couldn't upload the media in this message." }
};

const MAX_TEXT = 500;
const clip = (v) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, MAX_TEXT));
const intOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

/**
 * The failure to show for a stored error.
 * @param {number|string|null} code - raw Meta error code
 * @param {string|null} [title] - Meta's own title / message, kept for the unknown-code wording
 * @returns {{code: number|null, title: string|null, reason: string, kind: string}}
 */
const describeFailure = (code, title = null) => {
  const n = intOrNull(code);
  const known = n !== null ? REASONS[n] : undefined;
  if (known) return { code: n, title: title || null, reason: known.reason, kind: known.kind };
  const base = "WhatsApp couldn't deliver this message";
  const suffix = n !== null ? ` (code ${n})` : '';
  return { code: n, title: title || null, reason: title ? `${base}${suffix}: ${title}` : `${base}${suffix}.`, kind: 'other' };
};

/**
 * The error columns from a status webhook's `errors[]` (first entry).
 * @returns {{errorCode: number|null, errorTitle: string|null, errorDetails: string|null}}
 */
const fromStatusErrors = (errors) => {
  const e = Array.isArray(errors) ? errors[0] : null;
  if (!e || typeof e !== 'object') return { errorCode: null, errorTitle: null, errorDetails: null };
  return {
    errorCode: intOrNull(e.code),
    errorTitle: clip(e.title || e.message),
    errorDetails: clip(e.error_data && e.error_data.details ? e.error_data.details : e.message)
  };
};

/**
 * The error columns from a thrown send error: Meta's rejection (an axios error
 * with response.data.error) or any other Error.
 */
const fromSendError = (err) => {
  const meta = err && err.response && err.response.data && err.response.data.error;
  if (meta && typeof meta === 'object') {
    return {
      errorCode: intOrNull(meta.code),
      errorTitle: clip(meta.error_user_title || meta.type || meta.message),
      errorDetails: clip((meta.error_data && meta.error_data.details) || meta.error_user_msg || meta.message)
    };
  }
  return { errorCode: null, errorTitle: clip(err && err.message), errorDetails: null };
};

/**
 * A camelCased messages row with `failure` added: null unless the message failed
 * or carries an error. Old rows (no error columns) get a failure only when
 * their status is 'failed'.
 */
const withFailure = (message) => {
  if (!message) return message;
  const failed = message.status === 'failed';
  const hasError = message.errorCode !== undefined && message.errorCode !== null;
  if (!failed && !hasError) return { ...message, failure: null };
  const d = describeFailure(hasError ? message.errorCode : null, message.errorTitle || null);
  return { ...message, failure: { ...d, details: message.errorDetails || null } };
};

module.exports = { describeFailure, fromStatusErrors, fromSendError, withFailure, REASONS };
