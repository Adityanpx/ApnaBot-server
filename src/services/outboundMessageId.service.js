// Saves Meta's message id (the wamid from a send response) on the outbound
// messages row, so Meta's status webhooks (sent / delivered / read / failed)
// can find the row, and so an echo of the same message is recognised.
//
// Never throws: the message has already been sent, so nothing here may fail
// the send or the job.

const supabase = require('../config/supabase');
const logger = require('../utils/logger');

// Postgres unique_violation on (business_id, meta_message_id).
const UNIQUE_VIOLATION = '23505';

/**
 * The wamid in a WhatsApp Cloud API send response
 * ({ messaging_product, contacts: [...], messages: [{ id }] }).
 * @param {Object|null|undefined} sendResponse
 * @returns {string|null}
 */
const extractMetaMessageId = (sendResponse) => {
  const id = sendResponse && sendResponse.messages && sendResponse.messages[0] && sendResponse.messages[0].id;
  return typeof id === 'string' && id ? id : null;
};

/**
 * An echo row ('phone_app') already holding this wamid means Meta echoed a
 * message we sent through the API: our own row is the real one, so the echo is
 * deleted. Only phone_app rows are ever removed.
 * @returns {Promise<number>} how many echo rows were deleted
 */
const removeEchoConflict = async (businessId, metaMessageId, keepRowId) => {
  const { data, error } = await supabase
    .from('messages').select('id')
    .eq('business_id', businessId).eq('meta_message_id', metaMessageId).eq('sender_type', 'phone_app');
  if (error) throw error;
  const ids = (data || []).map((r) => r.id).filter((id) => id !== keepRowId);
  if (ids.length === 0) return 0;

  const { error: delError } = await supabase.from('messages').delete().in('id', ids);
  if (delError) throw delError;
  logger.warn('Outbound message id matched an echo row - echo removed, API row kept (Meta echoed an API-sent message)', {
    businessId, metaMessageId, keptRowId: keepRowId, removedEchoRows: ids.length
  });
  return ids.length;
};

/**
 * Write the wamid (plus any `extraFields`, e.g. { status: 'sent' }) to the row.
 * If the wamid collides with an echo row the echo is deleted and the write
 * retried. If the id cannot be saved for any reason, `extraFields` is still
 * written on its own, so a failure here never costs the caller its own update.
 * @param {string} businessId
 * @param {string} rowId - messages.id of the outbound row
 * @param {string|null} metaMessageId - null/empty: just the extra fields
 * @param {Object} [extraFields]
 * @returns {Promise<boolean>} whether the wamid was saved
 */
const attachMetaMessageId = async (businessId, rowId, metaMessageId, extraFields = {}) => {
  const writeExtra = async () => {
    if (Object.keys(extraFields).length === 0) return;
    const { error } = await supabase.from('messages').update(extraFields).eq('id', rowId);
    if (error) logger.error('Error updating outbound message row:', error);
  };

  if (!metaMessageId) {
    try { await writeExtra(); } catch (err) { logger.error('Error updating outbound message row:', err); }
    return false;
  }

  try {
    const write = () => supabase.from('messages').update({ ...extraFields, meta_message_id: metaMessageId }).eq('id', rowId);
    let { error } = await write();

    if (error && error.code === UNIQUE_VIOLATION) {
      const removed = await removeEchoConflict(businessId, metaMessageId, rowId);
      if (removed > 0) ({ error } = await write());
    }
    if (!error) return true;

    logger.warn('Could not save the Meta message id on an outbound row', { businessId, rowId, metaMessageId, code: error.code, message: error.message });
  } catch (err) {
    logger.error('Error saving the Meta message id on an outbound row', { businessId, rowId, metaMessageId, error: err.message });
  }

  try { await writeExtra(); } catch (err) { logger.error('Error updating outbound message row:', err); }
  return false;
};

module.exports = { extractMetaMessageId, attachMetaMessageId, removeEchoConflict };
