export type ChannelProvider = "whatsapp";
export type AutomationStatus = "active" | "paused_human";
export type FlowExecutionStatus = "running" | "waiting_reply" | "completed" | "paused_human" | "failed";

export interface NormalizedInboundMessage {
  provider: ChannelProvider;
  channelExternalId: string;
  senderExternalId: string;
  externalMessageId: string;
  timestamp: string;
  type: string;
  text?: string;
  senderName?: string;
  content: Record<string, unknown>;
}

export interface IngestedMessageContext {
  duplicate: boolean;
  companyId: string;
  channelId: string;
  contactId: string;
  conversationId: string;
  messageId?: string;
  automationStatus: AutomationStatus;
  channelExternalId: string;
  channelCredentialEnvKey: string;
  senderExternalId: string;
  /** conversations.last_message_at as it was BEFORE this inbound message was
   * ingested, i.e. the timestamp of the conversation's prior activity.
   * Undefined/null when this is the conversation's first ever message. */
  previousLastMessageAt?: string | null;
}

export type OutboundAction =
  | { type: "send_text"; text: string }
  | { type: "send_image"; imageUrl: string; caption?: string }
  | { type: "send_interactive"; interactive: Record<string, unknown> };

export interface FlowExecution {
  id: string;
  companyId: string;
  conversationId: string;
  status: FlowExecutionStatus;
  runtimeState: {
    on_reply?: OutboundAction;
    resume_status?: "running" | "waiting_reply";
    [key: string]: unknown;
  };
}

export interface ExecutionUpdate {
  status: FlowExecutionStatus;
  runtimeState?: FlowExecution["runtimeState"];
  error?: string | null;
  completedAt?: string | null;
}

export interface AutomationRepository {
  ingestInboundMessage(message: NormalizedInboundMessage): Promise<IngestedMessageContext>;
  findWaitingExecution(conversationId: string): Promise<FlowExecution | null>;
  updateExecution(executionId: string, update: ExecutionUpdate): Promise<void>;
  setAutomationPaused(conversationId: string, paused: boolean): Promise<void>;
}

export interface OutboundTarget {
  channelExternalId: string;
  credentialEnvKey: string;
  recipientExternalId: string;
}

export interface ChannelAdapter {
  sendText(target: OutboundTarget, text: string): Promise<string>;
  sendImage(target: OutboundTarget, imageUrl: string, caption?: string): Promise<string>;
  sendInteractive(target: OutboundTarget, interactive: Record<string, unknown>): Promise<string>;
}
