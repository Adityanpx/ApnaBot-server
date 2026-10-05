// Pure parsing for the WhatsApp Business app coexistence webhooks
// (smb_message_echoes, history, smb_app_state_sync, account_update). Shapes are
// from Meta's webhook reference; nothing here touches the database.

const { INBOUND_MESSAGE_TYPES, inboundMediaLabel } = require('./inboundMessage');

const digits = (v) => String(v === undefined || v === null ? '' : v).replace(/\D/g, '');

const isoFromUnix = (ts) => {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
};

const storedType = (type) => (INBOUND_MESSAGE_TYPES.has(type) ? type : 'unsupported');

/**
 * Text for the inbox. A type we don't store is labelled quietly - the
 * "ask the customer to resend" label of live inbound messages makes no sense
 * for something the owner sent or an old chat.
 */
const contentFor = (message) => {
  if (message.text && message.text.body) return message.text.body;
  if (storedType(message.type) === 'unsupported') return '[Message type not supported]';
  return inboundMediaLabel(message) || '';
};

/**
 * One entry of value.message_echoes (a message the owner sent from the phone).
 * @param {Object} echo
 * @param {string} businessDigits - the business number, digits only
 * @returns {{skip:string}|{row:{metaId:string, customerNumber:string, type:string, content:string, createdAt:string|null}}}
 */
const parseEcho = (echo, businessDigits) => {
  if (!echo || !echo.id) return { skip: 'no message id' };
  // revoke / edit act on an earlier message; they are not messages themselves.
  if (echo.type === 'revoke' || echo.type === 'edit') return { skip: echo.type };
  const to = digits(echo.to);
  if (!to) return { skip: 'no recipient' };
  if (to === businessDigits) return { skip: 'sent to the business number itself' };
  return {
    row: {
      metaId: echo.id,
      customerNumber: to,
      type: storedType(echo.type),
      content: contentFor(echo),
      createdAt: isoFromUnix(echo.timestamp)
    }
  };
};

/** History delivery status -> messages.status: ERROR is 'failed', everything else 'delivered'. */
const historyStatus = (contextStatus) => (String(contextStatus || '').toUpperCase() === 'ERROR' ? 'failed' : 'delivered');

/**
 * One entry of value.history[]: a chunk of old chats, or an error (the
 * business declined to share history).
 * Direction comes from `from`: the business number = sent by the business,
 * the thread's customer number = sent by the customer. Both sides are compared
 * as digits.
 * @param {Object} entry
 * @param {string} businessDigits
 * @returns {{meta:Object, errors:Object[], messages:Object[], unmatched:number, threads:number}}
 */
const parseHistoryEntry = (entry, businessDigits) => {
  const out = { meta: (entry && entry.metadata) || {}, errors: (entry && entry.errors) || [], messages: [], unmatched: 0, threads: 0 };
  const threads = Array.isArray(entry && entry.threads) ? entry.threads : [];
  out.threads = threads.length;

  for (const thread of threads) {
    const threadNumber = digits(thread && thread.id);
    for (const m of (thread && thread.messages) || []) {
      if (!m || !m.id) { out.unmatched += 1; continue; }
      const from = digits(m.from);
      const fromBusiness = from === businessDigits || (!businessDigits && from !== threadNumber && from !== '');
      const fromCustomer = from === threadNumber && from !== '';
      if (!fromBusiness && !fromCustomer) { out.unmatched += 1; continue; }

      const direction = fromBusiness ? 'outbound' : 'inbound';
      const customerNumber = fromBusiness ? (threadNumber || digits(m.to)) : from;
      if (!customerNumber || customerNumber === businessDigits) { out.unmatched += 1; continue; }

      out.messages.push({
        metaId: m.id,
        customerNumber,
        direction,
        type: storedType(m.type),
        content: contentFor(m),
        status: historyStatus(m.history_context && m.history_context.status),
        createdAt: isoFromUnix(m.timestamp)
      });
    }
  }
  return out;
};

/**
 * value.state_sync[]: contacts added / edited / removed on the phone.
 * @param {Object[]} items
 * @returns {{adds:{phone:string, name:string|null}[], removes:number, invalid:number}}
 */
const parseStateSync = (items) => {
  const adds = new Map();
  let removes = 0;
  let invalid = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.type !== 'contact' || !item.contact) { invalid += 1; continue; }
    if (item.action === 'remove') { removes += 1; continue; }
    if (item.action !== 'add') { invalid += 1; continue; }
    const phone = digits(item.contact.phone_number);
    if (!/^[0-9]{10,15}$/.test(phone)) { invalid += 1; continue; }
    const name = (item.contact.full_name || item.contact.first_name || '').trim() || null;
    const prev = adds.get(phone);
    // Later items win, but a name is never replaced by nothing.
    adds.set(phone, { phone, name: name || (prev && prev.name) || null });
  }
  return { adds: [...adds.values()], removes, invalid };
};

const DISCONNECT_EVENTS = new Set(['PARTNER_REMOVED', 'ACCOUNT_DELETED', 'ACCOUNT_OFFBOARDED']);

/** What an account_update event means for the connection. */
const accountUpdateAction = (event) => {
  if (DISCONNECT_EVENTS.has(event)) return 'disconnect';
  if (event === 'ACCOUNT_RECONNECTED') return 'reconnect';
  return 'log';
};

const BULK_SYNC_FIELDS = new Set(['history', 'smb_app_state_sync']);

/** True when a webhook body carries a history or contact-sync change (too big to log whole). */
const isBulkSyncBody = (body) => {
  const entries = body && Array.isArray(body.entry) ? body.entry : [];
  return entries.some((e) => Array.isArray(e && e.changes) && e.changes.some((c) => c && BULK_SYNC_FIELDS.has(c.field)));
};

module.exports = { isBulkSyncBody, digits, isoFromUnix, parseEcho, parseHistoryEntry, parseStateSync, historyStatus, accountUpdateAction };
