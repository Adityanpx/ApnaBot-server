-- "When a customer sends a photo, PDF or document" setting + the booking "file" question type.
--
--   business_handoff_settings.media_reply_mode   'default' = today's behaviour ("I can only read text")
--                                                'thank_and_alert' = thank the customer with
--                                                media_reply_text, raise the handoff (reason 'media')
--                                                and store the customer's documents in the chat.
--                                                Works on its own: enabled stays false unless the owner
--                                                switches the human-needed alert on separately.
--   business_handoff_settings.media_reply_text(+_translations)
--                                                '' = the built-in text (systemMessages.js mediaReceived)
--
--   customers.needs_human_reason gains 'media'.
--
--   flow_nodes.content_type gains 'file': a booking question answered with a photo / PDF / document.
--   The save RPC is untouched (it passes content_type through).
--
--   booking_files   one row per file a customer sent as the answer to a 'file' question, stored in R2
--                   under booking-files/<business_id>/. Counted in businesses.storage_used_bytes (the
--                   media storage limit) when stored. booking_id is set once the booking is created and
--                   goes NULL if the booking is deleted; a row with no booking is an orphan that storage
--                   cleanup removes (and un-counts) after 48 hours. The URL itself is also kept in
--                   bookings.fields under the question's field key.
--
-- DEPLOY ORDER: apply this BEFORE the server code. Additive: nothing changes for any live business until
-- an owner picks the new mode or a flow gets a 'file' question. Search cab AI is untouched.
begin;

alter table business_handoff_settings add column if not exists media_reply_mode text not null default 'default';
alter table business_handoff_settings drop constraint if exists business_handoff_settings_media_reply_mode_check;
alter table business_handoff_settings add constraint business_handoff_settings_media_reply_mode_check
  check (media_reply_mode in ('default', 'thank_and_alert'));
alter table business_handoff_settings add column if not exists media_reply_text text not null default '';
alter table business_handoff_settings add column if not exists media_reply_text_translations jsonb not null default '{}'::jsonb;

alter table customers drop constraint if exists customers_needs_human_reason_check;
alter table customers add constraint customers_needs_human_reason_check
  check (needs_human_reason is null or needs_human_reason in ('tap', 'keyword', 'unmatched', 'media'));

alter table flow_nodes drop constraint if exists flow_nodes_content_type_check;
alter table flow_nodes add constraint flow_nodes_content_type_check
  check (content_type in ('text','buttons','list','location','location_request','carousel','file'));

create table if not exists booking_files (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  booking_id uuid references bookings(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,
  field_key text,
  r2_key text not null unique,
  url text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  mime_type text,
  filename text,
  created_at timestamptz not null default now()
);

create index if not exists idx_booking_files_business on booking_files (business_id);
create index if not exists idx_booking_files_booking on booking_files (booking_id) where booking_id is not null;

alter table booking_files enable row level security;

comment on table booking_files is
  'Files customers sent as the answer to a booking "file" question (R2 booking-files/). Counted in businesses.storage_used_bytes.';

commit;
