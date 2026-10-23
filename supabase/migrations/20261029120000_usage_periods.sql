-- Message counter per subscription period (replaces the per-calendar-month `usage` counter).
--
--   subscriptions.current_period_start  when the current usage period began. The counter resets when
--                                       it changes. Set by subscription.service#createSubscription,
--                                       the Razorpay subscription.activated / subscription.charged
--                                       handlers (rzpSub.current_start) and the admin extend of an
--                                       expired row. NULL = not set yet: readers fall back to
--                                       start_date (utils/usagePeriod.js), and an autopay row with NULL
--                                       is still on its 48-hour placeholder end_date (no real cycle).
--
--   usage_periods                       one row per (business, period). outbound_count = messages sent
--                                       through ApnaBot in that period (bot replies, owner/staff
--                                       replies, broadcasts, payment links, reminders, handoff
--                                       messages). Inbound messages, booking events and echoes of
--                                       phone-app messages are not counted.
--
--   increment_usage_period(...)         atomic upsert-and-add, returns the new total. No read-then-write.
--
-- The old `usage` table is left in place and is no longer written.
--
-- DEPLOY ORDER: apply this BEFORE the server code (the code calls the RPC and reads the column). Then
-- run `node src/scripts/backfillUsagePeriods.js` (dry run) and `--confirm`. Additive: nothing changes
-- for any live business until the new server code is running.
begin;

alter table subscriptions add column if not exists current_period_start timestamptz;

create table if not exists usage_periods (
  business_id uuid not null references businesses(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz,
  outbound_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, period_start)
);
alter table usage_periods enable row level security;

create or replace function increment_usage_period(
  p_business_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_delta int
) returns int as $$
declare
  v_total int;
begin
  insert into usage_periods (business_id, period_start, period_end, outbound_count)
  values (p_business_id, p_period_start, p_period_end, greatest(p_delta, 0))
  on conflict (business_id, period_start) do update
    set outbound_count = usage_periods.outbound_count + greatest(p_delta, 0),
        period_end = coalesce(excluded.period_end, usage_periods.period_end),
        updated_at = now()
  returning outbound_count into v_total;
  return v_total;
end;
$$ language plpgsql;

commit;
