-- Round Trip pricing for travel quotes: three nullable inputs for the formula
--   billed_km = max(2 x one_way_distance_km, days x min_km_per_day)
--   total     = billed_km x vehicles.per_km_rate + driver allowance
-- and one business setting for how the allowance is counted.
--
--   vehicles.min_km_per_day            minimum km billed per day (null = not set)
--   vehicles.driver_allowance_per_day  driver allowance per day / night (null = 0)
--   travel_routes.one_way_distance_km  the route's one-way distance (null = not set;
--                                      typed by the owner or filled from Google)
--   travel_quote_settings.allowance_basis  'day' (allowance x days) or 'night'
--                                      (allowance x (days - 1); a same-day return has 0)
--
-- NO BEHAVIOUR CHANGE FROM THIS FILE: every column is nullable (or has a default
-- that matches today's wording), nothing is backfilled, and nothing reads them
-- until the server code from the same commit set is deployed. A vehicle or route
-- with a null value simply means "Round Trip by formula: owner confirms the
-- price" once that code runs. A fixed Round Trip fare in route_fares still wins.
--
-- travel_quote_settings.driver_allowance_per_day (business-wide) is RETIRED from
-- Round Trip pricing: the column stays (no data is dropped) but nothing reads it
-- and the settings API only returns it read-only (the live web Settings page builds its
-- form from it) and ignores it on PUT.
--
-- Existing CHECK constraints on the tables this file touches, read from the live
-- DB (pg_constraint, contype = 'c', output supplied by the owner) - restated so nothing here
-- widens or drops one by accident:
--   route_fares.route_fares_trip_type_check
--     trip_type in ('oneway', 'round_trip', 'outstation', 'local')
--   travel_routes: from_label / to_label / region  char_length <= 24
--   travel_quote_settings: driver_allowance_per_day, minimum_charge, night_charge >= 0;
--     night_start_minute / night_end_minute 0-1439; reminder_after_hours 0-167;
--     valid_hours 1-168; reminder_after_hours < valid_hours
--   travel_quotes.travel_quotes_status_check
--     status in ('sent', 'accepted', 'paid', 'expired', 'cancelled', 'handoff')
--   vehicles: none.
-- None of them is altered here.
--
-- DEPLOY ORDER: apply BEFORE the server code that reads the columns.
--
-- ROLLBACK:
--   alter table travel_quote_settings drop column allowance_basis;
--   alter table travel_routes drop column one_way_distance_km;
--   alter table vehicles drop column driver_allowance_per_day, drop column min_km_per_day;

begin;

alter table vehicles
  add column min_km_per_day numeric check (min_km_per_day > 0),
  add column driver_allowance_per_day numeric check (driver_allowance_per_day >= 0);

alter table travel_routes
  add column one_way_distance_km numeric check (one_way_distance_km > 0);

alter table travel_quote_settings
  add column allowance_basis text not null default 'day' check (allowance_basis in ('day', 'night'));

commit;
