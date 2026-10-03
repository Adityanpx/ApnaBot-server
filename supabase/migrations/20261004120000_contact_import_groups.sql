-- Contact import (CSV / XLSX / public Google Sheet) + customer groups.
--
--   contact_groups           owner-named groups of customers, name unique per
--                            business (case/space-insensitive).
--   contact_group_members    (group, customer) pairs. import_batch_id is set
--                            only when an import ADDED the membership, so
--                            undo removes exactly those (a membership that
--                            already existed is left alone).
--   import_batches           one row per committed import: source, counts,
--                            opt-in attestation (who attested), undo state.
--   contact_import_previews  the parsed file between "preview" and "commit"
--                            (POST /api/contacts/import/preview → /commit).
--                            30 minutes; deleted on commit; expired rows are
--                            deleted lazily by the next preview. Kept in
--                            Postgres, not Redis: a 5 MB file's rows in the
--                            shared Redis (volatile-lru) could evict live
--                            booking sessions.
--
-- Also:
--   customers.last_message_at  now nullable. Imported customers have never
--                              messaged: NULL means no 24h window, never a
--                              follow-up candidate (the sweeper's range filter
--                              drops NULLs), and kept out of the inbox. The
--                              webhook always sets it, so nothing changes for
--                              customers who message in.
--                              first_seen_at stays NOT NULL (import time for
--                              imports); the dashboard's "new customers today"
--                              counts only customers with total_messages > 0.
--   customers.import_batch_id  the batch that CREATED the customer (undo).
--                              Existing customers are never touched by an import.
--   customers.opt_in_source    gains 'import' — only for new customers of an
--                              attested import (import_batches.attested_by).
--   broadcasts.audience_filter gains 'groups' — audience_params { groupIds }.
--   category_features / business_features accept the 'contact_import' switch.
--
-- Only the server touches the new tables, with the service-role key (which
-- bypasses RLS); with RLS on and no policies, the anon / authenticated keys
-- can't read or change them.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same
-- change — the inbox / customer list read last_message_at IS NULL rows only
-- once imports exist, but the import RPCs, the 'groups' audience and the
-- 'contact_import' switch all need it.

-- ── customers.last_message_at: NULL = never messaged ──
alter table customers alter column last_message_at drop not null;

