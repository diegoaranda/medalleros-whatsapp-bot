-- Fase 8 (Media V1): 0..N images attachable to a FAQ, and a company-level
-- configurable template for the catalog's WhatsApp prefill text. Purely
-- additive — no existing table/column/bucket is touched.

-- New public bucket for automation media (FAQ attachments). Kept separate
-- from "catalog-media" (product photography) so the "why is this public"
-- reasoning stays scoped per bucket; images here are things like a QR code
-- or a storefront photo that are meant to be shown to the customer over
-- WhatsApp, so Meta must be able to fetch them via a plain public URL (no
-- signed-URL generation at send time).
insert into storage.buckets (id, name, public)
values ('automation-media', 'automation-media', true)
on conflict (id) do nothing;

create table public.automation_faq_media (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  faq_id uuid not null,
  storage_path text not null unique check (length(trim(storage_path)) > 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  foreign key (faq_id, company_id) references public.automation_faqs(id, company_id) on delete cascade
);

create index automation_faq_media_faq_sort_idx on public.automation_faq_media(faq_id, sort_order);

alter table public.automation_faq_media enable row level security;

create policy "members can read automation faq media" on public.automation_faq_media for select to authenticated
using (exists (
  select 1 from public.automation_faqs af
  join public.company_members cm on cm.company_id = af.company_id
  where af.id = automation_faq_media.faq_id and cm.user_id = (select auth.uid())
));

grant select, insert, update, delete on table public.automation_faq_media to service_role;

-- Company-level configurable prefill text for the catalog "Elegir" buttons.
-- Nullable: the app falls back to "Me interesa este diseño: {{code}}" when
-- empty. Must contain {{code}} to be usable; enforced in application code,
-- not a DB constraint, so an admin can save a draft without it briefly.
alter table public.companies
  add column catalog_prefill_template text;
