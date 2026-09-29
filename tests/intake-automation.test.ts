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
import type { ClassifierCompletionClient, ClassifierCompletionRequest, IntentClassifierConfig } from "../src/ai/intent-classifier.js";
import type { IntakeAiOptions, IntakeAutomationGateway, IntakeExecution, IntakeExecutionStatus } from "../src/flows/intake-runner.js";
import type { AutomationFaq } from "../src/flows/automation-faq.js";
import type { CatalogSport, IntakeMessages, IntakeState, IntakeVariables } from "../src/flows/whatsapp-intake.js";
import { DEFAULT_INTAKE_MESSAGES } from "../src/flows/whatsapp-intake.js";
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

const BASE_UNIX_SECONDS = 1790553600;

function payload(id: string, text: string, unixSeconds: number = BASE_UNIX_SECONDS) {
  return {
    entry: [{ changes: [{ field: "messages", value: {
      metadata: { phone_number_id: baseMessage.channelExternalId },
      contacts: [{ wa_id: baseMessage.senderExternalId, profile: { name: "Cliente" } }],
      messages: [{ from: baseMessage.senderExternalId, id, timestamp: String(unixSeconds), type: "text", text: { body: text } }]
    } }] }]
  };
}

const sports: CatalogSport[] = [
  { slug: "running", name: "Running", codes: ["RUN-01", "RUN-08"], aliases: ["runner", "runer", "correr"], catalogUrl: "https://medalleros-whatsapp-bot.vercel.app/catalogo/running" }
];

/** In-memory stand-in for the ingest RPC, mirroring what Fase 1's real
 * ingest_inbound_message() does: dedupes by external message id and reuses
 * one conversation per contact. */
class MemoryRepository implements AutomationRepository {
  readonly messageIds = new Set<string>();
  conversationId = "conversation-1";
  automationStatus: IngestedMessageContext["automationStatus"] = "active";
  /** Mirrors conversations.last_message_at: only advances for non-duplicate
   * inbound messages, exactly like the real ingest RPC. */
  lastMessageAt: string | undefined;

  async ingestInboundMessage(message: NormalizedInboundMessage): Promise<IngestedMessageContext> {
    const duplicate = this.messageIds.has(message.externalMessageId);
    this.messageIds.add(message.externalMessageId);
    const previousLastMessageAt = this.lastMessageAt;
    if (!duplicate) this.lastMessageAt = message.timestamp;
    return {
      duplicate,
      companyId: "company-1",
      channelId: "channel-1",
      contactId: "contact-1",
      conversationId: this.conversationId,
      messageId: duplicate ? undefined : message.externalMessageId,
      automationStatus: this.automationStatus,
      channelExternalId: message.channelExternalId,
      channelCredentialEnvKey: "WHATSAPP_ACCESS_TOKEN",
      senderExternalId: message.senderExternalId,
      previousLastMessageAt
    };
  }

  async findWaitingExecution(): Promise<FlowExecution | null> { return null; }
  async updateExecution(_id: string, _update: ExecutionUpdate): Promise<void> {}
  async setAutomationPaused(_conversationId: string, paused: boolean): Promise<void> {
    this.automationStatus = paused ? "paused_human" : "active";
  }
}

/** In-memory stand-in for SupabaseIntakeAutomationGateway. Takes the same
 * MemoryRepository instance so pauseConversation/resumeConversation flip the
 * exact automationStatus flag ingestInboundMessage reads next time, just
 * like production where both operate on the same conversations row. */
class FakeIntakeGateway implements IntakeAutomationGateway {
  active = true;
  messages: IntakeMessages = DEFAULT_INTAKE_MESSAGES;
  sports: CatalogSport[] = sports;
  imageIdByCode = new Map<string, string>([["RUN-08", "image-run-08"]]);
  failConfig = false;
  private executions = new Map<string, IntakeExecution>();
  private nextId = 1;
  readonly pausedConversations: string[] = [];
  readonly resumedConversations: string[] = [];

  constructor(private readonly repository: MemoryRepository) {}

  /** active is not part of AutomationFaq itself (filtering already happened
   * by the time resolveFaq sees them); the fake keeps it alongside to mirror
   * how the real gateway filters at the DB query level. */
  faqs: (AutomationFaq & { active?: boolean })[] = [];

  async getFlowConfig(_companyId: string) {
    if (this.failConfig) throw new Error("simulated configuration read failure");
    if (!this.active) return { flowId: "flow-1", flowVersionId: "version-1", active: false, messages: this.messages };
    return { flowId: "flow-1", flowVersionId: "version-1", active: true, messages: this.messages };
  }

  async getActiveFaqs(_companyId: string, _flowId: string) {
    return this.faqs.filter((faq) => faq.active !== false);
  }

  async getCatalogSports(_companyId: string) {
    return { sports: this.sports, imageIdByCode: this.imageIdByCode };
  }

