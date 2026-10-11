-- Web-form "form name": an optional title for a web_form_trigger reply, shown as the public
-- form page's header and snapshotted onto bookings.form_title at submit (Bot Builder forms keep
-- their own title and form_key; this is for every other form).
--
--   flow_nodes.form_title               short name, <= 60 chars (enforced by the API, not here)
--   flow_nodes.form_title_translations  { hi?, mr? } per-language versions
--
-- Meaningful only on reply_kind = 'web_form_trigger'; nullable, no default, no backfill.
--
-- save_flow_graph_full is re-created with both columns in its INSERT list AND its UPDATE SET so a
-- FlowSpec v2 compile / template apply / canvas batch save can carry them. That is only safe
-- because flowGraph.service.js#saveFullGraph now sends both keys on EVERY node row (reply nodes:
-- preserve-on-omit; question nodes: the current row's value; computed nodes: the whole existing
-- row). Everything else is carried forward unchanged from 20260926130000. Rolling the server
-- back to a build that predates this change would null the titles on the next canvas save.
--
-- distinct_booking_form_titles: the owner's form-name filter dropdown (GET /api/bookings/form-titles).
-- A SQL DISTINCT because PostgREST can't do one and a client-side dedupe would silently miss
-- titles past its 1000-row page.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same commit.

alter table flow_nodes add column if not exists form_title text;
alter table flow_nodes add column if not exists form_title_translations jsonb;

create or replace function distinct_booking_form_titles(p_business_id uuid)
returns setof text as $$
  select distinct b.form_title
    from bookings b
   where b.business_id = p_business_id
     and b.form_title is not null
   order by 1;
$$ language sql stable;

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
    form_title, form_title_translations
  )
  select
    x.id, p_business_id, x.node_type, x.keyword, x.match_type, x.hindi_aliases, x.reply_kind,
    x.trigger_count, x.content_type, x.label, x.label_translations, x.image_url, x.media_id,
    x.field_key, x.summary_label, x.required, x."order", x.options, x.is_computed,
    x.is_active, x.position_x, x.position_y,
    x.button_text, x.button_text_translations, x.form_fields,
    x.latitude, x.longitude, x.location_name, x.address,
    x.form_title, x.form_title_translations
  from jsonb_to_recordset(coalesce(p_node_upserts, '[]'::jsonb)) as x(
    id uuid, node_type text, keyword text, match_type text, hindi_aliases jsonb, reply_kind text,
    trigger_count integer, content_type text, label text, label_translations jsonb, image_url text, media_id uuid,
    field_key text, summary_label text, required boolean, "order" numeric, options jsonb, is_computed boolean,
    is_active boolean, position_x numeric, position_y numeric,
    button_text text, button_text_translations jsonb, form_fields jsonb,
    latitude numeric, longitude numeric, location_name text, address text,
    form_title text, form_title_translations jsonb
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
    form_title_translations = excluded.form_title_translations;

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
