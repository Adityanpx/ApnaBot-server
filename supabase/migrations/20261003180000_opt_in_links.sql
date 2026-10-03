-- Opt-in links: a wa.me link / QR poster whose prefilled message carries
-- "JOIN-<code>". The webhook (webhook.controller.js, Step 11.7) spots the
-- code and asks the customer for marketing consent with Yes/No buttons.
--
--   opt_in_links        one row per link / poster. Never hard-deleted —
--                       the owner switches it off (is_active) instead.
--     code              4 chars from 23456789ABCDEFGHJKMNPQRSTVWXYZ (no
--                       0/O, 1/I/L, U), unique per business.
--     prefill_text      ONLY the owner's greeting ("Hi {{businessName}} 👋"
--                       by default); the server always appends
--                       " Code: JOIN-<code>" when building the wa.me URL.
--   opt_in_link_events  'message' (JOIN code received), 'opted_in' (Yes),
--                       'declined' (No) — the per-link stats (distinct
--                       customers per event) and the "waiting for an
--                       answer" check after the language picker.
--
-- Also:
--   customers.opt_in_source  gains 'opt_in_link'.
--   customers.opt_in_link_id which link a customer opted in through, for
--                            "Opted in via Counter poster". Cleared by a
--                            manual toggle (customer.controller.js).
--   category_features / business_features accept the 'opt_in_links' switch.
--
-- Only the server touches the new tables, with the service-role key (which
-- bypasses RLS); with RLS on and no policies, the anon / authenticated keys
-- can't read or change them.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same
-- change — the manual opt-in toggle writes customers.opt_in_link_id, and the
-- webhook writes opt_in_source 'opt_in_link' and opt_in_link_events.

create table opt_in_links (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  code text not null check (code ~ '^[2-9A-HJKMNP-TV-Z]{4}$'),
  prefill_text text not null check (char_length(prefill_text) between 1 and 200),
  is_active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, code)
);

create trigger trg_set_updated_at before update on opt_in_links
  for each row execute function set_updated_at();

alter table opt_in_links enable row level security;

create table opt_in_link_events (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references opt_in_links(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  event text not null check (event in ('message', 'opted_in', 'declined')),
  created_at timestamptz not null default now()
);
create index idx_opt_in_link_events_link_created on opt_in_link_events(link_id, created_at desc);
create index idx_opt_in_link_events_customer_created on opt_in_link_events(business_id, customer_id, created_at desc);

alter table opt_in_link_events enable row level security;

-- Constraint name checked against the live database (pg_constraint) before
-- writing this: created inline in 20260822082805_customers_opt_in.sql, so
-- Postgres named it customers_opt_in_source_check.
alter table customers drop constraint customers_opt_in_source_check;
alter table customers add constraint customers_opt_in_source_check
  check (opt_in_source in ('customer_initiated', 'manual', 'website_form', 'opt_in_link'));

alter table customers add column opt_in_link_id uuid references opt_in_links(id) on delete set null;

-- Constraint names verified for 20261003120000_followup_automations.sql.
alter table category_features drop constraint category_features_feature_check;
alter table category_features add constraint category_features_feature_check
  check (feature in ('bot_builder', 'followups', 'opt_in_links'));

alter table business_features drop constraint business_features_feature_check;
alter table business_features add constraint business_features_feature_check
  check (feature in ('bot_builder', 'followups', 'opt_in_links'));

comment on table opt_in_links is
  'wa.me links / QR posters whose JOIN-<code> message triggers a marketing-consent question. Switched off, never deleted.';
comment on table opt_in_link_events is
  'Per-link events (message / opted_in / declined) for stats and the pending-consent check after the language picker.';
comment on column customers.opt_in_link_id is
  'The opt-in link the customer opted in through (opt_in_source = opt_in_link); null after a manual toggle.';
