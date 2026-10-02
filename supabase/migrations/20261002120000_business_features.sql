-- Per-business overrides for the Super Admin feature switches in
-- category_features (20260929140000_category_features.sql).
--
--   no row        → the business follows its category's switch (as before)
--   is_enabled t  → on for this business even while its category is off
--                   (e.g. pilot Bot Builder with one institute)
--   is_enabled f  → off for this business even while its category is on
--
-- An override only matters for a feature that applies to the business's
-- category (categoryFeature.service.js#FEATURES — bot_builder is coaching
-- only). Turning a feature off hides the dashboard pages; it deletes nothing
-- and does not change the published WhatsApp bot.
--
-- Toggled from Super Admin → Businesses → <business> → Features.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code that reads it —
-- the Courses / Bot Builder routes check it on every request.
create table business_features (
  business_id uuid not null references businesses(id) on delete cascade,
  feature text not null check (feature in ('bot_builder')),
  is_enabled boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, feature)
);

create trigger trg_set_updated_at before update on business_features
  for each row execute function set_updated_at();

-- Only the server touches this table, with the service-role key (which
-- bypasses RLS); with RLS on and no policies, the anon / authenticated keys
-- can't read or change it.
alter table business_features enable row level security;

comment on table business_features is
  'Super Admin per-business override of a category_features switch. No row = follow the category.';
