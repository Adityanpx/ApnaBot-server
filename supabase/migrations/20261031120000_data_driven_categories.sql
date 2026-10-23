-- Makes business categories data-driven: a new category is one row in business_categories (Super Admin ->
-- POST /api/admin/business-categories), with no migration, deploy or client release.
--
-- 1. business_categories gains the display data clients used to hard-code per category:
--      emoji               text, shown next to the label ('' = the client falls back to its own map)
--      label_translations  jsonb {"hi": "...", "mr": "..."} ({} = the client falls back to `label`)
--    No backfill: existing categories keep resolving through the clients' own maps.
-- 2. The four CHECK constraints that enumerated the category list (found by grepping every migration:
--    businesses_business_category_check, flow_snapshots_category_check, category_whatsapp_flows_category_check,
--    node_library_entries_category_check -- the last re-created by 20260918140000 and
--    20261023120000) become foreign keys to business_categories(value). on update cascade, on delete restrict:
--    a category row cannot be deleted while anything uses it.
--    business_type_templates and flow_packs (dead tables; flow_packs also allows 'any') keep their CHECKs,
--    as 20261023120000 left them. category_features and course_catalog already reference business_categories.
-- 3. Inserts the first category created this way: mobile_electronics (mobile / TV / appliance sales shops,
--    incl. CSD / CPC canteen dealers). electronics_repair is a different category and is untouched.
--    icon 'smartphone' is a lucide-react icon name in lucide-react 0.378.0 (Super Admin) and 1.42.x (web).
--
-- PREFLIGHT -- run this first; it MUST return 0 rows. Any row is a category value used by a table but missing
-- from business_categories, which would make the foreign keys below fail (the whole migration then rolls back):
--   select 'businesses' as tbl, business_category as value, count(*) from businesses
--     where business_category not in (select value from business_categories) group by 2
--   union all
--   select 'flow_snapshots', category, count(*) from flow_snapshots
--     where category is not null and category not in (select value from business_categories) group by 2
--   union all
--   select 'category_whatsapp_flows', category, count(*) from category_whatsapp_flows
--     where category not in (select value from business_categories) group by 2
--   union all
--   select 'node_library_entries', category, count(*) from node_library_entries
--     where category not in (select value from business_categories) group by 2;
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same commit (the new admin endpoints
-- select/insert emoji and label_translations). Additive for data: no existing row changes. The foreign keys
-- are stricter than the old lists in one way only: a value must now exist in business_categories, enabled or not.
begin;

alter table business_categories add column if not exists emoji text not null default '';
alter table business_categories add column if not exists label_translations jsonb not null default '{}'::jsonb;

alter table businesses drop constraint businesses_business_category_check;
alter table businesses add constraint businesses_business_category_fkey
  foreign key (business_category) references business_categories(value)
  on update cascade on delete restrict;

alter table flow_snapshots drop constraint flow_snapshots_category_check;
alter table flow_snapshots add constraint flow_snapshots_category_fkey
  foreign key (category) references business_categories(value)
  on update cascade on delete restrict;

alter table category_whatsapp_flows drop constraint category_whatsapp_flows_category_check;
alter table category_whatsapp_flows add constraint category_whatsapp_flows_category_fkey
  foreign key (category) references business_categories(value)
  on update cascade on delete restrict;

alter table node_library_entries drop constraint node_library_entries_category_check;
alter table node_library_entries add constraint node_library_entries_category_fkey
  foreign key (category) references business_categories(value)
  on update cascade on delete restrict;

-- Enabled at once; display_order 158 sits just before electronics_repair (160).
insert into business_categories (value, label, icon, emoji, label_translations, is_enabled, display_order) values
  ('mobile_electronics', 'Mobile & Electronics', 'smartphone', '📱',
   '{"hi":"मोबाइल और इलेक्ट्रॉनिक्स","mr":"मोबाइल आणि इलेक्ट्रॉनिक्स"}'::jsonb, true, 158)
on conflict (value) do nothing;

commit;
