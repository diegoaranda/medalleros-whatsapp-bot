import type { ChannelAdapter, IngestedMessageContext, NormalizedInboundMessage } from "../core/types.js";
import {
  classifyIntents,
  type AlreadyFoundIntent,
  type ClassifierCompletionClient,
  type IntentClassifierConfig
} from "../ai/intent-classifier.js";
import { resolveFaqs, type AutomationFaq } from "./automation-faq.js";
import {
  applySportSelection,
  bestMatchingTerm,
  normalize,
  resolveCode,
  resolveSport,
  step,
  type CatalogSport,
  type IntakeMessages,
  type IntakeState,
  type IntakeVariables
} from "./whatsapp-intake.js";

export type IntakeExecutionStatus = "running" | "completed" | "paused_human" | "failed";

export interface IntakeExecution {
  id: string;
  status: IntakeExecutionStatus;
  state: IntakeState;
  variables: IntakeVariables;
}

export interface IntakeFlowConfig {
  flowId: string;
  flowVersionId: string;
  active: boolean;
  messages: IntakeMessages;
}

/**
 * Everything the intake runner needs from persistence, kept behind an
 * interface so the orchestration logic can be tested without a real
 * Supabase connection (see SupabaseIntakeAutomationGateway for the real
 * implementation).
 */
export interface IntakeAutomationGateway {
  getFlowConfig(companyId: string): Promise<IntakeFlowConfig | null>;
  getCatalogSports(companyId: string): Promise<{ sports: CatalogSport[]; imageIdByCode: Map<string, string> }>;
  /** Active FAQs for this flow, ordered by admin-configured priority. */
  getActiveFaqs(companyId: string, flowId: string): Promise<AutomationFaq[]>;
  getLatestExecution(flowVersionId: string, conversationId: string): Promise<IntakeExecution | null>;
  createExecution(params: {
    companyId: string;
    flowVersionId: string;
    conversationId: string;
    contactId: string;
    status: IntakeExecutionStatus;
    state: IntakeState;
    variables: IntakeVariables;
  }): Promise<void>;
  updateExecution(id: string, params: { status: IntakeExecutionStatus; state: IntakeState; variables: IntakeVariables }): Promise<void>;
  pauseConversation(conversationId: string): Promise<void>;
  /** Clears the conversation's automation pause. Only called when a completed
   * HUMAN_HANDOFF has expired (48h+ idle) and a brand-new session starts. */
  resumeConversation(conversationId: string): Promise<void>;
}

/** How long a completed HUMAN_HANDOFF stays paused before a new inbound
 * message is treated as the start of a brand-new session. Checked lazily on
 * the next inbound message only — no cron/job. */
export const HUMAN_HANDOFF_EXPIRY_MS = 48 * 60 * 60 * 1000;

function idleMillisecondsSince(previousActivity: string | null | undefined, currentTimestamp: string): number | null {
  if (!previousActivity) return null;
  const previous = Date.parse(previousActivity);
  const current = Date.parse(currentTimestamp);
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return null;
  return current - previous;
}

/** Injected GPT classifier dependencies. Undefined disables the AI fallback
 * entirely (zero OpenAI calls, identical behavior to before Fase 5) — this
 * is how both process-webhook.ts and automation-simulate.ts stay AI-free
 * until OPENAI_API_KEY is actually configured. */
export interface IntakeAiOptions {
  config: IntentClassifierConfig;
  client: ClassifierCompletionClient;
}

/** One recognized intent, for the dev-only simulator display and server
 * logs — never sent to WhatsApp. */
export interface ResolvedIntentSummary {
  kind: "code" | "sport" | "faq" | "human";
  source: "deterministic" | "ai";
  label: string;
  /** Only set for AI-sourced intents. */
  confidence?: number;
}

