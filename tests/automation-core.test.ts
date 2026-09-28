import { describe, expect, it, vi } from "vitest";
import type {
  AutomationRepository,
  ChannelAdapter,
  ExecutionUpdate,
  FlowExecution,
  IngestedMessageContext,
  NormalizedInboundMessage,
  OutboundTarget
} from "../src/core/types.js";
import { FlowEngine } from "../src/flows/engine.js";
import { processWhatsAppWebhook } from "../src/application/process-webhook.js";

const baseMessage: NormalizedInboundMessage = {
  provider: "whatsapp",
  channelExternalId: "414146038441176",
  senderExternalId: "59167889020",
  externalMessageId: "wamid.1",
  timestamp: "2026-09-28T00:00:00.000Z",
  type: "text",
  text: "Hola",
  content: { body: "Hola" }
};

function payload(id: string, timestamp = "1790553600") {
  return {
    entry: [{ changes: [{ field: "messages", value: {
      metadata: { phone_number_id: baseMessage.channelExternalId },
      contacts: [{ wa_id: baseMessage.senderExternalId, profile: { name: "Cliente" } }],
      messages: [{ from: baseMessage.senderExternalId, id, timestamp, type: "text", text: { body: "Hola" } }]
    } }] }]
  };
}

class MemoryRepository implements AutomationRepository {
  readonly messageIds = new Set<string>();
  readonly conversations = new Map<string, { id: string; lastMessageAt: string }>();
  execution: FlowExecution | null = null;
  updates: ExecutionUpdate[] = [];
  automationStatus: IngestedMessageContext["automationStatus"] = "active";

  async ingestInboundMessage(message: NormalizedInboundMessage): Promise<IngestedMessageContext> {
    const duplicate = this.messageIds.has(message.externalMessageId);
    this.messageIds.add(message.externalMessageId);
    const key = `${message.channelExternalId}:${message.senderExternalId}`;
    const current = this.conversations.get(key);
    if (!current) this.conversations.set(key, { id: "conversation-1", lastMessageAt: message.timestamp });
    else if (!duplicate) current.lastMessageAt = message.timestamp;
    return {
      duplicate,
      companyId: "company-1",
      channelId: "channel-1",
      contactId: "contact-1",
      conversationId: "conversation-1",
      messageId: duplicate ? undefined : message.externalMessageId,
      automationStatus: this.automationStatus,
      channelExternalId: message.channelExternalId,
      channelCredentialEnvKey: "WHATSAPP_ACCESS_TOKEN",
      senderExternalId: message.senderExternalId
    };
  }

  async findWaitingExecution(): Promise<FlowExecution | null> { return this.execution; }
  async updateExecution(_id: string, update: ExecutionUpdate): Promise<void> { this.updates.push(update); }
  async setAutomationPaused(_conversationId: string, paused: boolean): Promise<void> {
    this.automationStatus = paused ? "paused_human" : "active";
  }
}

function adapterMock(): ChannelAdapter & { sendText: ReturnType<typeof vi.fn> } {
  return {
    sendText: vi.fn(async (_target: OutboundTarget, _text: string) => "wamid.out"),
    sendImage: vi.fn(async () => "wamid.out"),
    sendInteractive: vi.fn(async () => "wamid.out")
  };
}

describe("automation core", () => {
  it("deduplicates the same WhatsApp message id before automation", async () => {
    const repository = new MemoryRepository();
    repository.execution = {
      id: "execution-1", companyId: "company-1", conversationId: "conversation-1",
      status: "waiting_reply", runtimeState: { on_reply: { type: "send_text", text: "Respuesta" } }
    };
    const adapter = adapterMock();
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    await processWhatsAppWebhook(payload("wamid.same"), { repository, adapter });
    await processWhatsAppWebhook(payload("wamid.same"), { repository, adapter });

    expect(repository.messageIds.size).toBe(1);
    expect(adapter.sendText).toHaveBeenCalledTimes(1);
  });

  it("creates one conversation and updates it for later messages", async () => {
    const repository = new MemoryRepository();
    const adapter = adapterMock();
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    await processWhatsAppWebhook(payload("wamid.first", "1790553600"), { repository, adapter });
    await processWhatsAppWebhook(payload("wamid.second", "1790553660"), { repository, adapter });

    expect(repository.conversations.size).toBe(1);
    expect(repository.conversations.values().next().value?.lastMessageAt).toBe("2026-09-28T00:01:00.000Z");
  });

  it("does not send automatic replies while human takeover is active", async () => {
    const repository = new MemoryRepository();
    repository.execution = {
      id: "execution-1", companyId: "company-1", conversationId: "conversation-1",
      status: "waiting_reply", runtimeState: { on_reply: { type: "send_text", text: "No enviar" } }
    };
    const adapter = adapterMock();
    const engine = new FlowEngine(repository, adapter);
    const context = await repository.ingestInboundMessage(baseMessage);
    context.automationStatus = "paused_human";

    await engine.handleInbound(baseMessage, context);

    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(repository.updates).toEqual([]);
  });
});
