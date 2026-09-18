-- node_library_entries.category's CHECK constraint (from its creation
-- migration, 20260902160000_node_library_entries.sql) was never updated
-- when maha_eseva_kendra/tax_consultant (20260903130000), multi_brand
-- (20260915140000) and hotel (20260918120000) were added -- unlike
-- businesses_business_category_check/flow_snapshots_category_check/
-- category_whatsapp_flows_category_check, which each got a follow-up
-- migration at the same time. Found while fixing the matching stale
-- VALID_CATEGORIES arrays in nodeLibraryPublic.controller.js and
-- nodeLibrary.controller.js: those now validate against business_categories
-- via businessCategoryService.isKnownCategory(), so without this the INSERT
-- in addNodeToLibrary would still raw-500 on the 4 newer categories despite
-- passing JS-level validation.
alter table node_library_entries drop constraint node_library_entries_category_check;
alter table node_library_entries add constraint node_library_entries_category_check
  check (category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','software_it',
    'maha_eseva_kendra','tax_consultant','multi_brand','hotel'
  ));