  async getLatestExecution(_flowVersionId: string, conversationId: string) {
    return this.executions.get(conversationId) ?? null;
  }

  async createExecution(params: { conversationId: string; status: IntakeExecutionStatus; state: IntakeState; variables: IntakeVariables }) {
    const id = `execution-${this.nextId++}`;
    this.executions.set(params.conversationId, { id, status: params.status, state: params.state, variables: params.variables });
  }

  async updateExecution(id: string, params: { status: IntakeExecutionStatus; state: IntakeState; variables: IntakeVariables }) {
    for (const [conversationId, execution] of this.executions) {
      if (execution.id === id) {
        this.executions.set(conversationId, { id, status: params.status, state: params.state, variables: params.variables });
      }
    }
  }

  async pauseConversation(conversationId: string) {
    this.pausedConversations.push(conversationId);
    await this.repository.setAutomationPaused(conversationId, true);
  }

  async resumeConversation(conversationId: string) {
    this.resumedConversations.push(conversationId);
    await this.repository.setAutomationPaused(conversationId, false);
  }

  executionFor(conversationId: string) {
    return this.executions.get(conversationId) ?? null;
  }
}

function adapterMock(): ChannelAdapter & { sendText: ReturnType<typeof vi.fn> } {
  return {
    sendText: vi.fn(async (_target: OutboundTarget, _text: string) => "wamid.out"),
    sendImage: vi.fn(async () => "wamid.out"),
    sendInteractive: vi.fn(async () => "wamid.out")
  };
}

describe("whatsapp intake automation integration", () => {
  it("A. inactive automation: saves the message but sends zero replies", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.active = false;
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola"), { repository, adapter, intakeGateway: gateway });

    expect(repository.messageIds.has("wamid.1")).toBe(true);
    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(gateway.executionFor("conversation-1")).toBeNull();
  });

  it("B. active automation: Hola produces exactly one reply and moves to WAITING_FOR_SPORT", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola"), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText).toHaveBeenCalledTimes(1);
    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SPORT");
  });

  it("C. state persists across separate inbound messages: Hola -> runer -> WAITING_FOR_SELECTION with the catalog URL", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola"), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "runer"), { repository, adapter, intakeGateway: gateway });

    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SELECTION");
    const secondReply = adapter.sendText.mock.calls[1]?.[1] as string;
    expect(secondReply).toContain("/catalogo/running");
  });

  it("D. selecting a design reaches HUMAN_HANDOFF and persists the selection", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola"), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "runer"), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.3", "Hola, me interesa el diseño RUN-08"), { repository, adapter, intakeGateway: gateway });

    const execution = gateway.executionFor("conversation-1");
    expect(execution?.state).toBe("HUMAN_HANDOFF");
    expect(execution?.status).toBe("completed");
    expect(execution?.variables.selectedCode).toBe("RUN-08");
    expect(execution?.variables.imageId).toBe("image-run-08");
    expect(gateway.pausedConversations).toContain("conversation-1");
  });

  it("E. after handoff, further messages get zero automated replies", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola"), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "runer"), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.3", "Hola, me interesa el diseño RUN-08"), { repository, adapter, intakeGateway: gateway });
    // Handoff already marked the conversation paused_human via the gateway
    // (same table the real ingest RPC reads), well within the 48h window.
    expect(repository.automationStatus).toBe("paused_human");

    const callsBefore = adapter.sendText.mock.calls.length;
    await processWhatsAppWebhook(payload("wamid.4", "hola de nuevo"), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls.length).toBe(callsBefore);
  });

  it("F. a duplicated webhook delivery never runs the automation twice", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola"), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.1", "Hola"), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText).toHaveBeenCalledTimes(1);
    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SPORT");
  });

  it("G. a configuration read failure fails closed: zero replies, no throw", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.failConfig = true;
    const adapter = adapterMock();

    await expect(processWhatsAppWebhook(payload("wamid.1", "Hola"), { repository, adapter, intakeGateway: gateway })).resolves.toBeUndefined();

    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(repository.messageIds.has("wamid.1")).toBe(true);
  });
});

