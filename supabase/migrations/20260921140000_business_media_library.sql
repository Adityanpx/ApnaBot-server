-- Business-owned media library (image/video/PDF) backed by R2. Files are
-- uploaded once per business and referenced by multiple flow_nodes rows (no
-- duplicate storage for a reused asset).
--
-- BACKWARD COMPAT: flow_nodes.image_url is untouched and stays the field the
-- runtime actually sends (webhook.controller.js / whatsapp.service.js read
-- image_url only, never media_id). flow_nodes.media_id is purely additive —
-- when the dashboard picker attaches a library asset to a node, the API
-- layer writes BOTH media_id (the reference, for the picker's "currently
-- selected" state and for delete-in-use protection) and image_url (a copy of
-- that asset's current R2 url, so the send path needs zero changes and a
-- node created before this feature existed keeps working identically).
-- flow_edges has no image field at all (only flow_nodes does), so no
-- media_id column is added there.
create table business_media (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  media_type text not null check (media_type in ('image','video','document')),
  url text not null,
  r2_key text not null,  -- R2 object key, kept so DELETE can remove the object (mirrors message_templates.header_image_r2_key)
  file_size_bytes bigint not null,
  original_filename text,
  width int,   -- images only
  height int,  -- images only
  created_at timestamptz not null default now(),

  constraint business_media_dimensions_only_for_images
    check (media_type = 'image' or (width is null and height is null))
);
create index idx_business_media_business_id on business_media(business_id);
create index idx_business_media_business_type on business_media(business_id, media_type);

alter table businesses add column storage_used_bytes bigint not null default 0;

-- Same pattern as msg_limit/customer_limit (-1 = unlimited is NOT used here;
-- every plan gets a real cap, seeded in planSeed.js: basic 150, pro 300,
-- business 1000).
alter table plans add column storage_limit_mb integer not null default 200;

alter table flow_nodes add column media_id uuid references business_media(id) on delete set null;

-- No updated_at / update trigger on business_media — rows are immutable
-- (insert on upload, delete on removal), never updated in place.

-- Atomic counter, same pattern as increment_wallet_balance (20260822120000).
-- p_delta_bytes is signed: positive on upload, negative on delete.
create or replace function increment_business_storage_used(p_business_id uuid, p_delta_bytes bigint)
returns bigint as $$
declare
  new_total bigint;
begin
  update businesses
  set storage_used_bytes = storage_used_bytes + p_delta_bytes
  where id = p_business_id
  returning storage_used_bytes into new_total;

  if new_total is null then
    raise exception 'Business % not found', p_business_id;
  end if;

  return new_total;
end;
$$ language plpgsql;

-- Re-create save_flow_graph_full (20260902180000) to carry media_id through
-- the canvas batch-save path too — the single-node reply/question-node
-- REST endpoints are not the only write path for flow_nodes.image_url/
-- media_id, and this RPC's column list is an explicit whitelist, not
-- select *, so a new flow_nodes column is invisible to it until added here.
-- Without this, PUT /api/flow-graph/full would silently drop media_id on
-- every canvas save (the normal way flows are edited), even though the
-- single-node endpoints work — a bug that would only surface as "the
-- picker's selection doesn't stick after a canvas save", no error anywhere.
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
    is_active, position_x, position_y
  )
  select
    x.id, p_business_id, x.node_type, x.keyword, x.match_type, x.hindi_aliases, x.reply_kind,
    x.trigger_count, x.content_type, x.label, x.label_translations, x.image_url, x.media_id,
    x.field_key, x.summary_label, x.required, x."order", x.options, x.is_computed,
    x.is_active, x.position_x, x.position_y
  from jsonb_to_recordset(coalesce(p_node_upserts, '[]'::jsonb)) as x(
    id uuid, node_type text, keyword text, match_type text, hindi_aliases jsonb, reply_kind text,
    trigger_count integer, content_type text, label text, label_translations jsonb, image_url text, media_id uuid,
    field_key text, summary_label text, required boolean, "order" numeric, options jsonb, is_computed boolean,
    is_active boolean, position_x numeric, position_y numeric
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
    position_y = excluded.position_y;

  delete from flow_edges where id = any(p_edge_deletes) and business_id = p_business_id;
  delete from flow_nodes where id = any(p_node_deletes) and business_id = p_business_id;

  insert into flow_edges (
    id, business_id, from_node_id, to_node_id, label, label_translations,
    description, description_translations, condition, display_order
  )
  select
    x.id, p_business_id, x.from_node_id, x.to_node_id, x.label, x.label_translations,
    x.description, x.description_translations, x.condition, x.display_order
  from jsonb_to_recordset(coalesce(p_edge_upserts, '[]'::jsonb)) as x(
    id uuid, from_node_id uuid, to_node_id uuid, label text, label_translations jsonb,
    description text, description_translations jsonb, condition jsonb, display_order integer
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
    display_order = excluded.display_order;
end;
$$ language plpgsql;
