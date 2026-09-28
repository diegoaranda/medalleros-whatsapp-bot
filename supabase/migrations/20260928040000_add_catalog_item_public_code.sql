alter table public.catalog_items
  add column if not exists code text;

-- Backfill any pre-existing rows so the NOT NULL constraint below is safe to apply.
-- Codes are derived once from the category slug at backfill time and never recomputed
-- automatically afterwards, matching the guarantee that codes stay stable.
with prefixed as (
  select
    ci.id,
    upper(left(regexp_replace(cc.slug, '[^a-z0-9]', '', 'g'), 3)) as prefix
  from public.catalog_items ci
  join public.catalog_categories cc on cc.id = ci.category_id
  where ci.code is null
),
numbered as (
  select
    id,
    prefix,
    row_number() over (partition by prefix order by id) as seq
  from prefixed
)
update public.catalog_items ci
set code = numbered.prefix || '-' || lpad(numbered.seq::text, 2, '0')
from numbered
where numbered.id = ci.id;

alter table public.catalog_items
  alter column code set not null;

alter table public.catalog_items
  add constraint catalog_items_code_check check (code ~ '^[A-Z0-9]+-[0-9]+$');

alter table public.catalog_items
  add constraint catalog_items_company_code_key unique (company_id, code);
