-- Closes the flow_nodes half of the gap noted in
-- 20260922120000_fix_save_flow_graph_full_dropped_columns.sql: seven
-- reply-node columns (button_text, button_text_translations, form_fields,
-- latitude, longitude, location_name, address) were missing from
-- save_flow_graph_full's column whitelist, so a canvas batch save could
-- never write them (a node created via batch save lost them entirely;
-- existing nodes kept theirs only because the UPDATE SET never touched
-- those columns).
--
-- MUST ship together with the matching flowGraph.controller.js#saveFullGraph
-- change. That controller now sends all seven keys on EVERY node upsert
-- row — reply nodes preserve-on-omit (an item that omits a key gets the
-- current row's value merged in from currentNodeById before the upsert row
-- is built), question nodes carry the current row's values over unchanged,
-- computed nodes already spread the whole existing row — so this RPC can
-- set all seven unconditionally without nulling live data. Applying this
-- migration WITHOUT that controller change would null these columns on
-- every existing node on the next canvas save.
--
-- Everything else (including flow_edges.preset from 20260922120000) is
-- carried forward unchanged.
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
    latitude, longitude, location_name, address
  )
  select
    x.id, p_business_id, x.node_type, x.keyword, x.match_type, x.hindi_aliases, x.reply_kind,
    x.trigger_count, x.content_type, x.label, x.label_translations, x.image_url, x.media_id,
    x.field_key, x.summary_label, x.required, x."order", x.options, x.is_computed,
    x.is_active, x.position_x, x.position_y,
    x.button_text, x.button_text_translations, x.form_fields,
    x.latitude, x.longitude, x.location_name, x.address
  from jsonb_to_recordset(coalesce(p_node_upserts, '[]'::jsonb)) as x(
    id uuid, node_type text, keyword text, match_type text, hindi_aliases jsonb, reply_kind text,
    trigger_count integer, content_type text, label text, label_translations jsonb, image_url text, media_id uuid,
    field_key text, summary_label text, required boolean, "order" numeric, options jsonb, is_computed boolean,
    is_active boolean, position_x numeric, position_y numeric,
    button_text text, button_text_translations jsonb, form_fields jsonb,
    latitude numeric, longitude numeric, location_name text, address text
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
    address = excluded.address;

  delete from flow_edges where id = any(p_edge_deletes) and business_id = p_business_id;
  delete from flow_nodes where id = any(p_node_deletes) and business_id = p_business_id;

  insert into flow_edges (
    id, business_id, from_node_id, to_node_id, label, label_translations,
    description, description_translations, condition, preset, display_order
  )
  select
    x.id, p_business_id, x.from_node_id, x.to_node_id, x.label, x.label_translations,
    x.description, x.description_translations, x.condition, x.preset, x.display_order
  from jsonb_to_recordset(coalesce(p_edge_upserts, '[]'::jsonb)) as x(
    id uuid, from_node_id uuid, to_node_id uuid, label text, label_translations jsonb,
    description text, description_translations jsonb, condition jsonb, preset jsonb, display_order integer
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
    display_order = excluded.display_order;
end;
$$ language plpgsql;
