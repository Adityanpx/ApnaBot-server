-- Which web form a booking came from, and the question labels the customer
-- saw — both SNAPSHOTTED at submit time (publicServiceForm.controller.js
-- #submitServiceForm), because Bot Builder rebuilds its form nodes on every
-- publish (new ids, possibly new labels) and bookings.fields only holds
-- values keyed by field name (e.g. custom2: "Friends").
--
--   form_key     'demo' | 'admission' for a published Bot Builder (coaching)
--                form; null for every other form and for bookings made in chat.
--   form_title   short name of that form for lists ("Free demo", "Admission").
--   field_labels { [fieldName]: label } for every answered question on a
--                web-form booking (any business); null for chat bookings.
--
-- Additive and nullable: existing rows and the chat booking path are
-- untouched.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code that writes it —
-- that insert would otherwise fail and every web-form submission (all
-- businesses) would error.
alter table bookings
  add column form_key text,
  add column form_title text,
  add column field_labels jsonb;

create index idx_bookings_business_form_key on bookings(business_id, form_key) where form_key is not null;

comment on column bookings.form_key is 'Bot Builder form this booking came from (demo/admission), else null. Snapshot at submit.';
comment on column bookings.form_title is 'Short name of the web form this booking came from (e.g. Free demo), else null. Snapshot at submit.';
comment on column bookings.field_labels is '{fieldName: label} of the web form as submitted, else null. Snapshot at submit.';
