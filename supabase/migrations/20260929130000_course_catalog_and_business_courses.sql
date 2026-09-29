-- Course catalog (Super Admin) + each business's own courses — the coaching
-- counterpart of vehicle_type_catalog -> vehicles (20260819213717_init_schema).
--
--   course_catalog     Super Admin-managed suggestions per business category
--                      (only 'coaching' is used today). Global, not per
--                      business.
--   business_courses   a business's own course list: picked from the catalog
--                      or added from scratch. Read by the Bot Builder
--                      (course list + course pages on WhatsApp) and by the
--                      service form's "Course list" dropdown source.
--
-- Deliberate difference from vehicles: a picked course is a COPY, not a
-- live reference. vehicles keeps catalog_id NOT NULL and overrides only
-- custom_name/custom_photo_url on top of the catalog row; business_courses
-- stores its own name/description/details, because fees/duration/timings
-- differ per institute and a Super Admin catalog edit must never silently
-- rewrite a business's live course pages. catalog_id is kept only to show
-- "added from catalog" and is nulled (not cascaded) if the catalog entry is
-- deleted. Owners may also add courses that are not in the catalog at all
-- (catalog_id null).
--
-- Text limits mirror WhatsApp's list-row limits the Bot Builder enforces
-- (name <= 24 chars = list row title, description <= 72 = row
-- description); details (the course page) is checked at the API layer
-- (<= 1024) alongside the rest of the flow limits.
create table course_catalog (
  id uuid primary key default gen_random_uuid(),
  category text not null references business_categories(value),
  name text not null check (char_length(btrim(name)) between 1 and 24),
  description text check (description is null or char_length(description) <= 72),
  details text,
  is_active boolean not null default true,
  "order" integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index uq_course_catalog_category_name on course_catalog(category, lower(btrim(name)));
create index idx_course_catalog_category_active_order on course_catalog(category, is_active, "order");

create trigger trg_set_updated_at before update on course_catalog
  for each row execute function set_updated_at();

create table business_courses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  catalog_id uuid references course_catalog(id) on delete set null,
  name text not null check (char_length(btrim(name)) between 1 and 24),
  description text check (description is null or char_length(description) <= 72),
  details text,
  show_demo_button boolean not null default true,
  show_admission_button boolean not null default true,
  is_active boolean not null default true,
  "order" integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Course names double as WhatsApp list-row titles and form dropdown
-- options, so they must be unique within a business.
create unique index uq_business_courses_business_name on business_courses(business_id, lower(btrim(name)));
create index idx_business_courses_business_active_order on business_courses(business_id, is_active, "order");

create trigger trg_set_updated_at before update on business_courses
  for each row execute function set_updated_at();

comment on table course_catalog is
  'Super Admin course suggestions per business category (coaching). Businesses copy entries into business_courses; catalog edits never change a business''s copy.';
comment on table business_courses is
  'A business''s own courses (copied from course_catalog or custom). Used by the Bot Builder and the service form "Course list" dropdown.';
