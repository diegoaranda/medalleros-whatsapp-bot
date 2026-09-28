create extension if not exists pgcrypto;

create type public.channel_provider as enum ('whatsapp');
create type public.channel_status as enum ('active', 'disabled');
create type public.conversation_status as enum ('open', 'closed');
create type public.automation_status as enum ('active', 'paused_human');
create type public.message_direction as enum ('inbound', 'outbound');
create type public.flow_status as enum ('draft', 'active', 'archived');
create type public.flow_execution_status as enum ('running', 'waiting_reply', 'completed', 'paused_human', 'failed');

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.company_members (
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (company_id, user_id)
);

create table public.channels (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  provider public.channel_provider not null,
  external_id text not null,
  waba_id text,
  display_name text,
  status public.channel_status not null default 'active',
  credential_env_key text not null default 'WHATSAPP_ACCESS_TOKEN',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, external_id),
  unique (id, company_id)
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  channel_id uuid not null,
  external_id text not null,
  display_name text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (channel_id, company_id) references public.channels(id, company_id) on delete cascade,
  unique (company_id, channel_id, external_id),
  unique (id, company_id),
  unique (id, company_id, channel_id)
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  channel_id uuid not null,
  contact_id uuid not null,
  status public.conversation_status not null default 'open',
  automation_status public.automation_status not null default 'active',
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (channel_id, company_id) references public.channels(id, company_id) on delete cascade,
  foreign key (contact_id, company_id, channel_id) references public.contacts(id, company_id, channel_id) on delete cascade,
  unique (company_id, channel_id, contact_id),
  unique (id, company_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  channel_id uuid not null,
  conversation_id uuid not null,
  contact_id uuid not null,
  direction public.message_direction not null,
  external_message_id text not null,
  message_type text not null,
  text_body text,
  content jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (channel_id, company_id) references public.channels(id, company_id) on delete cascade,
  foreign key (conversation_id, company_id) references public.conversations(id, company_id) on delete cascade,
  foreign key (contact_id, company_id, channel_id) references public.contacts(id, company_id, channel_id) on delete cascade,
  unique (channel_id, external_message_id)
);

create table public.flows (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  status public.flow_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id)
);

create table public.flow_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  flow_id uuid not null,
  version integer not null check (version > 0),
  definition jsonb not null default '{"schema":1,"nodes":[],"edges":[]}'::jsonb,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (flow_id, company_id) references public.flows(id, company_id) on delete cascade,
  unique (flow_id, version),
  unique (id, company_id)
);

create unique index flow_versions_one_published_idx on public.flow_versions(flow_id) where published;

create table public.flow_executions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  flow_version_id uuid not null,
  conversation_id uuid not null,
  contact_id uuid not null,
  status public.flow_execution_status not null default 'running',
  current_node_id text,
  variables jsonb not null default '{}'::jsonb,
  runtime_state jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (flow_version_id, company_id) references public.flow_versions(id, company_id) on delete restrict,
  foreign key (conversation_id, company_id) references public.conversations(id, company_id) on delete cascade,
  foreign key (contact_id, company_id) references public.contacts(id, company_id) on delete cascade
);

create index company_members_user_id_idx on public.company_members(user_id);
create index channels_company_id_idx on public.channels(company_id);
create index contacts_channel_id_idx on public.contacts(channel_id);
create index contacts_company_id_idx on public.contacts(company_id);
create index conversations_channel_id_idx on public.conversations(channel_id);
create index conversations_contact_id_idx on public.conversations(contact_id);
create index conversations_company_status_idx on public.conversations(company_id, status, updated_at desc);
create index messages_company_conversation_idx on public.messages(company_id, conversation_id, occurred_at desc);
create index messages_contact_id_idx on public.messages(contact_id);
create index flows_company_id_idx on public.flows(company_id);
create index flow_versions_company_id_idx on public.flow_versions(company_id);
create index flow_executions_flow_version_id_idx on public.flow_executions(flow_version_id);
create index flow_executions_contact_id_idx on public.flow_executions(contact_id);
create index flow_executions_waiting_idx on public.flow_executions(conversation_id, started_at) where status = 'waiting_reply';

alter table public.companies enable row level security;
alter table public.company_members enable row level security;
alter table public.channels enable row level security;
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.flows enable row level security;
alter table public.flow_versions enable row level security;
alter table public.flow_executions enable row level security;

create policy "members can read their companies" on public.companies for select to authenticated
using (exists (select 1 from public.company_members cm where cm.company_id = companies.id and cm.user_id = (select auth.uid())));

