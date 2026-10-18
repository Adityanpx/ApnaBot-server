-- Checks migration 20261023130000_create_carousel_bundle_rpc.sql on a REAL database: that
-- create_carousel_bundle() creates the whole bundle, and that a failure part-way leaves NOTHING behind
-- (the all-or-nothing guarantee the Node tests can only model). Uses ONE TEST business you name below;
-- everything it writes is rolled back, and the script refuses to run against Search cab AI.
--
-- HOW TO RUN (Supabase dashboard -> SQL Editor), after applying both 202610231x migrations:
--   1. Replace the business id on the line marked  <<< EDIT  (a test/demo business, never Search cab AI).
--   2. Paste the whole file into a new query and press Run.
--   3. It always ends in an error whose text is the report. That is intended: the error is what
--      guarantees nothing is kept.
--        RESULT: ALL n CHECKS PASSED (nothing was kept)   -> good
--        RESULT: FAILED (n): <check names>                  -> send me the text
--      Any other error (e.g. a NOT NULL column the fixture rows don't set) -> send me that too.
--
-- What it does, in one DO block: counts the business's flow_nodes/flow_edges, then
--   1. calls the RPC with a valid 1-carousel + 2-text-node bundle  -> 3 nodes + 2 edges appear
--   2. repeats it with the same keywords                           -> raises bundle_keyword_exists, counts unchanged
--   3. calls it with a bundle whose SECOND edge targets a missing node (the first node/edge inserts
--      would already have happened if the function were not one transaction)
--                                                                   -> raises bundle_target_missing, counts unchanged
--   4. calls it with a duplicate node id (fails on the primary key INSIDE the inserts, after rows of
--      the same call were written)                                  -> raises, counts unchanged
-- Each failing call runs in its own BEGIN ... EXCEPTION sub-block, so only that call's effects are undone
-- by the exception, which is exactly what is being proven. The final RAISE then rolls back the lot.
--
-- NOTE: written without being run against a database (no DB access when it was written). If a check
-- FAILS, read the check name before suspecting the migration -- the harness is the newest part.

do $verify$
declare
  biz uuid := '00000000-0000-0000-0000-000000000000';  -- <<< EDIT: a test business id
  biz_name text;
  n0 int; e0 int; n1 int; e1 int;
  carousel uuid := gen_random_uuid();
  t1 uuid := gen_random_uuid();
  t2 uuid := gen_random_uuid();
  dup uuid := gen_random_uuid();
  kw text := 'verifybundle-' || substr(gen_random_uuid()::text, 1, 8);
  nodes jsonb; edges jsonb;
  msg text;
  failed text[] := '{}';
  passed int := 0;
begin
  select name into biz_name from businesses where id = biz;
  if biz_name is null then
    raise exception 'ABORTED: business % not found -- edit the id on the <<< EDIT line', biz;
  end if;
  if biz_name ilike '%search cab%' then
    raise exception 'ABORTED: % is the live Search cab AI business -- use a test business', biz_name;
  end if;

  select count(*) into n0 from flow_nodes where business_id = biz;
  select count(*) into e0 from flow_edges where business_id = biz;

  nodes := jsonb_build_array(
    jsonb_build_object('id', carousel, 'keyword', kw, 'match_type', 'exact', 'hindi_aliases', '[]'::jsonb,
      'content_type', 'carousel', 'label', 'Verify', 'carousel_cards', '[]'::jsonb, 'position_x', 1, 'position_y', 1),
    jsonb_build_object('id', t1, 'keyword', kw || '-a-1', 'match_type', 'exact', 'hindi_aliases', '[]'::jsonb,
      'content_type', 'text', 'label', 'A', 'gallery_media_ids', '[]'::jsonb, 'position_x', 2, 'position_y', 1),
    jsonb_build_object('id', t2, 'keyword', kw || '-b-2', 'match_type', 'exact', 'hindi_aliases', '[]'::jsonb,
      'content_type', 'text', 'label', 'B', 'gallery_media_ids', '[]'::jsonb, 'position_x', 2, 'position_y', 2)
  );
  edges := jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid(), 'from_node_id', carousel, 'to_node_id', t1, 'label', 'A', 'display_order', 0, 'card_index', 0),
    jsonb_build_object('id', gen_random_uuid(), 'from_node_id', carousel, 'to_node_id', t2, 'label', 'B', 'display_order', 1, 'card_index', 1)
  );

  -- 1. happy path
  perform create_carousel_bundle(biz, nodes, edges);
  select count(*) into n1 from flow_nodes where business_id = biz;
  select count(*) into e1 from flow_edges where business_id = biz;
  if n1 = n0 + 3 and e1 = e0 + 2 then passed := passed + 1; else failed := failed || 'happy path counts'; end if;
  if exists (select 1 from flow_nodes where id = t1 and node_type = 'reply' and reply_kind = 'text' and is_active
               and trigger_count = 0 and gallery_media_ids = '[]'::jsonb)
     and exists (select 1 from flow_edges where from_node_id = carousel and to_node_id = t2 and card_index = 1)
  then passed := passed + 1; else failed := failed || 'happy path row contents'; end if;

  -- 2. same keywords again -> keyword clash, nothing added
  begin
    perform create_carousel_bundle(biz, nodes, edges);
    failed := failed || 'keyword clash not raised';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg = 'bundle_keyword_exists' then passed := passed + 1; else failed := failed || ('keyword clash raised: ' || msg); end if;
  end;
  select count(*) into n1 from flow_nodes where business_id = biz;
  select count(*) into e1 from flow_edges where business_id = biz;
  if n1 = n0 + 3 and e1 = e0 + 2 then passed := passed + 1; else failed := failed || 'keyword clash left rows'; end if;

  -- 3. fresh keywords, but the second edge targets a node that does not exist
  begin
    perform create_carousel_bundle(biz,
      jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'keyword', kw || '-x', 'match_type', 'exact',
        'hindi_aliases', '[]'::jsonb, 'content_type', 'text', 'label', 'X', 'gallery_media_ids', '[]'::jsonb)),
      jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'from_node_id', carousel, 'to_node_id', gen_random_uuid(),
        'label', 'X', 'display_order', 0, 'card_index', 0)));
    failed := failed || 'missing target not raised';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg = 'bundle_target_missing' then passed := passed + 1; else failed := failed || ('missing target raised: ' || msg); end if;
  end;
  select count(*) into n1 from flow_nodes where business_id = biz;
  select count(*) into e1 from flow_edges where business_id = biz;
  if n1 = n0 + 3 and e1 = e0 + 2 then passed := passed + 1; else failed := failed || 'missing target left rows'; end if;

  -- 4. a duplicate node id inside one call: the first row inserts, the second hits the primary key
  begin
    perform create_carousel_bundle(biz,
      jsonb_build_array(
        jsonb_build_object('id', dup, 'keyword', kw || '-d1', 'match_type', 'exact', 'hindi_aliases', '[]'::jsonb,
          'content_type', 'text', 'label', 'D1', 'gallery_media_ids', '[]'::jsonb),
        jsonb_build_object('id', dup, 'keyword', kw || '-d2', 'match_type', 'exact', 'hindi_aliases', '[]'::jsonb,
          'content_type', 'text', 'label', 'D2', 'gallery_media_ids', '[]'::jsonb)),
      '[]'::jsonb);
    failed := failed || 'duplicate id not raised';
  exception when others then
    passed := passed + 1;
  end;
  select count(*) into n1 from flow_nodes where business_id = biz;
  select count(*) into e1 from flow_edges where business_id = biz;
  if n1 = n0 + 3 and e1 = e0 + 2 and not exists (select 1 from flow_nodes where id = dup)
  then passed := passed + 1; else failed := failed || 'duplicate id left rows'; end if;

  -- 5. the function is not callable by the public roles
  if not has_function_privilege('anon', 'create_carousel_bundle(uuid, jsonb, jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'create_carousel_bundle(uuid, jsonb, jsonb)', 'execute')
     and has_function_privilege('service_role', 'create_carousel_bundle(uuid, jsonb, jsonb)', 'execute')
  then passed := passed + 1; else failed := failed || 'grants'; end if;

  if array_length(failed, 1) is null then
    raise exception 'RESULT: ALL % CHECKS PASSED (nothing was kept)', passed;
  else
    raise exception 'RESULT: FAILED (%): %  [passed %]', array_length(failed, 1), array_to_string(failed, '; '), passed;
  end if;
end
$verify$;
