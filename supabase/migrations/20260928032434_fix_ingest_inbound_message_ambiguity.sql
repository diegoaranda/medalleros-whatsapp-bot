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
  select ch.company_id, ch.id, ch.credential_env_key
    into v_company_id, v_channel_id, v_credential_env_key
  from public.channels as ch
  where ch.provider = p_provider
    and ch.external_id = p_channel_external_id
    and ch.status = 'active';

  if v_channel_id is null then
    raise exception 'No active channel for provider % and external id %', p_provider, p_channel_external_id
      using errcode = 'P0002';
  end if;

  insert into public.contacts as ct (company_id, channel_id, external_id, display_name)
  values (v_company_id, v_channel_id, p_sender_external_id, p_sender_name)
  on conflict on constraint contacts_company_id_channel_id_external_id_key do update
    set display_name = coalesce(excluded.display_name, ct.display_name),
        updated_at = now()
  returning ct.id into v_contact_id;

  insert into public.conversations as cv (company_id, channel_id, contact_id, last_message_at)
  values (v_company_id, v_channel_id, v_contact_id, p_message_timestamp)
  on conflict on constraint conversations_company_id_channel_id_contact_id_key do nothing
  returning cv.id, cv.automation_status into v_conversation_id, v_automation_status;

  if v_conversation_id is null then
    select cv.id, cv.automation_status
      into v_conversation_id, v_automation_status
    from public.conversations as cv
    where cv.company_id = v_company_id
      and cv.channel_id = v_channel_id
      and cv.contact_id = v_contact_id;
  end if;

  insert into public.messages as msg (
    company_id, channel_id, conversation_id, contact_id, direction,
    external_message_id, message_type, text_body, content, occurred_at
  ) values (
    v_company_id, v_channel_id, v_conversation_id, v_contact_id, 'inbound',
    p_external_message_id, p_message_type, p_text_body, coalesce(p_content, '{}'::jsonb), p_message_timestamp
  )
  on conflict on constraint messages_channel_id_external_message_id_key do nothing
  returning msg.id into v_message_id;

  if v_message_id is not null then
    update public.conversations as cv
      set last_message_at = greatest(coalesce(cv.last_message_at, p_message_timestamp), p_message_timestamp),
          updated_at = now()
    where cv.id = v_conversation_id;
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
