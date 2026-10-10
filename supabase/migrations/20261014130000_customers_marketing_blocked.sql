-- A customer who stopped MARKETING messages from a business (Meta error 131050 /
-- the user_preferences webhook), kept apart from opted_out_at.
--
--   customers.marketing_blocked_at  when the customer stopped marketing messages
--     (NULL = they haven't). It blocks only the MARKETING rule - the same rule
--     that needs opted_in (broadcastAudience.service.js#requiresMarketingOptIn):
--     UTILITY broadcasts, bookings updates and in-window replies still reach
--     them, which opted_out_at (STOP: nothing at all) would wrongly stop.
--     Set by the server on a real 131050 or a user_preferences "stop"; cleared
--     ONLY by a user_preferences "resume", the customer's START message, or the
--     owner (POST /api/customers/:id/resume-marketing). An opt-in Yes tap and
--     a contact import never clear it.
--
--   broadcast_audience(business, filter, params, p_require_opt_in)
--   broadcast_audience_summary(business, filter, params, p_require_opt_in)
--     Same signatures and grants as 20261012120000. p_require_opt_in true (the
--     default, and what NULL means) is the marketing rule: a customer with
--     marketing_blocked_at is skipped as 'marketing_stopped'. false (a UTILITY
--     broadcast) ignores both opted_in and marketing_blocked_at. Skip order:
--     no_number > blocked > opted_out > marketing_stopped > not_opted_in
--     ('marketing_stopped' before 'not_opted_in': marking the customer opted in
--     cannot fix it). The summary gains skipped.marketing_stopped; every other
--     key is unchanged, so older clients simply ignore the new one.
--
-- Safe to re-run: add column if not exists + create or replace, no data touched
-- (the column starts NULL for everyone, so every result is identical until the
-- server stamps a first customer). One transaction. DEPLOY ORDER: apply this
-- BEFORE the server code - the new code selects and filters on the column.
-- Check it with supabase/verification/verify_marketing_blocked.sql.

begin;

alter table customers add column if not exists marketing_blocked_at timestamptz;

comment on column customers.marketing_blocked_at is
  'The customer stopped MARKETING messages from this business (Meta 131050 / user_preferences stop). Blocks only the MARKETING audience rule; NULL = not stopped.';

create or replace function broadcast_audience(p_business_id uuid, p_filter text, p_params jsonb, p_require_opt_in boolean default true)
returns table (customer_id uuid, whatsapp_number text, name text, skip_reason text)
language sql stable
set search_path = public
as $$
  select
    c.id,
    c.whatsapp_number,
    c.name,
    case
      when c.whatsapp_number is null or c.whatsapp_number !~ '^[0-9]{8,15}$' then 'no_number'
      when c.is_blocked is distinct from false then 'blocked'
      when c.opted_out_at is not null then 'opted_out'
      when coalesce(p_require_opt_in, true) and c.marketing_blocked_at is not null then 'marketing_stopped'
      when coalesce(p_require_opt_in, true) and c.opted_in is distinct from true then 'not_opted_in'
    end
  from customers c
  where c.business_id = p_business_id
    and case p_filter
      when 'all_customers' then true

      when 'customers' then c.id in (
        select v::uuid from jsonb_array_elements_text(coalesce(p_params->'customerIds', '[]'::jsonb)) as t(v))

      -- only this business's groups count (same as groupCustomerIds in the service)
      when 'groups' then exists (
        select 1
        from contact_group_members m
        join contact_groups g on g.id = m.group_id and g.business_id = p_business_id
        where m.customer_id = c.id
          and m.group_id in (
            select v::uuid from jsonb_array_elements_text(coalesce(p_params->'groupIds', '[]'::jsonb)) as t(v)))

      -- a Free demo / Admission request, optionally for one course, optionally not cancelled
      when 'coaching_requests' then exists (
        select 1
        from bookings b
        where b.business_id = p_business_id
          and b.customer_id = c.id
          and b.form_key = any (case coalesce(p_params->>'form', 'any')
                                  when 'any' then array['demo', 'admission']
                                  else array[p_params->>'form'] end)
          and (nullif(btrim(p_params->>'course'), '') is null or b.fields->>'course' = btrim(p_params->>'course'))
          and (not coalesce((p_params->>'skipClosed')::boolean, true) or b.status <> 'cancelled'))

      when 'segment' then
            case when jsonb_typeof(p_params->'tags') = 'array' and jsonb_array_length(p_params->'tags') > 0
                 then c.tags ?| array(select v from jsonb_array_elements_text(p_params->'tags') as t(v))
                 else true end
        and case when jsonb_typeof(p_params->'pipelineStages') = 'array' and jsonb_array_length(p_params->'pipelineStages') > 0
                 then c.pipeline_stage in (select v from jsonb_array_elements_text(p_params->'pipelineStages') as t(v))
                 else true end
        and (p_params->>'activeWithinDays' is null
             or c.last_message_at >= now() - make_interval(days => (p_params->>'activeWithinDays')::int))
        and (not coalesce((p_params->>'neverMessaged')::boolean, false) or c.last_message_at is null)

      else false
    end;
$$;

create or replace function broadcast_audience_summary(p_business_id uuid, p_filter text, p_params jsonb, p_require_opt_in boolean default true)
returns jsonb
language sql stable
set search_path = public
as $$
  select jsonb_build_object(
    'selected', count(*),
    'willReceive', count(*) filter (where a.skip_reason is null),
    'skipped', jsonb_build_object(
      'no_number', count(*) filter (where a.skip_reason = 'no_number'),
      'blocked', count(*) filter (where a.skip_reason = 'blocked'),
      'opted_out', count(*) filter (where a.skip_reason = 'opted_out'),
      'marketing_stopped', count(*) filter (where a.skip_reason = 'marketing_stopped'),
      'not_opted_in', count(*) filter (where a.skip_reason = 'not_opted_in')))
  from broadcast_audience(p_business_id, p_filter, p_params, p_require_opt_in) a;
$$;

revoke execute on function broadcast_audience(uuid, text, jsonb, boolean) from public, anon, authenticated;
revoke execute on function broadcast_audience_summary(uuid, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function broadcast_audience(uuid, text, jsonb, boolean) to service_role;
grant execute on function broadcast_audience_summary(uuid, text, jsonb, boolean) to service_role;

comment on function broadcast_audience(uuid, text, jsonb, boolean) is
  'Customers a broadcast audience selects, each with skip_reason (NULL = will receive). Same rules as broadcastAudience.service.js#resolveAudience; p_require_opt_in false (UTILITY template) skips the opted_in and marketing_blocked_at checks.';
comment on function broadcast_audience_summary(uuid, text, jsonb, boolean) is
  'Counts of broadcast_audience: selected, willReceive, skipped by reason (no_number, blocked, opted_out, marketing_stopped, not_opted_in).';

commit;
