-- Server-side aggregation for the reports endpoints (reports.service.js) and
-- the per-customer VIP booking stats (customer.controller.js). Each of these
-- used to fetch raw rows into Node and sum/count/pair them there, but
-- PostgREST silently caps any un-ranged select at max_rows (1000) — so once a
-- business crossed 1000 bookings/customers/messages the numbers were quietly
-- wrong rather than erroring. Doing the aggregation here means only the
-- (small) result crosses the wire.
--
-- All four are additive (new functions only, nothing existing is touched),
-- so this can be applied before the server code that calls them is deployed.
--
-- The server only ever calls these with the service_role key, so execute is
-- revoked from public/anon/authenticated and granted explicitly to
-- service_role (explicit grant so revoking from public can't take it away
-- on a project whose default privileges don't grant functions to
-- service_role directly).

-- Summary revenue: sum of fare_amount over bookings in [p_start, p_end) with
-- one of p_statuses. Null fares count as 0, matching the old
-- Number(fare_amount) || 0.
create or replace function report_sum_fare(
  p_business_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_statuses text[]
)
returns numeric as $$
  select coalesce(sum(fare_amount), 0)
  from bookings
  where business_id = p_business_id
    and status = any(p_statuses)
    and created_at >= p_start
    and created_at < p_end;
$$ language sql stable;

-- Revenue by customer tag. A customer with multiple tags contributes its full
-- revenue to each tag (not split); a customer with zero tags is excluded.
-- customer_count includes tagged customers with no qualifying bookings
-- (revenue 0). Ties on revenue are broken by tag so the order is stable.
-- The jsonb_typeof guard only protects jsonb_array_elements_text from a
-- non-array tags value (none exist; the column has no check constraint).
create or replace function report_revenue_by_tag(
  p_business_id uuid,
  p_statuses text[]
)
returns table (tag text, customer_count bigint, revenue numeric) as $$
  with revenue_by_customer as (
    select b.customer_id, sum(b.fare_amount) as customer_revenue
    from bookings b
    where b.business_id = p_business_id
      and b.status = any(p_statuses)
    group by b.customer_id
  )
  select t.tag_value, count(*), coalesce(sum(r.customer_revenue), 0)
  from customers c
  cross join lateral jsonb_array_elements_text(c.tags) as t(tag_value)
  left join revenue_by_customer r on r.customer_id = c.id
  where c.business_id = p_business_id
    and jsonb_typeof(c.tags) = 'array'
  group by t.tag_value
  order by 3 desc, 1;
$$ language sql stable;

-- Response time to a human reply. SQL port of reports.service.js's old
-- computeResponseTimeSamples pairing, run over messages in
-- [p_fetch_start, p_fetch_end):
--   - bot outbound messages are ignored entirely;
--   - per customer, every inbound message and human reply is numbered by how
--     many human replies came before it (grp), so each grp is "a run of
--     inbound messages + the human reply that closes it";
--   - a grp with at least one inbound and a closing reply is one wait
--     episode: wait = reply time - first inbound time;
--   - it's a sample only if the wait started in [p_window_start,
--     p_window_end) and wait <= p_max_wait_ms. A reply with nothing pending
--     (grp with no inbound) or an inbound never replied to (grp with no
--     reply) yields no sample.
-- Timestamps are truncated to milliseconds before the arithmetic to match
-- the JS Date precision the old code worked at; ordering uses the raw
-- created_at (id as tiebreaker). median = percentile_cont(0.5), which equals
-- the mean of the two middle values for an even count, as before.
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

-- VIP booking stats (count + summed fare_amount) per customer, for just the
-- given customer ids. Customers with no qualifying bookings get no row.
create or replace function customer_booking_stats(
  p_business_id uuid,
  p_customer_ids uuid[],
  p_statuses text[]
)
returns table (customer_id uuid, booking_count bigint, spend numeric) as $$
  select b.customer_id, count(*), coalesce(sum(b.fare_amount), 0)
  from bookings b
  where b.business_id = p_business_id
    and b.customer_id = any(p_customer_ids)
    and b.status = any(p_statuses)
  group by b.customer_id;
$$ language sql stable;

revoke execute on function report_sum_fare(uuid, timestamptz, timestamptz, text[]) from public, anon, authenticated;
revoke execute on function report_revenue_by_tag(uuid, text[]) from public, anon, authenticated;
revoke execute on function report_response_time_stats(uuid, timestamptz, timestamptz, timestamptz, timestamptz, bigint) from public, anon, authenticated;
revoke execute on function customer_booking_stats(uuid, uuid[], text[]) from public, anon, authenticated;

grant execute on function report_sum_fare(uuid, timestamptz, timestamptz, text[]) to service_role;
grant execute on function report_revenue_by_tag(uuid, text[]) to service_role;
grant execute on function report_response_time_stats(uuid, timestamptz, timestamptz, timestamptz, timestamptz, bigint) to service_role;
grant execute on function customer_booking_stats(uuid, uuid[], text[]) to service_role;
