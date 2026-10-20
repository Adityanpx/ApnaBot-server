// The pieces of fanning a broadcast out that don't depend on what is being sent: slicing the audience into
// worker jobs and keeping the per-recipient delivery rows (broadcast_recipients). Shared by
// controllers/broadcast.controller.js (template broadcasts) and services/catalogBroadcast.service.js.
const supabase = require('../config/supabase');
const logger = require('../utils/logger');

// One BullMQ job per this many recipients (whatsapp.queue.js has no
// existing batching precedent to follow, so this is a new, conservative
// default for broadcast fan-out).
const BATCH_SIZE = 50;

const chunk = (arr, size) => {
  const batches = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
};

// broadcast_recipients rows: one 'queued' row per recipient, made BEFORE the jobs are
// queued so the worker always finds its row. Delivery tracking is secondary to the
// send itself, so a failure here is logged and the send carries on; the worker then
// just skips the per-recipient write for the missing rows. Never throws.
const RECIPIENT_ROW_CHUNK = 500;

const createRecipientRows = async (broadcastId, businessId, customers) => {
  for (const part of chunk(customers, RECIPIENT_ROW_CHUNK)) {
    try {
      const { error } = await supabase.from('broadcast_recipients').upsert(
        part.map((c) => ({ broadcast_id: broadcastId, business_id: businessId, customer_id: c.id, whatsapp_number: c.whatsapp_number })),
        { onConflict: 'broadcast_id,whatsapp_number', ignoreDuplicates: true }
      );
      if (error) logger.error(`Broadcast ${broadcastId}: could not create recipient rows`, error);
    } catch (err) {
      logger.error(`Broadcast ${broadcastId}: could not create recipient rows`, err);
    }
  }
};

// Remove rows of recipients that will never be sent (all of them when the claim is
// released back to a draft, so a re-send doesn't meet stale 'queued' rows).
const removeRecipientRows = async (broadcastId, numbers = null) => {
  try {
    let q = supabase.from('broadcast_recipients').delete().eq('broadcast_id', broadcastId);
    if (numbers) q = q.in('whatsapp_number', numbers);
    const { error } = await q;
    if (error) logger.error(`Broadcast ${broadcastId}: could not remove recipient rows`, error);
  } catch (err) {
    logger.error(`Broadcast ${broadcastId}: could not remove recipient rows`, err);
  }
};

module.exports = { BATCH_SIZE, chunk, createRecipientRows, removeRecipientRows };
