-- Storage cleanup (Super Admin): remove old R2 files, by hand or by rule.
--
--   storage_cleanup_runs    one cleanup: its filters, status and totals
--   storage_cleanup_items   one R2 object in a run - also the audit trail and the
--                           CSV export (there is no separate audit table)
--   messages.media_removed_at   set when a chat file was purged (media_url is
--                               set to NULL at the same time; the message keeps
--                               its text label, e.g. "Photo")
--   platform_settings       small key/value table for platform-wide settings;
--                           first key: chat_media_retention_days (number; NULL /
--                           missing = automatic retention off)
--   businesses.chat_media_retention   per-business override of that setting:
--                           NULL = follow the platform, 'never', or a number of
--                           days as text ('30'). Applies to customer + owner chat
--                           media only (never library files, QR, logo, ...).
--
-- Flow: a run is MARKED (items 'pending', pending_delete_at = now + 24h), can be
-- cancelled until then, and is purged by the sweeper (ENABLE_STORAGE_SWEEPER):
-- database references first, then the R2 object. Nothing here ever calls Meta.
--
-- Run status: preview | pending | purging | done | cancelled | failed. 'preview'
-- is reserved (previews are not stored today). Item status: pending | purged |
-- skipped_in_use | failed | cancelled.
--
-- Extra columns beyond the agreed schema, for atomic claims and retries:
--   storage_cleanup_items.claimed_at / attempts   claim_storage_cleanup_items()
--   storage_cleanup_runs.automatic_day            India-time day of an automatic
--                                                 run; the unique index below makes
--                                                 a second automatic run for the
--                                                 same day impossible
--
-- Only the server touches these tables, with the service-role key (which
-- bypasses RLS); with RLS on and no policies, the anon / authenticated keys
-- can't read or change them.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same
-- commit. The code is inert until ENABLE_STORAGE_SWEEPER=true.

alter table messages add column if not exists media_removed_at timestamptz;

alter table businesses add column if not exists chat_media_retention text
  check (chat_media_retention is null or chat_media_retention ~ '^(never|[1-9][0-9]*)$');

create table platform_settings (
  key text primary key,
  value jsonb,
  updated_at timestamptz not null default now()
);
create trigger trg_set_updated_at before update on platform_settings
  for each row execute function set_updated_at();
alter table platform_settings enable row level security;

create table storage_cleanup_runs (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references users(id) on delete set null,   -- NULL for an automatic run
  filters jsonb not null,   -- { kinds, from, to, business_id | 'all', min_bytes, include_in_use, orphan_mode }
  is_automatic boolean not null default false,
  automatic_day date,
  status text not null default 'pending'
    check (status in ('preview', 'pending', 'purging', 'done', 'cancelled', 'failed')),
  pending_delete_at timestamptz,
  cancelled_by uuid references users(id) on delete set null,
  cancelled_at timestamptz,
  confirmed_business_name text,   -- the typed confirmation, when in-use files were included
  file_count integer not null default 0,
  total_bytes bigint not null default 0,
  purged_count integer not null default 0,
  purged_bytes bigint not null default 0,
  failed_count integer not null default 0,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index idx_storage_cleanup_runs_created on storage_cleanup_runs (created_at desc);
create index idx_storage_cleanup_runs_open on storage_cleanup_runs (status) where status in ('pending', 'purging');
create unique index uq_storage_cleanup_runs_automatic_day on storage_cleanup_runs (automatic_day) where is_automatic;
alter table storage_cleanup_runs enable row level security;

create table storage_cleanup_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references storage_cleanup_runs(id) on delete cascade,
  r2_key text not null,
  url text,
  business_id uuid references businesses(id) on delete set null,
  kind text not null check (kind in (
    'chat_inbound', 'chat_echo', 'library', 'template_header', 'bot_node_image',
    'payment_qr', 'logo', 'vehicle_photo', 'course_image', 'orphan')),
  size_bytes bigint not null default 0,
  object_date timestamptz,       -- R2 LastModified
  in_use boolean not null default false,
  used_by jsonb not null default '[]'::jsonb,   -- [{ type, id, label }]
  status text not null default 'pending'
    check (status in ('pending', 'purged', 'skipped_in_use', 'failed', 'cancelled')),
  pending_delete_at timestamptz,
  error text,
  claimed_at timestamptz,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  unique (run_id, r2_key)
);
create index idx_storage_cleanup_items_due on storage_cleanup_items (pending_delete_at)
  where status in ('pending', 'failed');
create index idx_storage_cleanup_items_key on storage_cleanup_items (r2_key);
alter table storage_cleanup_items enable row level security;

-- Atomic claim for the sweeper: due items of runs that are still pending /
-- purging, skipping rows another tick already holds (FOR UPDATE SKIP LOCKED) and
-- anything claimed in the last 15 minutes. A failed item is retried up to 5 times.
-- p_run_id limits the claim to one run (scripts/storageCleanup.js --run).
create or replace function claim_storage_cleanup_items(p_limit integer, p_run_id uuid default null)
returns setof storage_cleanup_items
language sql
as $$
  update storage_cleanup_items i
     set claimed_at = now(), attempts = i.attempts + 1
   where i.id in (
     select i2.id
       from storage_cleanup_items i2
       join storage_cleanup_runs r on r.id = i2.run_id
      where r.status in ('pending', 'purging')
        and (p_run_id is null or r.id = p_run_id)
        and i2.status in ('pending', 'failed')
        and i2.pending_delete_at <= now()
        and i2.attempts < 5
        and (i2.claimed_at is null or i2.claimed_at < now() - interval '15 minutes')
      order by i2.pending_delete_at, i2.id
      limit p_limit
        for update of i2 skip locked)
  returning i.*;
$$;

comment on table storage_cleanup_items is
  'One R2 object in a storage cleanup run; doubles as the audit trail and CSV source.';
