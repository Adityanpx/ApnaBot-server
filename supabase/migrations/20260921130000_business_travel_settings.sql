-- Splits the travel/cab-only fare-config columns out of `businesses` into
-- their own table. These 6 columns only ever meant anything for vehicle-for-
-- hire businesses (travels/cab, or a multi_brand business with one of those
-- as a sub-category), but lived on every business row regardless of category.
--
-- Backfilled for EVERY business, not just business_category in
-- ('travels','cab') — live data showed a multi_brand business (sub_categories
-- includes 'travels') and a 'general'-category business both carry real
-- non-default values here (enable_distance_fares/enable_fleet/
-- round_trip_driver_da_enabled all true), which a category-filtered backfill
-- would have silently deleted when the source columns are dropped below.
-- Reads/writes at the application layer still gate on category (see
-- business.service.js's isTravelFeaturedCategory) — this table simply exists
-- for every business so no live configuration is ever lost regardless of how
-- a business's category has been set up.
create table business_travel_settings (
  business_id uuid primary key references businesses(id) on delete cascade,
  enable_distance_fares boolean not null default false,
  round_trip_per_day_km numeric not null default 250,
  round_trip_driver_da_enabled boolean not null default false,
  round_trip_driver_da_amount numeric not null default 0,
  served_cities jsonb not null default '[]'::jsonb,
  enable_fleet boolean not null default false,
  updated_at timestamptz not null default now()
);

create trigger trg_set_updated_at before update on business_travel_settings
  for each row execute function set_updated_at();

insert into business_travel_settings (
  business_id, enable_distance_fares, round_trip_per_day_km,
  round_trip_driver_da_enabled, round_trip_driver_da_amount, served_cities, enable_fleet
)
select
  id, enable_distance_fares, round_trip_per_day_km,
  round_trip_driver_da_enabled, round_trip_driver_da_amount, served_cities, enable_fleet
from businesses;

alter table businesses
  drop column enable_distance_fares,
  drop column round_trip_per_day_km,
  drop column round_trip_driver_da_enabled,
  drop column round_trip_driver_da_amount,
  drop column served_cities,
  drop column enable_fleet;