export interface IntakeTurnResolution {
  state: IntakeState;
  variables: IntakeVariables;
  replies: string[];
  /** Every intent that ended up driving this turn's outcome, in the order
   * they were resolved. Empty when nothing was recognized ("unknown"). */
  resolvedIntents: ResolvedIntentSummary[];
  /** Whether the GPT classifier actually ran for this turn (it may run and
   * still find nothing new). */
  aiCalled: boolean;
  aiLatencyMs: number | null;
  aiModel: string | null;
}

const STOPWORDS = new Set([
  "y",
  "o",
  "u",
  "el",
  "la",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "de",
  "del",
  "al",
  "en",
  "que",
  "como",
  "para",
  "por",
  "con",
  "sin",
  "es",
  "son",
  "esta",
  "estan",
  "hola",
  "buenas",
  "buenos",
  "dias",
  "tardes",
  "noches",
  "hey",
  "tambien",
  "ademas",
  "me",
  "mi",
  "tambien"
]);

/** True when, after removing every deterministically-matched term and a
 * small list of connector/greeting words, the message still has meaningful
 * content left — i.e. there might be another intent GPT could find. Used to
 * decide whether a GPT call is worth making at all (see resolveIntakeTurn):
 * a bare "Hola", or a message fully accounted for by what determinism
 * already found, never reaches the model. */
function hasUnexplainedContent(norm: string, matchedTerms: string[]): boolean {
  const matchedWords = new Set<string>();
  for (const term of matchedTerms) {
    for (const word of term.split(/\s+/)) if (word) matchedWords.add(word);
  }
  for (const word of norm.split(/\s+/)) {
    if (!word || word.length <= 2) continue;
    if (matchedWords.has(word) || STOPWORDS.has(word)) continue;
    return true;
  }
  return false;
}

const GREETING_WORDS = new Set(["hola", "holis", "holaa", "ola", "buenas", "buenos", "dias", "tardes", "noches", "hey", "buen", "dia", "que", "tal", "como", "estas"]);

/** True when the WHOLE message is made only of greeting words ("hola",
 * "buenas tardes", "que tal", ...) — never true for a message that also
 * mentions anything else ("hola quiero running" is NOT a simple greeting).
 * A simple greeting is never sent to GPT and never triggers a Fase 6
 * UNKNOWN -> HUMAN_HANDOFF transfer; it keeps the pre-Fase-6 behavior for
 * whatever state it arrives in (the NEW greeting, or the per-state "not
 * recognized" retry message). */
function isSimpleGreeting(norm: string): boolean {
  const words = norm.split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  return words.every((word) => GREETING_WORDS.has(word));
}

/** Drops any empty/whitespace-only text so a blank admin-configured message
 * (e.g. an unfilled template) never becomes a visibly empty WhatsApp
 * message on its own. */
function filterBlankReplies(replies: string[]): string[] {
  return replies.filter((reply) => reply && reply.trim().length > 0);
}

type Intent = { kind: "code"; code: string } | { kind: "sport"; sport: CatalogSport } | { kind: "faq"; faq: AutomationFaq };

const MAX_TOTAL_INTENTS = 3;

