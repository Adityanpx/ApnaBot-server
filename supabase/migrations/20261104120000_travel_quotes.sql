-- Travel quotes, Phase 1 / part A (data + rate-card API + reports only).
-- Nothing in the WhatsApp bot reads these tables yet (part C), and the whole
-- feature sits behind the Super Admin switch 'travel_quotes', which is OFF for
-- every business until switched on. Applying this migration changes no
-- behaviour for any business, Search cab AI included.
--
--   travel_routes          one row per route a business serves: display names,
--                          region (groups a long From/To list), optional toll
--                          override. PRICES STAY IN route_fares (one row per
--                          route + trip type + vehicle) - unchanged, still read
--                          by the booking engine.
--   route_fares.route_id   nullable link to travel_routes, backfilled below.
--                          Readers also match on (business_id, from_city,
--                          to_city), so a fare saved through the old
--                          /api/route-fares endpoint (route_id null) still shows.
--   travel_quote_settings  extras (night charge, driver allowance, toll,
--                          minimum charge) and quote timing, one row per
--                          business. The ADVANCE is NOT here: it reuses
--                          businesses.require_advance_payment /
--                          advance_payment_type / advance_payment_value.
--   travel_quotes          one row per quote sent to a customer. A booking is
--                          only created when the customer accepts (bookings.quote_id).
--   report_travel_quote_stats()  aggregates for GET /api/reports/quotes.
--
-- Enumerated CHECK values this file restates (re-read before writing; the live
-- tables hold exactly these values as of 2026-11-04):
--   category_features.feature / business_features.feature:
--     bot_builder, followups, opt_in_links, contact_import, owner_phone_media,
--     staff, broadcasts, catalogue  + NEW travel_quotes
--   (flow_nodes.node_type / reply_kind are NOT touched here - the new node types
--    come with part C's own migration.)
--   Left as they are: bookings.status (pending, confirmed, completed, cancelled),
--   bookings.payment_status (pending, paid, not_required),
--   route_fares.trip_type (oneway, round_trip, outstation, local).
--
-- BACKFILL (idempotent - re-running it changes nothing):
--   one travel_routes row per distinct (business_id, from_city, to_city) found in
--   route_fares, labels = Initcap of the city key, region null, is_active = true
--   if any of its fares is active; then route_fares.route_id is set where null.
--   It also touches route_fares.updated_at of the rows it links (trigger).
--   Live data on 2026-11-04: only SG Travels has route_fares (2 rows, Pune ->
--   Mumbai one-way and round-trip) -> 1 travel_routes row ('Pune' / 'Mumbai'),
--   both fares linked to it. Search cab AI has none.
--
-- DEPLOY ORDER: apply BEFORE deploying the server code from the same commit
-- (the code reads travel_routes / travel_quote_settings / travel_quotes and the
-- new feature key).
--
-- ROLLBACK:
--   drop function report_travel_quote_stats(uuid, timestamptz, timestamptz);
--   alter table bookings drop column quote_id;
--   drop table travel_quotes; drop table travel_quote_settings;
--   alter table route_fares drop column route_id; drop table travel_routes;
--   delete from category_features where feature = 'travel_quotes';
--   delete from business_features where feature = 'travel_quotes';
--   then re-add both feature constraints without 'travel_quotes'
--   (see 20261026130000_catalogue_feature_switch.sql).

-- ── Feature switch ──────────────────────────────────────────────────────────
alter table category_features drop constraint category_features_feature_check;
alter table category_features add constraint category_features_feature_check
  check (feature in ('bot_builder', 'followups', 'opt_in_links', 'contact_import', 'owner_phone_media', 'staff', 'broadcasts', 'catalogue', 'travel_quotes'));

alter table business_features drop constraint business_features_feature_check;
alter table business_features add constraint business_features_feature_check
  check (feature in ('bot_builder', 'followups', 'opt_in_links', 'contact_import', 'owner_phone_media', 'staff', 'broadcasts', 'catalogue', 'travel_quotes'));

-- ── Routes ──────────────────────────────────────────────────────────────────
create table travel_routes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  from_city text not null,                 -- lowercased key, same as route_fares.from_city
  to_city text not null,
  from_label text check (char_length(from_label) <= 24),   -- shown in WhatsApp lists (24-char row title)
  to_label text check (char_length(to_label) <= 24),
  region text check (char_length(region) <= 24),
  toll_included boolean,                   -- null = use travel_quote_settings.toll_included
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, from_city, to_city)
);
create index idx_travel_routes_business on travel_routes(business_id, is_active);

create trigger trg_set_updated_at before update on travel_routes
  for each row execute function set_updated_at();

alter table route_fares add column route_id uuid references travel_routes(id) on delete set null;
create index idx_route_fares_route_id on route_fares(route_id);

insert into travel_routes (business_id, from_city, to_city, from_label, to_label, is_active)
select business_id, from_city, to_city,
       initcap(left(from_city, 24)), initcap(left(to_city, 24)), bool_or(is_active)
  from route_fares
 group by business_id, from_city, to_city