describe("HUMAN_HANDOFF auto-expiry (48h of conversation inactivity)", () => {
  const HANDOFF_AT = BASE_UNIX_SECONDS + 120; // "Hola" at +0s, "runer" at +60s, selection at +120s

  async function reachHandoff(repository: MemoryRepository, gateway: FakeIntakeGateway, adapter: ChannelAdapter & { sendText: ReturnType<typeof vi.fn> }) {
    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "runer", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.3", "Hola, me interesa el diseño RUN-08", HANDOFF_AT), { repository, adapter, intakeGateway: gateway });
    expect(gateway.executionFor("conversation-1")?.state).toBe("HUMAN_HANDOFF");
  }

  it("A. still paused after 10h of inactivity: zero replies, stays paused_human", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    await reachHandoff(repository, gateway, adapter);

    const callsBefore = adapter.sendText.mock.calls.length;
    await processWhatsAppWebhook(payload("wamid.4", "hola", HANDOFF_AT + 10 * 3600), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls.length).toBe(callsBefore);
    expect(repository.automationStatus).toBe("paused_human");
    expect(gateway.executionFor("conversation-1")?.state).toBe("HUMAN_HANDOFF");
  });

  it("B. still paused at 47h59m: zero replies", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    await reachHandoff(repository, gateway, adapter);

    const callsBefore = adapter.sendText.mock.calls.length;
    await processWhatsAppWebhook(payload("wamid.4", "hola", HANDOFF_AT + 47 * 3600 + 59 * 60), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls.length).toBe(callsBefore);
    expect(repository.automationStatus).toBe("paused_human");
  });

  it("C. at 48h+ of inactivity: starts a new session and processes the inbound message", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    await reachHandoff(repository, gateway, adapter);

    const callsBefore = adapter.sendText.mock.calls.length;
    await processWhatsAppWebhook(payload("wamid.4", "Hola", HANDOFF_AT + 48 * 3600), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls.length).toBe(callsBefore + 1); // the fresh greeting reply
    expect(repository.automationStatus).toBe("active");
    expect(gateway.resumedConversations).toContain("conversation-1");
    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SPORT");
  });

  it("D. the new session does not retain the previous sport/code/imageId", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    await reachHandoff(repository, gateway, adapter);
    expect(gateway.executionFor("conversation-1")?.variables.selectedCode).toBe("RUN-08");

    await processWhatsAppWebhook(payload("wamid.4", "Hola", HANDOFF_AT + 48 * 3600), { repository, adapter, intakeGateway: gateway });

    const variables = gateway.executionFor("conversation-1")?.variables;
    expect(variables?.sportSlug).toBeUndefined();
    expect(variables?.selectedCode).toBeUndefined();
    expect(variables?.imageId).toBeUndefined();
  });

  it("E. a message during the window still counts as activity, resetting the 48h clock", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    await reachHandoff(repository, gateway, adapter);

    // +10h: within the window, no reply, but this message IS the new "last activity".
    await processWhatsAppWebhook(payload("wamid.4", "hola", HANDOFF_AT + 10 * 3600), { repository, adapter, intakeGateway: gateway });
    const callsAfterFirstSilentMessage = adapter.sendText.mock.calls.length;

    // +50h from the original handoff, but only +40h from wamid.4 -> must still stay silent.
    await processWhatsAppWebhook(payload("wamid.5", "hola", HANDOFF_AT + 50 * 3600), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls.length).toBe(callsAfterFirstSilentMessage);
    expect(repository.automationStatus).toBe("paused_human");
    expect(gateway.executionFor("conversation-1")?.state).toBe("HUMAN_HANDOFF");
  });
});

