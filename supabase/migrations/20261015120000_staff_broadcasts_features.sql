-- Super Admin switches for 'staff' (staff members and permissions) and
-- 'broadcasts' (broadcasts to customers).
--
-- Like every other key, both are OFF until a category_features row or a
-- business_features override switches them on (no row = off). This migration
-- only widens the check constraints so those rows can be written; it seeds
-- nothing and changes no behaviour by itself. Staff / broadcasts stay Off for
-- every business until Super Admin switches them On.
--
-- DEPLOY ORDER: apply this BEFORE the server code that can write the new
-- keys (until then, saving an Off switch for either key fails the constraint).
-- Reads never touch the constraint, so deploying the code first is harmless.
--
-- ROLLBACK (remove any rows with the new keys first, or re-adding the
-- narrower constraint fails):
--   delete from category_features where feature in ('staff', 'broadcasts');
--   delete from business_features where feature in ('staff', 'broadcasts');
--   alter table category_features drop constraint category_features_feature_check;
--   alter table category_features add constraint category_features_feature_check
--     check (feature in ('bot_builder', 'followups', 'opt_in_links', 'contact_import', 'owner_phone_media'));
--   alter table business_features drop constraint business_features_feature_check;
--   alter table business_features add constraint business_features_feature_check
--     check (feature in ('bot_builder', 'followups', 'opt_in_links', 'contact_import', 'owner_phone_media'));

alter table category_features drop constraint category_features_feature_check;
alter table category_features add constraint category_features_feature_check
  check (feature in ('bot_builder', 'followups', 'opt_in_links', 'contact_import', 'owner_phone_media', 'staff', 'broadcasts'));

alter table business_features drop constraint business_features_feature_check;
alter table business_features add constraint business_features_feature_check
  check (feature in ('bot_builder', 'followups', 'opt_in_links', 'contact_import', 'owner_phone_media', 'staff', 'broadcasts'));
