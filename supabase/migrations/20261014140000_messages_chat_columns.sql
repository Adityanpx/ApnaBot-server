-- Columns for the chat redesign (Flutter + web inbox). All three are nullable with
-- no default: rows written before this migration keep NULL and read as plain text,
-- with no backfill.
--
--   messages.sent_by_user_id   the dashboard user who sent a human message
--     (message.controller.js sendMessage / sendPaymentQr). ON DELETE SET NULL, so
--     deleting a user never deletes or blocks on their messages.
--   messages.sent_by_name      the sender's name AS IT WAS when they sent it - a
--     snapshot, so a rename or a deleted user does not change old messages. A
--     superadmin's send is stored as 'ApnaBot Support'. Bot and phone-app rows
--     stay NULL. Shown to people who can view the business's chats; never sent
--     to Meta or the customer.
--   messages.interactive_payload  what the customer saw for a list / reply-buttons
--     / CTA-URL / location-request message, as a jsonb object:
--       { kind: 'list' | 'buttons' | 'cta_url' | 'location_request', body,
--         buttonText?, options?: [{ id, title, description? }], url?, label?, imageUrl? }
--     Text already cut to WhatsApp's limits (utils/interactivePayload.js). The
--     CHECK only requires NULL or a JSON object; the shape is the server's job.
--
-- Safe to re-run: add column if not exists, the CHECK is dropped and re-added. No
-- data is touched and no rewrite happens (nullable columns without a default are a
-- catalog-only change). No index: these are read only with the message row.
-- One transaction. DEPLOY ORDER: apply this BEFORE the server code - the new code
-- writes these columns on every bot reply, so code first would fail the insert.
-- Check it with supabase/verification/verify_messages_chat_columns.sql.

begin;

alter table messages
  add column if not exists sent_by_user_id uuid references users(id) on delete set null,
  add column if not exists sent_by_name text,
  add column if not exists interactive_payload jsonb;

alter table messages drop constraint if exists messages_interactive_payload_object_check;
alter table messages add constraint messages_interactive_payload_object_check
  check (interactive_payload is null or jsonb_typeof(interactive_payload) = 'object');

comment on column messages.sent_by_user_id is
  'Dashboard user who sent this human message (NULL for bot / phone-app rows and rows from before 2026-10-14). ON DELETE SET NULL.';
comment on column messages.sent_by_name is
  'Sender name as of the send (snapshot). A superadmin send is ''ApnaBot Support''. NULL for bot / phone-app / older rows.';
comment on column messages.interactive_payload is
  'What the customer saw for a list / buttons / cta_url / location_request message: {kind, body, buttonText?, options?, url?, label?, imageUrl?}. NULL = plain text.';

commit;

-- Rollback (only if ever needed; the code tolerates the columns existing, so a code
-- revert alone is always safe):
--   alter table messages drop constraint if exists messages_interactive_payload_object_check;
--   alter table messages drop column if exists interactive_payload,
--                        drop column if exists sent_by_name,
--                        drop column if exists sent_by_user_id;
