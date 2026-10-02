-- Course photo (Bot Builder, coaching): an optional image from the
-- business's media library (business_media), sent above the WhatsApp course
-- page — an interactive button message with an image header
-- (whatsapp.service.js#sendInteractiveButtons). Bot Builder passes it as the
-- course page node's mediaId; flowGraph.service.js#saveFullGraph re-checks
-- it is an image of this business and resolves flow_nodes.image_url.
--
-- Deleting the photo from the media library just clears it here.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code that reads it.
alter table business_courses
  add column image_media_id uuid references business_media(id) on delete set null;

comment on column business_courses.image_media_id is 'Optional course photo (business_media image) shown above the WhatsApp course page.';
