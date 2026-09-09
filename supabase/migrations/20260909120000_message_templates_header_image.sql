-- Optional IMAGE header support for WhatsApp message templates. header_image_url
-- is the public R2 URL used at send time (as the HEADER component's image link);
-- header_image_r2_key is the R2 object key, kept so deleteMessageTemplate can
-- clean up the uploaded file when a draft/rejected template is deleted.
alter table message_templates add column header_type text not null default 'NONE' check (header_type in ('NONE','IMAGE'));
alter table message_templates add column header_image_url text;
alter table message_templates add column header_image_r2_key text;
