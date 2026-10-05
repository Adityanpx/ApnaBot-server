-- #6 Phase 1: sync message templates from WhatsApp.
--
-- Adds the columns the sync writes (source, Meta's raw status / quality /
-- components, last-synced and soft-delete timestamps), the send_support flag
-- (can ApnaBot's sender actually send this template today?), the 'deleted'
-- status, wider header types, and two partial unique indexes the sync
-- matches against.
--
-- Constraint names confirmed against the live DB (pg_constraint, 2026-10-05):
--   message_templates_status_check, message_templates_header_type_check,
--   message_templates_category_check (left as MARKETING/UTILITY — AUTHENTICATION
--   templates are skipped by the sync, never stored).
-- Live dedupe check on (business_id, name, language): no duplicates.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same
-- change. The server selects/writes the new columns; without them the template
-- list, broadcast checks and follow-up picker break.

-- Preconditions: stop here (nothing is changed) if either unique index would fail.
do $$
begin
  if exists (
    select 1 from message_templates
    where meta_template_id is not null
    group by business_id, meta_template_id having count(*) > 1
  ) then
    raise exception 'duplicate (business_id, meta_template_id) rows exist - resolve before applying';
  end if;
  if exists (
    select 1 from message_templates
    where meta_template_id is null
    group by business_id, name, language having count(*) > 1
  ) then
    raise exception 'duplicate un-registered (business_id, name, language) rows exist - resolve before applying';
  end if;
end $$;

-- 'deleted' = soft-deleted: Meta no longer lists it (meta_deleted_at says when).
alter table message_templates drop constraint message_templates_status_check;
alter table message_templates add constraint message_templates_status_check
  check (status in ('draft','pending','approved','rejected','paused','disabled','deleted'));

-- Synced templates can have any header format Meta supports.
alter table message_templates drop constraint message_templates_header_type_check;
alter table message_templates add constraint message_templates_header_type_check
  check (header_type in ('NONE','IMAGE','TEXT','VIDEO','DOCUMENT','LOCATION'));

alter table message_templates
  add column source text not null default 'app' check (source in ('app','meta_sync')),
  add column meta_status text,                 -- Meta's own status string, as last seen (APPROVED, PENDING, ...)
  add column quality_score text,               -- GREEN / YELLOW / RED / UNKNOWN
  add column meta_components jsonb,            -- Meta's components array, as last seen
  add column send_support text not null default 'ok'
    check (send_support in ('ok','needs_header_media','unsupported_named_params','unsupported_component')),
  add column last_synced_at timestamptz,
  add column meta_deleted_at timestamptz;

-- Existing rows: body-only or IMAGE-with-header_image_url stay 'ok' (the column
-- default); an IMAGE header with no stored image can't be sent.
update message_templates set send_support = 'needs_header_media'
  where header_type = 'IMAGE' and header_image_url is null;

-- One row per Meta template id per business.
create unique index uq_msg_templates_business_meta_id
  on message_templates (business_id, meta_template_id)
  where meta_template_id is not null;

-- One not-yet-registered row per name + language per business, so the sync's
-- name fallback ("adopt a stuck draft") always has at most one candidate.
create unique index uq_msg_templates_business_name_lang_unregistered
  on message_templates (business_id, name, language)
  where meta_template_id is null;
