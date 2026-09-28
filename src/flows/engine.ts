import type { AutomationRepository, ChannelAdapter, IngestedMessageContext, NormalizedInboundMessage, OutboundAction } from "../core/types.js";

export class FlowEngine {
  constructor(
    private readonly repository: AutomationRepository,
    private readonly adapter: ChannelAdapter
  ) {}

  async handleInbound(message: NormalizedInboundMessage, context: IngestedMessageContext): Promise<void> {
    if (context.duplicate || context.automationStatus === "paused_human") return;

    const execution = await this.repository.findWaitingExecution(context.conversationId);
    if (!execution) return;

    const runtimeState = { ...execution.runtimeState, inbound_message_id: context.messageId };
    await this.repository.updateExecution(execution.id, { status: "running", runtimeState, error: null });

    try {
      if (execution.runtimeState.on_reply) {
        await this.executeAction(execution.runtimeState.on_reply, context);
      }
      await this.repository.updateExecution(execution.id, {
        status: "completed",
        runtimeState,
        completedAt: new Date().toISOString(),
        error: null
      });
    } catch (error) {
      await this.repository.updateExecution(execution.id, {
        status: "failed",
        runtimeState,
        error: error instanceof Error ? error.message : "Unknown flow execution error"
      });
      throw error;
    }
  }

  private async executeAction(action: OutboundAction, context: IngestedMessageContext): Promise<string> {
    const target = {
      channelExternalId: context.channelExternalId,
      credentialEnvKey: context.channelCredentialEnvKey,
      recipientExternalId: context.senderExternalId
    };
    if (action.type === "send_text") return this.adapter.sendText(target, action.text);
    if (action.type === "send_image") return this.adapter.sendImage(target, action.imageUrl, action.caption);
    return this.adapter.sendInteractive(target, action.interactive);
  }
}

export function pauseAutomation(repository: AutomationRepository, conversationId: string): Promise<void> {
  return repository.setAutomationPaused(conversationId, true);
}

export function resumeAutomation(repository: AutomationRepository, conversationId: string): Promise<void> {
  return repository.setAutomationPaused(conversationId, false);
}
