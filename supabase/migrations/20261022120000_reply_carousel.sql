-- Carousel reply node: a reply with content_type 'carousel' sends WhatsApp's native interactive media
-- carousel (2..N cards, each = image/video + optional text + 1-2 quick-reply buttons).
--
--   flow_nodes.carousel_cards  ordered jsonb array of
--                              { media_id, media_type: 'image'|'video', body, body_translations }
--   flow_edges.card_index      for an edge leaving a carousel node: the card (0-based) whose button it is.
--                              The edge id is the quick-reply id, so a tap routes like any reply button.
--   plans.carousel_max_cards   cards one carousel may carry on the plan (2..10), default 3.
--                              basic 3, pro 10, business 10 (backfilled by plan name).
--
-- carousel_cards is jsonb (not a table): short, ordered, read with the node, and flow_snapshots store
-- flow_nodes rows verbatim. Postgres therefore cannot enforce the media_id references, so: the API
-- refuses to delete media a card uses (mediaUsage.service.js) and the send path skips ids that no
-- longer resolve. No cleanup trigger on purpose (the gallery trigger strips plain ids; cards are objects).
--
-- save_flow_graph_full is re-created with carousel_cards (nodes) and card_index (edges) in its INSERT list
-- AND its UPDATE SET. That is only safe because flowGraph.service.js#saveFullGraph now sends both keys on
-- EVERY node / edge row (preserve-on-omit for reply nodes and edges, the existing value for question and
-- computed nodes). ROLLBACK WARNING: running a server build that predates this change against this RPC
-- (or re-running the previous RPC definition) nulls carousel_cards / card_index on the next canvas save.
-- Everything else in the function is carried forward unchanged from 20261017120000.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same commit. Additive: no existing
-- node or edge changes behaviour (both columns are NULL for them).

alter table plans add column if not exists carousel_max_cards integer not null default 3;
alter table plans drop constraint if exists plans_carousel_max_cards_range;
alter table plans add constraint plans_carousel_max_cards_range check (carousel_max_cards between 2 and 10);
update plans set carousel_max_cards = 3  where name = 'basic';
update plans set carousel_max_cards = 10 where name in ('pro', 'business');

alter table flow_nodes add column if not exists carousel_cards jsonb;
alter table flow_nodes drop constraint if exists flow_nodes_carousel_cards_is_array;
alter table flow_nodes add constraint flow_nodes_carousel_cards_is_array
  check (carousel_cards is null or jsonb_typeof(carousel_cards) = 'array');

alter table flow_edges add column if not exists card_index smallint;
alter table flow_edges drop constraint if exists flow_edges_card_index_range;
alter table flow_edges add constraint flow_edges_card_index_range
  check (card_index is null or card_index between 0 and 9);

alter table flow_nodes drop constraint if exists flow_nodes_content_type_check;
alter table flow_nodes add constraint flow_nodes_content_type_check
  check (content_type in ('text','buttons','list','location','location_request','carousel'));

create or replace function save_flow_graph_full(
  p_business_id uuid,
  p_node_upserts jsonb,
  p_node_deletes uuid[],
  p_edge_upserts jsonb,
  p_edge_deletes uuid[]
) returns void as $$
begin
  insert into flow_nodes (
    id, business_id, node_type, keyword, match_type, hindi_aliases, reply_kind,
    trigger_count, content_type, label, label_translations, image_url, media_id,
    field_key, summary_label, required, "order", options, is_computed,
    is_active, position_x, position_y,
    button_text, button_text_translations, form_fields,
    latitude, longitude, location_name, address,
    form_title, form_title_translations, carousel_cards
  )
  select
    x.id, p_business_id, x.node_type, x.keyword, x.match_type, x.hindi_aliases, x.reply_kind,
    x.trigger_count, x.content_type, x.label, x.label_translations, x.image_url, x.media_id,
    x.field_key, x.summary_label, x.required, x."order", x.options, x.is_computed,
    x.is_active, x.position_x, x.position_y,
    x.button_text, x.button_text_translations, x.form_fields,
    x.latitude, x.longitude, x.location_name, x.address,
    x.form_title, x.form_title_translations, x.carousel_cards
  from jsonb_to_recordset(coalesce(p_node_upserts, '[]'::jsonb)) as x(
    id uuid, node_type text, keyword text, match_type text, hindi_aliases jsonb, reply_kind text,
    trigger_count integer, content_type text, label text, label_translations jsonb, image_url text, media_id uuid,
    field_key text, summary_label text, required boolean, "order" numeric, options jsonb, is_computed boolean,
    is_active boolean, position_x numeric, position_y numeric,
    button_text text, button_text_translations jsonb, form_fields jsonb,
    latitude numeric, longitude numeric, location_name text, address text,
    form_title text, form_title_translations jsonb, carousel_cards jsonb
  )
  on conflict (id) do update set
    business_id = excluded.business_id,
    node_type = excluded.node_type,
    keyword = excluded.keyword,
    match_type = excluded.match_type,
    hindi_aliases = excluded.hindi_aliases,
    reply_kind = excluded.reply_kind,
    trigger_count = excluded.trigger_count,
    content_type = excluded.content_type,
    label = excluded.label,
    label_translations = excluded.label_translations,
    image_url = excluded.image_url,
    media_id = excluded.media_id,
    field_key = excluded.field_key,
    summary_label = excluded.summary_label,
    required = excluded.required,
    "order" = excluded."order",
    options = excluded.options,
    is_computed = excluded.is_computed,
    is_active = excluded.is_active,
    position_x = excluded.position_x,
    position_y = excluded.position_y,
    button_text = excluded.button_text,
    button_text_translations = excluded.button_text_translations,
    form_fields = excluded.form_fields,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    location_name = excluded.location_name,
    address = excluded.address,
    form_title = excluded.form_title,
    form_title_translations = excluded.form_title_translations,
    carousel_cards = excluded.carousel_cards;

  delete from flow_edges where id = any(p_edge_deletes) and business_id = p_business_id;
  delete from flow_nodes where id = any(p_node_deletes) and business_id = p_business_id;

  insert into flow_edges (
    id, business_id, from_node_id, to_node_id, label, label_translations,
    description, description_translations, condition, preset, display_order, card_index
  )
  select
    x.id, p_business_id, x.from_node_id, x.to_node_id, x.label, x.label_translations,
    x.description, x.description_translations, x.condition, x.preset, x.display_order, x.card_index
  from jsonb_to_recordset(coalesce(p_edge_upserts, '[]'::jsonb)) as x(
    id uuid, from_node_id uuid, to_node_id uuid, label text, label_translations jsonb,
    description text, description_translations jsonb, condition jsonb, preset jsonb, display_order integer, card_index smallint
  )
  on conflict (id) do update set
    business_id = excluded.business_id,
    from_node_id = excluded.from_node_id,
    to_node_id = excluded.to_node_id,
    label = excluded.label,
    label_translations = excluded.label_translations,
    description = excluded.description,
    description_translations = excluded.description_translations,
    condition = excluded.condition,
    preset = excluded.preset,
    display_order = excluded.display_order,
    card_index = excluded.card_index;
end;
$$ language plpgsql;
