-- messages.triggered_rule_id IS NULL was assumed to reliably mean "a human
-- staff reply" (distinct from the bot's near-instant auto-replies), but that's
-- false: several webhook.controller.js paths send fully automated messages
-- (the language picker, the "no rule matched" fallback reply, STOP/START
-- keyword acks, the booking-cancellation confirmation) without ever setting
-- triggered_rule_id, since there's no specific matched rule/node to record for
-- them. Under the old assumption those read as human replies, which is what
-- broke the CRM response-time report (median came back at ~1 second — the
-- language picker replying to spam messages at 2am, not a person).
--
-- sender_type is an explicit, always-set marker instead: 'bot' for anything
-- webhook.controller.js/payment.service.js send automatically, 'human' for
-- message.controller.js's staff-typed sendMessage. Default 'human' is
-- deliberate (not 'bot') — if a future insert site is ever missed, it fails
-- safe by under-counting as a slow human reply rather than silently
-- corrupting the response-time metric back toward zero the way the
-- triggered_rule_id-based signal did.
alter table messages
  add column sender_type text not null default 'human'
  check (sender_type in ('bot', 'human'));
