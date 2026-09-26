-- One business per owner, enforced at the DB layer. createBusiness
-- (business.controller.js) already 409s when users.business_id is set or
-- when getBusinessByOwnerId finds an owned row, but that's check-then-insert:
-- two concurrent POST /api/business for the same user can both pass it and
-- both insert. This constraint makes the second insert fail with 23505,
-- which createBusiness maps to the same 409.
--
-- Replaces idx_businesses_owner_user_id (init_schema, non-unique) — the
-- unique constraint's own index covers the same lookups.
--
-- Precondition: no owner currently has more than one business. Checked
-- below and aborts (whole migration rolls back) rather than failing midway
-- on the ALTER with a less readable error. Pre-apply check query:
--   select owner_user_id, count(*) from businesses
--   group by owner_user_id having count(*) > 1;
do $$
declare
  dup_count integer;
begin
  select count(*) into dup_count from (
    select owner_user_id from businesses group by owner_user_id having count(*) > 1
  ) d;
  if dup_count > 0 then
    raise exception 'businesses has % owner_user_id value(s) with more than one row — resolve before adding the unique constraint', dup_count;
  end if;
end $$;

alter table businesses
  add constraint businesses_owner_user_id_key unique (owner_user_id);

drop index if exists idx_businesses_owner_user_id;
