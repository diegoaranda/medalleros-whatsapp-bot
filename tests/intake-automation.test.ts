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
  { slug: "running", name: "Running", codes: ["RUN-01", "RUN-08", "RUN-14", "RUN-21"], aliases: ["runner", "runer", "correr"], catalogUrl: "https://medalleros-whatsapp-bot.vercel.app/catalogo/running" }
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
  imageUrlByCode = new Map<string, string>([
    ["RUN-08", "https://example.test/catalog-media/RUN-08.jpg"],
    ["RUN-14", "https://example.test/catalog-media/RUN-14.jpg"],
    ["RUN-21", "https://example.test/catalog-media/RUN-21.jpg"]
  ]);
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
    return { sports: this.sports, imageIdByCode: this.imageIdByCode, imageUrlByCode: this.imageUrlByCode };
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

function adapterMock(): ChannelAdapter & { sendText: ReturnType<typeof vi.fn>; sendImage: ReturnType<typeof vi.fn> } {
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

  it("D. selecting a design is a silent per-message handoff (Fase 7): persists the selection, zero bot replies, conversation stays live", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola"), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "runer"), { repository, adapter, intakeGateway: gateway });
    const callsBefore = adapter.sendText.mock.calls.length;
    await processWhatsAppWebhook(payload("wamid.3", "Hola, me interesa el diseño RUN-08"), { repository, adapter, intakeGateway: gateway });

    const execution = gateway.executionFor("conversation-1");
    // Fase 7: handoff never persists "HUMAN_HANDOFF" as the flow state, and
    // never pauses the conversation — sport context stays alive.
    expect(execution?.state).toBe("WAITING_FOR_SELECTION");
    expect(execution?.status).toBe("running");
    expect(execution?.variables.selectedCode).toBe("RUN-08");
    expect(execution?.variables.imageId).toBe("image-run-08");
    expect(gateway.pausedConversations).not.toContain("conversation-1");
    expect(adapter.sendText.mock.calls.length).toBe(callsBefore); // zero new replies for this message
  });

  it("E. after a selection handoff, a NEW message with a resolvable FAQ still answers automatically (Fase 7 per-message handoff)", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [{ id: "faq-envios", title: "Envíos", answer: "Sí, hacemos envíos.", aliases: ["hacen envios"], sortOrder: 0, active: true }];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola"), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "runer"), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.3", "Hola, me interesa el diseño RUN-08"), { repository, adapter, intakeGateway: gateway });
    expect(repository.automationStatus).toBe("active"); // never paused

    const callsBefore = adapter.sendText.mock.calls.length;
    await processWhatsAppWebhook(payload("wamid.4", "hacen envios?"), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls.length).toBe(callsBefore + 1);
    expect(adapter.sendText.mock.calls[callsBefore]?.[1]).toBe("Sí, hacemos envíos.");
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

