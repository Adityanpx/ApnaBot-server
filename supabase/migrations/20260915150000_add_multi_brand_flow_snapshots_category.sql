-- 'multi_brand' was added to businesses_business_category_check in
-- 20260915140000_businesses_multi_brand.sql but the two sibling constraints
-- that enumerate the same category list (flow_snapshots_category_check,
-- category_whatsapp_flows_category_check) were missed. The latter's own
-- migration comment (20260910120000_category_whatsapp_flows.sql) says to
-- keep all three lists in sync, so both are fixed here together.
-- business_type_templates_business_category_check and flow_packs_category_check
-- remain intentionally untouched (dead tables, per
-- 20260903130000_add_maha_eseva_tax_consultant_categories.sql).
alter table flow_snapshots drop constraint flow_snapshots_category_check;
alter table flow_snapshots add constraint flow_snapshots_category_check
  check (category is null or category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','software_it',
    'maha_eseva_kendra','tax_consultant','multi_brand'
  ));

alter table category_whatsapp_flows drop constraint category_whatsapp_flows_category_check;
alter table category_whatsapp_flows add constraint category_whatsapp_flows_category_check
  check (category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','software_it',
    'maha_eseva_kendra','tax_consultant','multi_brand'
  ));
