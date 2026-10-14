-- Plans fully managed from Super Admin: display fields the clients render.
--   plans.is_popular  highlight flag ("Most popular") on the plan card
--   plans.features    marketing bullet list, a JSON array of strings
--   plans.sort_order  explicit card order (ascending), ties broken by price
-- Additive, with defaults, so existing rows and running code are unaffected.
-- Apply before deploying the server code that reads/writes these columns.
alter table plans add column if not exists is_popular boolean not null default false;
alter table plans add column if not exists features jsonb not null default '[]'::jsonb;
alter table plans add column if not exists sort_order integer not null default 0;

alter table plans drop constraint if exists plans_features_is_array;
alter table plans add constraint plans_features_is_array check (jsonb_typeof(features) = 'array');
