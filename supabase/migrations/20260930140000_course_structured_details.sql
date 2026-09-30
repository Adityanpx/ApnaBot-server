-- Structured course details (Bot Builder, coaching): Age, Duration, Fees,
-- Mode and More details, instead of one free-text page. When ANY of these is
-- set, the WhatsApp course page is built from them
-- (coachingBotSettings.js#coursePageText):
--
--   *Abacus*
--   Mental maths for kids, age 6+        (description, if any)
--
--   👦 Age: 6 years and above
--   🕘 Duration: 3 months per level
--   💰 Fees: ₹4,000 per level
--   💻 Mode: Online and offline
--   <more details>
--
-- When none is set, the old free-text `details` column is used exactly as
-- before (so existing courses publish unchanged until the owner fills the
-- fields in). Same columns on the catalog, copied when a business adds a
-- course. All nullable, additive.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code that reads it.
alter table business_courses
  add column age_group text check (age_group is null or char_length(age_group) <= 100),
  add column duration text check (duration is null or char_length(duration) <= 100),
  add column fees text check (fees is null or char_length(fees) <= 100),
  add column mode text check (mode is null or mode in ('online', 'offline', 'both')),
  add column more_details text check (more_details is null or char_length(more_details) <= 800);

alter table course_catalog
  add column age_group text check (age_group is null or char_length(age_group) <= 100),
  add column duration text check (duration is null or char_length(duration) <= 100),
  add column fees text check (fees is null or char_length(fees) <= 100),
  add column mode text check (mode is null or mode in ('online', 'offline', 'both')),
  add column more_details text check (more_details is null or char_length(more_details) <= 800);

comment on column business_courses.age_group is 'Age / eligibility line on the WhatsApp course page, e.g. "6 years and above".';
comment on column business_courses.mode is 'online | offline | both — shown as the Mode line on the course page.';
comment on column business_courses.more_details is 'Free text after the structured lines. When any structured field is set, the page is built from them and `details` (legacy free text) is ignored.';
