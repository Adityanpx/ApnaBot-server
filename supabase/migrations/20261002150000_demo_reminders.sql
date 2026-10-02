-- Demo reminders (coaching Free demo requests, bookings.form_key = 'demo').
-- The owner fixes the demo time (PUT /api/bookings/:id/demo-time); the
-- parent is told at once and, when Bot Builder → Free demo → reminder is on
-- (settings.demoForm.reminder '2h' | 'evening'), reminded before it
-- (demoReminder.service.js / demoReminder.worker.js).
--
--   scheduled_for    when the demo class is (null = not fixed yet)
--   reminder_status  null = no reminder planned; scheduled → sent | skipped | failed
--   reminder_note    why a reminder was skipped / failed, shown to the owner
alter table bookings add column scheduled_for timestamptz;
alter table bookings add column reminder_status text
  check (reminder_status in ('scheduled', 'sent', 'skipped', 'failed'));
alter table bookings add column reminder_note text;

comment on column bookings.scheduled_for is 'Free demo: the class date/time the owner fixed.';
comment on column bookings.reminder_status is 'Free demo reminder: null (none) | scheduled | sent | skipped | failed.';
