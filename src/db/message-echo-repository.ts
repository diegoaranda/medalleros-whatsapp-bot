import type { SupabaseClient } from "@supabase/supabase-js";
import type { MessageEchoRepository, NormalizedMessageEcho } from "../core/types.js";

/** Uses existing tables/unique keys; never calls the inbound ingestion RPC. */
export class SupabaseMessageEchoRepository implements MessageEchoRepository {
  constructor(private readonly client: SupabaseClient) {}

  async ingestOutboundMessage(message: NormalizedMessageEcho): Promise<{ duplicate: boolean }> {
    const { data: channel, error: channelError } = await this.client.from("channels")
      .select("id,company_id")
      .eq("provider", message.provider)
      .eq("external_id", message.channelExternalId)
      .eq("status", "active")
      .single();
    if (channelError || !channel) throw new Error("Echo channel lookup failed: no accessible active channel");

    // Ignore conflicts instead of overwriting a known profile with missing echo data.
    const contactKey = {
      company_id: channel.company_id,
      channel_id: channel.id,
      external_id: message.recipientExternalId
    };
    const { error: contactInsertError } = await this.client.from("contacts")
      .upsert(contactKey, { onConflict: "company_id,channel_id,external_id", ignoreDuplicates: true });
    if (contactInsertError) throw new Error(`Echo contact creation failed: ${contactInsertError.message}`);

    const { data: contact, error: contactError } = await this.client.from("contacts")
      .select("id").match(contactKey).single();
    if (contactError || !contact) throw new Error("Echo contact lookup failed");

    const conversationKey = {
      company_id: channel.company_id,
      channel_id: channel.id,
      contact_id: contact.id
    };
    const { error: conversationInsertError } = await this.client.from("conversations")
      .upsert(conversationKey, { onConflict: "company_id,channel_id,contact_id", ignoreDuplicates: true });
    if (conversationInsertError) throw new Error(`Echo conversation creation failed: ${conversationInsertError.message}`);

    const { data: conversation, error: conversationError } = await this.client.from("conversations")
      .select("id").match(conversationKey).single();
    if (conversationError || !conversation) throw new Error("Echo conversation lookup failed");

    const { data: inserted, error: messageError } = await this.client.from("messages")
      .upsert({
        ...conversationKey,
        conversation_id: conversation.id,
        direction: "outbound",
        external_message_id: message.externalMessageId,
        message_type: message.type,
        text_body: message.text ?? null,
        content: message.content,
        occurred_at: message.timestamp
      }, { onConflict: "channel_id,external_message_id", ignoreDuplicates: true })
      .select("id").maybeSingle();
    if (messageError) throw new Error(`Echo message persistence failed: ${messageError.message}`);

    // The conditional update cannot move activity backwards, even with concurrent
    // inbound ingestion or delayed echoes. Retry deliveries also repair this step
    // if a previous attempt saved the message but failed to update activity.
    const { error: activityError } = await this.client.from("conversations")
      .update({ last_message_at: message.timestamp, updated_at: new Date().toISOString() })
      .eq("id", conversation.id)
      .eq("company_id", channel.company_id)
      .or(`last_message_at.is.null,last_message_at.lt.${message.timestamp}`);
    if (activityError) throw new Error(`Echo activity update failed: ${activityError.message}`);

    return { duplicate: !inserted };
  }
}
