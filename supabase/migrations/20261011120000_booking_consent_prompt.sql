-- Marketing-consent question after a booking confirmation.
--
-- After a booking is confirmed in chat (graph booking, immediate confirm, or
-- web form), a business that switched on ask_consent_after_booking sends ONE
-- Yes/No question per customer, ever (webhook.controller.js + services/
-- bookingConsent.service.js). Tap ids: optin_yes:booking / optin_no:booking.
--
--   businesses.ask_consent_after_booking  per-business setting, default off.
--   customers.consent_prompted_at         set when the question is claimed (the
--                                         atomic "ask once" marker); never reset.
--   customers.consent_prompt_result       'yes' / 'no' once the customer taps;
--                                         null = asked, not answered.
--   customers.opt_in_source               gains 'booking_prompt'.
--
-- Constraint name and current definition checked against the live database
-- (pg_constraint) on 2026-10-11: customers_opt_in_source_check =
-- customer_initiated, manual, website_form, opt_in_link, import. The new list
-- is that list plus the one new value.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same
-- change. With the setting off (default) the server never touches the new
-- customers columns, but the yes-tap writes opt_in_source 'booking_prompt'.

alter table businesses
  add column ask_consent_after_booking boolean not null default false;

alter table customers
  add column consent_prompted_at timestamptz,
  add column consent_prompt_result text
    check (consent_prompt_result in ('yes', 'no'));

alter table customers drop constraint customers_opt_in_source_check;
alter table customers add constraint customers_opt_in_source_check
  check (opt_in_source in ('customer_initiated', 'manual', 'website_form', 'opt_in_link', 'import', 'booking_prompt'));

comment on column businesses.ask_consent_after_booking is
  'Ask customers for marketing consent (Yes/No buttons) once, after a booking is confirmed. Default off.';
comment on column customers.consent_prompted_at is
  'When the post-booking marketing-consent question was claimed/sent. Set once, never reset.';
comment on column customers.consent_prompt_result is
  'yes / no tap on the post-booking consent question; null = asked, not answered.';
