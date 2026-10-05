-- One row per WhatsApp message id per business. The webhook is retried by
-- Meta and the coexistence history sync resends chunks, so the same wamid can
-- arrive more than once; this index lets the insert path treat a repeat as a
-- unique violation (23505) and skip it.
--
-- RUN ONLY AFTER src/scripts/dedupeMessages.js --confirm has removed the
-- existing duplicates - the create fails while any (business_id,
-- meta_message_id) pair repeats. Partial because many rows (anything not from
-- WhatsApp's webhook/send response) have no meta_message_id.
create unique index idx_messages_business_meta_message_id_unique
  on messages (business_id, meta_message_id)
  where meta_message_id is not null;
