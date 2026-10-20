-- Auto-translate (Azure Translator F0), part 2: cache, usage cap and its settings.
--
--   translation_cache         global: (sha256 of the English source text, target language) -> translated text.
--                             Repeat texts never call Azure twice, for any business.
--   translate_usage           per business per month: source characters sent to Azure on the owner's behalf.
--   translate_usage_global    per month: every character sent to Azure (all businesses, signup and admin runs
--                             too) - guards the free tier's 2M characters/month.
--   reserve_translate_chars   atomically checks the caps and counts the characters BEFORE the Azure call;
--   refund_translate_chars    gives them back when the call fails.
--   app_config                translate_monthly_char_cap (per business, default 20000) and
--                             translate_global_monthly_cap (default 1800000). Editable from Super Admin
--                             (PUT /api/admin/app-config); never part of the public /api/app/version payload.
--
-- Only the server touches these tables (service-role key); RLS is on with no policies, as for app_config.
--
-- DEPLOY ORDER: apply BEFORE the server code from the same change. Additive - no existing table or RPC changes.
create table translation_cache (
  source_hash text not null,
  target_lang text not null,
  translated_text text not null,
  created_at timestamptz not null default now(),
  primary key (source_hash, target_lang)
);
alter table translation_cache enable row level security;

create table translate_usage (
  business_id uuid not null references businesses(id) on delete cascade,
  month date not null,
  chars_used integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (business_id, month)
);
alter table translate_usage enable row level security;

create table translate_usage_global (
  month date primary key,
  chars_used bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table translate_usage_global enable row level security;

-- p_count_business = false for work that must not eat the owner's allowance (signup default-flow
-- translation, Super Admin template translation): only the global counter moves.
-- result: 'ok' | 'business_cap' | 'global_cap'.
create or replace function reserve_translate_chars(
  p_business uuid, p_month date, p_chars integer, p_cap integer, p_global_cap bigint, p_count_business boolean
) returns table(result text, business_used integer, global_used bigint)
language plpgsql as $$
declare
  b_used integer := 0;
  g_used bigint;
begin
  insert into translate_usage_global (month, chars_used) values (p_month, 0) on conflict (month) do nothing;
  select chars_used into g_used from translate_usage_global where month = p_month for update;

  if p_global_cap is not null and g_used + p_chars > p_global_cap then
    return query select 'global_cap'::text, null::integer, g_used;
    return;
  end if;

  if p_count_business then
    insert into translate_usage (business_id, month, chars_used) values (p_business, p_month, 0)
      on conflict (business_id, month) do nothing;
    select chars_used into b_used from translate_usage where business_id = p_business and month = p_month for update;
    if p_cap is not null and b_used + p_chars > p_cap then
      return query select 'business_cap'::text, b_used, g_used;
      return;
    end if;
    update translate_usage set chars_used = chars_used + p_chars, updated_at = now()
      where business_id = p_business and month = p_month;
    b_used := b_used + p_chars;
  end if;

  update translate_usage_global set chars_used = chars_used + p_chars, updated_at = now() where month = p_month;
  return query select 'ok'::text, b_used, g_used + p_chars;
end;
$$;

create or replace function refund_translate_chars(
  p_business uuid, p_month date, p_chars integer, p_count_business boolean
) returns void
language plpgsql as $$
begin
  if p_count_business then
    update translate_usage set chars_used = greatest(chars_used - p_chars, 0), updated_at = now()
      where business_id = p_business and month = p_month;
  end if;
  update translate_usage_global set chars_used = greatest(chars_used - p_chars, 0), updated_at = now()
    where month = p_month;
end;
$$;

insert into app_config (key, value) values
  ('translate_monthly_char_cap',   '20000'),
  ('translate_global_monthly_cap', '1800000')
on conflict (key) do nothing;
