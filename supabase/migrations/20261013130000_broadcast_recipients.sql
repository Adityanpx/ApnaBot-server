-- Per-recipient delivery tracking for broadcasts.
--
-- broadcast_recipients: one row per customer a broadcast was sent to. sendBroadcast
--   inserts them as 'queued' before the jobs are queued; broadcast.worker.js moves
--   each to 'sent' (saving Meta's wamid and sent_at at once, so Meta's delivered /
--   read / failed status webhooks can find it) or 'failed' (Meta's rejection:
--   error_code / error_title / error_details). Meta's later status webhooks move it
--   forward through apply_message_statuses below. Broadcasts sent before this
--   migration have no rows; the API reports them as "not tracked".
--   Only the server touches it, with the service-role key (bypasses RLS); with RLS
--   on and no policies the anon / authenticated keys can't read or change it.
--
-- broadcast_recipient_stats(broadcast, business) -> jsonb: the counts shown on a
--   broadcast, in one query (the 2000-recipient cap keeps it cheap). The counts
--   overlap on purpose, so each answers its own question:
--     sent       Meta accepted it (sent_at set) - includes ones that failed later
--     delivered  delivered_at set - includes read
--     read       read_at set
--     failed     status 'failed' - rejected at send time OR failed afterwards
--     queued     not handled by the worker yet
--   tracked = false when the broadcast has no rows (sent before this feature).
--
-- apply_message_statuses (created in 20261013120000) is REPLACED so a wamid that
--   matches no chat message is looked up in broadcast_recipients, with the same
--   forward-only rules. The result keeps its old keys (changed, unmatched) and
--   gains changed_recipients; a wamid is "unmatched" only when neither table has it.
--   Old callers ignore the new key. The server code from commit A works unchanged
--   against this function.
--
-- Safe to re-run (create table / index if not exists, create or replace).
--
-- DEPLOY ORDER: apply 20261013120000_messages_delivery_tracking.sql first (this
-- replaces its function), then this file, THEN deploy the server code from the same
-- change - sendBroadcast and the worker write broadcast_recipients. Run
-- supabase/verification/verify_broadcast_recipients.sql after applying.
-- Rolling the server back is safe; the table and functions can stay.

create table if not exists broadcast_recipients (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references broadcasts(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  whatsapp_number text not null,
  status text not null default 'queued'
    check (status in ('queued', 'sent', 'delivered', 'read', 'failed')),
  meta_message_id text,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  error_code integer,
  error_title text,
  error_details text,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_broadcast_recipients_broadcast_number
  on broadcast_recipients (broadcast_id, whatsapp_number);
create index if not exists idx_broadcast_recipients_broadcast_status
  on broadcast_recipients (broadcast_id, status);
create unique index if not exists idx_broadcast_recipients_wamid
  on broadcast_recipients (meta_message_id) where meta_message_id is not null;

alter table broadcast_recipients enable row level security;

comment on table broadcast_recipients is
  'One row per customer a broadcast was sent to: queued -> sent (wamid) -> delivered -> read, or failed with Meta''s error. Missing for broadcasts sent before delivery tracking.';

create or replace function broadcast_recipient_stats(p_broadcast_id uuid, p_business_id uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'tracked', count(*) > 0,
    'total', count(*),
    'queued', count(*) filter (where status = 'queued'),
    'sent', count(*) filter (where sent_at is not null),
    'delivered', count(*) filter (where delivered_at is not null),
    'read', count(*) filter (where read_at is not null),
    'failed', count(*) filter (where status = 'failed')
  )
  from broadcast_recipients
  where broadcast_id = p_broadcast_id and business_id = p_business_id;
$$;

revoke all on function broadcast_recipient_stats(uuid, uuid) from public, anon, authenticated;
grant execute on function broadcast_recipient_stats(uuid, uuid) to service_role;

create or replace function apply_message_statuses(p_events jsonb)
returns jsonb
language plpgsql
as $$
declare
  ev jsonb;
  w text;
  s text;
  at_ts timestamptz;
  r messages;
  rr broadcast_recipients;
  changed jsonb := '[]'::jsonb;
  changed_recipients jsonb := '[]'::jsonb;
  unmatched jsonb := '[]'::jsonb;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    return jsonb_build_object('changed', changed, 'changed_recipients', changed_recipients, 'unmatched', unmatched);
  end if;

  for ev in select e from jsonb_array_elements(p_events) as e loop
    w := ev ->> 'wamid';
    s := ev ->> 'status';
    continue when w is null or w = '';
    continue when s is null or s not in ('delivered', 'read', 'failed');
    at_ts := case when (ev ->> 'ts') ~ '^[0-9]{1,12}$' then to_timestamp((ev ->> 'ts')::bigint) else now() end;
    r := null;
    rr := null;

    -- A chat message first.
    if s = 'delivered' then
      update messages
         set status = 'delivered', delivered_at = coalesce(delivered_at, at_ts)
       where meta_message_id = w and status = 'sent'
      returning * into r;
    elsif s = 'read' then
      update messages
         set status = 'read', read_at = coalesce(read_at, at_ts), delivered_at = coalesce(delivered_at, at_ts)
       where meta_message_id = w and status in ('sent', 'delivered')
      returning * into r;
    else
      update messages
         set status = 'failed', failed_at = coalesce(failed_at, at_ts),
             error_code = nullif(ev ->> 'error_code', '')::integer,
             error_title = nullif(ev ->> 'error_title', ''),
             error_details = nullif(ev ->> 'error_details', '')
       where meta_message_id = w and status = 'sent'
      returning * into r;
    end if;

    -- Then a broadcast recipient with that wamid (same rules).
    if r.id is null then
      if s = 'delivered' then
        update broadcast_recipients
           set status = 'delivered', delivered_at = coalesce(delivered_at, at_ts)
         where meta_message_id = w and status = 'sent'
        returning * into rr;
      elsif s = 'read' then
        update broadcast_recipients
           set status = 'read', read_at = coalesce(read_at, at_ts), delivered_at = coalesce(delivered_at, at_ts)
         where meta_message_id = w and status in ('sent', 'delivered')
        returning * into rr;
      else
        update broadcast_recipients
           set status = 'failed', failed_at = coalesce(failed_at, at_ts),
               error_code = nullif(ev ->> 'error_code', '')::integer,
               error_title = nullif(ev ->> 'error_title', ''),
               error_details = nullif(ev ->> 'error_details', '')
         where meta_message_id = w and status = 'sent'
        returning * into rr;
      end if;
    end if;

    if r.id is not null then
      changed := changed || jsonb_build_array(to_jsonb(r) - 'raw_payload');
    elsif rr.id is not null then
      changed_recipients := changed_recipients || jsonb_build_array(to_jsonb(rr));
    elsif not exists (select 1 from messages where meta_message_id = w)
          and not exists (select 1 from broadcast_recipients where meta_message_id = w)
          and not (unmatched @> to_jsonb(w)) then
      unmatched := unmatched || to_jsonb(w);
    end if;
  end loop;

  return jsonb_build_object('changed', changed, 'changed_recipients', changed_recipients, 'unmatched', unmatched);
end;
$$;

revoke all on function apply_message_statuses(jsonb) from public, anon, authenticated;
grant execute on function apply_message_statuses(jsonb) to service_role;
