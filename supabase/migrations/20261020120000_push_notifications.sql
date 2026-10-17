-- Mobile push notifications (FCM), phase 1.
--
--   device_tokens             one row per installed app (the FCM token), the user and
--                             business it is signed in as, and the app's language
--                             (en | hi | mr) so the server picks the right sound channel
--                             and wording. token is unique: signing in as someone else
--                             on the same phone moves the row to that user.
--   notification_preferences  one row per user per business. prefs jsonb, exactly:
--                               { types: { booking_new, enquiry_new, payment_received,
--                                          human_needed, booking_cancelled, new_message,
--                                          customer_waiting: bool },
--                                 voiceEnabled: bool,
--                                 quietHours: { enabled: bool, start: 'HH:mm', end: 'HH:mm' } }
--                             Missing keys mean the defaults (every type on, voiceEnabled true,
--                             quietHours { enabled: false, start: '22:00', end: '07:00' }), so
--                             '{}' is a valid, complete setting. Quiet hours are India time and
--                             may run past midnight. Critical alerts are not switchable.
--
-- Only the server touches these tables, with the service-role key (which bypasses RLS);
-- with RLS on and no policies, the anon / authenticated keys can't read or change them.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same commit. The
-- code never throws on a missing table (push is fire-and-forget), but no device could
-- register and the POST /api/notifications/devices route would answer 500 until then.
-- Additive - no existing table or live-traffic path changes.

create table device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  token text not null unique,
  platform text not null default 'android',
  language text not null default 'en',
  app_version text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index idx_device_tokens_business on device_tokens(business_id);
alter table device_tokens enable row level security;

create table notification_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  prefs jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (user_id, business_id)
);
create trigger trg_set_updated_at before update on notification_preferences
  for each row execute function set_updated_at();
alter table notification_preferences enable row level security;
