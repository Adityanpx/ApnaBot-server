-- create_carousel_bundle: creates a carousel reply node, the reply nodes its card buttons open and the
-- edges between them, ALL-OR-NOTHING (POST /api/flow-graph/carousel-bundle,
-- carouselBundle.service.js). A plpgsql function body is one transaction, so any raise below (or any
-- constraint failure on an insert) rolls back every row it wrote -- no partial bundle can exist.
--
-- Why not save_flow_graph_full: it does not write flow_nodes.gallery_media_ids / video_media_id (see
-- 20261016120000), so gallery photos of the generated reply nodes would be lost. This function lists
-- the columns it writes explicitly; every other column keeps its table default.
--
-- Race safety: flow_nodes has no unique index on (business_id, keyword), so the keyword check alone
-- could race with a concurrent create. A per-business advisory lock (held to the end of the transaction)
-- serialises bundles for one business; the service has already pre-checked, this is the final word.
--
-- Errors (message = machine code, detail = the offending value) are mapped by the service:
--   bundle_keyword_exists   a keyword in p_nodes is already a reply keyword of this business  -> 409
--   bundle_target_missing   an edge targets a node that is neither in p_nodes nor a reply node of
--                           this business                                                       -> 400
--
-- p_nodes: array of { id, keyword, match_type, hindi_aliases, content_type, label, label_translations,
--          image_url, media_id, gallery_media_ids, carousel_cards, position_x, position_y } (all reply nodes,
--          reply_kind 'text', active, trigger_count 0).
-- p_edges: array of { id, from_node_id, to_node_id, label, label_translations, display_order, card_index }.
--
-- DEPLOY ORDER: apply AFTER 20261022120000 (needs carousel_cards / card_index) and BEFORE deploying the
-- server code. Purely additive: a new function, nothing existing changes.
create or replace function create_carousel_bundle(
  p_business_id uuid,
  p_nodes jsonb,
  p_edges jsonb
) returns void as $$
declare
  clash text;
  missing uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('carousel_bundle:' || p_business_id::text, 0));

  select f.keyword into clash
    from flow_nodes f
    join jsonb_to_recordset(coalesce(p_nodes, '[]'::jsonb)) as x(keyword text) on f.keyword = x.keyword
   where f.business_id = p_business_id and f.node_type = 'reply'
   limit 1;
  if clash is not null then
    raise exception 'bundle_keyword_exists' using detail = clash;
  end if;

  select e.to_node_id into missing
    from jsonb_to_recordset(coalesce(p_edges, '[]'::jsonb)) as e(to_node_id uuid)
   where e.to_node_id not in (select n.id from jsonb_to_recordset(coalesce(p_nodes, '[]'::jsonb)) as n(id uuid))
     and not exists (
       select 1 from flow_nodes f
        where f.id = e.to_node_id and f.business_id = p_business_id and f.node_type = 'reply'
     )
   limit 1;
  if missing is not null then
    raise exception 'bundle_target_missing' using detail = missing::text;
  end if;

  insert into flow_nodes (
    id, business_id, node_type, keyword, match_type, hindi_aliases, reply_kind, trigger_count,
    content_type, label, label_translations, image_url, media_id, gallery_media_ids, carousel_cards,
    is_active, position_x, position_y
  )
  select
    x.id, p_business_id, 'reply', x.keyword, x.match_type, coalesce(x.hindi_aliases, '[]'::jsonb), 'text', 0,
    x.content_type, x.label, x.label_translations, x.image_url, x.media_id,
    coalesce(x.gallery_media_ids, '[]'::jsonb), x.carousel_cards,
    true, x.position_x, x.position_y
  from jsonb_to_recordset(coalesce(p_nodes, '[]'::jsonb)) as x(
    id uuid, keyword text, match_type text, hindi_aliases jsonb, content_type text, label text,
    label_translations jsonb, image_url text, media_id uuid, gallery_media_ids jsonb, carousel_cards jsonb,
    position_x numeric, position_y numeric
  );

  insert into flow_edges (
    id, business_id, from_node_id, to_node_id, label, label_translations, display_order, card_index
  )
  select
    x.id, p_business_id, x.from_node_id, x.to_node_id, x.label, x.label_translations,
    coalesce(x.display_order, 0), x.card_index
  from jsonb_to_recordset(coalesce(p_edges, '[]'::jsonb)) as x(
    id uuid, from_node_id uuid, to_node_id uuid, label text, label_translations jsonb,
    display_order integer, card_index smallint
  );
end;
$$ language plpgsql;

-- Called only by the server (service role), like save_flow_graph_full.
revoke execute on function create_carousel_bundle(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function create_carousel_bundle(uuid, jsonb, jsonb) to service_role;
