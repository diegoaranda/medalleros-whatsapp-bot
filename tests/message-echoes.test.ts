import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { normalizeWhatsAppMessageEchoes, normalizeWhatsAppMessages } from "../src/whatsapp/normalize.js";
import { processWhatsAppWebhook } from "../src/application/process-webhook.js";
import { createWebhookHandler } from "../api/webhook.js";
import type { AutomationRepository, ChannelAdapter, IngestedMessageContext } from "../src/core/types.js";
import type { IntakeAutomationGateway } from "../src/flows/intake-runner.js";

function payload(echoes: unknown[]) {
  return { object: "whatsapp_business_account", entry: [{ id: "waba-1", changes: [{
    field: "smb_message_echoes",
    value: { metadata: { phone_number_id: "414146038441176", display_phone_number: "59167889020" }, message_echoes: echoes }
  }] }] };
}

function textEcho(overrides: Record<string, unknown> = {}) {
  return {
    from: "59167889020", to: "59170000001", id: "wamid.echo", timestamp: "1790553600",
    type: "text", text: { body: "Confirmado, llevará el nombre ANA" }, ...overrides
  };
}

function dependencies() {
  const context: IngestedMessageContext = {
    duplicate: false, companyId: "company-1", channelId: "channel-1", contactId: "contact-1",
    conversationId: "conversation-1", automationStatus: "active", channelExternalId: "414146038441176",
    channelCredentialEnvKey: "WHATSAPP_ACCESS_TOKEN", senderExternalId: "59170000001"
  };
  const repository: AutomationRepository = {
    ingestInboundMessage: vi.fn().mockResolvedValue(context),
    findWaitingExecution: vi.fn().mockResolvedValue(null),
    updateExecution: vi.fn(), setAutomationPaused: vi.fn()
  };
  const adapter: ChannelAdapter = { sendText: vi.fn(), sendImage: vi.fn(), sendInteractive: vi.fn() };
  const intakeGateway: IntakeAutomationGateway = {
    getFlowConfig: vi.fn().mockResolvedValue(null), getActiveFaqs: vi.fn(), getCatalogSports: vi.fn(),
    getLatestExecution: vi.fn(), createExecution: vi.fn(), updateExecution: vi.fn(),
    pauseConversation: vi.fn(), resumeConversation: vi.fn()
  };
  return { repository, adapter, intakeGateway, echoRepository: { ingestOutboundMessage: vi.fn().mockResolvedValue({ duplicate: false }) } };
}

