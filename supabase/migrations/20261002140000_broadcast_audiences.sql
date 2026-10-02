-- Broadcast audiences: besides every opted-in customer ('all_customers'),
-- a coaching business can send to the parents who asked for a Free demo /
-- Admission ('coaching_requests' — bookings.form_key, see
-- 20260930120000_bookings_form_meta.sql), optionally for one course.
--
--   audience_params (coaching_requests only):
--     { form: 'demo' | 'admission' | 'any',
--       course: '<course name>' | null,      -- bookings.fields.course; null = all
--       skipClosed: boolean }                -- skip requests marked cancelled
--                                            -- ("Not interested" / "Not joining")
--
-- Recipients are still only opted-in, non-blocked customers, and a broadcast
-- still sends a Meta-approved template (broadcastAudience.service.js).
-- Existing broadcasts keep 'all_customers' and a null audience_params.
-- Drop the init schema's inline check on audience_filter whatever Postgres
-- named it (normally broadcasts_audience_filter_check).
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

alter table broadcasts
  add constraint broadcasts_audience_filter_check check (audience_filter in ('all_customers', 'coaching_requests'));

alter table broadcasts add column audience_params jsonb;

comment on column broadcasts.audience_params is 'coaching_requests only: { form: demo|admission|any, course: name|null, skipClosed: bool }.';
