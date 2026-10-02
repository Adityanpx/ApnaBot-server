-- Course batches (Bot Builder, coaching): each course's batch list, e.g.
-- ["Mon–Fri 5–6 pm", "Sat–Sun 10–11 am (online)"], stored as a JSON array of
-- labels on the course (not a separate table: saving a course saves its
-- batches in one write, and a booking stores the chosen batch as text).
--
-- Used by:
--   - the WhatsApp course page — a "🗓 Batches" section after the details
--     (utils/courseValidation.js#coursePageText), only when non-empty;
--   - Bot Builder forms — the "Batch" question lists the batches of the
--     course the parent picked (field source 'course_batches', dependsOn
--     'course'), falling back to Weekday / Weekend when that course has none
--     (publicServiceForm.controller.js#resolveDynamicOptions).
--
-- Limits (also in courseValidation.js): at most 10 batches, each 1..72
-- characters. The catalog can suggest batches too, copied when a business
-- adds the course.
--
-- '[]' = no batches = everything exactly as before.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code that reads it.
alter table business_courses
  add column batches jsonb not null default '[]'::jsonb
    check (jsonb_typeof(batches) = 'array' and jsonb_array_length(batches) <= 10);

alter table course_catalog
  add column batches jsonb not null default '[]'::jsonb
    check (jsonb_typeof(batches) = 'array' and jsonb_array_length(batches) <= 10);

comment on column business_courses.batches is 'Batch labels (JSON array of text, max 10) shown on the course page and offered by the form''s Batch question for this course.';
comment on column course_catalog.batches is 'Suggested batch labels, copied to business_courses.batches when a business adds this course.';
