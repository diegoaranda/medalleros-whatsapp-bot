import { loadIntentClassifierConfigFromEnv, OpenAiCompletionClient } from "../ai/intent-classifier.js";
import { SupabaseAutomationRepository } from "../db/automation-repository.js";
import { SupabaseMessageEchoRepository } from "../db/message-echo-repository.js";
import { SupabaseIntakeAutomationGateway } from "../db/intake-automation-gateway.js";
import { getSupabaseAdmin } from "../db/supabase.js";
import { FlowEngine } from "../flows/engine.js";
import { runWhatsAppIntakeAutomation, type IntakeAiOptions, type IntakeAutomationGateway } from "../flows/intake-runner.js";
import { WhatsAppCloudAdapter } from "../whatsapp/adapter.js";
import { normalizeWhatsAppMessages, normalizeWhatsAppMessageEchoes } from "../whatsapp/normalize.js";
import type { AutomationRepository, ChannelAdapter, MessageEchoRepository } from "../core/types.js";

/** Undefined (the default) when OPENAI_API_KEY isn't configured, so the
 * automation makes zero OpenAI calls until it's explicitly set up. */
function defaultIntakeAi(): IntakeAiOptions | undefined {
  const config = loadIntentClassifierConfigFromEnv();
  return config ? { config, client: new OpenAiCompletionClient() } : undefined;
}

export async function processWhatsAppWebhook(
  payload: unknown,
  dependencies?: { repository: AutomationRepository; adapter: ChannelAdapter; intakeGateway?: IntakeAutomationGateway; intakeAi?: IntakeAiOptions; echoRepository?: MessageEchoRepository }
): Promise<void> {
  const echoes = normalizeWhatsAppMessageEchoes(payload);
  if (echoes.length > 0) {
    const echoRepository = dependencies?.echoRepository ?? new SupabaseMessageEchoRepository(getSupabaseAdmin());
    for (const echo of echoes) {
      try {
        const result = await echoRepository.ingestOutboundMessage(echo);
        console.info("whatsapp_message_echo_received", {
          phone_number_id: echo.channelExternalId,
          message_id: echo.externalMessageId,
          type: echo.type,
          duplicate: result.duplicate
        });
      } catch (error) {
        console.error("whatsapp_message_echo_processing_failed", {
          phone_number_id: echo.channelExternalId,
          message_id: echo.externalMessageId,
          error: error instanceof Error ? error.message : "Unknown echo processing error"
        });
      }
    }
  }

  const inboundMessages = normalizeWhatsAppMessages(payload);
  if (inboundMessages.length === 0) return;
  const repository = dependencies?.repository ?? new SupabaseAutomationRepository(getSupabaseAdmin());
  const adapter = dependencies?.adapter ?? new WhatsAppCloudAdapter();
  const intakeGateway = dependencies?.intakeGateway ?? new SupabaseIntakeAutomationGateway(getSupabaseAdmin());
  const intakeAi = dependencies?.intakeAi ?? defaultIntakeAi();
  const engine = new FlowEngine(repository, adapter);

  for (const message of inboundMessages) {
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
      await runWhatsAppIntakeAutomation(intakeGateway, adapter, message, context, intakeAi);
    } catch (error) {
      console.error("whatsapp_message_processing_failed", {
        phone_number_id: message.channelExternalId,
        message_id: message.externalMessageId,
        error: error instanceof Error ? error.message : "Unknown processing error"
      });
    }
  }
}
