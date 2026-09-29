export type ClassifierIntentType = "sport" | "faq";

export interface ClassifierSportOption {
  /** Stable slug — the id the classifier must echo back verbatim. */
  id: string;
  name: string;
}

export interface ClassifierFaqOption {
  id: string;
  title: string;
  /** Optional, admin-written guidance on when this FAQ applies. Sent to the
   * classifier to disambiguate short/generic titles — the customer-facing
   * `answer` text is NEVER sent here, only id + title + description. */
  description?: string | null;
}

export interface ClassifierIntent {
  type: ClassifierIntentType;
  id: string;
  confidence: number;
}

export interface IntentClassifierConfig {
  apiKey: string;
  model: string;
  minConfidence: number;
  timeoutMs: number;
}

export interface ClassifierCompletionRequest {
  apiKey: string;
  model: string;
  timeoutMs: number;
  systemPrompt: string;
  userMessage: string;
}

/**
 * Talks to the model provider and returns its raw (unvalidated) text
 * response. Kept behind an interface so the classification logic — and
 * every test that exercises it — never makes a real network call; tests
 * inject a fake implementation instead.
 */
export interface ClassifierCompletionClient {
  complete(request: ClassifierCompletionRequest): Promise<string>;
}

const MAX_INTENTS = 3;

const RESPONSE_JSON_SCHEMA = {
  name: "intent_classification",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      intents: {
        type: "array",
        maxItems: MAX_INTENTS,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["sport", "faq"] },
            id: { type: "string" },
            confidence: { type: "number" }
          },
          required: ["type", "id", "confidence"]
        }
      },
      requires_human: { type: "boolean" }
    },
    required: ["intents", "requires_human"]
  }
} as const;

/**
 * Real OpenAI Chat Completions client, used only when OPENAI_API_KEY is
 * configured. This is the ONLY function in the codebase allowed to make a
 * network call to OpenAI, and it is never invoked by the test suite (tests
 * inject ClassifierCompletionClient fakes instead).
 *
 * `reasoning_effort: "low"` is set deliberately: gpt-5-nano is a reasoning
 * model that, at its default effort, spends 500+ hidden "reasoning tokens"
 * (~5s+) even on a trivial classification prompt — comfortably exceeding
 * AI_CLASSIFIER_TIMEOUT_MS=4000 and making every call fail closed to
 * "unknown" with confidence 0. "low" effort cuts that to ~1.5-2.5s while
 * keeping classification quality (see the investigation notes in the Fase 5
 * report). This is a request-parameter fix, not a model change.
 */