describe("FAQ layer (transversal over the state machine)", () => {
  const envioFaq = { id: "faq-envios", answer: "Sí, realizamos envíos a todo el país.", aliases: ["envio", "hacen envios"], sortOrder: 0, active: true };
  const pagoFaq = { id: "faq-pagos", answer: "Aceptamos QR, transferencia y efectivo.", aliases: ["pago", "metodos de pago"], sortOrder: 1, active: true };

  it("A. WAITING_FOR_SPORT + recognized FAQ: answers the FAQ and stays in WAITING_FOR_SPORT", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [envioFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "¿Hacen envíos a Cochabamba?", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls[1]?.[1]).toBe(envioFaq.answer);
    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SPORT");
  });

  it("B. WAITING_FOR_SELECTION + FAQ: answers the FAQ and keeps sportSlug", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "runer", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });
    gateway.faqs = [envioFaq];
    await processWhatsAppWebhook(payload("wamid.3", "¿Hacen envíos nacionales?", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls[2]?.[1]).toBe(envioFaq.answer);
    const execution = gateway.executionFor("conversation-1");
    expect(execution?.state).toBe("WAITING_FOR_SELECTION");
    expect(execution?.variables.sportSlug).toBe("running");
  });

  it("C. after an FAQ answer, the sport message continues the normal flow", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [envioFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "¿Hacen envíos?", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.3", "running", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway });

    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SELECTION");
    expect(gateway.executionFor("conversation-1")?.variables.sportSlug).toBe("running");
  });

  it("D. after an FAQ answer, selecting a design still reaches HUMAN_HANDOFF", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [envioFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "running", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.3", "¿Hacen envíos?", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.4", "Hola, me interesa el diseño RUN-08", BASE_UNIX_SECONDS + 180), { repository, adapter, intakeGateway: gateway });

    const execution = gateway.executionFor("conversation-1");
    expect(execution?.state).toBe("HUMAN_HANDOFF");
    expect(execution?.variables.selectedCode).toBe("RUN-08");
  });

  it("E. an inactive FAQ never answers", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [{ ...envioFaq, active: false }];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "¿Hacen envíos?", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls[1]?.[1]).not.toBe(envioFaq.answer);
    // Fase 6: with no sport recognized either and nothing else resolvable,
    // this is now a fail-safe UNKNOWN -> HUMAN_HANDOFF transfer instead of
    // the old canned "not recognized" retry message. Fase 6.1: the handoff
    // is silent — no transfer message is sent at all.
    expect(adapter.sendText.mock.calls.length).toBe(1); // only the "Hola" greeting from message 1
    expect(gateway.executionFor("conversation-1")?.state).toBe("HUMAN_HANDOFF");
  });

  it("F. an alias that is only a substring of an unrelated word never matches", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [envioFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "estoy reenvioso con esto", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls[1]?.[1]).not.toBe(envioFaq.answer);
  });

  it("G. a message naming two different FAQ topics answers both, deterministically (Fase 5 multi-intent)", async () => {
    // Fase 5 superseded the old Fase-4 "exactly one FAQ ever answers" rule:
    // a message can genuinely ask about more than one topic, and when the
    // aliases for each are unambiguously present, determinism now answers
    // all of them (see resolveFaqs in src/flows/automation-faq.ts and the
    // multi-intent combiner in src/flows/intake-runner.ts).
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [envioFaq, pagoFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    const callsBefore = adapter.sendText.mock.calls.length;
    await processWhatsAppWebhook(payload("wamid.2", "quiero saber el pago y el envio", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });

    const replies = adapter.sendText.mock.calls.slice(callsBefore).map((call) => call[1]);
    expect(replies).toEqual([envioFaq.answer, pagoFaq.answer]); // both answered, most specific/lowest sortOrder first
  });

  it("H. paused_human (HUMAN_HANDOFF, unexpired): FAQ never answers", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [envioFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "running", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.3", "Hola, me interesa el diseño RUN-08", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway });
    expect(repository.automationStatus).toBe("paused_human");

    const callsBefore = adapter.sendText.mock.calls.length;
    await processWhatsAppWebhook(payload("wamid.4", "¿Hacen envíos?", BASE_UNIX_SECONDS + 180), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls.length).toBe(callsBefore);
  });

  it("I. automation globally INACTIVA: FAQ never answers", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.active = false;
    gateway.faqs = [envioFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "¿Hacen envíos?", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText).not.toHaveBeenCalled();
  });
});

