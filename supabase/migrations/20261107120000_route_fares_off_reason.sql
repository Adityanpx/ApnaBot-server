-- route_fares.off_reason: why a fare is switched off, so a route switched off and on again does not
-- bring back a fare the owner (or a script) switched off on purpose.
--
--   null      no marker (every existing row): the fare follows its route, exactly as before
--   'manual'  switched off on purpose (the Rates screen's per-fare switch, or deactivateSgRoundTripFares.js):
--             turning the route back ON leaves it off, and saving a price on it does not switch it on
--
-- NO BEHAVIOUR CHANGE FROM THIS FILE: one nullable column, nothing backfilled, nothing reads it until the
-- server code from the same commit is deployed. A fare that is already switched off has no marker, so until
-- something writes one it is treated as before.
--
-- Existing CHECK constraint on route_fares, read from the live DB (pg_constraint, contype = 'c', output
-- supplied by the owner) - restated so nothing here widens or drops it by accident:
--   route_fares.route_fares_trip_type_check
--     trip_type in ('oneway', 'round_trip', 'outstation', 'local')
-- It is not altered here. (route_fares also has unique (business_id, from_city, to_city, trip_type, vehicle_id).)
--
-- DEPLOY ORDER: apply BEFORE the server code that reads / writes the column (the route list and the
-- route editor select it).
--
-- ROLLBACK:
--   alter table route_fares drop column off_reason;

begin;

alter table route_fares
  add column off_reason text check (off_reason in ('manual'));

commit;