// Fase 7 removed the 48h pause/expiry mechanism from the active flow: a
// selection handoff no longer pauses the conversation at all, so there is
// nothing left to "expire" — see the "Fase 7: per-message handoff" describe
// block below for the coverage that replaces this (bot and human answering
// consecutive messages in the same conversation, no waiting required).

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

  it("D. after an FAQ answer, selecting a design is still a silent per-message handoff (Fase 7)", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [envioFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "running", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.3", "¿Hacen envíos?", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.4", "Hola, me interesa el diseño RUN-08", BASE_UNIX_SECONDS + 180), { repository, adapter, intakeGateway: gateway });

    const execution = gateway.executionFor("conversation-1");
    expect(execution?.state).toBe("WAITING_FOR_SELECTION"); // conversation stays live, not a terminal node
    expect(execution?.variables.selectedCode).toBe("RUN-08");
  });

  it("E. an inactive FAQ never answers; with nothing else resolvable, it's a silent handoff that keeps the flow state", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [{ ...envioFaq, active: false }];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "¿Hacen envíos?", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls[1]?.[1]).not.toBe(envioFaq.answer);
    // Fase 7: with no sport recognized either and nothing else resolvable,
    // this is a silent per-message handoff — zero replies for THIS message
    // — but the flow state stays WAITING_FOR_SPORT, never a terminal node.
    expect(adapter.sendText.mock.calls.length).toBe(1); // only the "Hola" greeting from message 1
    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SPORT");
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

  it("H. after a selection handoff, an FAQ in a later message answers normally (Fase 7: no pause)", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [envioFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "running", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.3", "Hola, me interesa el diseño RUN-08", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway });
    expect(repository.automationStatus).toBe("active"); // never paused

    const callsBefore = adapter.sendText.mock.calls.length;
    await processWhatsAppWebhook(payload("wamid.4", "¿Hacen envíos?", BASE_UNIX_SECONDS + 180), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls.length).toBe(callsBefore + 1);
    expect(adapter.sendText.mock.calls[callsBefore]?.[1]).toBe(envioFaq.answer);
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

  it("K. completely unknown message: no invented reply, silent per-message handoff (Fase 7)", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    const { ai } = makeAi(() => JSON.stringify({ intents: [], requires_human: false }));

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: ai });
    await processWhatsAppWebhook(payload("wamid.2", "quiero hablar con alguien", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway, intakeAi: ai });

    // Even with requires_human explicitly false, zero resolvable intents is
    // itself the fail-safe trigger (rule 7): never invent an answer, always
    // hand off to Jhoselin — silently, for this message only (Fase 7: no
    // pause, flow state stays WAITING_FOR_SPORT, not a terminal node).
    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SPORT");
    expect(adapter.sendText.mock.calls.length).toBe(1); // only the "Hola" greeting from message 1
    expect(repository.automationStatus).toBe("active");
  });

  it("L. RUN-08 code + FAQ in the same message: FAQ still answers, selection is a silent per-message handoff (Fase 7)", async () => {
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
    expect(execution?.state).toBe("WAITING_FOR_SELECTION"); // stays live, not a terminal node
    expect(execution?.variables.selectedCode).toBe("RUN-08");
  });

  it("M. after a selection handoff, the very next message is still evaluated normally (Fase 7: no pause)", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [entregaFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "running", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.3", "Hola, me interesa el diseño RUN-08", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway });
    expect(repository.automationStatus).toBe("active"); // never paused

    const callsBefore = adapter.sendText.mock.calls.length;
    // A resolvable FAQ right after a selection handoff must answer
    // normally — the bot is never blocked by the previous turn's handoff.
    await processWhatsAppWebhook(payload("wamid.4", "cuánto tardan?", BASE_UNIX_SECONDS + 180), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls.length).toBe(callsBefore + 1);
    expect(adapter.sendText.mock.calls[callsBefore]?.[1]).toBe(entregaFaq.answer);
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

  it("without OPENAI_API_KEY configured (no intakeAi dependency), no classifier runs, still fails safe to a silent handoff (Fase 7)", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "quiero hablar con alguien", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });

    // Zero resolvable intents (with or without a working classifier) is
    // itself the fail-safe trigger: never loop the customer on a canned
    // retry message forever, always hand off — silently, for this message
    // only (Fase 7: no pause, state stays WAITING_FOR_SPORT).
    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SPORT");
    expect(adapter.sendText.mock.calls.length).toBe(1); // only the "Hola" greeting from message 1
    expect(repository.automationStatus).toBe("active");
  });
});