on conflict (business_id, from_city, to_city) do nothing;

update route_fares rf
   set route_id = tr.id
  from travel_routes tr
 where rf.route_id is null
   and tr.business_id = rf.business_id
   and tr.from_city = rf.from_city
   and tr.to_city = rf.to_city;

-- ── Settings (extras + timing; advance lives on businesses) ─────────────────
create table travel_quote_settings (
  business_id uuid primary key references businesses(id) on delete cascade,
  night_charge numeric not null default 0 check (night_charge >= 0),
  night_start_minute smallint not null default 1320 check (night_start_minute between 0 and 1439),  -- 22:00 India time
  night_end_minute smallint not null default 360 check (night_end_minute between 0 and 1439),       -- 06:00
  driver_allowance_per_day numeric not null default 0 check (driver_allowance_per_day >= 0),
  toll_included boolean not null default false,
  minimum_charge numeric not null default 0 check (minimum_charge >= 0),
  valid_hours smallint not null default 24 check (valid_hours between 1 and 168),
  reminder_after_hours smallint not null default 3 check (reminder_after_hours between 0 and 167),  -- 0 = no reminder
  updated_at timestamptz not null default now(),
  constraint travel_quote_settings_reminder_before_expiry check (reminder_after_hours < valid_hours)
);

create trigger trg_set_updated_at before update on travel_quote_settings
  for each row execute function set_updated_at();

-- ── Quotes ──────────────────────────────────────────────────────────────────
--   status  sent       quote delivered, waiting for the customer
--           accepted   customer tapped Confirm; booking created (pending, advance asked)
--           paid       owner marked the advance paid
--           expired    never accepted and past expires_at
--           cancelled  owner cancelled it
--           handoff    "Other route" / "Talk to us": a lead, not a priced quote
--   An accepted quote is never expired or cancelled by the sweep: when its
--   advance is overdue the owner is alerted once (overdue_notified_at).
create table travel_quotes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  booking_id uuid references bookings(id) on delete set null,
  route_id uuid references travel_routes(id) on delete set null,
  route_fare_id uuid references route_fares(id) on delete set null,
  vehicle_id uuid references vehicles(id) on delete set null,
  from_city text not null,
  to_city text not null,
  trip_type text not null,
  collected jsonb not null default '{}',           -- date, time, passengers, days
  base_fare numeric not null default 0,
  extras jsonb not null default '[]',              -- [{ key, label, amount }]
  total_amount numeric not null default 0,
  advance_amount numeric,                          -- null = no advance asked
  status text not null default 'sent'
    check (status in ('sent', 'accepted', 'paid', 'expired', 'cancelled', 'handoff')),
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null,
  reminder_sent_at timestamptz,
  accepted_at timestamptz,
  customer_paid_claim_at timestamptz,              -- customer tapped "I've paid" (does NOT mark paid)
  overdue_notified_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_travel_quotes_sweep on travel_quotes(status, expires_at);
create index idx_travel_quotes_business_sent on travel_quotes(business_id, sent_at desc);
create index idx_travel_quotes_customer on travel_quotes(customer_id);

create trigger trg_set_updated_at before update on travel_quotes
  for each row execute function set_updated_at();

alter table bookings add column quote_id uuid references travel_quotes(id) on delete set null;
-- One booking per quote: a second "Confirm" tap cannot create a duplicate.
create unique index uq_bookings_quote on bookings(quote_id) where quote_id is not null;

-- Only the server touches these tables, with the service-role key (which
-- bypasses RLS); with RLS on and no policies, anon / authenticated can't.
alter table travel_routes enable row level security;
alter table travel_quote_settings enable row level security;
alter table travel_quotes enable row level security;

-- ── Reports ─────────────────────────────────────────────────────────────────
-- 'sent' counts priced quotes (handoff leads are counted separately). Quotes are
-- bucketed by sent_at; accepted/paid are counted when they happen to a quote
-- sent in the range.
create or replace function report_travel_quote_stats(
  p_business_id uuid,
  p_start timestamptz,
  p_end timestamptz
)
returns table (
  sent bigint,
  accepted bigint,
  paid bigint,
  expired bigint,
  cancelled bigint,
  handoff bigint,
  quoted_amount numeric,
  advance_collected numeric
) as $$
  select
    count(*) filter (where status <> 'handoff'),
    count(*) filter (where accepted_at is not null),
    count(*) filter (where paid_at is not null),
    count(*) filter (where status = 'expired'),
    count(*) filter (where status = 'cancelled'),
    count(*) filter (where status = 'handoff'),
    coalesce(sum(total_amount) filter (where status <> 'handoff'), 0),
    coalesce(sum(advance_amount) filter (where paid_at is not null), 0)
  from travel_quotes
  where business_id = p_business_id
    and sent_at >= p_start
    and sent_at < p_end;
$$ language sql stable;

revoke execute on function report_travel_quote_stats(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function report_travel_quote_stats(uuid, timestamptz, timestamptz) to service_role;
