-- web_form_trigger CTA button text, node-scoped (see 20260913120000_web_form_booking_link.sql
-- for the reply_kind and label_translations already covering the prompt text). Nullable, no
-- default, no length constraint — same looseness as label_translations/form_fields elsewhere
-- on this table. Meaningful only on web_form_trigger nodes; not DB-enforced.
alter table flow_nodes add column button_text text;
alter table flow_nodes add column button_text_translations jsonb;
