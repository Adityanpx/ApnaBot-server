-- Checks the SQL of migration 20261013130000_broadcast_recipients.sql WITHOUT touching
-- any real message or broadcast: the replaced apply_message_statuses() (chat messages
-- AND broadcast recipients) and broadcast_recipient_stats().
--
-- HOW TO RUN (Supabase dashboard -> SQL Editor), after applying BOTH migrations
-- (20261013120000 and 20261013130000):
--   1. Paste this whole file into a new query and press Run.
--   2. It always ends in an error whose text is the report. That is intended: the
--      error is what guarantees nothing is kept.
--        RESULT: ALL 18 CHECKS PASSED (nothing was kept)   -> good
--        RESULT: FAILED (n): <check names>                  -> send me the text
--      Any other error (e.g. a NOT NULL column the fixture rows don't set) -> send me that too.
--
-- What it does: inside one DO block it creates TEMP copies of public.messages and
-- public.broadcast_recipients (shape only, no foreign keys), puts pg_temp first on the
-- search_path so the functions' unqualified table names resolve to the copies, inserts
-- made-up rows and checks the results. From real data it only reads the catalog and two
-- counts proving no fixture wamid already exists. It never writes to a real table, and
-- the temp tables are dropped when the block ends.
-- (supabase/verification/verify_apply_message_statuses.sql still covers the chat-message
-- rules on their own; its check 13 now accepts the extra result key.)

do $verify$
declare
  t0 bigint := extract(epoch from timestamptz '2026-01-01 10:00:00+00')::bigint;
  res jsonb;
  m messages;
  rr broadcast_recipients;
  st jsonb;
  bc uuid := gen_random_uuid();
  biz uuid := gen_random_uuid();
  fails text[] := '{}';
  checks int := 0;
  leaked bigint;
begin
  if to_regclass('public.broadcast_recipients') is null then raise exception 'RESULT: ABORTED: apply migration 20261013130000 first'; end if;
  select (select count(*) from public.messages where meta_message_id like 'wamid.VERIFYB.%')
       + (select count(*) from public.broadcast_recipients where meta_message_id like 'wamid.VERIFYB.%') into leaked;
  if leaked > 0 then raise exception 'RESULT: ABORTED: % real rows already use a wamid.VERIFYB.* id', leaked; end if;

  create temp table messages (like public.messages including defaults) on commit drop;
  create temp table broadcast_recipients (like public.broadcast_recipients including defaults) on commit drop;
  perform set_config('search_path', 'pg_temp, public', true);
  if to_regclass('pg_temp.messages') is null or to_regclass('pg_temp.broadcast_recipients') is null then raise exception 'RESULT: ABORTED: temp tables missing'; end if;

  insert into messages (business_id, customer_id, customer_number, direction, status, meta_message_id)
  values (biz, gen_random_uuid(), '919800000001', 'outbound', 'sent', 'wamid.VERIFYB.CHAT');

  -- R1..R8 broadcast recipients: 4 sent (one will fail later), 1 failed at send, 2 queued, 1 sent -> read first
  insert into broadcast_recipients (broadcast_id, business_id, whatsapp_number, status, meta_message_id, sent_at) values
    (bc, biz, '911', 'sent', 'wamid.VERIFYB.R1', to_timestamp(t0)),
    (bc, biz, '912', 'sent', 'wamid.VERIFYB.R2', to_timestamp(t0)),
    (bc, biz, '913', 'sent', 'wamid.VERIFYB.R3', to_timestamp(t0)),
    (bc, biz, '914', 'sent', 'wamid.VERIFYB.R4', to_timestamp(t0)),
    (bc, biz, '918', 'sent', 'wamid.VERIFYB.R8', to_timestamp(t0));
  insert into broadcast_recipients (broadcast_id, business_id, whatsapp_number, status, failed_at, error_code, error_title) values
    (bc, biz, '915', 'failed', to_timestamp(t0), 131026, 'Message undeliverable');
  insert into broadcast_recipients (broadcast_id, business_id, whatsapp_number) values (bc, biz, '916'), (bc, biz, '917');

  -- 1-3: a recipient's delivered -> goes to changed_recipients, not changed
  res := apply_message_statuses(jsonb_build_array(jsonb_build_object('wamid','wamid.VERIFYB.R1','status','delivered','ts',t0 + 60)));
  select * into rr from broadcast_recipients where meta_message_id = 'wamid.VERIFYB.R1';
  checks := checks + 1; if rr.status <> 'delivered' or rr.delivered_at <> to_timestamp(t0 + 60) then fails := fails || '1 recipient delivered sets status + delivered_at from Meta ts'; end if;
  checks := checks + 1; if jsonb_array_length(res->'changed_recipients') <> 1 or jsonb_array_length(res->'changed') <> 0 or jsonb_array_length(res->'unmatched') <> 0 then fails := fails || '2 recipient change is reported under changed_recipients only'; end if;
  checks := checks + 1; if res->'changed_recipients'->0->>'broadcast_id' <> bc::text or res->'changed_recipients'->0->>'business_id' <> biz::text then fails := fails || '3 changed_recipients rows carry broadcast_id and business_id'; end if;

  -- 4: repeat is a no-op and not unmatched
  res := apply_message_statuses(jsonb_build_array(jsonb_build_object('wamid','wamid.VERIFYB.R1','status','delivered','ts',t0 + 99)));
  select * into rr from broadcast_recipients where meta_message_id = 'wamid.VERIFYB.R1';
  checks := checks + 1; if jsonb_array_length(res->'changed_recipients') <> 0 or jsonb_array_length(res->'unmatched') <> 0 or rr.delivered_at <> to_timestamp(t0 + 60) then fails := fails || '4 a repeated recipient delivered changes nothing and is not unmatched'; end if;

  -- 5: read then late delivered
  perform apply_message_statuses(jsonb_build_array(jsonb_build_object('wamid','wamid.VERIFYB.R1','status','read','ts',t0 + 120)));
  res := apply_message_statuses(jsonb_build_array(jsonb_build_object('wamid','wamid.VERIFYB.R1','status','delivered','ts',t0 + 130)));
  select * into rr from broadcast_recipients where meta_message_id = 'wamid.VERIFYB.R1';
  checks := checks + 1; if rr.status <> 'read' or rr.read_at <> to_timestamp(t0 + 120) or rr.delivered_at <> to_timestamp(t0 + 60) or jsonb_array_length(res->'changed_recipients') <> 0 then fails := fails || '5 recipient read stays read; a late delivered changes nothing'; end if;

  -- 6: read before delivered fills delivered_at
  perform apply_message_statuses(jsonb_build_array(jsonb_build_object('wamid','wamid.VERIFYB.R8','status','read','ts',t0 + 5)));
  select * into rr from broadcast_recipients where meta_message_id = 'wamid.VERIFYB.R8';
  checks := checks + 1; if rr.status <> 'read' or rr.delivered_at <> to_timestamp(t0 + 5) or rr.read_at <> to_timestamp(t0 + 5) then fails := fails || '6 recipient read before delivered also fills delivered_at'; end if;

  -- 7: async failure of a sent recipient stores the reason and keeps sent_at
  perform apply_message_statuses(jsonb_build_array(jsonb_build_object('wamid','wamid.VERIFYB.R2','status','failed','ts',t0 + 30,'error_code',131049,'error_title','Healthy ecosystem','error_details','d')));
  select * into rr from broadcast_recipients where meta_message_id = 'wamid.VERIFYB.R2';
  checks := checks + 1; if rr.status <> 'failed' or rr.error_code <> 131049 or rr.error_title <> 'Healthy ecosystem' or rr.error_details <> 'd' or rr.failed_at <> to_timestamp(t0 + 30) or rr.sent_at <> to_timestamp(t0) then fails := fails || '7 recipient failed stores the reason and keeps sent_at'; end if;

  -- 8: failed never overwrites a delivered recipient
  perform apply_message_statuses(jsonb_build_array(jsonb_build_object('wamid','wamid.VERIFYB.R3','status','delivered','ts',t0 + 40)));
  res := apply_message_statuses(jsonb_build_array(jsonb_build_object('wamid','wamid.VERIFYB.R3','status','failed','ts',t0 + 41,'error_code',131026)));
  select * into rr from broadcast_recipients where meta_message_id = 'wamid.VERIFYB.R3';
  checks := checks + 1; if rr.status <> 'delivered' or rr.error_code is not null or jsonb_array_length(res->'changed_recipients') <> 0 then fails := fails || '8 failed never overwrites a delivered recipient'; end if;

  -- 9: delivered + read for one recipient in ONE call
  res := apply_message_statuses(jsonb_build_array(
    jsonb_build_object('wamid','wamid.VERIFYB.R4','status','read','ts',t0 + 80),
    jsonb_build_object('wamid','wamid.VERIFYB.R4','status','delivered','ts',t0 + 79)));
  select * into rr from broadcast_recipients where meta_message_id = 'wamid.VERIFYB.R4';
  checks := checks + 1; if rr.status <> 'read' or rr.read_at <> to_timestamp(t0 + 80) or rr.delivered_at <> to_timestamp(t0 + 80) then fails := fails || '9 read then delivered in one call ends read'; end if;

  -- 10-11: a chat message still takes the chat path; both kinds in one call
  res := apply_message_statuses(jsonb_build_array(
    jsonb_build_object('wamid','wamid.VERIFYB.CHAT','status','delivered','ts',t0 + 1),
    jsonb_build_object('wamid','wamid.VERIFYB.R3','status','read','ts',t0 + 2)));
  select * into m from messages where meta_message_id = 'wamid.VERIFYB.CHAT';
  checks := checks + 1; if m.status <> 'delivered' or jsonb_array_length(res->'changed') <> 1 then fails := fails || '10 a chat message is still updated in messages'; end if;
  checks := checks + 1; if jsonb_array_length(res->'changed_recipients') <> 1 or res->'changed_recipients'->0->>'meta_message_id' <> 'wamid.VERIFYB.R3' then fails := fails || '11 a chat message and a recipient in one call both apply'; end if;

  -- 12-13: unmatched only when NEITHER table has the wamid
  res := apply_message_statuses(jsonb_build_array(
    jsonb_build_object('wamid','wamid.VERIFYB.NOPE','status','delivered','ts',t0),
    jsonb_build_object('wamid','wamid.VERIFYB.NOPE','status','read','ts',t0),
    jsonb_build_object('wamid','wamid.VERIFYB.R1','status','delivered','ts',t0)));
  checks := checks + 1; if res->'unmatched' <> '["wamid.VERIFYB.NOPE"]'::jsonb then fails := fails || '12 only a wamid in neither table is unmatched, once'; end if;
  checks := checks + 1; if apply_message_statuses(null)->'changed_recipients' <> '[]'::jsonb or apply_message_statuses('{}'::jsonb)->'unmatched' <> '[]'::jsonb then fails := fails || '13 null / non-array input returns empty lists'; end if;

  -- stats: R1 read, R2 failed(after sent), R3 read, R4 read, R8 read, 915 failed at send, 916/917 queued
  st := broadcast_recipient_stats(bc, biz);
  checks := checks + 1; if (st->>'tracked')::boolean is not true or (st->>'total')::int <> 8 then fails := fails || '14 stats: tracked and total'; end if;
  checks := checks + 1; if (st->>'queued')::int <> 2 then fails := fails || '15 stats: queued counts rows the worker has not handled'; end if;
  checks := checks + 1; if (st->>'sent')::int <> 5 or (st->>'delivered')::int <> 4 or (st->>'read')::int <> 4 then fails := fails || format('16 stats: sent counts accepted incl. later-failed, delivered includes read (got %s)', st::text); end if;
  checks := checks + 1; if (st->>'failed')::int <> 2 then fails := fails || '17 stats: failed counts send-time and later failures'; end if;
  checks := checks + 1; if broadcast_recipient_stats(bc, gen_random_uuid())->>'tracked' <> 'false' or broadcast_recipient_stats(gen_random_uuid(), biz)->>'total' <> '0' then fails := fails || '18 stats: other business / unknown broadcast is untracked and empty'; end if;

  if array_length(fails, 1) is null then
    raise exception 'RESULT: ALL % CHECKS PASSED (nothing was kept)', checks;
  else
    raise exception 'RESULT: FAILED (%): %', array_length(fails, 1), array_to_string(fails, ' | ');
  end if;
end
$verify$;
