-- Owner phone-app media switch (feature key 'owner_phone_media').
--
-- Echo media = photos / videos / PDFs the owner sends from the WhatsApp
-- Business app on a coexistence number (smb_message_echoes). Until now every
-- one was downloaded from Meta into R2. Now that happens only for businesses
-- with the 'owner_phone_media' switch on (category_features / business_features,
-- applies to every category, default OFF). Customer (inbound) media is
-- unchanged.
--
-- The echo's WhatsApp media id is ALWAYS stored, switch on or off, so that
-- turning the switch on later can backfill the last 7 days (Meta keeps a media
-- id downloadable for ~30 days; we cap at 7):
--   messages.wa_media_id        Meta media id of the echo's file
--   messages.wa_media_mime      mime type from the payload (may be NULL)
--   messages.wa_media_filename  document filename from the payload (may be NULL)
-- Only phone_app echo rows of type image / video / document set them; every
-- other row leaves them NULL. Existing rows stay NULL (no backfill possible:
-- the id was never kept).
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same
-- commit - the echo handler writes the new columns and the feature check
-- constraints must accept the new key.

alter table messages add column if not exists wa_media_id text;
alter table messages add column if not exists wa_media_mime text;
alter table messages add column if not exists wa_media_filename text;

-- Backfill candidates: echo rows with a media id and no stored file, newest first.
create index if not exists idx_messages_owner_media_backfill
  on messages (business_id, created_at desc)
  where wa_media_id is not null and media_url is null;

alter table category_features drop constraint category_features_feature_check;
alter table category_features add constraint category_features_feature_check
  check (feature in ('bot_builder', 'followups', 'opt_in_links', 'contact_import', 'owner_phone_media'));

alter table business_features drop constraint business_features_feature_check;
alter table business_features add constraint business_features_feature_check
  check (feature in ('bot_builder', 'followups', 'opt_in_links', 'contact_import', 'owner_phone_media'));

comment on column messages.wa_media_id is
  'Meta media id of a phone-app echo''s photo/video/PDF; always stored for echoes, downloaded only when owner_phone_media is on.';
