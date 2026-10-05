-- #6 Phase 2: a template's header media (IMAGE / VIDEO / DOCUMENT) picked from
-- the business media library (business_media), sent as a public R2 link.
--
-- header_media_url       the link a send uses (falls back to header_image_url for
--                        IMAGE headers made in ApnaBot before this existed)
-- header_media_id        the business_media row it came from; SET NULL if that row
--                        is deleted (the delete endpoint refuses while a template
--                        uses it, so this is only a backstop)
-- header_media_filename  shown on a DOCUMENT header (business_media.original_filename)
--
-- Nothing is backfilled: existing templates keep sending from header_image_url.
-- send_support values are unchanged (needs_header_media / unsupported_component
-- cover the new cases).
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same
-- change (the server writes these columns).
alter table message_templates
  add column header_media_url text,
  add column header_media_id uuid references business_media(id) on delete set null,
  add column header_media_filename text;

create index idx_message_templates_header_media_id
  on message_templates (header_media_id) where header_media_id is not null;
