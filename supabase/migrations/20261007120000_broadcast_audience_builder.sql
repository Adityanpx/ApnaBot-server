-- Broadcast audience builder, phase 1.
--
--   broadcasts.audience_filter gains 'customers' and 'segment':
--     customers  audience_params { customerIds: [uuid, ...] }            (at most 2000)
--     segment    audience_params { tags?: [text], pipelineStages?: [text],
--                                  activeWithinDays?: int, neverMessaged?: bool }
--                every key given must hold; tags match ANY, exactly
--                (customers.tags is a jsonb array of text); activeWithinDays is
--                last_message_at within N days; neverMessaged is
--                last_message_at IS NULL.
--
--   broadcast_audience(business, filter, params)
--     every customer the audience SELECTS, with skip_reason NULL when the
--     broadcast would reach them, else why not — checked in this order:
--       no_number      whatsapp_number is not 8-15 digits
--       blocked        customers.is_blocked
--       opted_out      customers.opted_out_at (sent STOP)
--       not_opted_in   customers.opted_in is not true
--     skip_reason IS NULL is exactly what broadcastAudience.service.js
--     #resolveAudience returns (which stays the send path);
--     src/scripts/checkAudienceParity.js compares the two on a real business.
--   broadcast_audience_summary(business, filter, params)
--     { selected, willReceive, skipped: { no_number, blocked, opted_out, not_opted_in } }
--     counted in one pass — no row is returned to the server.
--
-- Only the server calls these, with the service-role key.
--
-- DEPLOY ORDER: apply this BEFORE the server code from the same change. Without
-- it creating a 'customers' / 'segment' broadcast fails on the check constraint
-- and the summary endpoints fail on the missing functions; the existing audience
-- types are unaffected either way.

-- Drop the audience_filter check whatever Postgres named it (normally
-- broadcasts_audience_filter_check), then recreate it with the two new values.
do $$
declare c record;
begin
  for c in
    select con.conname from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'broadcasts' and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%audience_filter%'
  loop
    execute format('alter table broadcasts drop constraint %I', c.conname);
  end loop;
end $$;

alter table broadcasts add constraint broadcasts_audience_filter_check
  check (audience_filter in ('all_customers', 'coaching_requests', 'groups', 'customers', 'segment'));

create or replace function broadcast_audience(p_business_id uuid, p_filter text, p_params jsonb)
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
      when c.opted_in is distinct from true then 'not_opted_in'
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

create or replace function broadcast_audience_summary(p_business_id uuid, p_filter text, p_params jsonb)
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
      'not_opted_in', count(*) filter (where a.skip_reason = 'not_opted_in')))
  from broadcast_audience(p_business_id, p_filter, p_params) a;
$$;

revoke execute on function broadcast_audience(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function broadcast_audience_summary(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function broadcast_audience(uuid, text, jsonb) to service_role;
grant execute on function broadcast_audience_summary(uuid, text, jsonb) to service_role;

comment on function broadcast_audience(uuid, text, jsonb) is
  'Customers a broadcast audience selects, each with skip_reason (NULL = will receive). Same rules as broadcastAudience.service.js#resolveAudience.';
comment on function broadcast_audience_summary(uuid, text, jsonb) is
  'Counts of broadcast_audience: selected, willReceive, skipped by reason.';
