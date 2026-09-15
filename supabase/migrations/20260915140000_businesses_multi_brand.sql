-- Adds a 'multi_brand' business_category: a mixed-category business whose
-- sub_categories determine feature defaults automatically at creation time
-- (src/config/categoryFeatures.js), replacing one-off enableX toggles
-- (enable_fleet, enable_distance_fares, etc.) that previously needed manual
-- per-business discovery and flipping. New businesses only — no backfill of
-- existing rows.
alter table businesses drop constraint businesses_business_category_check;
alter table businesses add constraint businesses_business_category_check
  check (business_category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','software_it',
    'maha_eseva_kendra','tax_consultant','multi_brand'
  ));

-- Array of category strings from the same set business_category allows,
-- minus 'multi_brand' itself (e.g. ['cab','coaching']). Only meaningful when
-- business_category = 'multi_brand'. No DB-level check on element values —
-- same pattern as disabled_booking_fields/served_cities, validated at the
-- application layer (business.controller.js) instead.
alter table businesses add column sub_categories jsonb not null default '[]';

-- business_category validation at signup goes through the business_categories
-- table (is_enabled), not the CHECK constraint above (see
-- businessCategory.service.js#isEnabledCategory) — without this row,
-- business_category='multi_brand' would always be rejected at signup despite
-- being a valid CHECK value. Enabled immediately, not staged disabled like
-- maha_eseva_kendra/tax_consultant were, since this business is being
-- created specifically to use it.
insert into business_categories (value, label, icon, is_enabled, display_order)
values ('multi_brand', 'Multi Brand', '', true, 220)
on conflict (value) do nothing;
