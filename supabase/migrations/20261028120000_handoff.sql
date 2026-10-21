-- Human-needed alert ("handoff"): when a customer needs a person, the owner is pushed ONCE per
-- open escalation, the customer gets an honest reply, and a reminder follows if nobody answers.
--
--   customers.needs_human_at       when the escalation was opened. NULL = none open. Set by one
--                                  guarded UPDATE (webhook.controller.js -> handoff.service.js#raise)
--                                  that only succeeds while it is NULL, so only the winner pushes.
--   customers.needs_human_reason   'tap' (a handoff node was reached) | 'keyword' (the customer
--                                  asked for a person) | 'unmatched' (N messages in a row the bot
--                                  could not answer).
--   customers.handoff_cleared_at   when it was last cleared (staff reply, phone-app reply, Mark
--                                  done). The 30-minute cooldown after a clear applies to
--                                  'unmatched' only.
--   customers.handoff_pause_set_to the bot_paused_until value the handoff itself wrote. Clearing
--                                  lifts the pause only when bot_paused_until still equals it, so a
--                                  pause the owner set by hand is never undone.
--
--   business_handoff_settings      one row per business. NO ROW = handoff off (the old
--                                  human_needed behaviour stays exactly as it is). New signups get
--                                  a row with enabled = true (business.service.js#createBusiness);
--                                  existing businesses get none.
--     keywords           jsonb array of phrases, NULL = the built-in defaults (utils/handoffSettings.js)
--     unmatched_threshold unmatched messages in a row before escalating; 0 = never on unmatched
--     reply_text(+_translations) what the customer is told; '' = the built-in text (systemMessages.js)
--     closed_text(+_translations) the same when the business is closed ({{nextOpening}} is filled in)
--     pause_bot_minutes  pause the bot this long on escalation; 0 = leave the bot on
--     reminder_minutes   "still waiting" push this long after the first one; 0 = no reminder
--     auto_resume_bot    clearing lifts the pause the handoff set (never an owner's own pause)
--     hours              {"mon":[{"open":"09:00","close":"18:00"}],...} India time; a missing day or
--                        [] = closed; NULL = hours unknown, the closed text is never sent
--
--   flow_nodes.reply_kind gains 'handoff': a reply node that is the "talk to a person" entry.
--   Dropped and re-added exactly as 20260913120000 did; the save RPC is untouched (it passes
--   reply_kind through).
--
-- DEPLOY ORDER: apply this BEFORE the server code. Additive: nothing changes for any live
-- business until a settings row exists with enabled = true. Search cab AI gets no row.
begin;

alter table customers add column if not exists needs_human_at timestamptz;
alter table customers add column if not exists needs_human_reason text;
alter table customers add column if not exists handoff_cleared_at timestamptz;
alter table customers add column if not exists handoff_pause_set_to timestamptz;

alter table customers drop constraint if exists customers_needs_human_reason_check;
alter table customers add constraint customers_needs_human_reason_check
  check (needs_human_reason is null or needs_human_reason in ('tap', 'keyword', 'unmatched'));

create index if not exists idx_customers_needs_human
  on customers (business_id, needs_human_at) where needs_human_at is not null;

create table if not exists business_handoff_settings (
  business_id uuid primary key references businesses(id) on delete cascade,
  enabled boolean not null default false,
  keywords jsonb check (keywords is null or jsonb_typeof(keywords) = 'array'),
  unmatched_threshold integer not null default 3 check (unmatched_threshold between 0 and 10),
  reply_text text not null default '',
  reply_text_translations jsonb not null default '{}'::jsonb,
  closed_text text not null default '',
  closed_text_translations jsonb not null default '{}'::jsonb,
  pause_bot_minutes integer not null default 0 check (pause_bot_minutes between 0 and 10080),
  reminder_minutes integer not null default 15 check (reminder_minutes between 0 and 1440),
  auto_resume_bot boolean not null default false,
  hours jsonb check (hours is null or jsonb_typeof(hours) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_set_updated_at on business_handoff_settings;
create trigger trg_set_updated_at before update on business_handoff_settings
  for each row execute function set_updated_at();

alter table business_handoff_settings enable row level security;

comment on table business_handoff_settings is
  'Human-needed alert settings, one row per business. No row = handoff off (legacy human_needed push only).';

alter table flow_nodes drop constraint flow_nodes_reply_kind_check;
alter table flow_nodes add constraint flow_nodes_reply_kind_check
  check (reply_kind in ('text','booking_trigger','payment_trigger','web_form_trigger','handoff'));

commit;
