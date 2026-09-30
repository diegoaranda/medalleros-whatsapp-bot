import type { ChannelAdapter, IngestedMessageContext, NormalizedInboundMessage } from "../core/types.js";
import {
  classifyIntents,
  type AlreadyFoundIntent,
  type ClassifierCompletionClient,
  type IntentClassifierConfig
} from "../ai/intent-classifier.js";
import { resolveFaqs, type AutomationFaq } from "./automation-faq.js";
import { filterBlankReplyItems, imageReply, textReply, type ReplyItem } from "./reply.js";
import {
  applySportSelection,
  bestMatchingTerm,
  normalize,
  resolveCodes,
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
 *
 * Fase 7: `pauseConversation`/`resumeConversation` are kept on the
 * interface for backward compatibility (no destructive removal), but
 * `runWhatsAppIntakeAutomation` below no longer calls them — handoff is
 * per-message metadata now, not a conversation-level pause. See that
 * function's docstring.
 */
export interface IntakeAutomationGateway {
  getFlowConfig(companyId: string): Promise<IntakeFlowConfig | null>;
  /** `imageUrlByCode` (Fase 8) is the already-public URL for each catalog
   * design, reused as-is for the WhatsApp image reply — never re-uploaded or
   * copied into another bucket. */
  getCatalogSports(companyId: string): Promise<{ sports: CatalogSport[]; imageIdByCode: Map<string, string>; imageUrlByCode: Map<string, string> }>;
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
  resumeConversation(conversationId: string): Promise<void>;
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
  /** The CONTINUABLE flow state — what gets persisted and fed into the next
   * inbound message's resolveIntakeTurn call. Fase 7: this is never
   * "HUMAN_HANDOFF" — a handoff is signaled via `handoff` below instead, so
   * it can never block or gate a future message. */
  state: IntakeState;
  variables: IntakeVariables;
  replies: ReplyItem[];
  /** Every intent that ended up driving this turn's outcome, in the order
   * they were resolved. Empty when nothing was recognized ("unknown"). */
  resolvedIntents: ResolvedIntentSummary[];
  /** True when THIS message's turn required a human (UNKNOWN, requires_human,
   * or a valid RUN-XX selection) — dev/analytics metadata only. It never
   * pauses the conversation and never affects how the NEXT inbound message
   * is resolved; every message is evaluated independently. */
  handoff: boolean;
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
 * A simple greeting is never sent to GPT and never triggers a handoff; it
 * keeps the exact pre-existing behavior for whatever state it arrives in. */
function isSimpleGreeting(norm: string): boolean {
  const words = norm.split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  return words.every((word) => GREETING_WORDS.has(word));
}

/** An FAQ's own reply: its text (if non-blank) followed by its attached
 * images in admin-configured order (Fase 8). */
function faqReplyItems(faq: AutomationFaq): ReplyItem[] {
  const items: ReplyItem[] = [];
  if (faq.answer && faq.answer.trim()) items.push(textReply(faq.answer));
  for (const media of [...(faq.media ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)) {
    items.push(imageReply(media.url));
  }
  return items;
}

type Intent = { kind: "code"; codes: string[] } | { kind: "sport"; sport: CatalogSport } | { kind: "faq"; faq: AutomationFaq };

const MAX_TOTAL_INTENTS = 3;

/** Fase 7 defensive normalization: some already-persisted executions may
 * still carry the legacy "HUMAN_HANDOFF" node id from before per-message
 * handoff existed. Since that value is never produced going forward, treat
 * it the same way a fresh message would be treated given the variables
 * already on file — sport chosen -> ready for a selection, otherwise ready
 * for a sport — so an old row can never permanently block future messages. */
function normalizeLegacyState(state: IntakeState, variables: IntakeVariables): IntakeState {
  if (state !== "HUMAN_HANDOFF") return state;
  return variables.sportSlug ? "WAITING_FOR_SELECTION" : "WAITING_FOR_SPORT";
}

/**
 * Pure (no persistence, no sending) resolution of a single inbound message,
 * shared by the real webhook runner below and the /automations local
 * simulator, implementing the multi-intent resolution order:
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
 * path uses), and anything invalid/unresolved is simply dropped rather than
 * failing the whole turn.
 *
 * Fase 7 — handoff is PER MESSAGE, not per conversation: a valid RUN-XX
 * selection, an explicit `requiresHuman` flag from GPT, or nothing at all
 * resolvable all produce a completely silent turn (`handoff: true`,
 * `replies` filtered of any blank text) — but the returned `state` is
 * always a normal, continuable flow state (never "HUMAN_HANDOFF"), so the
 * very next inbound message is evaluated exactly like any other: a bot and
 * a human agent can answer turns in the same conversation back to back. A
 * bare greeting ("hola", "buenas tardes") is the one deliberate exception:
 * it never reaches GPT and never counts as a handoff, keeping the original
 * per-state behavior (the NEW greeting, or the "not recognized" retry
 * message).
 */
export async function resolveIntakeTurn(params: {
  state: IntakeState;
  variables: IntakeVariables;
  input: string;
  messages: IntakeMessages;
  sports: CatalogSport[];
  faqs: AutomationFaq[];
  /** Fase 8: public URL for each catalog design code, used to build the
   * image reply for a RUN-XX selection. A valid code with no entry here is
   * never invented into a reply — it's simply skipped. */
  imageUrlByCode?: Map<string, string>;
  ai?: IntakeAiOptions;
}): Promise<IntakeTurnResolution> {
  const state = normalizeLegacyState(params.state, params.variables);
  const { variables, input, messages, sports, faqs, ai } = params;
  const imageUrlByCode = params.imageUrlByCode ?? new Map<string, string>();

  const norm = normalize(input);
  const isGreeting = !norm || isSimpleGreeting(norm);
  const sportAlreadyChosen = Boolean(variables.sportSlug);
  const currentSport = sportAlreadyChosen ? (sports.find((candidate) => candidate.slug === variables.sportSlug) ?? null) : null;

  const intents: Intent[] = [];
  const matchedTerms: string[] = [];

  // 1. selection code(s). A code (e.g. "RUN-08") is sport-prefixed and
  // unique across the whole catalog, so it identifies its sport on its own —
  // no prior "which sport?" turn is required. If a sport is already chosen,
  // codes are matched only against ITS catalog (unchanged behavior); if none
  // is chosen yet, every sport's codes are checked so a first message like
  // "Me interesa este diseño: RUN-08" resolves deterministically, and that
  // sport is adopted below exactly as if the customer had named it.
  let codeSport: CatalogSport | null = currentSport;
  let codes: string[] = [];
  if (currentSport) {
    codes = resolveCodes(input, currentSport.codes);
  } else {
    for (const sport of sports) {
      const found = resolveCodes(input, sport.codes);
      if (found.length) {
        codeSport = sport;
        codes = found;
        break;
      }
    }
  }
  if (codes.length) {
    intents.push({ kind: "code", codes });
    for (const code of codes) matchedTerms.push(normalize(code));
  }

  // 2. sport — from the first message on, as long as none is chosen yet. A
  // code match above already identifies its sport, so it takes precedence
  // and this step is skipped (avoids a redundant/contradictory sport intent
  // and an unnecessary GPT call for the same message).
  if (!sportAlreadyChosen && !codeSport) {
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
        ? `Código ${intent.codes.join(", ")}`
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

  // A bare greeting is never sent to GPT and never counts as a handoff — it
  // always falls through to the original per-state behavior at the bottom
  // of this function.
  if (ai && !isGreeting && intents.length < MAX_TOTAL_INTENTS && hasUnexplainedContent(norm, matchedTerms)) {
    const classifierSports = sportAlreadyChosen || codeSport ? [] : sports.map((sport) => ({ id: sport.slug, name: sport.name }));
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
  const faqReplies = faqIntents.flatMap((intent) => faqReplyItems(intent.faq));
  const codeIntent = intents.find((intent): intent is Extract<Intent, { kind: "code" }> => intent.kind === "code");
  const sportIntent = intents.find((intent): intent is Extract<Intent, { kind: "sport" }> => intent.kind === "sport");

  if (codeIntent) {
    // A valid selection is a full, safe resolution and a silent per-message
    // handoff: the customer perceives no confirmation/transfer text — only
    // the real design image(s) — and the conversation stays fully alive for
    // the NEXT message (state stays WAITING_FOR_SELECTION, sport context
    // preserved) rather than freezing on a terminal "HUMAN_HANDOFF" node.
    // Fase 8: one image per valid selected code, in the order mentioned; a
    // code with no catalog image on file is skipped rather than invented.
    const imageReplies = codeIntent.codes.flatMap((code) => {
      const url = imageUrlByCode.get(code);
      return url ? [imageReply(url)] : [];
    });
    const nextVariables: IntakeVariables = {
      ...variables,
      sportSlug: variables.sportSlug ?? codeSport?.slug,
      selectedCode: codeIntent.codes[0],
      selectedCodes: codeIntent.codes
    };
    return {
      state: "WAITING_FOR_SELECTION",
      variables: nextVariables,
      replies: filterBlankReplyItems([...faqReplies, ...imageReplies]),
      resolvedIntents,
      handoff: true,
      aiCalled,
      aiLatencyMs,
      aiModel
    };
  }

  // A bare greeting never counts as a handoff — it keeps the exact original
  // behavior (the NEW-state greeting, or the per-state "not recognized"
  // retry message) regardless of what follows below.
  if (!isGreeting) {
    const anyResolvableIntentFound = Boolean(sportIntent) || faqIntents.length > 0;
    // Silent per-message handoff: either GPT explicitly flagged part of the
    // message as needing a human, or — fail-safe — nothing at all could be
    // resolved (deterministically or via GPT, including when GPT wasn't
    // configured or errored/timed out and left nothing else to fall back
    // on). A resolvable sport/FAQ intent is never hidden: it still
    // answers/transitions first. `state` stays a normal continuable state
    // (never "HUMAN_HANDOFF") so the next message is evaluated normally —
    // handoff is metadata (`handoff: true`) for the simulator/logs only.
    if (requiresHuman || !anyResolvableIntentFound) {
      const sportTransition = sportIntent ? applySportSelection(variables, sportIntent.sport, messages) : null;
      const continuationState: IntakeState = sportTransition ? sportTransition.state : state === "NEW" ? "WAITING_FOR_SPORT" : state;
      const continuationVariables = sportTransition ? sportTransition.variables : variables;
      const replies = filterBlankReplyItems([...faqReplies, ...(sportTransition ? sportTransition.replies.map(textReply) : [])]);
      return { state: continuationState, variables: continuationVariables, replies, resolvedIntents, handoff: true, aiCalled, aiLatencyMs, aiModel };
    }
  }

  if (sportIntent) {
    const transition = applySportSelection(variables, sportIntent.sport, messages);
    return {
      state: transition.state,
      variables: transition.variables,
      replies: [...faqReplies, ...transition.replies.map(textReply)],
      resolvedIntents,
      handoff: false,
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
    return { state: nextState, variables, replies: faqReplies, resolvedIntents, handoff: false, aiCalled, aiLatencyMs, aiModel };
  }

  // Only reachable for a bare greeting with nothing else resolved: fall
  // back to the original state-machine behavior (NEW greeting, or the
  // per-state "not recognized" retry message) instead of a handoff.
  const fallback = step(state, variables, input, { messages, sports });
  return { state: fallback.state, variables: fallback.variables, replies: fallback.replies.map(textReply), resolvedIntents, handoff: false, aiCalled, aiLatencyMs, aiModel };
}

/**
 * Connects the deterministic whatsapp-intake state machine to a real inbound
 * WhatsApp message. This is the ONLY place that decides whether the
 * automation may respond: it fails closed (no reply) whenever the flow
 * cannot be confirmed as active, or anything below fails unexpectedly. It
 * never throws — a bot failure must never prevent the inbound message from
 * having been saved.
 *
 * Fase 7 — handoff is per message, not per conversation: the bot and a
 * human agent (Jhoselin, from WhatsApp Business) share the same
 * conversation naturally. A message that needs a human (UNKNOWN,
 * `requiresHuman`, or a valid RUN-XX selection) produces zero bot replies
 * for THAT message only — it never calls pauseConversation and never marks
 * the execution "completed", so the very next inbound message is resolved
 * completely normally (a resolvable FAQ/sport answers automatically even
 * right after a handoff turn). There is deliberately no 48h pause/expiry in
 * this active path any more (that mechanism has no remaining purpose once
 * handoff no longer pauses anything); `pauseConversation`/`resumeConversation`
 * stay on the gateway interface for compatibility but are unused here.
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

    const { sports, imageIdByCode, imageUrlByCode } = await gateway.getCatalogSports(context.companyId);
    const existing = await gateway.getLatestExecution(flow.flowVersionId, context.conversationId);

    const state: IntakeState = existing?.state ?? "NEW";
    const variables: IntakeVariables = existing?.variables ?? {};

    const target = {
      channelExternalId: context.channelExternalId,
      credentialEnvKey: context.channelCredentialEnvKey,
      recipientExternalId: context.senderExternalId
    };

    const faqs = await gateway.getActiveFaqs(context.companyId, flow.flowId);
    const outcome = await resolveIntakeTurn({ state, variables, input: message.text ?? "", messages: flow.messages, sports, faqs, imageUrlByCode, ai });

    console.info("intake_turn_resolved", {
      conversationId: context.conversationId,
      handoff: outcome.handoff,
      intents: outcome.resolvedIntents.map((intent) => ({ kind: intent.kind, source: intent.source, confidence: intent.confidence })),
      aiCalled: outcome.aiCalled,
      aiLatencyMs: outcome.aiLatencyMs,
      aiModel: outcome.aiModel
    });

    let variablesToPersist: IntakeVariables = outcome.variables;
    if (outcome.variables.selectedCode) {
      const imageId = imageIdByCode.get(outcome.variables.selectedCode);
      if (imageId) variablesToPersist = { ...outcome.variables, imageId };
    }

    if (existing) {
      await gateway.updateExecution(existing.id, { status: "running", state: outcome.state, variables: variablesToPersist });
    } else {
      await gateway.createExecution({
        companyId: context.companyId,
        flowVersionId: flow.flowVersionId,
        conversationId: context.conversationId,
        contactId: context.contactId,
        status: "running",
        state: outcome.state,
        variables: variablesToPersist
      });
    }

    for (const item of outcome.replies) {
      if (item.type === "text") await adapter.sendText(target, item.text);
      else await adapter.sendImage(target, item.url, item.caption);
    }
  } catch (error) {
    console.error("whatsapp_intake_automation_failed", {
      conversationId: context.conversationId,
      error: error instanceof Error ? error.message : "Unknown intake automation error"
    });
  }
}
