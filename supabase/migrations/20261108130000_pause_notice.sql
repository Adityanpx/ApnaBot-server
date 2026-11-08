-- "Tell customers when the bot pauses": when the owner or staff replies and that switches the bot off for
-- the customer, the customer gets one short notice saying so and how it resumes.
--
-- ADDITIVE ONLY and idempotent (add column if not exists). No backfill, no change to any existing row's values.
--
--   businesses.notify_pause_enabled          the switch. DEFAULT FALSE, so every existing business (Search cab AI
--                                            included) stays off. New signups are inserted with TRUE by
--                                            business.service.js#createBusiness.
--   businesses.notify_pause_text             optional owner wording for the timed (24h) pause notice. NULL = the
--                                            built-in text (systemMessages.js pauseNoticeTimed).
--   businesses.notify_pause_text_translations  { <lang>: text }, same shape as stop_message_translations.
--
--   customers.pause_notice_sent_at           when a pause notice was last sent to this customer. One guarded UPDATE
--                                            (pauseNotice.service.js) claims it, so at most one notice per customer per
--                                            24h even when two replies race. NULL = never sent.

begin;

alter table businesses add column if not exists notify_pause_enabled boolean not null default false;
alter table businesses add column if not exists notify_pause_text text;
alter table businesses add column if not exists notify_pause_text_translations jsonb;

alter table customers add column if not exists pause_notice_sent_at timestamptz;

commit;
