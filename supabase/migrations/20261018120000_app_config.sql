-- App version gate (mobile): which app versions the server accepts.
--
--   app_config   small key/value table, TEXT values (booleans are 'true' / 'false').
--                Read by the public GET /api/app/version, changed by the
--                superadmin-only PUT /api/admin/app-config. updated_by is the
--                user who last changed that key (NULL for the seed rows, and
--                for a change by a user whose account was later deleted).
--
-- Keys: android_min_version, android_latest_version, force_update,
-- maintenance_mode, play_store_url. A missing key is not an error: the server
-- falls back to 1.0.0 / false / the Play Store URL below.
--
-- Only the server touches this table, with the service-role key (which
-- bypasses RLS); with RLS on and no policies, the anon / authenticated keys
-- can't read or change it.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same
-- commit. Additive - no existing table or live-traffic path changes.

create table app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null
);
create trigger trg_set_updated_at before update on app_config
  for each row execute function set_updated_at();
alter table app_config enable row level security;

insert into app_config (key, value) values
  ('android_min_version',    '1.0.0'),
  ('android_latest_version', '1.0.0'),
  ('force_update',           'false'),
  ('maintenance_mode',       'false'),
  ('play_store_url',         'https://play.google.com/store/apps/details?id=com.averixsolutions.apnabot')
on conflict (key) do nothing;