export class OpenAiCompletionClient implements ClassifierCompletionClient {
  async complete(request: ClassifierCompletionRequest): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${request.apiKey}` },
        body: JSON.stringify({
          model: request.model,
          reasoning_effort: "low",
          messages: [
            { role: "system", content: request.systemPrompt },
            { role: "user", content: request.userMessage }
          ],
          response_format: { type: "json_schema", json_schema: RESPONSE_JSON_SCHEMA }
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`openai_http_${response.status}`);
      const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("openai_empty_response");
      return content;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Reads classifier config from server-side env vars only. Returns null
 * (classifier disabled) when OPENAI_API_KEY is absent, so the automation
 * makes zero AI calls until it is explicitly configured. */
export function loadIntentClassifierConfigFromEnv(): IntentClassifierConfig | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.OPENAI_CLASSIFIER_MODEL || "gpt-5-nano";
  const minConfidence = Number(process.env.AI_CLASSIFIER_MIN_CONFIDENCE ?? "0.80");
  const timeoutMs = Number(process.env.AI_CLASSIFIER_TIMEOUT_MS ?? "8000");
  return {
    apiKey,
    model,
    minConfidence: Number.isFinite(minConfidence) ? minConfidence : 0.8,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000
  };
}

/** An intent the caller already resolved deterministically (or from an
 * earlier part of this same classification), so the model is told not to
 * repeat it — see resolveIntakeTurn in intake-runner.ts. */
export interface AlreadyFoundIntent {
  type: ClassifierIntentType;
  id: string;
}

function buildSystemPrompt(sports: ClassifierSportOption[], faqs: ClassifierFaqOption[], alreadyFound: AlreadyFoundIntent[]): string {
  const sportLines = sports.map((sport) => `- id="${sport.id}" name="${sport.name}"`).join("\n") || "(ninguno disponible)";
  const faqLines =
    faqs
      .map((faq) => {
        const description = faq.description?.trim();
        return description ? `- id="${faq.id}" title="${faq.title}" description="${description}"` : `- id="${faq.id}" title="${faq.title}"`;
      })
      .join("\n") || "(ninguna disponible)";
  const alreadyFoundLines =
    alreadyFound.map((intent) => `- ${intent.type} id="${intent.id}"`).join("\n") || "(ninguna todavía)";

  return [
    "Eres un clasificador de intención para un bot de WhatsApp de una tienda de medallas deportivas en Bolivia.",
    "Tu ÚNICA tarea es leer el mensaje del cliente y devolver TODAS las intenciones (deporte y/o FAQ) que reconozcas con seguridad, de la lista ofrecida. No redactas ninguna respuesta para el cliente. No inventas deportes ni FAQ que no estén en las listas.",
    "Un mensaje puede contener más de una intención (por ejemplo, preguntar por la ubicación Y pedir un deporte a la vez). Devuelve una entrada por cada intención distinta que identifiques, hasta un máximo de 3.",
    "",
    'Los mensajes reales de clientes suelen tener errores de tipeo, sin tildes, abreviados o coloquiales (ej: "d donde son", "q material usan"). Interpreta la intención real, no solo coincidencias literales de palabras.',
    "",
    "Cada FAQ tiene un título y, cuando está disponible, una descripción (\"description\") escrita por el administrador que indica EXACTAMENTE cuándo usarla y cuándo NO usarla — esa descripción es más confiable que el título por sí solo y debes seguirla al pie de la letra, incluyendo sus exclusiones explícitas. Si una FAQ no tiene descripción, guíate solo por su título de forma conservadora.",
    "NO clasifiques ninguna FAQ para: mensajes sobre el estado de un pedido YA hecho por el cliente, quejas o problemas puntuales, confirmaciones de pago ya realizado (\"ya pagué\"), pedidos de hablar con una persona, o solicitudes de personalización — esos casos simplemente no generan ninguna intención, aunque compartan una palabra con el título de una FAQ.",
    "",
    "Además de `intents`, debes devolver `requires_human` (true/false): indica que hay una parte del mensaje que el bot NO debe intentar resolver por sí solo y que necesita atención de una persona. No redactas nada para esa parte — solo señalas que existe.",
    "Marca requires_human=true cuando el mensaje (o una parte de él) sea: seguimiento o estado de un pedido YA existente, el cliente diciendo que ya pagó/hizo un depósito, un comprobante de pago, una queja o problema/reclamo, una modificación especial o personalización no cubierta por ninguna FAQ, una negociación o pedido de descuento, una solicitud explícita de hablar con una persona, o cualquier pregunta comercial que ninguna FAQ o deporte de la lista pueda responder con seguridad.",
    "Marca requires_human=false cuando el mensaje sea un saludo simple, o cuando todo lo relevante del mensaje ya quedó cubierto por las intenciones (deporte/FAQ) que identificaste — no marques requires_human=true solo porque el mensaje también resolvió una intención válida.",
    "requires_human es independiente de `intents`: un mensaje puede tener una intención válida (ej. un deporte) Y ADEMÁS requerir humano por otra parte del mismo mensaje (ej. \"quiero running pero necesito un diseño totalmente personalizado\" -> intents con el deporte, requires_human=true por la personalización).",
    "",
    "CONTEXTO GEOGRÁFICO: cuando el cliente menciona una ciudad, departamento o \"provincia\", o dice \"soy de...\"/\"estoy en...\", interpreta semánticamente qué significa eso usando la descripción de cada FAQ — NO existe una lista fija de ciudades que reconozcas de memoria; usa el razonamiento (ej: si la descripción de una FAQ dice que aplica cuando el cliente está fuera de la ciudad donde opera el negocio, y el cliente nombra cualquier otra ciudad/lugar, esa FAQ aplica; si la descripción de otra FAQ dice que es solo sobre la ubicación del NEGOCIO y aclara que no debe usarse solo porque el cliente mencione su propia ciudad, entonces esa otra FAQ NO aplica en ese caso).",
    "",
    "confidence debe reflejar tu seguridad real: usa 0.85-1.0 solo cuando el mensaje claramente pide información general sobre el tema de una FAQ o deporte de la lista. Si no estás segura, no incluyas esa intención en la respuesta.",
    "",
    "Una parte del mensaje YA fue resuelta por otra vía (ver la lista de abajo) — pero eso NO significa que el mensaje completo ya esté resuelto. Analiza el mensaje COMPLETO de nuevo, de forma independiente, buscando cualquier intención ADICIONAL (deporte o FAQ) que también esté presente, aunque el mensaje ya mencione otra cosa. Un mensaje casi siempre combina varias ideas distintas (ej: ubicación + deporte, o dos FAQ distintas) y tu trabajo es encontrar TODAS las que apliquen, no solo la más obvia. Simplemente no repitas en tu respuesta las que ya aparecen en esa lista.",
    "Divide mentalmente el mensaje en sus cláusulas (separadas por \"y\", \"además\", \"también\", comas, etc.) y evalúa CADA cláusula por separado contra las listas de deportes y FAQ — incluida la cláusula que ya fue resuelta, y cualquier otra. No dejes de reportar una intención real solo porque el mensaje ya contenía otra.",
    "",
    "Intenciones que YA fueron detectadas por otra vía (no las repitas en tu respuesta):",
    alreadyFoundLines,
    "",
    "Deportes disponibles:",
    sportLines,
    "",
    "FAQ disponibles:",
    faqLines,
    "",
    'Responde SOLO un JSON con la forma {"intents":[{"type":"sport"|"faq","id":"<id>","confidence":<numero entre 0 y 1>}, ...],"requires_human":true|false}. El array de intents puede quedar vacío si, tras ese reanálisis completo, no encuentras ninguna intención adicional real; requires_human es obligatorio siempre.'
  ].join("\n");
}

function isValidIntentType(value: unknown): value is ClassifierIntentType {
  return value === "sport" || value === "faq";
}

function validateIntents(
  raw: unknown,
  sports: ClassifierSportOption[],
  faqs: ClassifierFaqOption[],
  alreadyFound: AlreadyFoundIntent[],
  minConfidence: number
): ClassifierIntent[] {
  if (!raw || typeof raw !== "object") return [];
  const candidate = (raw as Record<string, unknown>).intents;
  if (!Array.isArray(candidate)) return [];

  const alreadyFoundKeys = new Set(alreadyFound.map((intent) => `${intent.type}:${intent.id}`));
  const seen = new Set<string>();
  const validated: ClassifierIntent[] = [];

  for (const entry of candidate) {
    if (!entry || typeof entry !== "object") continue; // one malformed entry never invalidates the rest
    const item = entry as Record<string, unknown>;
    if (!isValidIntentType(item.type)) continue;
    const id = typeof item.id === "string" && item.id ? item.id : null;
    if (!id) continue;
    const confidence = typeof item.confidence === "number" && Number.isFinite(item.confidence) ? item.confidence : 0;
    if (confidence < minConfidence) continue;

    const exists = item.type === "sport" ? sports.some((sport) => sport.id === id) : faqs.some((faq) => faq.id === id);
    if (!exists) continue; // invented id -> discarded, doesn't affect other entries

    const key = `${item.type}:${id}`;
    if (alreadyFoundKeys.has(key) || seen.has(key)) continue; // no repeated intent
    seen.add(key);
    validated.push({ type: item.type, id, confidence });
  }

  // Highest-confidence intents win when the model still returns more than
  // the requested maximum.
  validated.sort((a, b) => b.confidence - a.confidence);
  return validated.slice(0, MAX_INTENTS);
}

function parseRequiresHuman(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const value = (raw as Record<string, unknown>).requires_human;
  return value === true;
}

export interface ClassifyIntentsParams {
  message: string;
  sports: ClassifierSportOption[];
  faqs: ClassifierFaqOption[];
  /** Intents already resolved (deterministically, or earlier), so the model
   * knows not to return them again. */
  alreadyFound?: AlreadyFoundIntent[];
  config: IntentClassifierConfig;
  client: ClassifierCompletionClient;
}

export interface ClassifyIntentsOutcome {
  intents: ClassifierIntent[];
  /** True when GPT flagged that some part of the message needs a human
   * (order-status follow-up, "ya pagué", a complaint, a custom request, a
   * discount ask, an explicit request to talk to a person, or a commercial
   * question nothing in the offered lists can answer safely). Independent
   * of `intents` — a message can resolve a sport/FAQ AND still need a
   * human for another part of the same message. Defaults to false on any
   * error/timeout/invalid response (never fabricated). */
  requiresHuman: boolean;
  latencyMs: number;
}

/**
 * Fail-closed, multi-intent GPT classification: any timeout, HTTP/network
 * error, invalid JSON, or a type/id that doesn't match the options actually
 * offered collapses that entry (never the whole call) to being dropped —
 * an empty `intents` array is the safe "found nothing new" result. Makes at
 * most one completion call per invocation; the caller decides whether to
 * call this at all (only when deterministic rules left something
 * unexplained, and there's still room under the 3-intent cap).
 */
export async function classifyIntents(params: ClassifyIntentsParams): Promise<ClassifyIntentsOutcome> {
  const started = Date.now();
  const alreadyFound = params.alreadyFound ?? [];
  if (!params.sports.length && !params.faqs.length) {
    return { intents: [], requiresHuman: false, latencyMs: Date.now() - started };
  }
  try {
    const systemPrompt = buildSystemPrompt(params.sports, params.faqs, alreadyFound);
    const raw = await params.client.complete({
      apiKey: params.config.apiKey,
      model: params.config.model,
      timeoutMs: params.config.timeoutMs,
      systemPrompt,
      userMessage: params.message
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { intents: [], requiresHuman: false, latencyMs: Date.now() - started };
    }

    const intents = validateIntents(parsed, params.sports, params.faqs, alreadyFound, params.config.minConfidence);
    const requiresHuman = parseRequiresHuman(parsed);
    return { intents, requiresHuman, latencyMs: Date.now() - started };
  } catch {
    return { intents: [], requiresHuman: false, latencyMs: Date.now() - started };
  }
}
