-- Per-business VIP customer settings, same pattern as enable_fleet etc.
-- isVip is never stored on the customer row — customer.controller.js#getCustomers
-- computes it live against these three columns on every read.
alter table businesses add column vip_enabled boolean not null default false;
alter table businesses add column vip_criteria text check (vip_criteria in ('bookings', 'spend'));
alter table businesses add column vip_threshold numeric;
