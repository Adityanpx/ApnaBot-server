-- Per-business Fleet access toggle, independent of business_category, so a
-- mixed-category business with a car-booking service line among several
-- unrelated ones can use vehicles/route_fares/rental_packages (all keyed
-- only by business_id, no category dependency) without every business in
-- that category getting it. Same pattern as enable_distance_fares /
-- enable_smart_fallback.
alter table businesses
  add column enable_fleet boolean not null default false;
