-- Follow-up automations, Phase 1 (schema only — nothing reads these tables
-- yet; the sweeper that sends follow-ups comes in a later phase).
--
-- An owner sets up an automation (a preset or custom); the sweeper later
-- messages customers who match its trigger. Each send is claimed in
-- followup_sends BEFORE it goes out — the unique (automation_id,
-- customer_id, trigger_key) row is what stops a double send if two sweeps
-- overlap (a long sweep, or old + new instance during a deploy).
--
--   followup_automations  one row per automation
--     preset            what the owner picked: enquiry_nudge | review_request
--                       | payment_pending | win_back | custom
--     trigger_type      when a customer becomes due (custom picks one too)
--     delay_minutes     the "X hours / days" after (or of inactivity)
--     message_category  marketing | utility — decides the opt-in rule for
--                       template sends (enforced in code, not here)
--     template_id       approved template used when the 24-hour window is
--                       closed; null = text-only (window-open sends only)
--     send_start_minute / send_end_minute
--                       allowed send hours as minutes of the day, India time
--     daily_cap         sends per automation per India-time day
--     per_customer_cap  lifetime sends per customer per automation
--
--   followup_sends  one row per (automation, customer, trigger occurrence)
--     trigger_key  identifies the occurrence, e.g. 'inbound:<last_message_at>'
--     status       claimed → sent_text | sent_template | skipped | failed
--
-- Also:
--   customers.opted_out_at  set when the customer sends STOP / UNSUBSCRIBE,
--                           cleared by START (webhook.controller.js). A
--                           durable "don't message me" — unlike
--                           bot_paused_until, which STOP only sets for 24h.
--                           Broadcasts and follow-ups skip these customers.
--   idx_customers_business_last_message  for the "last inbound X ago" triggers.
--   category_features / business_features accept the 'followups' switch.
--
-- Only the server touches the new tables, with the service-role key (which
-- bypasses RLS); with RLS on and no policies, the anon / authenticated keys
-- can't read or change them.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same
-- change — the STOP / START handling writes customers.opted_out_at and the
-- broadcast audience filters on it, so on the old schema STOP would fail to
-- record the pause AND the opt-out (one update) and every broadcast send /
-- recipients preview would error.

create table followup_automations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,
  preset text not null
    check (preset in ('enquiry_nudge', 'review_request', 'payment_pending', 'win_back', 'custom')),
  trigger_type text not null
    check (trigger_type in ('after_last_inbound', 'after_completed', 'after_payment_requested', 'inactive_for')),
  delay_minutes integer not null check (delay_minutes > 0),
  trigger_params jsonb not null default '{}',
  message_category text not null check (message_category in ('marketing', 'utility')),
  message_text text not null,
  message_text_translations jsonb,
  template_id uuid references message_templates(id) on delete set null,
  template_variable_mapping jsonb,
  send_start_minute smallint not null default 540 check (send_start_minute between 0 and 1439),
  send_end_minute smallint not null default 1260 check (send_end_minute between 1 and 1440),
  daily_cap integer not null default 50 check (daily_cap > 0),
  per_customer_cap smallint not null default 1 check (per_customer_cap between 1 and 5),
  is_active boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_followup_automations_active on followup_automations(business_id) where is_active;

create trigger trg_set_updated_at before update on followup_automations
  for each row execute function set_updated_at();

alter table followup_automations enable row level security;

create table followup_sends (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references followup_automations(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  booking_id uuid references bookings(id) on delete set null,
  trigger_key text not null,
  status text not null default 'claimed'
    check (status in ('claimed', 'sent_text', 'sent_template', 'skipped', 'failed')),
  reason text,
  message_id uuid references messages(id) on delete set null,
  cost_paise integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (automation_id, customer_id, trigger_key)
);
create index idx_followup_sends_automation_created on followup_sends(automation_id, created_at desc);
create index idx_followup_sends_automation_customer on followup_sends(automation_id, customer_id);
create index idx_followup_sends_business_created on followup_sends(business_id, created_at desc);

create trigger trg_set_updated_at before update on followup_sends
  for each row execute function set_updated_at();

alter table followup_sends enable row level security;

alter table customers add column opted_out_at timestamptz;

create index idx_customers_business_last_message on customers(business_id, last_message_at);

-- Constraint names checked against the live database (pg_constraint) before
-- writing this: both were created inline, so Postgres named them
-- <table>_feature_check.
alter table category_features drop constraint category_features_feature_check;
alter table category_features add constraint category_features_feature_check
  check (feature in ('bot_builder', 'followups'));

alter table business_features drop constraint business_features_feature_check;
alter table business_features add constraint business_features_feature_check
  check (feature in ('bot_builder', 'followups'));

comment on table followup_automations is
  'Owner-defined follow-up messages sent automatically to customers matching a trigger (sweeper, later phase).';
comment on table followup_sends is
  'One row per follow-up occurrence, claimed before sending; unique key prevents double sends. Also drives the caps.';
comment on column customers.opted_out_at is
  'Set when the customer sends STOP/UNSUBSCRIBE, cleared by START. Broadcasts and follow-ups skip these customers.';
