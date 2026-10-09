-- customers.last_activity_at: the last time anything happened in the chat -
-- an inbound message, an owner reply from the dashboard, or an owner reply from
-- the WhatsApp Business app (smb_message_echoes). It orders the inbox and decides
-- who is in it.
--
-- last_message_at keeps its one job: the last INBOUND customer message, which
-- opens the 24h customer-service window (and drives follow-ups / audiences).
-- Echoes and dashboard sends must never move it, so a separate column.
--
-- Backfill = last_message_at, so the inbox is identical right after this runs
-- (same customers, same order). Customers with last_message_at NULL stay NULL
-- (not in the inbox) until they have activity.
alter table customers add column if not exists last_activity_at timestamptz;

update customers set last_activity_at = last_message_at where last_activity_at is null;

create index if not exists idx_customers_business_last_activity
  on customers (business_id, last_activity_at desc nulls last);
