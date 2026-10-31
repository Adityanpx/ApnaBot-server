-- Owner contact phone (users.phone).
--
-- Nullable: existing users and staff have none, and a future non-password sign-in has none until
-- the user completes their profile. Format: +91 followed by 10 digits starting 6-9. Not unique
-- (a family can share a number). No backfill.
-- Note: stored WITH the '+' (+919876543210), unlike customers.whatsapp_number / wa_id, which are
-- digits only (919876543210) - convert before comparing the two.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same commit (register and
-- PATCH /api/auth/me write the column; the Super Admin queries select it).

alter table users add column if not exists phone text;

alter table users drop constraint if exists users_phone_format_check;
alter table users add constraint users_phone_format_check
  check (phone is null or phone ~ '^\+91[6-9][0-9]{9}$');
