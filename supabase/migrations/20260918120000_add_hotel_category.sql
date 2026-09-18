-- Adds 'hotel' as a real business_category for multi-property hotel/lodging
-- businesses (confirmed via grep -- neither 'hotel' nor 'lodging' exists in
-- any of the three CHECK constraints or business_categories today). All
-- three lists enumerate the same set and must stay in sync (see
-- 20260915150000's comment); fixed together here, same pattern.
-- business_type_templates_business_category_check and flow_packs_category_check
-- remain intentionally untouched (dead tables, per
-- 20260903130000_add_maha_eseva_tax_consultant_categories.sql).
alter table businesses drop constraint businesses_business_category_check;
alter table businesses add constraint businesses_business_category_check
  check (business_category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','software_it',
    'maha_eseva_kendra','tax_consultant','multi_brand','hotel'
  ));

alter table flow_snapshots drop constraint flow_snapshots_category_check;
alter table flow_snapshots add constraint flow_snapshots_category_check
  check (category is null or category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','software_it',
    'maha_eseva_kendra','tax_consultant','multi_brand','hotel'
  ));

alter table category_whatsapp_flows drop constraint category_whatsapp_flows_category_check;
alter table category_whatsapp_flows add constraint category_whatsapp_flows_category_check
  check (category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','software_it',
    'maha_eseva_kendra','tax_consultant','multi_brand','hotel'
  ));

-- Enabled immediately, same as multi_brand (20260915140000) -- being added
-- for a real client, not staged disabled like maha_eseva_kendra/
-- tax_consultant were.
insert into business_categories (value, label, icon, is_enabled, display_order)
values ('hotel', 'Hotel', '🏨', true, 230)
on conflict (value) do nothing;
