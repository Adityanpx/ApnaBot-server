-- Per-business customizable text for the STOP/START/cancel-exit-menu keyword
-- replies (webhook.controller.js STOP_KEYWORDS/START_KEYWORDS/ESCAPE_KEYWORDS
-- branches). Same nullable text + jsonb translation-pair shape as
-- welcome_message/welcome_message_translations. The keyword *behavior*
-- (bot_paused_until set/cleared, booking session deleted) stays hardcoded and
-- is not affected by this migration — only the reply text is customizable.
-- cancel_message covers all of menu/cancel/exit/restart, which already share
-- one reply today (see ESCAPE_KEYWORDS in webhook.controller.js).
alter table businesses add column stop_message text;
alter table businesses add column stop_message_translations jsonb;
alter table businesses add column start_message text;
alter table businesses add column start_message_translations jsonb;
alter table businesses add column cancel_message text;
alter table businesses add column cancel_message_translations jsonb;
