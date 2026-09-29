-- Stable, permanent, per-category codes for catalog images (e.g. RUN-01),
-- generated atomically in the database so concurrent uploads never collide
-- and deleted codes are never reused.

alter table public.catalog_categories
  add column if not exists next_media_seq integer not null default 0;

alter table public.catalog_category_media
  add column if not exists code text;

-- Backfill existing rows using their current sort_order as the one-time
-- bootstrap ordering. The code itself never depends on sort_order afterwards.
with ordered as (
  select
    ccm.id,
    ccm.category_id,
    coalesce(nullif(upper(left(regexp_replace(cc.slug, '[^a-z0-9]', '', 'g'), 3)), ''), 'GEN') as prefix,
    row_number() over (partition by ccm.category_id order by ccm.sort_order, ccm.created_at, ccm.id) as seq
  from public.catalog_category_media ccm
  join public.catalog_categories cc on cc.id = ccm.category_id
  where ccm.code is null
)
update public.catalog_category_media ccm
set code = ordered.prefix || '-' || lpad(ordered.seq::text, 2, '0')
from ordered
where ordered.id = ccm.id;

-- Advance each category's counter past whatever codes now exist, so the next
-- upload continues the sequence instead of colliding with backfilled codes.
update public.catalog_categories cc
set next_media_seq = greatest(cc.next_media_seq, sub.count)
from (
  select category_id, count(*) as count
  from public.catalog_category_media
  where code is not null
  group by category_id
) sub
where sub.category_id = cc.id;

alter table public.catalog_category_media
  alter column code set not null;

alter table public.catalog_category_media
  add constraint catalog_category_media_code_check check (code ~ '^[A-Z0-9]+-[0-9]+$');

alter table public.catalog_category_media
  add constraint catalog_category_media_company_code_key unique (company_id, code);

-- Atomically hands out the next sequence number for a category. Uses a plain
-- row UPDATE ... RETURNING so Postgres' row lock serializes concurrent
-- callers; the caller must never compute this from MAX(sort_order) client-side.
create or replace function public.next_catalog_media_seq(p_category_id uuid) returns integer
language sql
as $$
  update public.catalog_categories
  set next_media_seq = next_media_seq + 1
  where id = p_category_id
  returning next_media_seq;
$$;

grant execute on function public.next_catalog_media_seq(uuid) to service_role;
