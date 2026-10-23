-- messages.wa_timestamp: when WhatsApp says the message was sent (the webhook payload's `timestamp`).
-- created_at is when ApnaBot stored the row, which is later when Meta delivers a webhook late or in a
-- batch, so a chat ordered by created_at can show messages out of order.
--
--   wa_timestamp   inbound: the payload timestamp. Phone-app echoes: the echo's payload timestamp.
--                  Outbound from ApnaBot: NULL (created_at IS the send time). Nullable, no default.
--   message_time   GENERATED ALWAYS AS (coalesce(wa_timestamp, created_at)) STORED. PostgREST cannot
--                  ORDER BY or filter on an expression, so the coalesce lives in a column the chat
--                  queries (order by / `before` cursor) can use. Never written by the app.
--
-- The index is on (business_id, customer_id, message_time), i.e. the requested
-- (business_id, customer_id, coalesce(wa_timestamp, created_at)) with the expression held in the column.
--
-- DEPLOY ORDER: apply this BEFORE the server code (inserts now write wa_timestamp; reads order by
-- message_time). Adding a stored generated column rewrites the table under an ACCESS EXCLUSIVE lock for
-- the duration - run it at a quiet time. Then run `node src/scripts/backfillInboundWaTimestamp.js`
-- (dry run) and `--confirm`.
begin;

alter table messages add column if not exists wa_timestamp timestamptz;

alter table messages add column if not exists message_time timestamptz
  generated always as (coalesce(wa_timestamp, created_at)) stored;

create index if not exists idx_messages_chat_time
  on messages (business_id, customer_id, message_time desc);

commit;
