-- Adds 'clothing_wholesaler' (B2B: retailers order in bulk) and 'menswear' (retail shop) as real
-- business categories. Boutique stays as it is (women's wear). Same pattern as
-- 20260918120000_add_hotel_category.sql: every CHECK constraint that enumerates the category list
-- is recreated with the two new values (found by grepping all migrations):
--   businesses_business_category_check, flow_snapshots_category_check,
--   category_whatsapp_flows_category_check (20260918120000) and
--   node_library_entries_category_check (20260918140000).
-- Nothing else enumerates categories: category_features / course_catalog reference
-- business_categories(value), business_category_templates.business_category is unconstrained text,
-- multi_brand sub_categories has no DB check. business_type_templates_business_category_check and
-- flow_packs_category_check stay untouched (dead tables).
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same commit (inserting a
-- business with a new value fails on the old constraint). Additive: no existing row changes.
alter table businesses drop constraint businesses_business_category_check;
alter table businesses add constraint businesses_business_category_check
  check (business_category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','software_it',
    'maha_eseva_kendra','tax_consultant','multi_brand','hotel',
    'clothing_wholesaler','menswear'
  ));

alter table flow_snapshots drop constraint flow_snapshots_category_check;
alter table flow_snapshots add constraint flow_snapshots_category_check
  check (category is null or category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','software_it',
    'maha_eseva_kendra','tax_consultant','multi_brand','hotel',
    'clothing_wholesaler','menswear'
  ));

alter table category_whatsapp_flows drop constraint category_whatsapp_flows_category_check;
alter table category_whatsapp_flows add constraint category_whatsapp_flows_category_check
  check (category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','software_it',
    'maha_eseva_kendra','tax_consultant','multi_brand','hotel',
    'clothing_wholesaler','menswear'
  ));

alter table node_library_entries drop constraint node_library_entries_category_check;
alter table node_library_entries add constraint node_library_entries_category_check
  check (category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','software_it',
    'maha_eseva_kendra','tax_consultant','multi_brand','hotel',
    'clothing_wholesaler','menswear'
  ));

-- Enabled immediately (same as hotel / multi_brand). display_order sits next to boutique (130).
-- icon = lucide-react icon-name key (see 20260908120000_business_categories_icon_names.sql);
-- both names exist in lucide-react 0.378.0 (the version ApnaBot-SuperAdmin has installed).
insert into business_categories (value, label, icon, is_enabled, display_order) values
  ('menswear', 'Men''s Wear', 'shirt', true, 133),
  ('clothing_wholesaler', 'Clothing Wholesaler', 'warehouse', true, 136)
on conflict (value) do nothing;