describe("WhatsApp Business message echoes", () => {
  it("uses to (not the business from/profile), preserves text, timestamp and reply context", () => {
    const echo = textEcho({ context: { id: "wamid.question", from: "59170000001" } });
    expect(normalizeWhatsAppMessageEchoes(payload([echo]))).toEqual([{
      provider: "whatsapp", channelExternalId: "414146038441176", recipientExternalId: "59170000001",
      externalMessageId: "wamid.echo", timestamp: "2026-09-28T00:00:00.000Z", type: "text",
      text: "Confirmado, llevará el nombre ANA", content: echo
    }]);
    expect(normalizeWhatsAppMessages(payload([echo]))).toEqual([]);
  });

  it("accepts numeric timestamps and canonicalizes a recipient's optional plus sign", () => {
    expect(normalizeWhatsAppMessageEchoes(payload([textEcho({ to: "+59170000001", timestamp: 1790553600 })]))[0])
      .toMatchObject({ recipientExternalId: "59170000001", timestamp: "2026-09-28T00:00:00.000Z" });
  });

  it.each([
    ["image", { id: "media-image", caption: "Diseño aprobado", mime_type: "image/jpeg", sha256: "hash" }],
    ["document", { id: "media-document", filename: "diseno.pdf", mime_type: "application/pdf" }],
    ["edit", { original_message_id: "wamid.original", message: { type: "text", text: { body: "Corrección" } } }],
    ["revoke", { original_message_id: "wamid.original" }]
  ])("retains %s payloads without inventing text or fetching media", (type, content) => {
    const echo = { from: "59167889020", to: "59170000001", id: `wamid.${type}`, timestamp: "1790553600", type, [type]: content };
    const [message] = normalizeWhatsAppMessageEchoes(payload([echo]));
    expect(message.content).toEqual(echo);
    expect(message.text).toBeUndefined();
  });

  it("leaves absent text/context absent", () => {
    const [message] = normalizeWhatsAppMessageEchoes(payload([textEcho({ text: undefined })]));
    expect(message.text).toBeUndefined();
    expect(message.content).not.toHaveProperty("context");
  });

  it.each([
    { to: undefined }, { to: "" }, { id: undefined }, { type: undefined },
    { timestamp: undefined }, { timestamp: "" }, { timestamp: "invalid" },
    { timestamp: "99999999999999999" }, { timestamp: -1 }
  ])("skips an invalid echo without dropping the valid sibling: %j", (invalid) => {
    const messages = normalizeWhatsAppMessageEchoes(payload([null, textEcho(invalid), textEcho({ id: "wamid.valid" })]));
    expect(messages.map((message) => message.externalMessageId)).toEqual(["wamid.valid"]);
  });

  it.each([null, {}, { entry: [null] }, { entry: [{ changes: [{ field: "smb_message_echoes", value: {} }] }] }])
    ("ignores malformed envelopes: %j", (input) => expect(normalizeWhatsAppMessageEchoes(input)).toEqual([]));

  it("handles multiple entries/changes/echoes", () => {
    const input = payload([textEcho(), textEcho({ id: "wamid.2" })]);
    input.entry.push(...payload([textEcho({ id: "wamid.3" })]).entry);
    expect(normalizeWhatsAppMessageEchoes(input)).toHaveLength(3);
  });

  it("persists echoes without invoking inbound ingestion, flows, AI or reply adapters", async () => {
    const deps = dependencies();
    const complete = vi.fn();
    await processWhatsAppWebhook(payload([textEcho()]), {
      ...deps, intakeAi: { config: { apiKey: "test", model: "test", minConfidence: 0.8, timeoutMs: 1000 }, client: { complete } }
    });
    expect(deps.echoRepository.ingestOutboundMessage).toHaveBeenCalledOnce();
    expect(deps.repository.ingestInboundMessage).not.toHaveBeenCalled();
    expect(deps.repository.findWaitingExecution).not.toHaveBeenCalled();
    expect(deps.repository.setAutomationPaused).not.toHaveBeenCalled();
    expect(deps.intakeGateway.getFlowConfig).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(deps.adapter.sendText).not.toHaveBeenCalled();
    expect(deps.adapter.sendImage).not.toHaveBeenCalled();
    expect(deps.adapter.sendInteractive).not.toHaveBeenCalled();
  });

  it("still processes inbound in a mixed payload, even if an echo fails", async () => {
    const deps = dependencies();
    deps.echoRepository.ingestOutboundMessage.mockRejectedValueOnce(new Error("test failure"));
    const input = { entry: [{ changes: [
      ...payload([textEcho(), textEcho({ id: "wamid.second" })]).entry[0].changes,
      { field: "messages", value: { metadata: { phone_number_id: "414146038441176" }, messages: [{ from: "59170000001", id: "wamid.in", timestamp: "1790553600", type: "text", text: { body: "Hola" } }] } }
    ] }] };
    await processWhatsAppWebhook(input, deps);
    expect(deps.echoRepository.ingestOutboundMessage).toHaveBeenCalledTimes(2);
    expect(deps.repository.ingestInboundMessage).toHaveBeenCalledWith(expect.objectContaining({ senderExternalId: "59170000001", text: "Hola" }));
    expect(deps.intakeGateway.getFlowConfig).toHaveBeenCalledOnce();
  });

  it("accepts a signed echo through POST /api/webhook and persists it without replies", async () => {
    const deps = dependencies();
    const secret = "echo-test-secret";
    vi.stubEnv("META_APP_SECRET", secret);
    try {
      const body = JSON.stringify(payload([textEcho()]));
      const deferred: Promise<unknown>[] = [];
      const handler = createWebhookHandler({ processPayload: (input) => processWhatsAppWebhook(input, deps), defer: (work) => deferred.push(work) });
      const request = Object.assign(Readable.from([Buffer.from(body)]), {
        method: "POST", headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` }
      });
      const response = { status: vi.fn().mockReturnThis(), send: vi.fn() };
      await handler(request as never, response as never);
      await Promise.all(deferred);
      expect(response.status).toHaveBeenCalledWith(200);
      expect(deps.echoRepository.ingestOutboundMessage).toHaveBeenCalledOnce();
      expect(deps.adapter.sendText).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
});