describe("multi-intent resolution + GPT classifier fallback (Fase 5)", () => {
  const ubicacionFaq = {
    id: "faq-ubicacion",
    title: "Ubicación",
    answer: "Estamos en Santa Cruz de la Sierra, Bolivia.",
    aliases: ["de que ciudad son", "son de santa cruz"],
    sortOrder: 0,
    active: true
  };
  const materialFaq = {
    id: "faq-material",
    title: "Material",
    answer: "Las medallas son de zamak con baño metálico.",
    aliases: ["de que material", "que material"],
    sortOrder: 1,
    active: true
  };
  const entregaFaq = {
    id: "faq-entrega",
    title: "Tiempo de entrega",
    answer: "El tiempo de entrega es de 5 a 7 días hábiles.",
    aliases: ["cuanto tardan", "cuanto tarda", "cuanto demoran", "tiempo de entrega"],
    sortOrder: 2,
    active: true
  };
  const pagoFaq = {
    id: "faq-pago",
    title: "Forma de pago",
    answer: "Aceptamos QR, transferencia y efectivo.",
    aliases: ["como puedo pagar", "formas de pago", "metodos de pago"],
    sortOrder: 3,
    active: true
  };
  const enviosFaq = {
    id: "faq-envios",
    title: "Envíos",
    answer: "Sí, hacemos envíos a todo el país.",
    aliases: ["hacen envios", "envian a"],
    sortOrder: 4,
    active: true
  };

  const aiConfig: IntentClassifierConfig = { apiKey: "test-key", model: "gpt-5-nano-test", minConfidence: 0.8, timeoutMs: 1000 };

  /** Counts every completion request so tests can assert "at most one GPT
   * call per message"; never makes a real network call. */
  function makeAi(respond: (request: ClassifierCompletionRequest) => string): { ai: IntakeAiOptions; calls: () => number } {
    let calls = 0;
    const client: ClassifierCompletionClient = {
      complete: async (request) => {
        calls += 1;
        return respond(request);
      }
    };
    return { ai: { config: aiConfig, client }, calls: () => calls };
  }

  it("A. FAQ from the very first message: no forced greeting/sport step first", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [materialFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "de que material son?", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls[0]?.[1]).toBe(materialFaq.answer);
    expect(adapter.sendText.mock.calls[0]?.[1]).not.toBe(DEFAULT_INTAKE_MESSAGES.greeting);
    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SPORT");
  });

  it("B. sport from the very first message reaches WAITING_FOR_SELECTION directly", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "quiero uno para running", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });

    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SELECTION");
    expect(gateway.executionFor("conversation-1")?.variables.sportSlug).toBe("running");
  });

  it("C. FAQ ubicación + SPORT running in one message: answers both, ends WAITING_FOR_SELECTION", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [ubicacionFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "son de Santa Cruz y quiero uno para running", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });

    const replies = adapter.sendText.mock.calls.map((call) => call[1] as string);
    expect(replies[0]).toBe(ubicacionFaq.answer);
    expect(replies[1]).toContain("/catalogo/running");
    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SELECTION");
    expect(gateway.executionFor("conversation-1")?.variables.sportSlug).toBe("running");
  });

  it("D. two FAQ topics in one message: two deterministic replies, state unchanged", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [entregaFaq, pagoFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "cuánto tardan y cómo puedo pagar?", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });

    // resolveFaqs orders by specificity (longest matching alias wins first
    // place); both FAQs answer regardless of which one sorts first.
    const replies = adapter.sendText.mock.calls.slice(1).map((call) => call[1] as string);
    expect(replies.sort()).toEqual([entregaFaq.answer, pagoFaq.answer].sort());
    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SPORT"); // conserva el estado
  });

  it("E. FAQ envíos + SPORT running in one message", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [enviosFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "envían a Cochabamba y quiero running", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });

    const replies = adapter.sendText.mock.calls.map((call) => call[1] as string);
    expect(replies[0]).toBe(enviosFaq.answer);
    expect(gateway.executionFor("conversation-1")?.variables.sportSlug).toBe("running");
  });

  it("F. same intent found by determinism and (redundantly) by GPT: answered exactly once", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [ubicacionFaq];
    const adapter = adapterMock();
    // GPT redundantly re-reports the sport determinism already found; the
    // combiner in resolveIntakeTurn must drop it, never double-reply.
    const { ai, calls } = makeAi(() => JSON.stringify({ intents: [{ type: "sport", id: "running", confidence: 0.9 }] }));

    await processWhatsAppWebhook(payload("wamid.1", "running y además ustedes trabajan aqui en scz", BASE_UNIX_SECONDS), {
      repository,
      adapter,
      intakeGateway: gateway,
      intakeAi: ai
    });

    const replies = adapter.sendText.mock.calls.map((call) => call[1] as string);
    expect(replies).toHaveLength(1); // only the sport/catalog reply, not repeated
    expect(replies[0]).toContain("/catalogo/running");
    expect(calls()).toBe(1);
  });

  it("J. GPT error/timeout: keeps whatever determinism already found", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    const ai: IntakeAiOptions = { config: aiConfig, client: { complete: async () => { throw new Error("timeout"); } } };

    await expect(
      processWhatsAppWebhook(payload("wamid.1", "running y además ustedes trabajan aqui en scz", BASE_UNIX_SECONDS), {
        repository,
        adapter,
        intakeGateway: gateway,
        intakeAi: ai
      })
    ).resolves.toBeUndefined();

    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SELECTION");
    expect(gateway.executionFor("conversation-1")?.variables.sportSlug).toBe("running");
  });

  it("K. completely unknown message: no invented reply, fail-safe transfers to a human (Fase 6)", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    const { ai } = makeAi(() => JSON.stringify({ intents: [], requires_human: false }));

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: ai });
    await processWhatsAppWebhook(payload("wamid.2", "quiero hablar con alguien", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway, intakeAi: ai });

    // Even with requires_human explicitly false, zero resolvable intents is
    // itself the fail-safe trigger (rule 7): never invent an answer, always
    // hand off to Jhoselin. Fase 6.1: silently — no transfer message sent.
    expect(gateway.executionFor("conversation-1")?.state).toBe("HUMAN_HANDOFF");
    expect(adapter.sendText.mock.calls.length).toBe(1); // only the "Hola" greeting from message 1
    expect(repository.automationStatus).toBe("paused_human");
  });

  it("L. RUN-08 code + FAQ in the same message: FAQ still answers, selection is a silent handoff (Fase 6.2)", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [entregaFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "running", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.3", "me gusta RUN-08, cuánto tarda?", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway });

    const replies = adapter.sendText.mock.calls.slice(2).map((call) => call[1] as string);
    expect(replies).toEqual([entregaFaq.answer]); // FAQ answered, no selection-confirmation message
    const execution = gateway.executionFor("conversation-1");
    expect(execution?.state).toBe("HUMAN_HANDOFF");
    expect(execution?.variables.selectedCode).toBe("RUN-08");
  });

  it("M. paused_human (unexpired HUMAN_HANDOFF): zero replies, zero GPT calls", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    const { ai, calls } = makeAi(() => JSON.stringify({ intents: [{ type: "sport", id: "running", confidence: 0.9 }] }));

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: ai });
    await processWhatsAppWebhook(payload("wamid.2", "running", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway, intakeAi: ai });
    await processWhatsAppWebhook(payload("wamid.3", "Hola, me interesa el diseño RUN-08", BASE_UNIX_SECONDS + 120), {
      repository,
      adapter,
      intakeGateway: gateway,
      intakeAi: ai
    });
    expect(repository.automationStatus).toBe("paused_human");

    const callsBefore = adapter.sendText.mock.calls.length;
    await processWhatsAppWebhook(payload("wamid.4", "quiero uno para mis carreras", BASE_UNIX_SECONDS + 180), {
      repository,
      adapter,
      intakeGateway: gateway,
      intakeAi: ai
    });

    expect(adapter.sendText.mock.calls.length).toBe(callsBefore);
    expect(calls()).toBe(0);
  });

  it("N. automation globally INACTIVA: zero replies, zero GPT calls", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.active = false;
    const adapter = adapterMock();
    const { ai, calls } = makeAi(() => JSON.stringify({ intents: [{ type: "sport", id: "running", confidence: 0.9 }] }));

    await processWhatsAppWebhook(payload("wamid.1", "quiero uno para mis carreras", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: ai });

    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(calls()).toBe(0);
  });

  it("O. several unresolved parts in one message still trigger at most one GPT call", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    const { ai, calls } = makeAi(() => JSON.stringify({ intents: [] }));

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: ai });
    await processWhatsAppWebhook(
      payload("wamid.2", "tengo un problema con mi pedido y ademas ya hice el pago y quiero hablar con alguien", BASE_UNIX_SECONDS + 60),
      { repository, adapter, intakeGateway: gateway, intakeAi: ai }
    );

    expect(calls()).toBe(1);
  });

  it("P. two FAQ topics fully resolved deterministically: zero GPT calls", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [entregaFaq, pagoFaq];
    const adapter = adapterMock();
    const { ai, calls } = makeAi(() => JSON.stringify({ intents: [] }));

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: ai });
    await processWhatsAppWebhook(payload("wamid.2", "cuánto tardan y cómo puedo pagar?", BASE_UNIX_SECONDS + 60), {
      repository,
      adapter,
      intakeGateway: gateway,
      intakeAi: ai
    });

    expect(calls()).toBe(0);
  });

  it("without OPENAI_API_KEY configured (no intakeAi dependency), no classifier runs, still fails safe to a human handoff (Fase 6)", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "quiero hablar con alguien", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });

    // Zero resolvable intents (with or without a working classifier) is
    // itself the fail-safe trigger: never loop the customer on a canned
    // retry message forever, always hand off — silently (Fase 6.1).
    expect(gateway.executionFor("conversation-1")?.state).toBe("HUMAN_HANDOFF");
    expect(adapter.sendText.mock.calls.length).toBe(1); // only the "Hola" greeting from message 1
  });
});

