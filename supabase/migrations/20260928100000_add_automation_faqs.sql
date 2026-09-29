-- Administrable FAQ layer for the automation, mirroring the catalog
-- categories/aliases pattern. FAQs are transversal over the intake state
-- machine (not a node in it): the runner checks them before advancing the
-- state, and they never trigger HUMAN_HANDOFF or reset a session.
create table public.automation_faqs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  flow_id uuid not null,
  title text not null check (length(trim(title)) > 0),
  answer text not null check (length(trim(answer)) > 0),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (flow_id, company_id) references public.flows(id, company_id) on delete cascade,
  unique (id, company_id)
);

create table public.automation_faq_aliases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  faq_id uuid not null,
  alias text not null check (length(trim(alias)) > 0),
  alias_normalized text not null check (length(trim(alias_normalized)) > 0),
  created_at timestamptz not null default now(),
  foreign key (faq_id, company_id) references public.automation_faqs(id, company_id) on delete cascade,
  unique (company_id, alias_normalized)
);

create index automation_faqs_flow_sort_idx on public.automation_faqs(flow_id, sort_order);
create index automation_faq_aliases_faq_idx on public.automation_faq_aliases(faq_id);

alter table public.automation_faqs enable row level security;
alter table public.automation_faq_aliases enable row level security;

create policy "members can read automation faqs" on public.automation_faqs for select to authenticated
using (exists (select 1 from public.company_members cm where cm.company_id = automation_faqs.company_id and cm.user_id = (select auth.uid())));

create policy "members can read automation faq aliases" on public.automation_faq_aliases for select to authenticated
using (exists (
  select 1 from public.automation_faqs af
  join public.company_members cm on cm.company_id = af.company_id
  where af.id = automation_faq_aliases.faq_id and cm.user_id = (select auth.uid())
));

grant select, insert, update, delete on table public.automation_faqs to service_role;
grant select, insert, delete on table public.automation_faq_aliases to service_role;
