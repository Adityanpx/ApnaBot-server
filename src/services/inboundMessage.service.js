const supabase = require('../config/supabase');
const { decideDuplicate } = require('../utils/inboundMessage');

// Postgres unique_violation - raised by idx_messages_business_meta_message_id_unique
// (migration 20261005140000) when the same business + wamid is inserted twice.
const UNIQUE_VIOLATION = '23505';

/**
 * The stored row for this WhatsApp message id, if any.
 * @returns {Promise<Object|null>} snake_case row (id, type, customer_id)
 */
const findByMetaId = async (businessId, metaMessageId) => {
  const { data, error } = await supabase.from('messages')
    .select('id, type, customer_id')
    .eq('business_id', businessId).eq('meta_message_id', metaMessageId);
  if (error) throw error;
  return data && data.length > 0 ? data[0] : null;
};

/**
 * Turn a stored 'unsupported' row into the real message. A single conditional
 * UPDATE, so of two concurrent real deliveries exactly one gets a row back.
 * @returns {Promise<Object|null>} the updated row, or null if someone else already replaced it
 */
const replaceWeakRow = async (businessId, metaMessageId, replaceFields) => {
  const { data, error } = await supabase.from('messages')
    .update(replaceFields)
    .eq('business_id', businessId).eq('meta_message_id', metaMessageId).eq('type', 'unsupported')
    .select();
  if (error) throw error;
  return data && data.length > 0 ? data[0] : null;
};

/**
 * Gate for an inbound delivery, run BEFORE any side effect (customer bump,
 * usage, bot). Looks up the stored row for the wamid and applies
 * decideDuplicate; a 'replace' is performed here.
 * @param {string} businessId
 * @param {string} metaMessageId
 * @param {string} incomingType - the type this delivery would be stored as
 * @param {Object} replaceFields - columns written over a weak row when this delivery is real
 * @returns {Promise<{action:'insert'}|{action:'ignore'}|{action:'replace', message:Object}>}
 */
const gateInbound = async (businessId, metaMessageId, incomingType, replaceFields) => {
  const existing = await findByMetaId(businessId, metaMessageId);
  const decision = decideDuplicate(existing?.type, incomingType);
  if (decision === 'insert') return { action: 'insert' };
  if (decision === 'ignore') return { action: 'ignore' };
  const message = await replaceWeakRow(businessId, metaMessageId, replaceFields);
  return message ? { action: 'replace', message } : { action: 'ignore' };
};

/**
 * Insert an inbound row. Without the unique index a repeat simply inserts (the
 * gate above is the only protection); with it, a concurrent repeat raises
 * 23505 and is resolved here by the same matrix as the gate.
 * @param {Object} fields - snake_case row fields (must include business_id, meta_message_id, type)
 * @param {Object} replaceFields - columns written over a weak row when this delivery is real
 * @returns {Promise<{action:'inserted'|'replace', message:Object}|{action:'ignore'}>}
 */
const insertInbound = async (fields, replaceFields) => {
  const { data, error } = await supabase.from('messages').insert(fields).select().single();
  if (!error) return { action: 'inserted', message: data };
  if (error.code !== UNIQUE_VIOLATION) throw error;

  const existing = await findByMetaId(fields.business_id, fields.meta_message_id);
  const decision = decideDuplicate(existing?.type, fields.type);
  if (decision === 'replace') {
    const message = await replaceWeakRow(fields.business_id, fields.meta_message_id, replaceFields);
    return message ? { action: 'replace', message } : { action: 'ignore' };
  }
  if (decision === 'insert') {
    // The row vanished between the violation and the re-read (e.g. the dedupe
    // script ran): insert once more rather than lose a real message.
    const retry = await supabase.from('messages').insert(fields).select().single();
    if (retry.error) throw retry.error;
    return { action: 'inserted', message: retry.data };
  }
  return { action: 'ignore' };
};

module.exports = { gateInbound, insertInbound };
