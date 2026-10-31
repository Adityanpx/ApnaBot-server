-- WhatsApp connection diagnostics: one row per connect attempt.
--
--   entries       what the client logged (Embedded Signup events, errors), posted to
--                 POST /api/business/whatsapp-connect-log. Secret-named keys are stripped
--                 before insert; max 100 entries of 4 KB.
--   server_steps  what connect-whatsapp did (received request, token exchange, debug_token,
--                 phone node, WABA, registration decision, subscribed_apps, syncs), with
--                 Meta's code / error_subcode / fbtrace_id on every failed Graph call.
--   outcome       the server's final outcome ('connected', 'token_exchange_failed', ...),
--                 'started' while in flight, or the client's own when it never reached the server.
--
-- Never stored: access tokens, the exchanged code, the app secret, the encryption key, the
-- system-user token. The app keeps only the last 50 rows per business (pruned on insert).
-- RLS on with no policies: only the service role (the server) reads or writes it.
--
-- DEPLOY ORDER: apply BEFORE the server code. Additive; nothing existing changes.
begin;

create table if not exists whatsapp_connect_attempts (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid references businesses(id) on delete cascade,
  user_id      uuid,
  outcome      text,
  entries      jsonb not null default '[]',
  server_steps jsonb not null default '[]',
  config_id    text,
  app_id       text,
  created_at   timestamptz default now()
);

create index if not exists whatsapp_connect_attempts_business_created_idx
  on whatsapp_connect_attempts (business_id, created_at desc);

alter table whatsapp_connect_attempts enable row level security;

commit;
