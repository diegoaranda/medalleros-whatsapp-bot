-- Per-sport aliases/synonyms so the automation's sport resolution is fully
-- dynamic: any category (existing or future) can carry its own aliases,
-- editable from the Catálogo admin, with no hardcoded sport list anywhere in
-- the flow engine. alias_normalized (accent/case-insensitive) backs both the
-- uniqueness guarantee and runtime matching.
create table public.catalog_category_aliases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  category_id uuid not null,
  alias text not null check (length(trim(alias)) > 0),
  alias_normalized text not null check (length(trim(alias_normalized)) > 0),
  created_at timestamptz not null default now(),
  foreign key (category_id, company_id) references public.catalog_categories(id, company_id) on delete cascade,
  unique (company_id, alias_normalized)
);

create index catalog_category_aliases_category_idx on public.catalog_category_aliases(category_id);

alter table public.catalog_category_aliases enable row level security;

create policy "members can read catalog category aliases" on public.catalog_category_aliases for select to authenticated
using (exists (
  select 1 from public.catalog_categories cc
  join public.company_members cm on cm.company_id = cc.company_id
  where cc.id = catalog_category_aliases.category_id and cm.user_id = (select auth.uid())
));

grant select, insert, delete on table public.catalog_category_aliases to service_role;
