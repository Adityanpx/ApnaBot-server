-- One 7-day Basic trial per WhatsApp number, ever.
--
--   trial_claims   one row per phone number (E.164 digits, no '+') that has used
--                  its trial. The UNIQUE on phone_e164 is the race guard: two
--                  simultaneous connects insert, one loses with 23505 and gets
--                  no trial.
--
-- The claim must outlive the account: business_id / user_id / subscription_id
-- are plain references with ON DELETE SET NULL (never CASCADE), so deleting a
-- business or its owner keeps the claim and the number cannot re-claim a trial
-- under a fresh account. Super Admin can delete a claim by hand (support reset).
--
-- Trial settings live in app_config (no schema change): trial_enabled
-- ('true'/'false'), trial_days (integer text), trial_plan_id (plans.id uuid;
-- missing = the plan named 'basic').
--
-- Only the server touches this table, with the service-role key (bypasses RLS);
-- with RLS on and no policies the anon / authenticated keys cannot read it.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same
-- commit. Additive - no existing table or live-traffic path changes.

create table trial_claims (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique,
  waba_id text,
  phone_number_id text,
  business_id uuid references businesses(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  subscription_id uuid references subscriptions(id) on delete set null,
  claimed_at timestamptz not null default now()
);
create index idx_trial_claims_business_id on trial_claims(business_id);
alter table trial_claims enable row level security;
