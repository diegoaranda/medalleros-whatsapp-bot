create table public.catalog_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  slug text not null check (slug = lower(slug) and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, slug),
  unique (id, company_id)
);

create table public.catalog_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  category_id uuid not null,
  name text not null check (length(trim(name)) > 0),
  active boolean not null default true,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (category_id, company_id) references public.catalog_categories(id, company_id) on delete cascade,
  unique (id, company_id)
);

create table public.catalog_item_media (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.catalog_items(id) on delete cascade,
  storage_path text not null unique check (length(trim(storage_path)) > 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index catalog_categories_company_sort_idx on public.catalog_categories(company_id, sort_order, name);
create index catalog_items_category_sort_idx on public.catalog_items(category_id, sort_order, name);
create index catalog_item_media_item_sort_idx on public.catalog_item_media(item_id, sort_order);

alter table public.catalog_categories enable row level security;
alter table public.catalog_items enable row level security;
alter table public.catalog_item_media enable row level security;

create policy "members can read catalog categories" on public.catalog_categories for select to authenticated
using (exists (select 1 from public.company_members cm where cm.company_id = catalog_categories.company_id and cm.user_id = (select auth.uid())));

create policy "members can read catalog items" on public.catalog_items for select to authenticated
using (exists (select 1 from public.company_members cm where cm.company_id = catalog_items.company_id and cm.user_id = (select auth.uid())));

create policy "members can read catalog media" on public.catalog_item_media for select to authenticated
using (exists (
  select 1 from public.catalog_items ci
  join public.company_members cm on cm.company_id = ci.company_id
  where ci.id = catalog_item_media.item_id and cm.user_id = (select auth.uid())
));

insert into storage.buckets (id, name, public)
values ('catalog-media', 'catalog-media', false)
on conflict (id) do nothing;

grant select, insert, update, delete on table public.catalog_categories to service_role;
grant select, insert, update, delete on table public.catalog_items to service_role;
grant select, insert, update, delete on table public.catalog_item_media to service_role;
