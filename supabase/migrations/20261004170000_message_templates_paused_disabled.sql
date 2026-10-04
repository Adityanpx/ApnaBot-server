-- Adds 'paused' and 'disabled' as message_templates.status values, written
-- by the message_template_status_update webhook (webhook.controller.js) when
-- Meta pauses (quality dropped) or disables a template. Both mean "registered
-- with Meta but can't be sent": broadcasts, follow-ups and the follow-up
-- template picker only use status 'approved'. Meta's REINSTATED event puts a
-- template back to 'approved'.
--
-- The constraint was declared inline in 20260819213717_init_schema.sql, so
-- Postgres named it message_templates_status_check — confirm on the live DB
-- before applying:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.message_templates'::regclass and contype = 'c';
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same
-- change — until then a PAUSED/DISABLED webhook's update is rejected by the
-- old check (logged, template status left as it was).

alter table message_templates drop constraint message_templates_status_check;
alter table message_templates add constraint message_templates_status_check
  check (status in ('draft','pending','approved','rejected','paused','disabled'));
