-- messages.raw_payload: Meta's raw webhook message object, stored ONLY for
-- inbound messages saved as type 'unsupported' (Meta's own 'unsupported'
-- placeholder, or a message type we don't parse). It carries the errors /
-- referral / real type that the stored row otherwise loses, so these can be
-- diagnosed without digging through Render logs. NULL for every other row.
--
-- RUN BEFORE deploying the inbound dedupe change: the webhook now writes this
-- column for unsupported messages, and the insert fails if it doesn't exist.
alter table messages add column if not exists raw_payload jsonb;