-- ── Groups ──
create table contact_groups (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index uq_contact_groups_business_name on contact_groups(business_id, lower(btrim(name)));

create trigger trg_set_updated_at before update on contact_groups
  for each row execute function set_updated_at();

alter table contact_groups enable row level security;

-- ── Import batches ──
create table import_batches (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  source text not null check (source in ('csv', 'xlsx', 'gsheet')),
  file_name text,
  sheet_url text,
  total_rows integer not null default 0,
  created_count integer not null default 0,
  existing_count integer not null default 0,
  existing_added_to_group_count integer not null default 0,
  invalid_count integer not null default 0,
  duplicate_in_file_count integer not null default 0,
  group_id uuid references contact_groups(id) on delete set null,
  opt_in_attested boolean not null default false,
  attested_by uuid references users(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_deleted_count integer,
  undone_kept_count integer
);
create index idx_import_batches_business_created on import_batches(business_id, created_at desc);

alter table import_batches enable row level security;

create table contact_group_members (
  group_id uuid not null references contact_groups(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  import_batch_id uuid references import_batches(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (group_id, customer_id)
);
create index idx_contact_group_members_customer on contact_group_members(customer_id);
create index idx_contact_group_members_batch on contact_group_members(import_batch_id) where import_batch_id is not null;

alter table contact_group_members enable row level security;

-- ── Previews (between preview and commit) ──
create table contact_import_previews (
  id uuid primary key default gen_random_uuid(),   -- the preview token
  business_id uuid not null references businesses(id) on delete cascade,
  created_by uuid references users(id) on delete set null,
  source text not null check (source in ('csv', 'xlsx', 'gsheet')),
  file_name text,
  sheet_url text,
  headers jsonb not null,                           -- ["Name", "Mobile", ...]
  rows jsonb not null,                              -- [["Rahul", "98765 43210", ...], ...] (strings)
  mapping jsonb not null,                           -- the detected column mapping
  expires_at timestamptz not null default now() + interval '30 minutes',
  created_at timestamptz not null default now()
);
create index idx_contact_import_previews_expires on contact_import_previews(expires_at);

alter table contact_import_previews enable row level security;

-- ── customers ──
alter table customers add column import_batch_id uuid references import_batches(id) on delete set null;
create index idx_customers_import_batch on customers(import_batch_id) where import_batch_id is not null;

-- Constraint names and current definitions checked against the live
-- database (pg_constraint) on 2026-10-04 before writing this; each new list
-- is the live list plus the one new value.
alter table customers drop constraint customers_opt_in_source_check;
alter table customers add constraint customers_opt_in_source_check
  check (opt_in_source in ('customer_initiated', 'manual', 'website_form', 'opt_in_link', 'import'));

alter table broadcasts drop constraint broadcasts_audience_filter_check;
alter table broadcasts add constraint broadcasts_audience_filter_check
  check (audience_filter in ('all_customers', 'coaching_requests', 'groups'));

alter table category_features drop constraint category_features_feature_check;
alter table category_features add constraint category_features_feature_check
  check (feature in ('bot_builder', 'followups', 'opt_in_links', 'contact_import'));

alter table business_features drop constraint business_features_feature_check;
alter table business_features add constraint business_features_feature_check
  check (feature in ('bot_builder', 'followups', 'opt_in_links', 'contact_import'));

-- ── import_contacts: one committed import, as one transaction ──
-- p_rows: [{ phone, name }] — already normalized (digits, E.164 without +),
-- unique and valid (contactImport.js); invalid / duplicate rows are only
-- counted (p_invalid_count, p_duplicate_count). New numbers become customers
-- (never messaged: last_message_at NULL, total_messages 0; opted in only when
-- attested). Existing customers are NEVER changed — not name, not opt-in, not
-- opted_out_at — only added to the group. Any failure rolls the whole import
-- back: no batch, no customers, no group, no memberships.
create or replace function import_contacts(
  p_business_id uuid,
  p_created_by uuid,
  p_source text,
  p_file_name text,
  p_sheet_url text,
  p_total_rows integer,
  p_invalid_count integer,
  p_duplicate_count integer,
  p_opt_in_attested boolean,
  p_attested_by uuid,
  p_group_id uuid,
  p_new_group_name text,
  p_rows jsonb
) returns jsonb as $$
declare
  v_now timestamptz := now();
  v_batch_id uuid;
  v_group_id uuid := p_group_id;
  v_valid integer;
  v_created integer;
  v_added_existing integer := 0;
begin
  if p_group_id is not null and p_new_group_name is not null then
    return jsonb_build_object('error', 'group_and_new_group');
  end if;
  if p_opt_in_attested and p_attested_by is null then
    return jsonb_build_object('error', 'attested_by_required');
  end if;

  if p_group_id is not null then
    perform 1 from contact_groups where id = p_group_id and business_id = p_business_id;
    if not found then
      return jsonb_build_object('error', 'group_not_found');
    end if;
  elsif p_new_group_name is not null then
    perform 1 from contact_groups where business_id = p_business_id and lower(btrim(name)) = lower(btrim(p_new_group_name));
    if found then
      return jsonb_build_object('error', 'group_name_taken');
    end if;
    insert into contact_groups (business_id, name, created_by)
    values (p_business_id, btrim(p_new_group_name), p_created_by)
    returning id into v_group_id;
  end if;

  insert into import_batches (
    business_id, source, file_name, sheet_url, total_rows, invalid_count,
    duplicate_in_file_count, group_id, opt_in_attested, attested_by, created_by
  ) values (
    p_business_id, p_source, p_file_name, p_sheet_url, p_total_rows, p_invalid_count,
    p_duplicate_count, v_group_id, p_opt_in_attested, case when p_opt_in_attested then p_attested_by end, p_created_by
  ) returning id into v_batch_id;

  -- (business_id, whatsapp_number) is unique, so a number can't repeat; the
  -- caller already de-duplicated, distinct on is only a backstop.
  with r as (
    select distinct on (x.phone) x.phone
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(phone text, name text)
    where x.phone ~ '^[0-9]{8,15}$'
  )
  select count(*) into v_valid from r;

  with r as (
    select distinct on (x.phone) x.phone, nullif(btrim(x.name), '') as name
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(phone text, name text)
    where x.phone ~ '^[0-9]{8,15}$'
  ), inserted as (
    insert into customers (
      business_id, whatsapp_number, name, first_seen_at, last_message_at, total_messages,
      opted_in, opted_in_at, opt_in_source, import_batch_id
    )
    select
      p_business_id, r.phone, r.name, v_now, null, 0,
      p_opt_in_attested, case when p_opt_in_attested then v_now end,
      case when p_opt_in_attested then 'import' end, v_batch_id
    from r
    on conflict (business_id, whatsapp_number) do nothing
    returning 1
  )
  select count(*) into v_created from inserted;

  if v_group_id is not null then
    with r as (
      select distinct x.phone
      from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(phone text, name text)
      where x.phone ~ '^[0-9]{8,15}$'
    ), added as (
      insert into contact_group_members (group_id, customer_id, import_batch_id)
      select v_group_id, c.id, v_batch_id
      from customers c
      join r on r.phone = c.whatsapp_number
      where c.business_id = p_business_id
      on conflict (group_id, customer_id) do nothing
      returning customer_id
    )
    select count(*) into v_added_existing
    from added a join customers c on c.id = a.customer_id
    where c.import_batch_id is distinct from v_batch_id;
  end if;

  update import_batches set
    created_count = v_created,
    existing_count = v_valid - v_created,
    existing_added_to_group_count = v_added_existing
  where id = v_batch_id;

  return jsonb_build_object(
    'batchId', v_batch_id,
    'groupId', v_group_id,
    'createdCount', v_created,
    'existingCount', v_valid - v_created,
    'existingAddedToGroupCount', v_added_existing
  );
end;
$$ language plpgsql;

-- ── undo_import_batch: within 7 days, as one transaction ──
-- Removes the memberships this batch added, then deletes the customers this
-- batch created that have no messages, no bookings and no booking-form
-- tokens (those FKs don't cascade). Customers who have since messaged /
-- booked are kept (counted as kept). The 7-day window is also checked in
-- contactImport.service.js; re-checked here with the row locked so two undos
-- can't both run.
create or replace function undo_import_batch(
  p_business_id uuid,
  p_batch_id uuid
) returns jsonb as $$
declare
  v_batch import_batches%rowtype;
  v_memberships integer;
  v_deleted integer;
  v_kept integer;
begin
  select * into v_batch from import_batches
  where id = p_batch_id and business_id = p_business_id
  for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_batch.undone_at is not null then
    return jsonb_build_object('error', 'already_undone');
  end if;
  if v_batch.created_at < now() - interval '7 days' then
    return jsonb_build_object('error', 'window_closed');
  end if;

  delete from contact_group_members where import_batch_id = p_batch_id;
  get diagnostics v_memberships = row_count;

  with deleted as (
    delete from customers c
    where c.import_batch_id = p_batch_id
      and c.business_id = p_business_id
      and not exists (select 1 from messages m where m.business_id = p_business_id and m.customer_id = c.id)
      and not exists (select 1 from bookings b where b.business_id = p_business_id and b.customer_id = c.id)
      and not exists (select 1 from booking_form_tokens t where t.business_id = p_business_id and t.customer_id = c.id)
    returning 1
  )
  select count(*) into v_deleted from deleted;

  select count(*) into v_kept from customers
  where import_batch_id = p_batch_id and business_id = p_business_id;

  update import_batches set
    undone_at = now(),
    undone_deleted_count = v_deleted,
    undone_kept_count = v_kept
  where id = p_batch_id;

  return jsonb_build_object(
    'deletedCount', v_deleted,
    'keptCount', v_kept,
    'membershipsRemoved', v_memberships
  );
end;
$$ language plpgsql;

revoke execute on function import_contacts(uuid, uuid, text, text, text, integer, integer, integer, boolean, uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function undo_import_batch(uuid, uuid) from public, anon, authenticated;
grant execute on function import_contacts(uuid, uuid, text, text, text, integer, integer, integer, boolean, uuid, uuid, text, jsonb) to service_role;
grant execute on function undo_import_batch(uuid, uuid) to service_role;

comment on table contact_groups is 'Owner-named customer groups (Customers page, broadcast audience ''groups'').';
comment on table contact_group_members is 'Group memberships; import_batch_id = the import that added it (undo removes those).';
comment on table import_batches is 'Committed contact imports: counts, opt-in attestation, undo state.';
comment on table contact_import_previews is 'Parsed import file between preview and commit; 30 min, deleted on commit.';
comment on column customers.import_batch_id is 'The contact import that created this customer (undo deletes it if it never messaged/booked).';
comment on column customers.last_message_at is 'Last inbound message; NULL = never messaged (imported contact).';
