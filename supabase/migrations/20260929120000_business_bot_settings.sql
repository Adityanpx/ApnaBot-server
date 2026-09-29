-- Settings-driven bot builder (first preset: coaching/classes). An owner
-- describes what the business offers in Settings (courses, menu sections,
-- form fields); the server turns that into the business's WhatsApp flow
-- (flow_nodes/flow_edges) on Publish, through the same snapshot-first,
-- validated save path as AI flow generation (aiFlow.service.js ->
-- flowGraph.service.js#saveFullGraph).
--
-- Own table, one row per business, same shape of choice as
-- business_travel_settings (20260921130000) — but, unlike that table, NOT
-- backfilled for every business: a row exists only once an owner has saved
-- bot settings at least once. "No row" means "this business's flow is
-- hand-built in the canvas", which is the case for every existing business.
--
--   preset             which settings form/generator applies. Only
--                      'coaching' exists today; new presets are added by
--                      widening this check constraint in a later migration
--                      (the API layer validates the same list).
--   settings           the owner's current, saved (draft) settings.
--   published_settings the exact settings last turned into the live flow —
--                      lets the dashboard show "you have unpublished
--                      changes" (settings <> published_settings) without
--                      guessing. null = never published.
--   published_at       when that publish happened. null = never published.
--   published_snapshot_id
--                      the flow_snapshots row taken of the previous live flow
--                      right before the last publish (the one-click undo).
--                      ON DELETE SET NULL because the 5-snapshot cap may
--                      evict it later; the settings row must survive that.
create table business_bot_settings (
  business_id uuid primary key references businesses(id) on delete cascade,
  preset text not null check (preset in ('coaching')),
  settings jsonb not null default '{}'::jsonb,
  published_settings jsonb,
  published_at timestamptz,
  published_snapshot_id uuid references flow_snapshots(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_set_updated_at before update on business_bot_settings
  for each row execute function set_updated_at();

comment on table business_bot_settings is
  'Settings-driven bot builder: an owner''s structured description of the business (courses, menu sections, form fields) that Publish compiles into flow_nodes/flow_edges. No row = flow is hand-built in the canvas.';
