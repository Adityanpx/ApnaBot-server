-- Course groups (Bot Builder, coaching): an optional group name on each
-- course, e.g. "JEE / NEET", "Foundation", "Skill classes". When any shown
-- course has one, WhatsApp shows Courses → groups → that group's courses
-- (coachingBotSettings.js#mapCoachingSettingsToSpec) instead of one flat
-- list, so an institute can show more than WhatsApp's 10-row list limit.
-- Courses without a group appear under "Other courses". Null everywhere =
-- exactly the old flat list.
--
-- The catalog carries a suggested group, copied when a business adds the
-- course (coaching/course.controller.js#createCourse).
--
-- 24 characters = a WhatsApp list row title (the group list's rows).
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code that reads it
-- (GET /api/courses/catalog and the Bot Builder select group_name).
alter table business_courses
  add column group_name text check (group_name is null or char_length(btrim(group_name)) between 1 and 24);

alter table course_catalog
  add column group_name text check (group_name is null or char_length(btrim(group_name)) between 1 and 24);

comment on column business_courses.group_name is 'Optional group shown on WhatsApp (Courses → groups → courses). Null = no group.';
comment on column course_catalog.group_name is 'Suggested group, copied to business_courses.group_name when a business adds this course.';
