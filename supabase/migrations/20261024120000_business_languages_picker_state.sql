-- Per-business bot languages (English + up to 3 Indian languages), part 1: columns.
--
--   businesses.language_picker     picker settings, NULL = defaults:
--                                  { prompt, promptTranslations, mode: 'first_message'|'off', changeKeyword }
--   businesses.state               Indian state / UT (validated in the app against the catalog in
--                                  utils/languageCatalog.js); picks the default enabled_languages at signup
--   businesses.translation_status  { "<lang>": { "status": "pending"|"done"|"failed", "at": iso } } -
--                                  set while the signup default-flow translation runs
--   *.auto_translations            which translation slots Azure filled, so the apps can badge them:
--                                  { "<slot>": { "<lang>": "<hash of the stored text>" } }.
--                                  A slot is "auto-translated" only while the stored text still hashes to
--                                  the recorded value, so a hand edit clears the badge by itself - no
--                                  writer has to know about this column (the canvas save RPC leaves it alone).
--                                  The existing *_translations JSON shapes are unchanged.
--
-- enabled_languages itself is unchanged (text[] not null default '{en}'); the 1..4 / 'en' first /
-- catalog-code rules are enforced in the application (array constraints are awkward in Postgres).
--
-- DEPLOY ORDER: apply BEFORE the server code from the same change. Additive, nullable, no default -
-- no existing row, column, RPC or live-traffic path changes.
alter table businesses
  add column if not exists language_picker jsonb,
  add column if not exists state text,
  add column if not exists translation_status jsonb,
  add column if not exists auto_translations jsonb;

alter table flow_nodes add column if not exists auto_translations jsonb;
alter table flow_edges add column if not exists auto_translations jsonb;
