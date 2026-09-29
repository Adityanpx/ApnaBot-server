-- Super Admin feature switches per business category. Replaces the
-- ENABLE_BOT_SETTINGS environment variable: Bot Builder + Courses
-- (/api/bot-settings, /api/courses) are available to a business only while
-- its category's 'bot_builder' switch is on (middleware
-- categoryFeature.middleware.js#requireCategoryFeature), toggled from Super
-- Admin → Business Settings → <category> → Features, no redeploy.
--
-- A missing row means OFF, so nothing is seeded: every category starts
-- switched off, exactly like the old default (env var unset).
--
-- Per-business overrides (pilot a feature for chosen businesses before a
-- whole category) are deliberately NOT modelled yet — see PRD.md "Known
-- gaps / deferred work".
create table category_features (
  category text not null references business_categories(value),
  feature text not null check (feature in ('bot_builder')),
  is_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (category, feature)
);

create trigger trg_set_updated_at before update on category_features
  for each row execute function set_updated_at();

comment on table category_features is
  'Super Admin on/off feature switches per business category (bot_builder = Courses + Bot Builder for coaching). No row = off.';
