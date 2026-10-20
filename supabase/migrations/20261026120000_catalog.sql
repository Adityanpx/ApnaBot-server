-- Data-driven Catalogue: collections + photos managed from one Catalogue page, rendered live by the bot.
--
--   catalogs              one row per business: the settings jsonb (enabled, keywords, aliases, texts,
--                         button labels + translations, photosPerPage, photoStyle, orderAction,
--                         addToMainMenu...). Validated by the server (utils/catalogSettings.js).
--   catalog_collections   a card of the carousel: title, card text (body), price label, cover photo.
--   catalog_items         one photo (+ design no / price / caption) of a collection.
--   catalog_events        lightweight counters for the Insights tab (carousel shown, cards shown,
--                         View designs taps, orders).
--
-- THE BOT NODE. The catalogue is represented in the flow graph by ONE reply node with
-- content_type = 'catalog' per business (partial unique index below). It carries no catalogue data of
-- its own: keyword / hindi_aliases / label are a projection of catalogs.settings, written only by the
-- catalogue endpoints, so keyword matching (incl. the Unicode matcher), the rules cache and menu edges
-- work unchanged. is_computed stays false: flow_nodes_is_computed_only_for_computed_types forbids it on a
-- reply node and the content_type is the discriminator. save_flow_graph_full needs NO change (no new
-- flow_nodes column); the server guards the node in code (flowGraph.service.js / flowGraph.controller.js).
--
-- MEDIA. catalog_items.media_id is a real FK with ON DELETE CASCADE (an item without its photo is
-- meaningless; the API refuses to delete a library file that is in use, so the cascade only fires for an
-- admin storage purge that includes in-use files). catalog_collections.cover_media_id is ON DELETE SET
-- NULL (the card then falls back to the collection's first photo).
--
-- booking_form_tokens.prefill: [{ key, value }] set when the customer taps Order on a catalogue and the
-- order action is a web_form_trigger; the public form shows the entries as read-only chips and locks any
-- form field whose name equals the key (publicServiceForm.controller.js).
--
-- upsert_catalog_node: creates / updates the business's catalogue node and, optionally, in the SAME
-- transaction deactivates (never deletes) older reply nodes that clash on a keyword and retargets every
-- edge that pointed to them to the catalogue node. Per-business advisory lock.
--
-- DEPLOY ORDER: apply this (and 20261026130000_catalogue_feature_switch.sql) BEFORE deploying the server
-- code. Additive: no existing node, edge or booking changes behaviour. Search cab AI is untouched.

-- ---- flow_nodes: the 'catalog' content type, one per business ------------------------------------------
alter table flow_nodes drop constraint if exists flow_nodes_content_type_check;
alter table flow_nodes add constraint flow_nodes_content_type_check
  check (content_type in ('text','buttons','list','location','location_request','carousel','catalog'));

create unique index if not exists uq_flow_nodes_one_catalog_per_business
  on flow_nodes (business_id) where content_type = 'catalog';

-- ---- tables -------------------------------------------------------------------------------------------
create table catalogs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null unique references businesses(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  auto_translations jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table catalog_collections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 60),
  title_translations jsonb,
  body text check (body is null or char_length(body) <= 160),
  body_translations jsonb,
  price_label text check (price_label is null or char_length(price_label) <= 30),
  price_label_translations jsonb,
  cover_media_id uuid references business_media(id) on delete set null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  auto_translations jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_catalog_collections_business_sort on catalog_collections (business_id, sort_order);
create index idx_catalog_collections_cover on catalog_collections (cover_media_id) where cover_media_id is not null;

create table catalog_items (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references catalog_collections(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  media_id uuid not null references business_media(id) on delete cascade,
  design_no text check (design_no is null or char_length(design_no) <= 40),
  price_text text check (price_text is null or char_length(price_text) <= 40),
  caption text check (caption is null or char_length(caption) <= 500),
  caption_translations jsonb,
  sort_order integer not null default 0,
  auto_translations jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_catalog_items_collection_sort on catalog_items (collection_id, sort_order);
create index idx_catalog_items_business on catalog_items (business_id);
create index idx_catalog_items_media on catalog_items (media_id);

create table catalog_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  collection_id uuid references catalog_collections(id) on delete set null,
  item_id uuid references catalog_items(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,
  event text not null check (event in ('catalogue_open','collection_view','designs_view','designs_more','order_collection','order_item')),
  created_at timestamptz not null default now()
);
create index idx_catalog_events_business_created on catalog_events (business_id, created_at desc);

create trigger trg_set_updated_at before update on catalogs
  for each row execute function set_updated_at();
create trigger trg_set_updated_at before update on catalog_collections
  for each row execute function set_updated_at();
create trigger trg_set_updated_at before update on catalog_items
  for each row execute function set_updated_at();

-- Only the server touches these tables (service-role key bypasses RLS).
alter table catalogs enable row level security;
alter table catalog_collections enable row level security;
alter table catalog_items enable row level security;
alter table catalog_events enable row level security;

-- ---- booking_form_tokens.prefill -----------------------------------------------------------------------
alter table booking_form_tokens add column if not exists prefill jsonb;
comment on column booking_form_tokens.prefill is
  'Catalogue order: [{ "key": "catalogCollection"|"catalogDesignNo"|"catalogPrice", "value": text }]. Shown on the form as read-only chips; a form field with the same name is locked to the value.';

-- ---- upsert_catalog_node ---------------------------------------------------------------------------------
-- p_node: { keyword, hindi_aliases (jsonb array), label, label_translations, position_x, position_y }
-- Returns { nodeId, created, replaced: [{ id, keyword, label, retargetedEdges }] }.
create or replace function upsert_catalog_node(
  p_business_id uuid,
  p_node jsonb,
  p_replace_ids uuid[] default '{}'
) returns jsonb as $$
declare
  v_node_id uuid;
  v_created boolean := false;
  v_replaced jsonb := '[]'::jsonb;
  r record;
  v_moved integer;
begin
  perform pg_advisory_xact_lock(hashtext('catalog_node:' || p_business_id::text));

  select id into v_node_id from flow_nodes where business_id = p_business_id and content_type = 'catalog';

  if v_node_id is null then
    insert into flow_nodes (
      business_id, node_type, keyword, match_type, hindi_aliases, reply_kind, content_type,
      label, label_translations, is_active, position_x, position_y
    ) values (
      p_business_id, 'reply', p_node->>'keyword', 'contains',
      coalesce(p_node->'hindi_aliases', '[]'::jsonb), 'text', 'catalog',
      p_node->>'label', p_node->'label_translations', true,
      nullif(p_node->>'position_x', '')::numeric, nullif(p_node->>'position_y', '')::numeric
    ) returning id into v_node_id;
    v_created := true;
  else
    update flow_nodes set
      keyword = p_node->>'keyword',
      match_type = 'contains',
      hindi_aliases = coalesce(p_node->'hindi_aliases', '[]'::jsonb),
      label = p_node->>'label',
      label_translations = p_node->'label_translations',
      is_active = true
    where id = v_node_id;
  end if;

  for r in
    select id, keyword, label from flow_nodes
    where business_id = p_business_id and id = any(coalesce(p_replace_ids, '{}'))
      and node_type = 'reply' and content_type <> 'catalog'
  loop
    update flow_nodes set is_active = false where id = r.id;
    -- a source that already has an edge to the catalogue node would get a duplicate button: drop the old one
    delete from flow_edges e
    where e.business_id = p_business_id and e.to_node_id = r.id
      and exists (select 1 from flow_edges x where x.from_node_id = e.from_node_id and x.to_node_id = v_node_id);
    update flow_edges set to_node_id = v_node_id
    where business_id = p_business_id and to_node_id = r.id and from_node_id <> v_node_id;
    get diagnostics v_moved = row_count;
    v_replaced := v_replaced || jsonb_build_object(
      'id', r.id, 'keyword', r.keyword, 'label', r.label, 'retargetedEdges', v_moved);
  end loop;

  return jsonb_build_object('nodeId', v_node_id, 'created', v_created, 'replaced', v_replaced);
end;
$$ language plpgsql;

-- ---- catalog_insights ----------------------------------------------------------------------------------
create or replace function catalog_insights(p_business_id uuid, p_since timestamptz)
returns table (collection_id uuid, event text, total bigint, customers bigint) as $$
  select e.collection_id, e.event, count(*)::bigint, count(distinct e.customer_id)::bigint
  from catalog_events e
  where e.business_id = p_business_id and e.created_at >= p_since
  group by e.collection_id, e.event;
$$ language sql stable;
