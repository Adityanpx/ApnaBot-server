-- Grandfather the two businesses that already use the now-Off-by-default
-- switches (staff, broadcasts): one business_features override each.
--
--   a94aec66-23fb-43e1-afcc-f4e8d518134b  SG Travels         'staff'
--   e7fe86ca-fb4d-4405-824b-f9a4242a72a1  Averix Solutions   'broadcasts'
--
-- ORDER: apply this AFTER 20261015120000_staff_broadcasts_features.sql (which
-- widens the check constraint to accept these keys) and BEFORE deploying the
-- server code that gates /api/staff and /api/broadcasts. Deploying first would
-- switch both screens off for these businesses until this runs.
--
-- Safe to re-run: on conflict do nothing keeps any existing override for the
-- same business and key. A business id that doesn't exist fails the foreign
-- key and nothing is inserted.
--
-- ROLLBACK (deletes exactly these two rows; if one of them already existed
-- before this migration it is removed too):
--   delete from business_features
--   where (business_id = 'a94aec66-23fb-43e1-afcc-f4e8d518134b' and feature = 'staff')
--      or (business_id = 'e7fe86ca-fb4d-4405-824b-f9a4242a72a1' and feature = 'broadcasts');

insert into business_features (business_id, feature, is_enabled) values
  ('a94aec66-23fb-43e1-afcc-f4e8d518134b', 'staff', true),
  ('e7fe86ca-fb4d-4405-824b-f9a4242a72a1', 'broadcasts', true)
on conflict (business_id, feature) do nothing;