/**
 * Pure (no persistence, no sending) resolution of a single inbound message,
 * shared by the real webhook runner below and the /automations local
 * simulator, implementing the Fase 5 transversal / multi-intent order:
 *
 *   1. selection code (RUN-XX), only once a sport is already chosen
 *   2. sport, only while no sport is chosen yet — from the FIRST message on,
 *      not gated behind any particular state
 *   3. FAQ(s) by alias — transversal, never gated by state, and MORE THAN
 *      ONE FAQ can match the same message
 *   4. GPT classifier fallback, ONLY when 1-3 left the 3-intent cap
 *      unfilled AND the message still has content those didn't account for.
 *      GPT is told what was already found so it never repeats it, and is
 *      called AT MOST ONCE regardless of how many gaps remain.
 *
 * GPT never overrides a deterministic match, never invents a reply (a
 * matched FAQ always answers with its own stored `answer` text; a matched
 * sport always goes through the same applySportSelection() the deterministic
 * path uses; a matched code always goes through the same step() transition
 * the deterministic path uses), and anything invalid/unresolved is simply
 * dropped rather than failing the whole turn.
 *
 * Fase 6 — UNKNOWN -> HUMAN_HANDOFF: reuses the existing HUMAN_HANDOFF
 * transition/pause/48h-expiry machinery, never a separate system. Whenever
 * GPT flags `requiresHuman` (order-status follow-up, "ya pagué", a
 * complaint, an uncovered customization, a discount ask, an explicit
 * request for a person, or any commercial question nothing offered can
 * answer safely) OR nothing at all could be resolved, the turn ends in
 * HUMAN_HANDOFF with the existing admin-editable `messages.handoff` text —
 * any resolvable sport/FAQ found in the same message still answers first,
 * it is never hidden by the transfer. A bare greeting ("hola", "buenas
 * tardes") is the one deliberate exception: it never reaches GPT and never
 * transfers, keeping the exact pre-Fase-6 behavior for whatever state it
 * arrives in.
 */
