-- Default flow per category: every new business is seeded from its category's
-- DEFAULT template (falling back to the 'general' one) - see
-- services/defaultSetup.service.js#applyDefaultSetup.
--
--   flow_snapshots.is_default   marks the one category template (is_category_template
--                               rows only) that new businesses of that category get.
--
-- At most ONE default per category is enforced by a partial unique index, and
-- set_default_category_template() swaps the default atomically (a plpgsql
-- function body is one transaction, so there is no moment with two defaults or
-- - for readers - with none).
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same
-- commit. Additive - no existing row or live-traffic path changes (every row
-- starts with is_default = false, i.e. nothing is auto-seeded until Super Admin
-- sets a default).

alter table flow_snapshots add column is_default boolean not null default false;

alter table flow_snapshots add constraint flow_snapshots_default_only_templates
  check (not is_default or is_category_template);

create unique index uq_flow_snapshots_default_per_category
  on flow_snapshots(category) where is_category_template and is_default;

create or replace function set_default_category_template(p_template_id uuid)
returns text
language plpgsql
as $$
declare
  v_category text;
begin
  select category into v_category
    from flow_snapshots
   where id = p_template_id and is_category_template and is_active
   for update;
  if not found then
    return null;
  end if;

  update flow_snapshots set is_default = false
   where is_category_template and category = v_category and is_default and id <> p_template_id;
  update flow_snapshots set is_default = true where id = p_template_id;

  return v_category;
end;
$$;

revoke all on function set_default_category_template(uuid) from public, anon, authenticated;
