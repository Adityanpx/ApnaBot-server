-- Per-category WhatsApp Flow definitions, authored by SuperAdmin, and the
-- per-business registration state of whichever definition a business has
-- had published to its own WABA. This is authoring + registration only —
-- no webhook/nfm_reply handling yet (separate, later step).
create table category_whatsapp_flows (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  name text not null,
  flow_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Same 22-value list as flow_snapshots_category_check
-- (20260903130000_add_maha_eseva_tax_consultant_categories.sql). Keep all
-- three lists (this one, businesses, flow_snapshots) in sync if any changes.
alter table category_whatsapp_flows add constraint category_whatsapp_flows_category_check
  check (category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','software_it',
    'maha_eseva_kendra','tax_consultant'
  ));

create index idx_category_whatsapp_flows_category on category_whatsapp_flows(category);

create trigger trg_set_updated_at before update on category_whatsapp_flows
  for each row execute function set_updated_at();

-- Per-business registration state: which category_whatsapp_flows definition
-- (if any) this business has had submitted to its own WABA, Meta's returned
-- Flow id, and where that Flow currently sits in Meta's draft/published
-- lifecycle. All null until a SuperAdmin runs publish-to-business.
alter table businesses add column whatsapp_flow_id text;
alter table businesses add column whatsapp_flow_status text;
alter table businesses add column whatsapp_flow_source_id uuid references category_whatsapp_flows(id);

alter table businesses add constraint businesses_whatsapp_flow_status_check
  check (whatsapp_flow_status is null or whatsapp_flow_status in ('draft', 'published'));