create policy "members can read their memberships" on public.company_members for select to authenticated
using (user_id = (select auth.uid()));

create policy "members can read company channels" on public.channels for select to authenticated
using (exists (select 1 from public.company_members cm where cm.company_id = channels.company_id and cm.user_id = (select auth.uid())));

create policy "members can read company contacts" on public.contacts for select to authenticated
using (exists (select 1 from public.company_members cm where cm.company_id = contacts.company_id and cm.user_id = (select auth.uid())));

create policy "members can read company conversations" on public.conversations for select to authenticated
using (exists (select 1 from public.company_members cm where cm.company_id = conversations.company_id and cm.user_id = (select auth.uid())));

create policy "members can read company messages" on public.messages for select to authenticated
using (exists (select 1 from public.company_members cm where cm.company_id = messages.company_id and cm.user_id = (select auth.uid())));

create policy "members can read company flows" on public.flows for select to authenticated
using (exists (select 1 from public.company_members cm where cm.company_id = flows.company_id and cm.user_id = (select auth.uid())));

create policy "members can read company flow versions" on public.flow_versions for select to authenticated
using (exists (select 1 from public.company_members cm where cm.company_id = flow_versions.company_id and cm.user_id = (select auth.uid())));

create policy "members can read company flow executions" on public.flow_executions for select to authenticated
using (exists (select 1 from public.company_members cm where cm.company_id = flow_executions.company_id and cm.user_id = (select auth.uid())));

create or replace function public.ingest_inbound_message(
  p_provider public.channel_provider,
  p_channel_external_id text,
  p_sender_external_id text,
  p_sender_name text,
  p_external_message_id text,
  p_message_timestamp timestamptz,
  p_message_type text,
  p_text_body text,
  p_content jsonb
)
returns table (
  duplicate boolean,
  company_id uuid,
  channel_id uuid,
  contact_id uuid,
  conversation_id uuid,
  message_id uuid,
  automation_status public.automation_status,
  credential_env_key text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_channel_id uuid;
  v_contact_id uuid;
  v_conversation_id uuid;
  v_message_id uuid;
  v_automation_status public.automation_status;
  v_credential_env_key text;
begin
  select c.company_id, c.id, c.credential_env_key
    into v_company_id, v_channel_id, v_credential_env_key
  from public.channels c
  where c.provider = p_provider
    and c.external_id = p_channel_external_id
    and c.status = 'active';

  if v_channel_id is null then
    raise exception 'No active channel for provider % and external id %', p_provider, p_channel_external_id
      using errcode = 'P0002';
  end if;

  insert into public.contacts (company_id, channel_id, external_id, display_name)
  values (v_company_id, v_channel_id, p_sender_external_id, p_sender_name)
  on conflict (company_id, channel_id, external_id) do update
    set display_name = coalesce(excluded.display_name, public.contacts.display_name),
        updated_at = now()
  returning id into v_contact_id;

  insert into public.conversations (company_id, channel_id, contact_id, last_message_at)
  values (v_company_id, v_channel_id, v_contact_id, p_message_timestamp)
  on conflict (company_id, channel_id, contact_id) do nothing
  returning id, public.conversations.automation_status into v_conversation_id, v_automation_status;

  if v_conversation_id is null then
    select c.id, c.automation_status
      into v_conversation_id, v_automation_status
    from public.conversations c
    where c.company_id = v_company_id and c.channel_id = v_channel_id and c.contact_id = v_contact_id;
  end if;

  insert into public.messages (
    company_id, channel_id, conversation_id, contact_id, direction,
    external_message_id, message_type, text_body, content, occurred_at
  ) values (
    v_company_id, v_channel_id, v_conversation_id, v_contact_id, 'inbound',
    p_external_message_id, p_message_type, p_text_body, coalesce(p_content, '{}'::jsonb), p_message_timestamp
  )
  on conflict (channel_id, external_message_id) do nothing
  returning id into v_message_id;

  if v_message_id is not null then
    update public.conversations
      set last_message_at = greatest(coalesce(last_message_at, p_message_timestamp), p_message_timestamp),
          updated_at = now()
    where id = v_conversation_id;
  end if;

  return query select
    v_message_id is null,
    v_company_id,
    v_channel_id,
    v_contact_id,
    v_conversation_id,
    v_message_id,
    v_automation_status,
    v_credential_env_key;
end;
$$;

revoke all on function public.ingest_inbound_message(
  public.channel_provider, text, text, text, text, timestamptz, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.ingest_inbound_message(
  public.channel_provider, text, text, text, text, timestamptz, text, text, jsonb
) to service_role;
