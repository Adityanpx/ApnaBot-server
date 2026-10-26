-- Unlisted business at signup: an owner whose kind of business is not in the category list
-- signs up as 'general' and says what they are.
--
--   businesses.requested_category_text   what the owner typed (NULL for every normal signup)
--   business_requests                    one row per such signup, worked by the Averix team from
--                                        Super Admin: status new -> contacted -> set_up, free-text
--                                        notes. owner_name / owner_email are a snapshot at signup;
--                                        contact_phone is digits only with the country code (the
--                                        number the owner gave to be reached on, e.g. 919876543210).
--
-- Only the server touches business_requests, with the service-role key (bypasses RLS); with RLS on
-- and no policies the anon / authenticated keys can't read or change it.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same commit (signup writes
-- businesses.requested_category_text only when the owner sent a requested category, so a normal
-- signup is unaffected either way). Additive - no existing column or live-traffic path changes.

alter table businesses add column requested_category_text text;

create table business_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  requested_text text not null,
  contact_phone text,
  owner_name text,
  owner_email text,
  status text not null default 'new' check (status in ('new', 'contacted', 'set_up')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_business_requests_status on business_requests(status, created_at desc);
create index idx_business_requests_business on business_requests(business_id);
create trigger trg_set_updated_at before update on business_requests
  for each row execute function set_updated_at();
alter table business_requests enable row level security;
