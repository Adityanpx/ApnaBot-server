-- Checks the SQL of migration 20261014130000_customers_marketing_blocked.sql WITHOUT
-- touching any real customer: broadcast_audience() and broadcast_audience_summary()
-- with the new 'marketing_stopped' skip reason, plus the column, the signatures and
-- the grants.
--
-- HOW TO RUN (Supabase dashboard -> SQL Editor), after applying that migration:
--   1. Paste this whole file into a new query and press Run.
--   2. It always ends in an error whose text is the report. That is intended: the
--      error is what guarantees nothing is kept.
--        RESULT: ALL n CHECKS PASSED (nothing was kept)   -> good
--        RESULT: FAILED (n): <check names>                  -> send me the text
--      Any other error (e.g. a NOT NULL column the fixture rows don't set) -> send me that too.
--
-- What it does: inside one DO block it creates a TEMP copy of public.customers (shape
-- only, no foreign keys), puts pg_temp first on the search_path, and re-creates the two
-- functions in pg_temp FROM THEIR DEPLOYED TEXT (pg_get_functiondef, with only the
-- schema name and the `SET search_path` line changed - that line would otherwise pin
-- them to the real customers table). So the rules checked are the deployed ones, run
-- over made-up customers. From real data it only reads the catalog and one count
-- proving no fixture row leaked into public.customers. It never writes to a real
-- table, and the temp objects are dropped when the block ends.
--
-- NOTE: written without being run against a database (no DB access when it was
-- written). If a check FAILS, read the check name before suspecting the migration -
-- the harness itself is the newest part.

do $verify$
declare
  biz uuid := gen_random_uuid();
  other_biz uuid := gen_random_uuid();
  c_ok uuid := gen_random_uuid();
  c_stopped uuid := gen_random_uuid();
  c_stopped_noopt uuid := gen_random_uuid();
  c_noopt uuid := gen_random_uuid();
  c_stop_out uuid := gen_random_uuid();
  c_blocked uuid := gen_random_uuid();
  c_badnum uuid := gen_random_uuid();
  c_other uuid := gen_random_uuid();
  def_audience text;
  def_summary text;
  s jsonb;
  reasons jsonb;
  fails text[] := '{}';
  checks int := 0;
  leaked bigint;
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'customers' and column_name = 'marketing_blocked_at') then
    raise exception 'RESULT: ABORTED: apply migration 20261014130000 first (customers.marketing_blocked_at is missing)';
  end if;

  -- The functions as deployed, copied into pg_temp over a temp customers table.
  def_audience := pg_get_functiondef('public.broadcast_audience(uuid,text,jsonb,boolean)'::regprocedure);
  def_summary  := pg_get_functiondef('public.broadcast_audience_summary(uuid,text,jsonb,boolean)'::regprocedure);

  create temp table customers (like public.customers including defaults) on commit drop;
  perform set_config('search_path', 'pg_temp, public', true);
  if to_regclass('pg_temp.customers') is null then raise exception 'RESULT: ABORTED: temp customers table missing'; end if;

  def_audience := regexp_replace(def_audience, 'CREATE OR REPLACE FUNCTION public\.', 'CREATE OR REPLACE FUNCTION pg_temp.');
  def_audience := regexp_replace(def_audience, E'\\n\\s*SET search_path TO ''public''', '');
  def_summary  := regexp_replace(def_summary,  'CREATE OR REPLACE FUNCTION public\.', 'CREATE OR REPLACE FUNCTION pg_temp.');
  def_summary  := regexp_replace(def_summary,  E'\\n\\s*SET search_path TO ''public''', '');
  execute def_audience;
  execute def_summary;

  insert into customers (id, business_id, whatsapp_number, name, opted_in, is_blocked, opted_out_at, marketing_blocked_at) values
    (c_ok,            biz,       '919100000001', 'ok',               true,  false, null,  null),
    (c_stopped,       biz,       '919100000002', 'stopped',          true,  false, null,  now()),
    (c_stopped_noopt, biz,       '919100000003', 'stopped-no-optin', false, false, null,  now()),
    (c_noopt,         biz,       '919100000004', 'no-optin',         false, false, null,  null),
    (c_stop_out,      biz,       '919100000005', 'stop-and-stopped', true,  false, now(), now()),
    (c_blocked,       biz,       '919100000006', 'blocked',          true,  true,  null,  now()),
    (c_badnum,        biz,       '123',          'bad-number',       true,  false, null,  now()),
    (c_other,         other_biz, '919100000008', 'other-business',   true,  false, null,  now());

  -- reasons: customer name -> skip_reason (null = will receive), for one rule
  -- MARKETING (p_require_opt_in true)
  select jsonb_object_agg(a.name, a.skip_reason) into reasons
    from pg_temp.broadcast_audience(biz, 'all_customers', '{}'::jsonb, true) a;
  checks := checks + 1; if reasons->>'ok' is not null then fails := fails || '1 marketing: a normal opted-in customer is not skipped'; end if;
  checks := checks + 1; if reasons->>'stopped' is distinct from 'marketing_stopped' then fails := fails || '2 marketing: opted in + stopped marketing -> marketing_stopped'; end if;
  checks := checks + 1; if reasons->>'stopped-no-optin' is distinct from 'marketing_stopped' then fails := fails || '3 marketing: not opted in + stopped -> marketing_stopped (before not_opted_in)'; end if;
  checks := checks + 1; if reasons->>'no-optin' is distinct from 'not_opted_in' then fails := fails || '4 marketing: not opted in, not stopped -> not_opted_in'; end if;
  checks := checks + 1; if reasons->>'stop-and-stopped' is distinct from 'opted_out' then fails := fails || '5 marketing: STOP (opted_out_at) wins over marketing_stopped'; end if;
  checks := checks + 1; if reasons->>'blocked' is distinct from 'blocked' then fails := fails || '6 marketing: blocked wins over marketing_stopped'; end if;
  checks := checks + 1; if reasons->>'bad-number' is distinct from 'no_number' then fails := fails || '7 marketing: a bad number wins over everything'; end if;
  checks := checks + 1; if reasons ? 'other-business' then fails := fails || '8 another business''s customers are never selected'; end if;

  -- UTILITY (p_require_opt_in false): neither opted_in nor marketing_blocked_at is looked at
  select jsonb_object_agg(a.name, a.skip_reason) into reasons
    from pg_temp.broadcast_audience(biz, 'all_customers', '{}'::jsonb, false) a;
  checks := checks + 1; if reasons->>'stopped' is not null or reasons->>'stopped-no-optin' is not null or reasons->>'no-optin' is not null or reasons->>'ok' is not null then fails := fails || '9 utility: stopped / not-opted-in customers are NOT skipped'; end if;
  checks := checks + 1; if reasons->>'stop-and-stopped' is distinct from 'opted_out' or reasons->>'blocked' is distinct from 'blocked' or reasons->>'bad-number' is distinct from 'no_number' then fails := fails || '10 utility: opted_out / blocked / no_number still apply'; end if;

  -- NULL means the marketing rule; leaving the argument out too
  select jsonb_object_agg(a.name, a.skip_reason) into reasons
    from pg_temp.broadcast_audience(biz, 'all_customers', '{}'::jsonb, null) a;
  checks := checks + 1; if reasons->>'stopped' is distinct from 'marketing_stopped' then fails := fails || '11 NULL p_require_opt_in = marketing rule'; end if;
  select jsonb_object_agg(a.name, a.skip_reason) into reasons
    from pg_temp.broadcast_audience(biz, 'all_customers', '{}'::jsonb) a;
  checks := checks + 1; if reasons->>'stopped' is distinct from 'marketing_stopped' then fails := fails || '12 default p_require_opt_in = marketing rule'; end if;

  -- a picked-customers audience
  s := pg_temp.broadcast_audience_summary(biz, 'customers',
         jsonb_build_object('customerIds', jsonb_build_array(c_stopped, c_ok, c_other)), true);
  checks := checks + 1; if (s->>'selected')::int <> 2 or (s->>'willReceive')::int <> 1 or (s->'skipped'->>'marketing_stopped')::int <> 1 then fails := fails || '13 picked customers: selected 2 (not the other business), 1 will receive, 1 marketing_stopped'; end if;

  -- summary
  s := pg_temp.broadcast_audience_summary(biz, 'all_customers', '{}'::jsonb, true);
  checks := checks + 1; if (s->>'selected')::int <> 7 or (s->>'willReceive')::int <> 1 then fails := fails || '14 marketing summary: selected 7, willReceive 1'; end if;
  checks := checks + 1; if (s->'skipped'->>'no_number')::int <> 1 or (s->'skipped'->>'blocked')::int <> 1 or (s->'skipped'->>'opted_out')::int <> 1
                          or (s->'skipped'->>'marketing_stopped')::int <> 2 or (s->'skipped'->>'not_opted_in')::int <> 1 then fails := fails || '15 marketing summary skipped counts: 1 / 1 / 1 / 2 / 1'; end if;
  checks := checks + 1; if (s->>'selected')::int <> (s->>'willReceive')::int + (s->'skipped'->>'no_number')::int + (s->'skipped'->>'blocked')::int
                          + (s->'skipped'->>'opted_out')::int + (s->'skipped'->>'marketing_stopped')::int + (s->'skipped'->>'not_opted_in')::int then fails := fails || '16 marketing summary: nobody counted twice (selected = willReceive + skipped)'; end if;
  checks := checks + 1; if not (s->'skipped' ? 'marketing_stopped') then fails := fails || '17 the summary has the marketing_stopped key'; end if;

  s := pg_temp.broadcast_audience_summary(biz, 'all_customers', '{}'::jsonb, false);
  checks := checks + 1; if (s->>'willReceive')::int <> 4 or (s->'skipped'->>'marketing_stopped')::int <> 0 or (s->'skipped'->>'not_opted_in')::int <> 0 then fails := fails || '18 utility summary: willReceive 4, no marketing_stopped, no not_opted_in'; end if;

  -- nothing leaked into the real table
  select count(*) into leaked from public.customers where business_id in (biz, other_biz);
  checks := checks + 1; if leaked <> 0 then fails := fails || '19 no fixture row reached public.customers'; end if;

  -- the deployed functions: signatures and grants as the migration states
  checks := checks + 1; if to_regprocedure('public.broadcast_audience(uuid,text,jsonb,boolean)') is null
                          or to_regprocedure('public.broadcast_audience_summary(uuid,text,jsonb,boolean)') is null then fails := fails || '20 the 4-argument functions exist'; end if;
  checks := checks + 1; if to_regprocedure('public.broadcast_audience(uuid,text,jsonb)') is not null
                          or to_regprocedure('public.broadcast_audience_summary(uuid,text,jsonb)') is not null then fails := fails || '21 no 3-argument leftovers (a call would be ambiguous)'; end if;
  checks := checks + 1; if not has_function_privilege('service_role', 'public.broadcast_audience(uuid,text,jsonb,boolean)', 'execute')
                          or not has_function_privilege('service_role', 'public.broadcast_audience_summary(uuid,text,jsonb,boolean)', 'execute') then fails := fails || '22 service_role can execute both'; end if;
  checks := checks + 1; if has_function_privilege('anon', 'public.broadcast_audience(uuid,text,jsonb,boolean)', 'execute')
                          or has_function_privilege('authenticated', 'public.broadcast_audience(uuid,text,jsonb,boolean)', 'execute')
                          or has_function_privilege('anon', 'public.broadcast_audience_summary(uuid,text,jsonb,boolean)', 'execute')
                          or has_function_privilege('authenticated', 'public.broadcast_audience_summary(uuid,text,jsonb,boolean)', 'execute') then fails := fails || '23 anon / authenticated cannot execute either'; end if;

  if array_length(fails, 1) is null then
    raise exception 'RESULT: ALL % CHECKS PASSED (nothing was kept)', checks;
  else
    raise exception 'RESULT: FAILED (%): %', array_length(fails, 1), array_to_string(fails, ' | ');
  end if;
end
$verify$;
