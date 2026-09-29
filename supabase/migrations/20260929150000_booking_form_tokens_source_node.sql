-- The reply node whose button/list row was tapped to reach a web_form_trigger
-- (webhook.controller.js — the tapped flow_edges row's from_node_id). Null
-- for a typed keyword, a stale tap, or a token minted before this column.
--
-- Read only by publicServiceForm.controller.js#resolvePrefill: a coaching
-- Bot Builder course page (keyword page_course_N) pre-selects that course in
-- the form's Course list dropdown.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code that writes it —
-- that insert would otherwise fail and every tapped form link (all
-- businesses) would get the fallback message instead.
alter table booking_form_tokens
  add column source_node_id uuid references flow_nodes(id) on delete set null;

comment on column booking_form_tokens.source_node_id is
  'Reply node whose button/list row was tapped to reach this form (null when typed). Used to pre-fill the form, e.g. the course of a Bot Builder course page.';
