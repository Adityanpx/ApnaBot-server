-- Follow-up automations, Phase 3: review request (after a booking is
-- completed) and payment reminder (while a payment is still pending) need to
-- know WHEN those happened. updated_at can't tell — any later edit moves it.
--
--   completed_at          when status last became 'completed'; cleared when
--                         the booking is reopened (status changes away)
--   payment_requested_at  when payment_status last became 'pending' (kept
--                         after it is paid, for history; a new request after
--                         that stamps a new time)
--
-- Stamped by a trigger, not the application: bookings reach these states
-- from five places (owner status change, an admission marked paid, a booking
-- created with an advance, the payment QR sent from chat, a payment marked
-- pending again) and any future path is covered too. The trigger only ever
-- writes these two columns.
--
-- Existing rows stay NULL — only bookings completed / payments requested
-- after this migration can trigger a follow-up (checked 2026-10-03: 1
-- completed booking and 3 pending payments in total, none for a live
-- business).
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code that reads these
-- columns (followupSweep.service.js). Safe with the current server: nothing
-- reads them yet and the trigger never changes any other column.

alter table bookings add column completed_at timestamptz;
alter table bookings add column payment_requested_at timestamptz;

create or replace function stamp_booking_followup_times()
returns trigger as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'completed' and new.completed_at is null then
      new.completed_at := now();
    end if;
    if new.payment_status = 'pending' and new.payment_requested_at is null then
      new.payment_requested_at := now();
    end if;
  else
    if new.status is distinct from old.status then
      new.completed_at := case when new.status = 'completed' then now() else null end;
    end if;
    if new.payment_status is distinct from old.payment_status and new.payment_status = 'pending' then
      new.payment_requested_at := now();
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_stamp_followup_times before insert or update on bookings
  for each row execute function stamp_booking_followup_times();

-- The sweeper's candidate queries (followupSweep.service.js).
create index idx_bookings_business_completed on bookings(business_id, completed_at)
  where status = 'completed';
create index idx_bookings_business_payment_requested on bookings(business_id, payment_requested_at)
  where payment_status = 'pending';

comment on column bookings.completed_at is
  'When status last became completed (trigger trg_stamp_followup_times); null when not completed. Drives review-request follow-ups.';
comment on column bookings.payment_requested_at is
  'When payment_status last became pending (trigger trg_stamp_followup_times). Drives payment-reminder follow-ups.';
