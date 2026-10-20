-- Super Admin switch for 'catalogue' (the data-driven Catalogue page + bot reply).
--
-- Unlike the other keys, 'catalogue' is ON BY DEFAULT: categoryFeature.service.js applies the
-- definition's defaultEnabled when a business has neither a business_features override nor a
-- category_features row. This migration only widens the check constraints so Super Admin can write an
-- explicit Off (or On) row; it seeds nothing and changes no behaviour by itself.
--
-- DEPLOY ORDER: apply BEFORE the server code that can write the new key. Reads never touch the
-- constraint.
--
-- ROLLBACK (remove rows with the new key first):
--   delete from category_features where feature = 'catalogue';
--   delete from business_features where feature = 'catalogue';
--   then re-add the constraints without 'catalogue' (see 20261015120000_staff_broadcasts_features.sql).

alter table category_features drop constraint category_features_feature_check;
alter table category_features add constraint category_features_feature_check
  check (feature in ('bot_builder', 'followups', 'opt_in_links', 'contact_import', 'owner_phone_media', 'staff', 'broadcasts', 'catalogue'));

alter table business_features drop constraint business_features_feature_check;
alter table business_features add constraint business_features_feature_check
  check (feature in ('bot_builder', 'followups', 'opt_in_links', 'contact_import', 'owner_phone_media', 'staff', 'broadcasts', 'catalogue'));