describe("UNKNOWN -> HUMAN_HANDOFF (Fase 6)", () => {
  const pagoFaq = {
    id: "faq-pago-f6",
    title: "Forma de pago",
    answer: "Aceptamos QR, transferencia y efectivo.",
    aliases: ["como puedo pagar"],
    sortOrder: 0,
    active: true
  };
  const entregaFaq = {
    id: "faq-entrega-f6",
    title: "Tiempo de entrega",
    answer: "Entregas miércoles y sábados.",
    aliases: ["cuanto tardan"],
    sortOrder: 1,
    active: true
  };
  const ubicacionFaq = {
    id: "faq-ubicacion-f6",
    title: "Ubicación",
    answer: "Estamos en Santa Cruz de la Sierra.",
    aliases: ["son de santa cruz"],
    sortOrder: 2,
    active: true
  };

  const aiConfig: IntentClassifierConfig = { apiKey: "test-key", model: "gpt-5-nano-test", minConfidence: 0.8, timeoutMs: 1000 };

  function makeAi(respond: (request: ClassifierCompletionRequest) => string): { ai: IntakeAiOptions; calls: () => number } {
    let calls = 0;
    const client: ClassifierCompletionClient = {
      complete: async (request) => {
        calls += 1;
        return respond(request);
      }
    };
    return { ai: { config: aiConfig, client }, calls: () => calls };
  }

  /** Every one of these should be flagged requires_human=true by the real
   * classifier (already verified live against OpenAI) — here we only test
   * the RUNNER's own handoff logic, so a fixed fake response is enough. */
  const { ai: requiresHumanAi } = makeAi(() => JSON.stringify({ intents: [], requires_human: true }));

  it("A. 'ya hice el pago': HUMAN_HANDOFF, zero bot replies (silent handoff, Fase 6.1)", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "ya hice el pago", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: requiresHumanAi });

    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(gateway.executionFor("conversation-1")?.state).toBe("HUMAN_HANDOFF");
    expect(repository.automationStatus).toBe("paused_human");
  });

  it("B. 'dónde está mi pedido?': HUMAN_HANDOFF, zero bot replies", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "dónde está mi pedido?", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: requiresHumanAi });

    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(gateway.executionFor("conversation-1")?.state).toBe("HUMAN_HANDOFF");
  });

  it("C. 'quiero hablar con alguien': HUMAN_HANDOFF, zero bot replies", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "quiero hablar con alguien", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: requiresHumanAi });

    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(gateway.executionFor("conversation-1")?.state).toBe("HUMAN_HANDOFF");
  });

  it("D. 'tengo un problema con mi pedido': HUMAN_HANDOFF, zero bot replies", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "tengo un problema con mi pedido", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: requiresHumanAi });

    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(gateway.executionFor("conversation-1")?.state).toBe("HUMAN_HANDOFF");
  });

  it("E. 'quiero un diseño personalizado': HUMAN_HANDOFF, zero bot replies", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "quiero un diseño personalizado", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: requiresHumanAi });

    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(gateway.executionFor("conversation-1")?.state).toBe("HUMAN_HANDOFF");
  });

  it("F. SPORT + personalization: the sport reply is allowed, then silent HUMAN_HANDOFF — zero transfer message", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    const { ai } = makeAi(() => JSON.stringify({ intents: [], requires_human: true }));

    await processWhatsAppWebhook(payload("wamid.1", "quiero running pero necesito un diseño totalmente personalizado", BASE_UNIX_SECONDS), {
      repository,
      adapter,
      intakeGateway: gateway,
      intakeAi: ai
    });

    const replies = adapter.sendText.mock.calls.map((call) => call[1] as string);
    expect(replies).toHaveLength(1); // only the sport/catalog reply, no transfer message appended
    expect(replies[0]).toContain("/catalogo/running");
    expect(gateway.executionFor("conversation-1")?.state).toBe("HUMAN_HANDOFF");
    expect(gateway.executionFor("conversation-1")?.variables.sportSlug).toBe("running");
  });

  it("G. FAQ + requires_human: the FAQ reply is allowed, then silent HUMAN_HANDOFF — zero additional message", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [pagoFaq];
    const adapter = adapterMock();
    const { ai } = makeAi(() => JSON.stringify({ intents: [], requires_human: true }));

    await processWhatsAppWebhook(payload("wamid.1", "como puedo pagar? ya hice el deposito", BASE_UNIX_SECONDS), {
      repository,
      adapter,
      intakeGateway: gateway,
      intakeAi: ai
    });

    const replies = adapter.sendText.mock.calls.map((call) => call[1] as string);
    expect(replies).toEqual([pagoFaq.answer]); // FAQ answered, nothing appended after it
    expect(gateway.executionFor("conversation-1")?.state).toBe("HUMAN_HANDOFF");
  });

  it("H. RUN-XX: fully silent handoff (Fase 6.2) — no selection-confirmation, no transfer message", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "running", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });
    const callsBefore = adapter.sendText.mock.calls.length;
    await processWhatsAppWebhook(payload("wamid.3", "RUN-08", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls.length).toBe(callsBefore); // zero new replies
    const execution = gateway.executionFor("conversation-1");
    expect(execution?.state).toBe("HUMAN_HANDOFF");
    expect(execution?.variables.selectedCode).toBe("RUN-08");
  });

  it("I. paused_human: zero bot replies, zero GPT calls", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    const { ai, calls } = makeAi(() => JSON.stringify({ intents: [], requires_human: true }));

    await processWhatsAppWebhook(payload("wamid.1", "ya hice el pago", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: ai });
    expect(repository.automationStatus).toBe("paused_human");

    const callsBefore = adapter.sendText.mock.calls.length;
    await processWhatsAppWebhook(payload("wamid.2", "hola, siguen ahi?", BASE_UNIX_SECONDS + 3600), { repository, adapter, intakeGateway: gateway, intakeAi: ai });

    expect(adapter.sendText.mock.calls.length).toBe(callsBefore);
    expect(calls()).toBe(1); // only the original handoff-triggering call, none for the follow-up
  });

  it("J. >=48h inactivity: next inbound starts a fresh, normal session", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "ya hice el pago", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: requiresHumanAi });
    expect(adapter.sendText).not.toHaveBeenCalled(); // silent handoff

    await processWhatsAppWebhook(payload("wamid.2", "hola", BASE_UNIX_SECONDS + 48 * 3600), { repository, adapter, intakeGateway: gateway, intakeAi: requiresHumanAi });

    expect(repository.automationStatus).toBe("active");
    expect(gateway.resumedConversations).toContain("conversation-1");
    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SPORT");
    expect(adapter.sendText.mock.calls[0]?.[1]).toBe(DEFAULT_INTAKE_MESSAGES.greeting);
  });

  it("K. plain greeting on NEW: normal behavior, no handoff", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    const { calls } = makeAi(() => JSON.stringify({ intents: [], requires_human: true }));

    await processWhatsAppWebhook(payload("wamid.1", "hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: requiresHumanAi });

    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SPORT");
    expect(adapter.sendText.mock.calls[0]?.[1]).toBe(DEFAULT_INTAKE_MESSAGES.greeting);
    expect(calls()).toBe(0); // greeting never reaches GPT
  });

  it("L. a resolvable FAQ answers normally, never triggers a handoff", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [pagoFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "como puedo pagar?", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls[0]?.[1]).toBe(pagoFaq.answer);
    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SPORT");
  });

  it("a fully-resolved multi-FAQ message never triggers a handoff", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [pagoFaq, entregaFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "cuanto tardan y como puedo pagar?", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });

    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SPORT");
    expect(adapter.sendText.mock.calls.length).toBe(2);
  });

  it("SPORT + FAQ fully resolved never triggers a handoff", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [ubicacionFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "son de santa cruz y quiero running", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });

    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SELECTION");
    expect(gateway.executionFor("conversation-1")?.variables.sportSlug).toBe("running");
  });

  it("WAITING_FOR_SELECTION + unresolved message: silent HUMAN_HANDOFF", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    const { ai } = makeAi(() => JSON.stringify({ intents: [], requires_human: false }));

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: ai });
    await processWhatsAppWebhook(payload("wamid.2", "runer", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway, intakeAi: ai });
    const callsBefore = adapter.sendText.mock.calls.length;
    await processWhatsAppWebhook(payload("wamid.3", "quiero que le cambien completamente el diseño", BASE_UNIX_SECONDS + 120), {
      repository,
      adapter,
      intakeGateway: gateway,
      intakeAi: ai
    });

    expect(gateway.executionFor("conversation-1")?.state).toBe("HUMAN_HANDOFF");
    expect(adapter.sendText.mock.calls.length).toBe(callsBefore); // no new reply at all
  });

  it("an inbound message during paused_human still counts as activity (extends the 48h window per existing logic)", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "ya hice el pago", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: requiresHumanAi });
    // +10h: within the window, but this message IS the new "last activity".
    await processWhatsAppWebhook(payload("wamid.2", "hola", BASE_UNIX_SECONDS + 10 * 3600), { repository, adapter, intakeGateway: gateway, intakeAi: requiresHumanAi });

    // +50h from the original handoff, but only +40h from wamid.2 -> must still stay silent.
    await processWhatsAppWebhook(payload("wamid.3", "hola", BASE_UNIX_SECONDS + 50 * 3600), { repository, adapter, intakeGateway: gateway, intakeAi: requiresHumanAi });

    expect(adapter.sendText).not.toHaveBeenCalled(); // silent throughout
    expect(repository.automationStatus).toBe("paused_human");
  });

  it(">=48h inactivity + 'quiero running': fresh session resolves the sport directly", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    const { ai: notRequiredAi } = makeAi(() => JSON.stringify({ intents: [], requires_human: false }));

    await processWhatsAppWebhook(payload("wamid.1", "ya hice el pago", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: requiresHumanAi });
    await processWhatsAppWebhook(payload("wamid.2", "quiero running", BASE_UNIX_SECONDS + 48 * 3600), { repository, adapter, intakeGateway: gateway, intakeAi: notRequiredAi });

    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SELECTION");
    expect(gateway.executionFor("conversation-1")?.variables.sportSlug).toBe("running");
  });

  it("automation globally INACTIVA: zero replies, zero GPT calls, never a handoff", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.active = false;
    const adapter = adapterMock();
    const { ai, calls } = makeAi(() => JSON.stringify({ intents: [], requires_human: true }));

    await processWhatsAppWebhook(payload("wamid.1", "ya hice el pago", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: ai });

    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(gateway.executionFor("conversation-1")).toBeNull();
    expect(calls()).toBe(0);
  });

  it("OpenAI timeout/error on an otherwise-unresolved message: fails safe to a silent HUMAN_HANDOFF, never throws", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    const ai: IntakeAiOptions = { config: aiConfig, client: { complete: async () => { throw new Error("timeout"); } } };

    await expect(
      processWhatsAppWebhook(payload("wamid.1", "quiero hablar con alguien", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: ai })
    ).resolves.toBeUndefined();

    expect(gateway.executionFor("conversation-1")?.state).toBe("HUMAN_HANDOFF");
    expect(adapter.sendText).not.toHaveBeenCalled();
  });

  it("a valid deterministic intent survives an OpenAI error: no forced handoff just because GPT failed", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    const ai: IntakeAiOptions = { config: aiConfig, client: { complete: async () => { throw new Error("timeout"); } } };

    await processWhatsAppWebhook(payload("wamid.1", "running y además cuéntame algo más sobre ustedes", BASE_UNIX_SECONDS), {
      repository,
      adapter,
      intakeGateway: gateway,
      intakeAi: ai
    });

    // Running was resolved deterministically; GPT erroring while looking for
    // extra content must never override that with a forced handoff.
    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SELECTION");
    expect(gateway.executionFor("conversation-1")?.variables.sportSlug).toBe("running");
  });
});
