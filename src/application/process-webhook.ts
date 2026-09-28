import { SupabaseAutomationRepository } from "../db/automation-repository.js";
import { getSupabaseAdmin } from "../db/supabase.js";
import { FlowEngine } from "../flows/engine.js";
import { WhatsAppCloudAdapter } from "../whatsapp/adapter.js";
import { normalizeWhatsAppMessages } from "../whatsapp/normalize.js";
import type { AutomationRepository, ChannelAdapter } from "../core/types.js";

export async function processWhatsAppWebhook(
  payload: unknown,
  dependencies?: { repository: AutomationRepository; adapter: ChannelAdapter }
): Promise<void> {
  const repository = dependencies?.repository ?? new SupabaseAutomationRepository(getSupabaseAdmin());
  const adapter = dependencies?.adapter ?? new WhatsAppCloudAdapter();
  const engine = new FlowEngine(repository, adapter);

  for (const message of normalizeWhatsAppMessages(payload)) {
    try {
      const context = await repository.ingestInboundMessage(message);
      console.info("whatsapp_message_received", {
        phone_number_id: message.channelExternalId,
        wa_id: message.senderExternalId,
        message_id: message.externalMessageId,
        timestamp: message.timestamp,
        type: message.type,
        duplicate: context.duplicate
      });
      await engine.handleInbound(message, context);
    } catch (error) {
      console.error("whatsapp_message_processing_failed", {
        phone_number_id: message.channelExternalId,
        message_id: message.externalMessageId,
        error: error instanceof Error ? error.message : "Unknown processing error"
      });
    }
  }
}