export async function resolveIntakeTurn(params: {
  state: IntakeState;
  variables: IntakeVariables;
  input: string;
  messages: IntakeMessages;
  sports: CatalogSport[];
  faqs: AutomationFaq[];
  ai?: IntakeAiOptions;
}): Promise<IntakeTurnResolution> {
  const { state, variables, input, messages, sports, faqs, ai } = params;

  if (state === "HUMAN_HANDOFF") {
    return { state, variables, replies: [], resolvedIntents: [], aiCalled: false, aiLatencyMs: null, aiModel: null };
  }

  const norm = normalize(input);
  const isGreeting = !norm || isSimpleGreeting(norm);
  const sportAlreadyChosen = Boolean(variables.sportSlug);
  const currentSport = sportAlreadyChosen ? (sports.find((candidate) => candidate.slug === variables.sportSlug) ?? null) : null;

  const intents: Intent[] = [];
  const matchedTerms: string[] = [];

  // 1. selection code — only meaningful once a sport is already chosen.
  if (currentSport) {
    const code = resolveCode(input, currentSport.codes);
    if (code) {
      intents.push({ kind: "code", code });
      matchedTerms.push(normalize(code));
    }
  }

  // 2. sport — from the first message on, as long as none is chosen yet.
  if (!sportAlreadyChosen) {
    const sport = resolveSport(input, sports);
    if (sport) {
      intents.push({ kind: "sport", sport });
      const terms = [sport.slug, sport.name, ...(sport.aliases ?? [])].map(normalize);
      const term = bestMatchingTerm(norm, terms);
      if (term) matchedTerms.push(term);
    }
  }

  // 3. FAQ(s) — transversal, more than one can match the same message.
  for (const faq of resolveFaqs(input, faqs)) {
    if (intents.length >= MAX_TOTAL_INTENTS) break;
    intents.push({ kind: "faq", faq });
    const term = bestMatchingTerm(norm, faq.aliases.map(normalize));
    if (term) matchedTerms.push(term);
  }

  const deterministicIntents: ResolvedIntentSummary[] = intents.map((intent) => ({
    kind: intent.kind,
    source: "deterministic",
    label:
      intent.kind === "code"
        ? `Código ${intent.code}`
        : intent.kind === "sport"
          ? `Deporte ${intent.sport.name}`
          : `FAQ ${intent.faq.title ?? intent.faq.id}`
  }));

  // 4. GPT fallback — at most one call, only if there's still room and the
  // message has content the deterministic pass didn't account for.
  let aiCalled = false;
  let aiLatencyMs: number | null = null;
  let aiModel: string | null = null;
  let requiresHuman = false;
  const aiIntentSummaries: ResolvedIntentSummary[] = [];

  // A bare greeting is never sent to GPT (Fase 6: "no usar GPT para saludos
  // simples") — it always falls through to the pre-Fase-6 per-state
  // behavior at the bottom of this function, never to a handoff.
  if (ai && !isGreeting && intents.length < MAX_TOTAL_INTENTS && hasUnexplainedContent(norm, matchedTerms)) {
    const classifierSports = sportAlreadyChosen ? [] : sports.map((sport) => ({ id: sport.slug, name: sport.name }));
    // The classifier only ever sees id + title + classifierDescription —
    // never `answer` (Fase 5.1: GPT classifies, it never drafts a reply).
    const classifierFaqs = faqs.map((faq) => ({ id: faq.id, title: faq.title ?? faq.id, description: faq.classifierDescription ?? undefined }));
    const alreadyFound: AlreadyFoundIntent[] = intents
      .filter((intent): intent is Extract<Intent, { kind: "sport" | "faq" }> => intent.kind !== "code")
      .map((intent) => (intent.kind === "sport" ? { type: "sport" as const, id: intent.sport.slug } : { type: "faq" as const, id: intent.faq.id }));

    const outcome = await classifyIntents({
      message: input,
      sports: classifierSports,
      faqs: classifierFaqs,
      alreadyFound,
      config: ai.config,
      client: ai.client
    });
    aiCalled = true;
    aiLatencyMs = outcome.latencyMs;
    aiModel = ai.config.model;
    requiresHuman = outcome.requiresHuman;

    for (const aiIntent of outcome.intents) {
      if (intents.length >= MAX_TOTAL_INTENTS) break;
      if (aiIntent.type === "sport") {
        if (sportAlreadyChosen || intents.some((intent) => intent.kind === "sport")) continue;
        const sport = sports.find((candidate) => candidate.slug === aiIntent.id);
        if (!sport) continue;
        intents.push({ kind: "sport", sport });
        aiIntentSummaries.push({ kind: "sport", source: "ai", label: `Deporte ${sport.name}`, confidence: aiIntent.confidence });
      } else {
        if (intents.some((intent) => intent.kind === "faq" && intent.faq.id === aiIntent.id)) continue;
        const faq = faqs.find((candidate) => candidate.id === aiIntent.id);
        if (!faq) continue;
        intents.push({ kind: "faq", faq });
        aiIntentSummaries.push({ kind: "faq", source: "ai", label: `FAQ ${faq.title ?? faq.id}`, confidence: aiIntent.confidence });
      }
    }
  }

  const humanRequiredSummary: ResolvedIntentSummary[] = requiresHuman ? [{ kind: "human", source: "ai", label: "HUMAN_REQUIRED" }] : [];
  const resolvedIntents = [...deterministicIntents, ...aiIntentSummaries, ...humanRequiredSummary];
  const faqIntents = intents.filter((intent): intent is Extract<Intent, { kind: "faq" }> => intent.kind === "faq");
  const faqReplies = faqIntents.map((intent) => intent.faq.answer);
  const codeIntent = intents.find((intent): intent is Extract<Intent, { kind: "code" }> => intent.kind === "code");
  const sportIntent = intents.find((intent): intent is Extract<Intent, { kind: "sport" }> => intent.kind === "sport");

  if (codeIntent) {
    // A valid selection code always completes the flow into HUMAN_HANDOFF
    // through its own existing transition, regardless of requiresHuman — it
    // is already a full, safe resolution. The deterministic code check
    // above already guarantees step() will resolve to the exact same
    // transition; reusing it here avoids duplicating the
    // WAITING_FOR_SELECTION -> HUMAN_HANDOFF logic.
    //
    // Fase 6.2: a valid selection is ALSO a fully silent handoff now — no
    // selection-confirmation message and no transfer message, ever. step()'s
    // WAITING_FOR_SELECTION branch returns [modelSelected, handoff] as a
    // fixed pair; both are dropped here on purpose. Jhoselin picks up
    // straight from WhatsApp Business with zero bot noise; only an FAQ
    // resolved in the very same message still answers.
    const codeResult = step(state, variables, input, { messages, sports });
    return {
      state: codeResult.state,
      variables: codeResult.variables,
      replies: filterBlankReplies([...faqReplies]),
      resolvedIntents,
      aiCalled,
      aiLatencyMs,
      aiModel
    };
  }

  // Fase 6: a bare greeting never gets handed off — it keeps the exact
  // pre-Fase-6 behavior (the NEW-state greeting, or the per-state "not
  // recognized" retry message) regardless of what follows below.
  if (!isGreeting) {
    const anyResolvableIntentFound = Boolean(sportIntent) || faqIntents.length > 0;
    // UNKNOWN -> HUMAN_HANDOFF (Fase 6): either GPT explicitly flagged part
    // of the message as needing a human, or — fail-safe — nothing at all
    // could be resolved (deterministically or via GPT, including when GPT
    // wasn't configured or errored/timed out and left nothing else to fall
    // back on). A resolvable sport/FAQ intent is never hidden: it still
    // answers/transitions first. Fase 6.1: HUMAN_HANDOFF is silent — no
    // transfer message is ever appended; when nothing at all resolved,
    // replies is simply [] (Jhoselin sees the inbound message in WhatsApp
    // Business and takes over with zero bot noise).
    if (requiresHuman || !anyResolvableIntentFound) {
      const sportTransition = sportIntent ? applySportSelection(variables, sportIntent.sport, messages) : null;
      const variablesAfterSport = sportTransition ? sportTransition.variables : variables;
      const replies = filterBlankReplies([...faqReplies, ...(sportTransition ? sportTransition.replies : [])]);
      return { state: "HUMAN_HANDOFF", variables: variablesAfterSport, replies, resolvedIntents, aiCalled, aiLatencyMs, aiModel };
    }
  }

  if (sportIntent) {
    const transition = applySportSelection(variables, sportIntent.sport, messages);
    return {
      state: transition.state,
      variables: transition.variables,
      replies: [...faqReplies, ...transition.replies],
      resolvedIntents,
      aiCalled,
      aiLatencyMs,
      aiModel
    };
  }

  if (faqIntents.length) {
    // FAQs never change state/variables; NEW is bootstrap-only, so the very
    // first message still needs to move past it even when all it contained
    // was an FAQ (no separate greeting is sent — the FAQ answer already
    // acknowledges the customer).
    const nextState: IntakeState = state === "NEW" ? "WAITING_FOR_SPORT" : state;
    return { state: nextState, variables, replies: faqReplies, resolvedIntents, aiCalled, aiLatencyMs, aiModel };
  }

  // Only reachable for a bare greeting with nothing else resolved: fall
  // back to the original state-machine behavior (NEW greeting, or the
  // per-state "not recognized" retry message) instead of transferring.
  const fallback = step(state, variables, input, { messages, sports });
  return { state: fallback.state, variables: fallback.variables, replies: fallback.replies, resolvedIntents, aiCalled, aiLatencyMs, aiModel };
}

