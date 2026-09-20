-- SuperAdmin-owned starter templates for businesses.flow_fields (the
-- web-form booking link's field config — see
-- 20260913120000_web_form_booking_link.sql / utils/flowFieldsValidation.js).
-- One row per category, applied to a business only when explicitly
-- triggered via POST /api/admin/business-category-templates/:category/apply/:businessId
-- (src/controllers/businessCategoryTemplate.controller.js) — never read at
-- business creation time. Distinct from flow_snapshots'
-- is_category_template rows, which template the flow_nodes/flow_edges
-- conversation graph, not the booking-form field list.
create table business_category_templates (
  id uuid primary key default gen_random_uuid(),
  business_category text not null unique,
  label text not null,
  flow_fields jsonb not null default '[]'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_set_updated_at before update on business_category_templates
  for each row execute function set_updated_at();
