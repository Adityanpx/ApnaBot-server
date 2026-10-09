-- Delivery tracking for chat messages: when a message was delivered / read /
-- failed, and why it failed, plus the RPC the status webhook uses to apply
-- Meta's status events.
--
-- messages gains (all nullable, so no existing row is rewritten and old rows
-- simply have no timestamps / reason):
--   delivered_at, read_at, failed_at   Meta's own event time, not our clock
--   error_code     Meta's raw error code (integer), error_title / error_details
--                  its title and detail text. Mapped to plain words on read
--                  (utils/whatsappErrors.js), never here.
--
-- apply_message_statuses(p_events jsonb) -> jsonb { changed: [row...], unmatched: [wamid...] }
--   p_events: [{ wamid, status, ts, error_code, error_title, error_details }]
--   (ts = Meta's epoch seconds; error_* only for 'failed').
--   One round trip for a whole webhook change instead of one UPDATE per status.
--   Status only moves forward, per event:
--     delivered  sent -> delivered           delivered_at = COALESCE(existing, ts)
--     read       sent|delivered -> read      read_at = COALESCE(existing, ts), and
--                                            delivered_at is filled too if missing
--                                            (read can arrive before delivered)
--     failed     sent -> failed              only a message that never got delivered
--   Anything else (a late delivered after read, a repeat, an unknown status) changes
--   nothing. `changed` holds the rows that moved (without raw_payload);
--   `unmatched` holds wamids that match NO message row at all, so the caller can
--   retry once if the worker hadn't saved the wamid yet. A repeat of an applied
--   status is not "unmatched".
--
-- Each branch's UPDATE sets only the columns that event carries (nothing is
-- nulled by omission). No function-level search_path on purpose, like the other
-- RPCs; supabase/verification/verify_apply_message_statuses.sql relies on that
-- to run the function against a throwaway temp copy of messages.
--
-- Execute is limited to the service role (the server's key); the anon /
-- authenticated keys cannot call it.
--
-- Safe to re-run (add column if not exists / create or replace).
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same
-- change - the webhook calls apply_message_statuses, and the queue worker
-- writes messages.failed_at / error_* when a send finally fails. Until it is
-- applied the old code keeps working unchanged. Rolling the server back is
-- safe; the columns and function can stay.

alter table messages
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at timestamptz,
  add column if not exists failed_at timestamptz,
  add column if not exists error_code integer,
  add column if not exists error_title text,
  add column if not exists error_details text;

create or replace function apply_message_statuses(p_events jsonb)
returns jsonb
language plpgsql
as $$
declare
  ev jsonb;
  w text;
  s text;
  at_ts timestamptz;
  r messages;
  changed jsonb := '[]'::jsonb;
  unmatched jsonb := '[]'::jsonb;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    return jsonb_build_object('changed', changed, 'unmatched', unmatched);
  end if;

  for ev in select e from jsonb_array_elements(p_events) as e loop
    w := ev ->> 'wamid';
    s := ev ->> 'status';
    continue when w is null or w = '';
    at_ts := case when (ev ->> 'ts') ~ '^[0-9]{1,12}$' then to_timestamp((ev ->> 'ts')::bigint) else now() end;
    r := null;

    if s = 'delivered' then
      update messages
         set status = 'delivered', delivered_at = coalesce(delivered_at, at_ts)
       where meta_message_id = w and status = 'sent'
      returning * into r;
    elsif s = 'read' then
      update messages
         set status = 'read', read_at = coalesce(read_at, at_ts), delivered_at = coalesce(delivered_at, at_ts)
       where meta_message_id = w and status in ('sent', 'delivered')
      returning * into r;
    elsif s = 'failed' then
      update messages
         set status = 'failed', failed_at = coalesce(failed_at, at_ts),
             error_code = nullif(ev ->> 'error_code', '')::integer,
             error_title = nullif(ev ->> 'error_title', ''),
             error_details = nullif(ev ->> 'error_details', '')
       where meta_message_id = w and status = 'sent'
      returning * into r;
    else
      continue;
    end if;

    if r.id is not null then
      changed := changed || jsonb_build_array(to_jsonb(r) - 'raw_payload');
    elsif not exists (select 1 from messages where meta_message_id = w)
          and not (unmatched @> to_jsonb(w)) then
      unmatched := unmatched || to_jsonb(w);
    end if;
  end loop;

  return jsonb_build_object('changed', changed, 'unmatched', unmatched);
end;
$$;

revoke all on function apply_message_statuses(jsonb) from public, anon, authenticated;
grant execute on function apply_message_statuses(jsonb) to service_role;

comment on column messages.delivered_at is 'When Meta reported the message delivered (Meta''s timestamp). Null on rows from before delivery tracking.';
comment on column messages.read_at is 'When Meta reported the message read (Meta''s timestamp).';
comment on column messages.failed_at is 'When the message failed: a failed status webhook, or the queue worker giving up.';
comment on column messages.error_code is 'Raw Meta error code of the failure; mapped to plain words by utils/whatsappErrors.js.';
