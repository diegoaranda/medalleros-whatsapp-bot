-- Additive support for photographs attached directly to a sport/category,
-- without requiring an intermediate "model" (catalog_items) row. The existing
-- catalog_items / catalog_item_media tables are left untouched so any
-- existing data keeps working; the new admin UI simply stops using them.
create table public.catalog_category_media (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null,
  company_id uuid not null references public.companies(id) on delete cascade,
  storage_path text not null unique check (length(trim(storage_path)) > 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  foreign key (category_id, company_id) references public.catalog_categories(id, company_id) on delete cascade
);

create index catalog_category_media_category_sort_idx on public.catalog_category_media(category_id, sort_order);

alter table public.catalog_category_media enable row level security;

create policy "members can read catalog category media" on public.catalog_category_media for select to authenticated
using (exists (
  select 1 from public.catalog_categories cc
  join public.company_members cm on cm.company_id = cc.company_id
  where cc.id = catalog_category_media.category_id and cm.user_id = (select auth.uid())
));

grant select, insert, update, delete on table public.catalog_category_media to service_role;