/**
 * Connects the deterministic whatsapp-intake state machine to a real inbound
 * WhatsApp message. This is the ONLY place that decides whether the
 * automation may respond: it fails closed (no reply) whenever the flow
 * cannot be confirmed as active, the conversation is paused for a human and
 * that pause hasn't expired, or anything below fails unexpectedly. It never
 * throws — a bot failure must never prevent the inbound message from having
 * been saved.
 *
 * HUMAN_HANDOFF auto-expiry (48h of conversation inactivity, checked lazily
 * here on the next inbound message, no cron): a completed execution only
 * unblocks a brand-new session once idle time since the conversation's prior
 * activity — conversations.last_message_at from BEFORE this message, via
 * context.previousLastMessageAt — reaches the threshold. Any other paused
 * state (e.g. a future manual/Coexistence-detected human takeover) stays
 * paused indefinitely; only our own completed HUMAN_HANDOFF auto-expires.
 */
export async function runWhatsAppIntakeAutomation(
  gateway: IntakeAutomationGateway,
  adapter: ChannelAdapter,
  message: NormalizedInboundMessage,
  context: IngestedMessageContext,
  ai?: IntakeAiOptions
): Promise<void> {
  if (context.duplicate) return;

  try {
    const flow = await gateway.getFlowConfig(context.companyId);
    if (!flow || flow.active !== true) return; // inactive, missing, or undetermined -> fail closed

    const { sports, imageIdByCode } = await gateway.getCatalogSports(context.companyId);

    const existing = await gateway.getLatestExecution(flow.flowVersionId, context.conversationId);
    const conversationPaused = context.automationStatus === "paused_human";
    const handoffCompleted = existing?.status === "completed";

    let startFresh = false;

    if (conversationPaused || handoffCompleted) {
      if (!handoffCompleted) return; // paused for a reason that isn't our own handoff -> stay silent, no auto-expiry

      const idleMs = idleMillisecondsSince(context.previousLastMessageAt, message.timestamp);
      if (idleMs === null || idleMs < HUMAN_HANDOFF_EXPIRY_MS) return; // still within the window, or unknown -> stay silent

      startFresh = true; // 48h+ idle since the last activity before this message: the previous session is over
    } else if (existing && existing.status !== "running") {
      return; // e.g. a failed execution -> stay silent, no auto-recovery defined for this
    }

    const state: IntakeState = startFresh ? "NEW" : (existing?.state ?? "NEW");
    const variables: IntakeVariables = startFresh ? {} : (existing?.variables ?? {});

    const target = {
      channelExternalId: context.channelExternalId,
      credentialEnvKey: context.channelCredentialEnvKey,
      recipientExternalId: context.senderExternalId
    };

    const faqs = await gateway.getActiveFaqs(context.companyId, flow.flowId);
    const outcome = await resolveIntakeTurn({ state, variables, input: message.text ?? "", messages: flow.messages, sports, faqs, ai });

    console.info("intake_turn_resolved", {
      conversationId: context.conversationId,
      intents: outcome.resolvedIntents.map((intent) => ({ kind: intent.kind, source: intent.source, confidence: intent.confidence })),
      aiCalled: outcome.aiCalled,
      aiLatencyMs: outcome.aiLatencyMs,
      aiModel: outcome.aiModel
    });

    let variablesToPersist: IntakeVariables = outcome.variables;
    if (outcome.state === "HUMAN_HANDOFF" && outcome.variables.selectedCode) {
      const imageId = imageIdByCode.get(outcome.variables.selectedCode);
      if (imageId) variablesToPersist = { ...outcome.variables, imageId };
    }

    const status: IntakeExecutionStatus = outcome.state === "HUMAN_HANDOFF" ? "completed" : "running";

    if (existing && !startFresh) {
      await gateway.updateExecution(existing.id, { status, state: outcome.state, variables: variablesToPersist });
    } else {
      await gateway.createExecution({
        companyId: context.companyId,
        flowVersionId: flow.flowVersionId,
        conversationId: context.conversationId,
        contactId: context.contactId,
        status,
        state: outcome.state,
        variables: variablesToPersist
      });
    }

    if (startFresh) {
      await gateway.resumeConversation(context.conversationId);
    }
    if (outcome.state === "HUMAN_HANDOFF") {
      await gateway.pauseConversation(context.conversationId);
    }

    for (const text of outcome.replies) {
      await adapter.sendText(target, text);
    }
  } catch (error) {
    console.error("whatsapp_intake_automation_failed", {
      conversationId: context.conversationId,
      error: error instanceof Error ? error.message : "Unknown intake automation error"
    });
  }
}
