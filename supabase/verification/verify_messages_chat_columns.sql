-- Checks the SQL of migration 20261014140000_messages_chat_columns.sql WITHOUT touching
-- any real message: the three columns (types, nullable, no default), the foreign key
-- (ON DELETE SET NULL), the object-only CHECK, and the "mark a whole conversation
-- read" UPDATE that PUT /api/messages/customer/:customerId/read will run.
--
-- HOW TO RUN (Supabase dashboard -> SQL Editor), after applying that migration:
--   1. Paste this whole file into a new query and press Run.
--   2. It always ends in an error whose text is the report. That is intended: the
--      error is what guarantees nothing is kept.
--        RESULT: ALL n CHECKS PASSED (nothing was kept)   -> good
--        RESULT: FAILED (n): <check names>                  -> send me the text
--      Any other error (e.g. a NOT NULL column the fixture rows don't set) -> send me that too.
--
-- What it does: inside one DO block it creates a TEMP copy of public.messages (shape,
-- defaults and CHECK constraints, no foreign keys), puts pg_temp first on the
-- search_path, and runs the fixture inserts and the UPDATE against the copy. From the
-- real table it only reads the catalog and one count proving no fixture row leaked
-- into public.messages. It never writes to a real table, and the temp table is
-- dropped when the block ends.
--
-- NOTE: written without being run against a database (no DB access when it was
-- written). If a check FAILS, read the check name before suspecting the migration -
-- the harness itself is the newest part.

do $verify$
declare
  biz uuid := gen_random_uuid();
  other_biz uuid := gen_random_uuid();
  c1 uuid := gen_random_uuid();
  c2 uuid := gen_random_uuid();
  u1 uuid := gen_random_uuid();
  n int;
  v jsonb;
  rejected boolean;
  fails text[] := '{}';
  checks int := 0;
  leaked bigint;
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'messages' and column_name = 'interactive_payload') then
    raise exception 'RESULT: ABORTED: apply migration 20261014140000 first (messages.interactive_payload is missing)';
  end if;

  -- The real table, read-only (catalog): types, nullability, defaults.
  checks := checks + 1; if (select data_type from information_schema.columns where table_schema = 'public' and table_name = 'messages' and column_name = 'sent_by_user_id') is distinct from 'uuid' then fails := fails || '1 sent_by_user_id is uuid'; end if;
  checks := checks + 1; if (select data_type from information_schema.columns where table_schema = 'public' and table_name = 'messages' and column_name = 'sent_by_name') is distinct from 'text' then fails := fails || '2 sent_by_name is text'; end if;
  checks := checks + 1; if (select data_type from information_schema.columns where table_schema = 'public' and table_name = 'messages' and column_name = 'interactive_payload') is distinct from 'jsonb' then fails := fails || '3 interactive_payload is jsonb'; end if;
  checks := checks + 1; if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'messages'
                                    and column_name in ('sent_by_user_id', 'sent_by_name', 'interactive_payload')
                                    and (is_nullable <> 'YES' or column_default is not null)) then fails := fails || '4 all three columns are nullable with no default'; end if;

  -- Foreign key to users, ON DELETE SET NULL (confdeltype 'n').
  checks := checks + 1; if not exists (select 1 from pg_constraint
                                        where conrelid = 'public.messages'::regclass and contype = 'f'
                                          and confrelid = 'public.users'::regclass and confdeltype = 'n'
                                          and conkey = array[(select attnum from pg_attribute where attrelid = 'public.messages'::regclass and attname = 'sent_by_user_id')]) then
    fails := fails || '5 sent_by_user_id references users ON DELETE SET NULL'; end if;

  -- The CHECK exists on the real table.
  checks := checks + 1; if not exists (select 1 from pg_constraint
                                        where conrelid = 'public.messages'::regclass and contype = 'c'
                                          and conname = 'messages_interactive_payload_object_check') then
    fails := fails || '6 messages_interactive_payload_object_check exists'; end if;

  -- Temp copy: defaults and CHECK constraints come along, foreign keys do not.
  create temp table messages (like public.messages including defaults including constraints) on commit drop;
  perform set_config('search_path', 'pg_temp, public', true);
  if to_regclass('pg_temp.messages') is null then raise exception 'RESULT: ABORTED: temp messages table missing'; end if;

  -- An insert that knows nothing about the new columns (every pre-migration writer).
  insert into pg_temp.messages (business_id, customer_id, customer_number, direction, type, content)
    values (biz, c1, '919100000001', 'outbound', 'text', 'old-style row');
  checks := checks + 1; if exists (select 1 from pg_temp.messages where content = 'old-style row'
                                    and (sent_by_user_id is not null or sent_by_name is not null or interactive_payload is not null)) then
    fails := fails || '7 an old-style insert leaves all three columns NULL'; end if;

  -- The new values.
  insert into pg_temp.messages (business_id, customer_id, customer_number, direction, type, content, sender_type, sent_by_user_id, sent_by_name, interactive_payload)
    values (biz, c1, '919100000001', 'outbound', 'text', 'staff row', 'human', u1, 'ApnaBot Support',
            '{"kind":"list","body":"Pick one","buttonText":"Choose","options":[{"id":"a:0","title":"One","description":"d"}]}');
  select interactive_payload into v from pg_temp.messages where content = 'staff row';
  checks := checks + 1; if v->>'kind' is distinct from 'list' or v->'options'->0->>'title' is distinct from 'One' then fails := fails || '8 a payload object round-trips'; end if;
  checks := checks + 1; if (select sent_by_name from pg_temp.messages where content = 'staff row') is distinct from 'ApnaBot Support' then fails := fails || '9 sent_by_name round-trips'; end if;

  -- The CHECK: only NULL or an object. An array, a string, a number and JSON null are refused.
  rejected := false; begin insert into pg_temp.messages (business_id, customer_id, customer_number, direction, content, interactive_payload) values (biz, c1, '1', 'outbound', 'x', '[]'); exception when check_violation then rejected := true; end;
  checks := checks + 1; if not rejected then fails := fails || '10 an array payload is refused'; end if;
  rejected := false; begin insert into pg_temp.messages (business_id, customer_id, customer_number, direction, content, interactive_payload) values (biz, c1, '1', 'outbound', 'x', '"text"'); exception when check_violation then rejected := true; end;
  checks := checks + 1; if not rejected then fails := fails || '11 a string payload is refused'; end if;
  rejected := false; begin insert into pg_temp.messages (business_id, customer_id, customer_number, direction, content, interactive_payload) values (biz, c1, '1', 'outbound', 'x', '5'); exception when check_violation then rejected := true; end;
  checks := checks + 1; if not rejected then fails := fails || '12 a number payload is refused'; end if;
  rejected := false; begin insert into pg_temp.messages (business_id, customer_id, customer_number, direction, content, interactive_payload) values (biz, c1, '1', 'outbound', 'x', 'null'::jsonb); exception when check_violation then rejected := true; end;
  checks := checks + 1; if not rejected then fails := fails || '13 a JSON null payload is refused (use SQL NULL)'; end if;

  -- The batch mark-read UPDATE, on fixtures: biz/c1 has 2 unread inbound, 1 read inbound,
  -- 1 unread outbound; biz/c2 and other_biz/c1 each have 1 unread inbound that must not move.
  delete from pg_temp.messages;
  insert into pg_temp.messages (business_id, customer_id, customer_number, direction, content, is_read) values
    (biz,       c1, '919100000001', 'inbound',  'in-unread-1', false),
    (biz,       c1, '919100000001', 'inbound',  'in-unread-2', false),
    (biz,       c1, '919100000001', 'inbound',  'in-read',     true),
    (biz,       c1, '919100000001', 'outbound', 'out-unread',  false),
    (biz,       c2, '919100000002', 'inbound',  'other-customer', false),
    (other_biz, c1, '919100000001', 'inbound',  'other-business', false);

  with changed as (
    update pg_temp.messages set is_read = true
     where business_id = biz and customer_id = c1 and direction = 'inbound' and is_read = false
    returning id)
  select count(*) into n from changed;
  checks := checks + 1; if n <> 2 then fails := fails || '14 the UPDATE changes exactly the 2 unread inbound rows (got ' || n || ')'; end if;
  checks := checks + 1; if (select is_read from pg_temp.messages where content = 'out-unread') then fails := fails || '15 an outbound row is not touched'; end if;
  checks := checks + 1; if (select is_read from pg_temp.messages where content = 'other-customer') or (select is_read from pg_temp.messages where content = 'other-business') then fails := fails || '16 another customer / another business is not touched'; end if;
  with changed as (
    update pg_temp.messages set is_read = true
     where business_id = biz and customer_id = c1 and direction = 'inbound' and is_read = false
    returning id)
  select count(*) into n from changed;
  checks := checks + 1; if n <> 0 then fails := fails || '17 running it again changes nothing (count 0)'; end if;

  -- nothing leaked into the real table
  select count(*) into leaked from public.messages where business_id in (biz, other_biz);
  checks := checks + 1; if leaked <> 0 then fails := fails || '18 no fixture row reached public.messages'; end if;

  if array_length(fails, 1) is null then
    raise exception 'RESULT: ALL % CHECKS PASSED (nothing was kept)', checks;
  else
    raise exception 'RESULT: FAILED (%): %', array_length(fails, 1), array_to_string(fails, ' | ');
  end if;
end
$verify$;