describe("Fase 7: per-message handoff (no conversation pause)", () => {
  const pagoFaq = {
    id: "faq-pago-f7",
    title: "Forma de pago",
    answer: "Aceptamos QR, transferencia y efectivo.",
    aliases: ["como puedo pagar", "cuánto hay que dar de anticipo"],
    sortOrder: 0,
    active: true
  };
  const entregaFaq = {
    id: "faq-entrega-f7",
    title: "Tiempo de entrega",
    answer: "Entregas miércoles y sábados.",
    aliases: ["cuanto tardan", "cuánto demora"],
    sortOrder: 1,
    active: true
  };
  const ubicacionFaq = {
    id: "faq-ubicacion-f7",
    title: "Ubicación",
    answer: "Estamos en Santa Cruz de la Sierra.",
    aliases: ["son de santa cruz", "de dónde son"],
    sortOrder: 2,
    active: true
  };
  const materialFaq = {
    id: "faq-material-f7",
    title: "Material",
    answer: "Madera trupan con detalles en acrílico.",
    aliases: ["de que material es"],
    sortOrder: 3,
    active: true
  };
  const enviosFaq = {
    id: "faq-envios-f7",
    title: "Envíos nacionales",
    answer: "Sí, hacemos envíos a todo Bolivia.",
    aliases: ["hacen envios a cochabamba", "hacen envios a oruro"],
    sortOrder: 4,
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

  it("A. 'ya hice el pago': silent handoff (0 bot replies), then the NEXT message's FAQ answers normally", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [enviosFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "ya hice el pago", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: requiresHumanAi });
    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(repository.automationStatus).toBe("active"); // never paused

    await processWhatsAppWebhook(payload("wamid.2", "hacen envios a cochabamba?", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls).toHaveLength(1);
    expect(adapter.sendText.mock.calls[0]?.[1]).toBe(enviosFaq.answer);
  });

  it("B. 'ya hice el pago' then 'cuánto demora?': FAQ tiempo answers on the next message", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [entregaFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "ya hice el pago", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: requiresHumanAi });
    await processWhatsAppWebhook(payload("wamid.2", "cuánto demora?", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls).toHaveLength(1);
    expect(adapter.sendText.mock.calls[0]?.[1]).toBe(entregaFaq.answer);
  });

  it("C. 'quiero un diseño personalizado' then 'de que material es?': FAQ material answers on the next message", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [materialFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "quiero un diseño personalizado", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: requiresHumanAi });
    await processWhatsAppWebhook(payload("wamid.2", "de que material es?", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls).toHaveLength(1);
    expect(adapter.sendText.mock.calls[0]?.[1]).toBe(materialFaq.answer);
  });

  it("D. 'tengo un problema con mi pedido' then 'cuánto hay que dar de anticipo?': FAQ pago answers on the next message", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [pagoFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "tengo un problema con mi pedido", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: requiresHumanAi });
    await processWhatsAppWebhook(payload("wamid.2", "cuánto hay que dar de anticipo?", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls).toHaveLength(1);
    expect(adapter.sendText.mock.calls[0]?.[1]).toBe(pagoFaq.answer);
  });

  it("E. 'quiero hablar con alguien' then 'de dónde son?': FAQ ubicación answers on the next message", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [ubicacionFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "quiero hablar con alguien", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: requiresHumanAi });
    await processWhatsAppWebhook(payload("wamid.2", "de dónde son?", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls).toHaveLength(1);
    expect(adapter.sendText.mock.calls[0]?.[1]).toBe(ubicacionFaq.answer);
  });

  it("F. full coexistence sequence: sport -> FAQ -> silent RUN-08 handoff -> FAQ, all in one conversation", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [enviosFaq, entregaFaq];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "quiero running", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SELECTION");
    expect(adapter.sendText.mock.calls[0]?.[1]).toContain("/catalogo/running");

    await processWhatsAppWebhook(payload("wamid.2", "hacen envios a oruro?", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });
    expect(adapter.sendText.mock.calls[1]?.[1]).toBe(enviosFaq.answer);

    await processWhatsAppWebhook(payload("wamid.3", "RUN-08", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway });
    expect(adapter.sendText.mock.calls).toHaveLength(2); // silent: no new reply for the selection
    const midExecution = gateway.executionFor("conversation-1");
    expect(midExecution?.state).toBe("WAITING_FOR_SELECTION"); // stays live
    expect(midExecution?.variables.selectedCode).toBe("RUN-08");
    expect(repository.automationStatus).toBe("active"); // never paused

    await processWhatsAppWebhook(payload("wamid.4", "cuánto demora?", BASE_UNIX_SECONDS + 180), { repository, adapter, intakeGateway: gateway });
    expect(adapter.sendText.mock.calls).toHaveLength(3);
    expect(adapter.sendText.mock.calls[2]?.[1]).toBe(entregaFaq.answer);
  });

  it("SPORT + personalization: the sport reply is allowed, silent handoff for the human part, conversation stays live", async () => {
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
    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SELECTION"); // not a terminal node
    expect(gateway.executionFor("conversation-1")?.variables.sportSlug).toBe("running");
  });

  it("FAQ + requires_human: the FAQ reply is allowed, silent handoff for the human part, state unchanged", async () => {
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
    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SPORT");
  });

  it("RUN-XX: fully silent handoff — no selection-confirmation, no transfer message, conversation stays live", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "running", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });
    const callsBefore = adapter.sendText.mock.calls.length;
    await processWhatsAppWebhook(payload("wamid.3", "RUN-08", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls.length).toBe(callsBefore); // zero new replies
    const execution = gateway.executionFor("conversation-1");
    expect(execution?.state).toBe("WAITING_FOR_SELECTION");
    expect(execution?.variables.selectedCode).toBe("RUN-08");
    expect(repository.automationStatus).toBe("active");
  });

  it("plain greeting on NEW: normal behavior, no handoff, no GPT call", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    const { calls } = makeAi(() => JSON.stringify({ intents: [], requires_human: true }));

    await processWhatsAppWebhook(payload("wamid.1", "hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: requiresHumanAi });

    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SPORT");
    expect(adapter.sendText.mock.calls[0]?.[1]).toBe(DEFAULT_INTAKE_MESSAGES.greeting);
    expect(calls()).toBe(0); // greeting never reaches GPT
  });

  it("a resolvable FAQ answers normally, never triggers a handoff", async () => {
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

  it("WAITING_FOR_SELECTION + unresolved message: silent handoff, sport context preserved", async () => {
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

    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SELECTION"); // sport context preserved
    expect(gateway.executionFor("conversation-1")?.variables.sportSlug).toBe("running");
    expect(adapter.sendText.mock.calls.length).toBe(callsBefore); // no new reply at all
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

  it("OpenAI timeout/error on an otherwise-unresolved message: fails safe to a silent handoff, never throws", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    const ai: IntakeAiOptions = { config: aiConfig, client: { complete: async () => { throw new Error("timeout"); } } };

    await expect(
      processWhatsAppWebhook(payload("wamid.1", "quiero hablar con alguien", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway, intakeAi: ai })
    ).resolves.toBeUndefined();

    expect(gateway.executionFor("conversation-1")?.state).toBe("WAITING_FOR_SPORT");
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

describe("Fase 8: Media V1 (catalog images + FAQ media)", () => {
  async function reachSelection(repository: MemoryRepository, gateway: FakeIntakeGateway, adapter: ReturnType<typeof adapterMock>) {
    await processWhatsAppWebhook(payload("wamid.1", "Hola", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.2", "running", BASE_UNIX_SECONDS + 60), { repository, adapter, intakeGateway: gateway });
  }

  it("Q1. 'RUN-08': sends the real RUN-08 image, handoff:true, zero text replies", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    await reachSelection(repository, gateway, adapter);

    const textCallsBefore = adapter.sendText.mock.calls.length;
    await processWhatsAppWebhook(payload("wamid.3", "RUN-08", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls.length).toBe(textCallsBefore); // no text at all
    expect(adapter.sendImage).toHaveBeenCalledTimes(1);
    expect(adapter.sendImage.mock.calls[0]?.[1]).toBe(gateway.imageUrlByCode.get("RUN-08"));
    const execution = gateway.executionFor("conversation-1");
    expect(execution?.variables.selectedCode).toBe("RUN-08");
    expect(execution?.variables.selectedCodes).toEqual(["RUN-08"]);
  });

  it("Q2. 'Me interesa este diseño: RUN-08': recognizes the code inside the new prefill phrasing", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    await reachSelection(repository, gateway, adapter);

    await processWhatsAppWebhook(payload("wamid.3", "Me interesa este diseño: RUN-08", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendImage).toHaveBeenCalledTimes(1);
    expect(adapter.sendImage.mock.calls[0]?.[1]).toBe(gateway.imageUrlByCode.get("RUN-08"));
  });

  it("Q3. 'RUN-08 y RUN-14': two images, in that order", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    await reachSelection(repository, gateway, adapter);

    await processWhatsAppWebhook(payload("wamid.3", "RUN-08 y RUN-14", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendImage).toHaveBeenCalledTimes(2);
    expect(adapter.sendImage.mock.calls[0]?.[1]).toBe(gateway.imageUrlByCode.get("RUN-08"));
    expect(adapter.sendImage.mock.calls[1]?.[1]).toBe(gateway.imageUrlByCode.get("RUN-14"));
    expect(gateway.executionFor("conversation-1")?.variables.selectedCodes).toEqual(["RUN-08", "RUN-14"]);
  });

  it("Q4. 'RUN-08, RUN-14 y RUN-21': three images", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    await reachSelection(repository, gateway, adapter);

    await processWhatsAppWebhook(payload("wamid.3", "RUN-08, RUN-14 y RUN-21", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendImage).toHaveBeenCalledTimes(3);
    expect(gateway.executionFor("conversation-1")?.variables.selectedCodes).toEqual(["RUN-08", "RUN-14", "RUN-21"]);
  });

  it("Q5. 'RUN-08 RUN-08 RUN-14': deduplicates, 2 images", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    await reachSelection(repository, gateway, adapter);

    await processWhatsAppWebhook(payload("wamid.3", "RUN-08 RUN-08 RUN-14", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendImage).toHaveBeenCalledTimes(2);
    expect(gateway.executionFor("conversation-1")?.variables.selectedCodes).toEqual(["RUN-08", "RUN-14"]);
  });

  it("Q6. 'RUN-99' (nonexistent code): never invents an image, silent handoff like any unresolved message", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    const { ai } = (() => {
      const client: ClassifierCompletionClient = { complete: async () => JSON.stringify({ intents: [], requires_human: false }) };
      return { ai: { config: { apiKey: "k", model: "m", minConfidence: 0.8, timeoutMs: 1000 }, client } };
    })();
    await reachSelection(repository, gateway, adapter);

    const callsBefore = adapter.sendText.mock.calls.length;
    await processWhatsAppWebhook(payload("wamid.3", "RUN-99", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway, intakeAi: ai });

    expect(adapter.sendImage).not.toHaveBeenCalled();
    expect(adapter.sendText.mock.calls.length).toBe(callsBefore);
    expect(gateway.executionFor("conversation-1")?.variables.selectedCode).toBeUndefined();
  });

  it("Q7. after a RUN-08 image, a later FAQ answers normally (Fase 7 intact)", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [{ id: "faq-envios-media", title: "Envíos", answer: "Sí, hacemos envíos.", aliases: ["hacen envios"], sortOrder: 0, active: true }];
    const adapter = adapterMock();
    await reachSelection(repository, gateway, adapter);

    const textCallsBefore = adapter.sendText.mock.calls.length;
    await processWhatsAppWebhook(payload("wamid.3", "RUN-08", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway });
    expect(adapter.sendImage).toHaveBeenCalledTimes(1);

    await processWhatsAppWebhook(payload("wamid.4", "hacen envios?", BASE_UNIX_SECONDS + 180), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText.mock.calls.length).toBe(textCallsBefore + 1);
    expect(adapter.sendText.mock.calls[textCallsBefore]?.[1]).toBe("Sí, hacemos envíos.");
  });

  it("D. selections across separate messages (RUN-08, then RUN-14, then RUN-21) each send their own image", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    const adapter = adapterMock();
    await reachSelection(repository, gateway, adapter);

    await processWhatsAppWebhook(payload("wamid.3", "RUN-08", BASE_UNIX_SECONDS + 120), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.4", "RUN-14", BASE_UNIX_SECONDS + 180), { repository, adapter, intakeGateway: gateway });
    await processWhatsAppWebhook(payload("wamid.5", "RUN-21", BASE_UNIX_SECONDS + 240), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendImage).toHaveBeenCalledTimes(3);
    expect(adapter.sendImage.mock.calls.map((call) => call[1])).toEqual([
      gateway.imageUrlByCode.get("RUN-08"),
      gateway.imageUrlByCode.get("RUN-14"),
      gateway.imageUrlByCode.get("RUN-21")
    ]);
  });

  // --- R. FAQ media fixtures ---

  it("R1. FAQ text only: a single text reply", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [{ id: "faq-r1", title: "Material", answer: "Madera trupan.", aliases: ["de que material es"], sortOrder: 0, active: true }];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "de que material es?", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText).toHaveBeenCalledTimes(1);
    expect(adapter.sendText.mock.calls[0]?.[1]).toBe("Madera trupan.");
    expect(adapter.sendImage).not.toHaveBeenCalled();
  });

  it("R2. FAQ text + 1 image: text then the image", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [
      {
        id: "faq-r2",
        title: "Recojo",
        answer: "Estamos en Av. Paragua, 3er anillo interno.",
        aliases: ["puedo pasar a recoger"],
        sortOrder: 0,
        active: true,
        media: [{ url: "https://example.test/automation-media/casa.jpg", sortOrder: 0 }]
      }
    ];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "puedo pasar a recoger?", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText).toHaveBeenCalledTimes(1);
    expect(adapter.sendText.mock.calls[0]?.[1]).toBe("Estamos en Av. Paragua, 3er anillo interno.");
    expect(adapter.sendImage).toHaveBeenCalledTimes(1);
    expect(adapter.sendImage.mock.calls[0]?.[1]).toBe("https://example.test/automation-media/casa.jpg");
  });

  it("R3. FAQ text + 2 images: text then both images in sort_order", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [
      {
        id: "faq-r3",
        title: "QR",
        answer: "Puedes pagar escaneando el QR.",
        aliases: ["tienen qr"],
        sortOrder: 0,
        active: true,
        media: [
          { url: "https://example.test/automation-media/qr-2.jpg", sortOrder: 1 },
          { url: "https://example.test/automation-media/qr-1.jpg", sortOrder: 0 }
        ]
      }
    ];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "tienen qr?", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText).toHaveBeenCalledTimes(1);
    expect(adapter.sendImage).toHaveBeenCalledTimes(2);
    // sort_order respected regardless of array insertion order (R8 reorder coverage)
    expect(adapter.sendImage.mock.calls[0]?.[1]).toBe("https://example.test/automation-media/qr-1.jpg");
    expect(adapter.sendImage.mock.calls[1]?.[1]).toBe("https://example.test/automation-media/qr-2.jpg");
  });

  it("R4. FAQ image only (no text): a single image reply, no empty text message", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [
      {
        id: "faq-r4",
        title: "Foto local",
        answer: "",
        aliases: ["como es el local"],
        sortOrder: 0,
        active: true,
        media: [{ url: "https://example.test/automation-media/local.jpg", sortOrder: 0 }]
      }
    ];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "como es el local?", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(adapter.sendImage).toHaveBeenCalledTimes(1);
  });

  it("R5. FAQ with no text and no media: never sends an empty reply", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    // Not realistically creatable via the admin UI (answer is required), but
    // the runner must stay safe even if a row ends up empty by accident.
    gateway.faqs = [{ id: "faq-r5", title: "Vacía", answer: "", aliases: ["frase-vacia-r5"], sortOrder: 0, active: true }];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "frase-vacia-r5", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(adapter.sendImage).not.toHaveBeenCalled();
  });

  it("R6. an inactive FAQ with media never responds", async () => {
    const repository = new MemoryRepository();
    const gateway = new FakeIntakeGateway(repository);
    gateway.faqs = [
      {
        id: "faq-r6",
        title: "Inactiva",
        answer: "No debería verse.",
        aliases: ["frase-inactiva-r6"],
        sortOrder: 0,
        active: false,
        media: [{ url: "https://example.test/automation-media/no.jpg", sortOrder: 0 }]
      }
    ];
    const adapter = adapterMock();

    await processWhatsAppWebhook(payload("wamid.1", "frase-inactiva-r6", BASE_UNIX_SECONDS), { repository, adapter, intakeGateway: gateway });

    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(adapter.sendImage).not.toHaveBeenCalled();
  });
});
