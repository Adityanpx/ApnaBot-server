-- Help Center "Was this helpful?" votes, one row per click, from the public
-- POST /api/public/help-feedback (no auth — anonymous, so no user/business
-- id is stored).
--
--   slug    article path, e.g. 'getting-started/connect-whatsapp' — the same
--           pattern the endpoint validates (2–3 lowercase segments, ≤120).
--   locale  'en' | 'hi' | 'mr'.
--
-- Only the server touches this table, with the service-role key (which
-- bypasses RLS); with RLS on and no policies, the anon / authenticated keys
-- can't read or change it.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same
-- change — the endpoint inserts into help_feedback.

create table help_feedback (
  id uuid primary key default gen_random_uuid(),
  slug text not null check (char_length(slug) <= 120 and slug ~ '^[a-z0-9-]+(/[a-z0-9-]+){1,2}$'),
  locale text not null check (locale in ('en', 'hi', 'mr')),
  helpful boolean not null,
  created_at timestamptz not null default now()
);
create index idx_help_feedback_slug_created on help_feedback(slug, created_at);

alter table help_feedback enable row level security;
