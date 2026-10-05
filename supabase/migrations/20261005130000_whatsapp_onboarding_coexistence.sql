-- WhatsApp onboarding paths (Cloud API vs coexistence) + coexistence message
-- sources. See the Embedded Signup coexistence task.
-- One transaction: either every change below lands or none does.
begin;
--
-- businesses.waba_id already exists (init schema) - not touched here.
-- whatsapp_onboarding_type stays NULL for businesses connected before this
-- migration (no backfill).
-- whatsapp_register_pin is the 2-step-verification PIN sent to /register on
-- the Cloud API path; stored encrypted with utils/crypto.encrypt, never logged.
alter table businesses
  add column if not exists whatsapp_onboarding_type text
    check (whatsapp_onboarding_type in ('cloud_api', 'coexistence')),
  add column if not exists whatsapp_register_pin text,
  add column if not exists coex_contacts_sync_requested_at timestamptz,
  add column if not exists coex_history_sync_requested_at timestamptz,
  add column if not exists whatsapp_connected_at timestamptz;

-- messages.sender_type: 'phone_app' = sent by the owner from the WhatsApp
-- Business app on the phone (smb_message_echoes / history sync). The original
-- check was declared inline on ADD COLUMN (auto-named), so look it up instead
-- of assuming its name.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'messages'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%sender_type%'
  loop
    execute format('alter table messages drop constraint %I', c.conname);
  end loop;
end $$;

alter table messages add constraint messages_sender_type_check
  check (sender_type in ('bot', 'human', 'phone_app'));

-- Rows imported by the coexistence history sync. They carry the original
-- (old) timestamps and must never count toward reports, unread counts or the
-- 24h window.
alter table messages
  add column if not exists is_history_import boolean not null default false;

-- report_response_time_stats: identical to 20260927120000 except history
-- imports are excluded. create or replace keeps the existing grants (the
-- revoke from public/anon/authenticated stays in force). It is the only
-- report RPC that reads messages (report_sum_fare / report_revenue_by_tag /
-- customer_booking_stats read bookings only).
create or replace function report_response_time_stats(
  p_business_id uuid,
  p_fetch_start timestamptz,
  p_fetch_end timestamptz,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_max_wait_ms bigint
)
returns table (average_minutes double precision, median_minutes double precision, sample_size bigint) as $$
  with relevant as (
    select
      m.id,
      m.customer_id,
      m.created_at,
      date_trunc('milliseconds', m.created_at) as created_ms,
      case when m.direction = 'inbound' then 0 else 1 end as is_reply
    from messages m
    where m.business_id = p_business_id
      and m.created_at >= p_fetch_start
      and m.created_at < p_fetch_end
      and not m.is_history_import
      and (m.direction = 'inbound' or m.sender_type <> 'bot')
  ),
  grouped as (
    select
      customer_id,
      created_ms,
      is_reply,
      sum(is_reply) over (
        partition by customer_id
        order by created_at, id
        rows between unbounded preceding and current row
      ) - is_reply as grp
    from relevant
  ),
  episodes as (
    select
      min(created_ms) filter (where is_reply = 0) as pending_since,
      max(created_ms) filter (where is_reply = 1) as replied_at
    from grouped
    group by customer_id, grp
  ),
  samples as (
    select
      pending_since,
      (extract(epoch from (replied_at - pending_since)) * 1000)::bigint as wait_ms
    from episodes
    where pending_since is not null
      and replied_at is not null
  )
  select
    avg(wait_ms / 60000.0::double precision),
    percentile_cont(0.5) within group (order by wait_ms / 60000.0::double precision),
    count(*)
  from samples
  where pending_since >= p_window_start
    and pending_since < p_window_end
    and wait_ms <= p_max_wait_ms;
$$ language sql stable;

commit;
