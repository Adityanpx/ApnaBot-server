-- Checks apply_message_statuses() (migration 20261013120000_messages_delivery_tracking.sql)
-- WITHOUT touching any real message.
--
-- HOW TO RUN (Supabase dashboard -> SQL Editor), after applying the migration:
--   1. Paste this whole file into a new query and press Run.
--   2. It always ends in an error whose text is the report. That is intended: the
--      error is what guarantees nothing is kept.
--        RESULT: ALL 14 CHECKS PASSED (nothing was kept)   -> good
--        RESULT: FAILED (n): <check names>                  -> send me the text
--      Any other error (e.g. a NOT NULL column the fixture rows don't set) -> send me that too.
--
-- What it does: inside one DO block it creates a TEMP table shaped like public.messages,
-- puts pg_temp first on the search_path so the function's unqualified `messages`
-- resolves to that temp table, inserts made-up rows, calls the function and checks the
-- results. From real data it only reads the catalog (to copy the table's shape) and one
-- count proving no fixture wamid exists in public.messages. It never writes to
-- public.messages, and the temp table is dropped when the block ends.

do $verify$
declare
  t0 bigint := extract(epoch from timestamptz '2026-01-01 10:00:00+00')::bigint;
  res jsonb;
  m messages;
  fails text[] := '{}';
  checks int := 0;
  leaked bigint;
begin
  select count(*) into leaked from public.messages where meta_message_id like 'wamid.VERIFY.%';
  if leaked > 0 then raise exception 'RESULT: ABORTED: % real rows already use a wamid.VERIFY.* id', leaked; end if;

  create temp table messages (like public.messages including defaults) on commit drop;
  perform set_config('search_path', 'pg_temp, public', true);
  if to_regclass('pg_temp.messages') is null then raise exception 'RESULT: ABORTED: temp table missing'; end if;

  insert into messages (business_id, customer_id, customer_number, direction, status, meta_message_id)
  select gen_random_uuid(), gen_random_uuid(), '919800000001', 'outbound', 'sent', 'wamid.VERIFY.' || x
    from unnest(array['A','B','C','D','E']) as x;

  -- A: delivered, repeat, read, late delivered ------------------------------------------
  res := apply_message_statuses(jsonb_build_array(jsonb_build_object('wamid','wamid.VERIFY.A','status','delivered','ts',t0)));
  select * into m from messages where meta_message_id = 'wamid.VERIFY.A';
  checks := checks + 1; if m.status <> 'delivered' or m.delivered_at <> to_timestamp(t0) then fails := fails || '1 delivered sets status + delivered_at from Meta ts'; end if;
  checks := checks + 1; if jsonb_array_length(res->'changed') <> 1 or jsonb_array_length(res->'unmatched') <> 0 then fails := fails || '2 delivered is reported as changed'; end if;
  checks := checks + 1; if (res->'changed'->0->'raw_payload') is not null then fails := fails || '3 changed rows carry no raw_payload'; end if;

  res := apply_message_statuses(jsonb_build_array(jsonb_build_object('wamid','wamid.VERIFY.A','status','delivered','ts',t0 + 99)));
  select * into m from messages where meta_message_id = 'wamid.VERIFY.A';
  checks := checks + 1; if jsonb_array_length(res->'changed') <> 0 or jsonb_array_length(res->'unmatched') <> 0 or m.delivered_at <> to_timestamp(t0) then fails := fails || '4 a repeated delivered changes nothing and is not unmatched'; end if;

  res := apply_message_statuses(jsonb_build_array(jsonb_build_object('wamid','wamid.VERIFY.A','status','read','ts',t0 + 10)));
  select * into m from messages where meta_message_id = 'wamid.VERIFY.A';
  checks := checks + 1; if m.status <> 'read' or m.read_at <> to_timestamp(t0 + 10) or m.delivered_at <> to_timestamp(t0) then fails := fails || '5 read sets read_at and keeps the earlier delivered_at'; end if;

  res := apply_message_statuses(jsonb_build_array(jsonb_build_object('wamid','wamid.VERIFY.A','status','delivered','ts',t0 + 20)));
  select * into m from messages where meta_message_id = 'wamid.VERIFY.A';
  checks := checks + 1; if m.status <> 'read' or jsonb_array_length(res->'changed') <> 0 then fails := fails || '6 a late delivered never moves read backwards'; end if;

  -- B: read arrives first -------------------------------------------------------------
  res := apply_message_statuses(jsonb_build_array(jsonb_build_object('wamid','wamid.VERIFY.B','status','read','ts',t0 + 5)));
  select * into m from messages where meta_message_id = 'wamid.VERIFY.B';
  checks := checks + 1; if m.status <> 'read' or m.read_at <> to_timestamp(t0 + 5) or m.delivered_at <> to_timestamp(t0 + 5) then fails := fails || '7 read before delivered also fills delivered_at'; end if;

  -- C: failed -------------------------------------------------------------------------
  res := apply_message_statuses(jsonb_build_array(jsonb_build_object('wamid','wamid.VERIFY.C','status','failed','ts',t0 + 7,'error_code',131026,'error_title','Message undeliverable','error_details','not on whatsapp')));
  select * into m from messages where meta_message_id = 'wamid.VERIFY.C';
  checks := checks + 1; if m.status <> 'failed' or m.failed_at <> to_timestamp(t0 + 7) or m.error_code <> 131026 or m.error_title <> 'Message undeliverable' or m.error_details <> 'not on whatsapp' then fails := fails || '8 failed stores time, code, title and details'; end if;

  -- D: failed must not hit a delivered message -------------------------------------------
  perform apply_message_statuses(jsonb_build_array(jsonb_build_object('wamid','wamid.VERIFY.D','status','delivered','ts',t0)));
  res := apply_message_statuses(jsonb_build_array(jsonb_build_object('wamid','wamid.VERIFY.D','status','failed','ts',t0 + 1,'error_code',131026)));
  select * into m from messages where meta_message_id = 'wamid.VERIFY.D';
  checks := checks + 1; if m.status <> 'delivered' or m.error_code is not null or jsonb_array_length(res->'changed') <> 0 then fails := fails || '9 failed never overwrites a delivered message'; end if;

  -- E: delivered + read for the same wamid in ONE call ------------------------------------
  res := apply_message_statuses(jsonb_build_array(
    jsonb_build_object('wamid','wamid.VERIFY.E','status','read','ts',t0 + 30),
    jsonb_build_object('wamid','wamid.VERIFY.E','status','delivered','ts',t0 + 29)));
  select * into m from messages where meta_message_id = 'wamid.VERIFY.E';
  checks := checks + 1; if m.status <> 'read' or m.read_at <> to_timestamp(t0 + 30) or m.delivered_at <> to_timestamp(t0 + 30) then fails := fails || '10 read then delivered in one call ends read'; end if;

  -- unmatched, ignored statuses, bad input -----------------------------------------------
  res := apply_message_statuses(jsonb_build_array(
    jsonb_build_object('wamid','wamid.VERIFY.NOPE','status','delivered','ts',t0),
    jsonb_build_object('wamid','wamid.VERIFY.NOPE','status','read','ts',t0)));
  checks := checks + 1; if res->'unmatched' <> '["wamid.VERIFY.NOPE"]'::jsonb then fails := fails || '11 an unknown wamid is reported unmatched once'; end if;

  res := apply_message_statuses(jsonb_build_array(jsonb_build_object('wamid','wamid.VERIFY.A','status','deleted','ts',t0)));
  checks := checks + 1; if jsonb_array_length(res->'changed') <> 0 or jsonb_array_length(res->'unmatched') <> 0 then fails := fails || '12 a status that is not stored is ignored'; end if;

  checks := checks + 1; if apply_message_statuses(null) <> '{"changed":[],"unmatched":[]}'::jsonb or apply_message_statuses('{}'::jsonb) <> '{"changed":[],"unmatched":[]}'::jsonb then fails := fails || '13 null / non-array input returns empty'; end if;

  -- a missing ts is fine (falls back to now()), and a failed message stays failed
  perform apply_message_statuses(jsonb_build_array(jsonb_build_object('wamid','wamid.VERIFY.C','status','delivered')));
  checks := checks + 1; if (select status from messages where meta_message_id = 'wamid.VERIFY.C') <> 'failed' then fails := fails || '14 a failed message is not revived by a later delivered'; end if;

  if array_length(fails, 1) is null then
    raise exception 'RESULT: ALL % CHECKS PASSED (nothing was kept)', checks;
  else
    raise exception 'RESULT: FAILED (%): %', array_length(fails, 1), array_to_string(fails, ' | ');
  end if;
end
$verify$;
