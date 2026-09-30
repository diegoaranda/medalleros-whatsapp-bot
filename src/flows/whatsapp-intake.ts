export type IntakeState = "NEW" | "WAITING_FOR_SPORT" | "SHOWING_OPTIONS" | "WAITING_FOR_SELECTION" | "HUMAN_HANDOFF";

export interface IntakeMessages {
  greeting: string;
  sportRecognized: string;
  sportNotRecognized: string;
  modelSelected: string;
  handoff: string;
}

export const DEFAULT_INTAKE_MESSAGES: IntakeMessages = {
  greeting: "Hola 👋 ¿Qué deporte estás buscando?",
  sportRecognized: "Tenemos estos diseños de {{sport}} 👇\n{{catalog_url}}",
  sportNotRecognized: "¿Qué deporte estás buscando?",
  modelSelected: "Perfecto 🙌 elegiste el {{code}}.",
  handoff: "Ya te ayudamos con el modelo 😊 ahora te atendemos personalmente para precio y detalles."
};

export interface CatalogSport {
  slug: string;
  name: string;
  codes: string[];
  aliases?: string[];
  catalogUrl?: string;
}

export interface IntakeVariables {
  sportSlug?: string;
  sportName?: string;
  selectedCode?: string;
  /** Fase 8: every code selected across one or more messages (not just the
   * most recent one) — additive alongside `selectedCode`, which is kept for
   * backward compatibility and always mirrors the FIRST entry here. */
  selectedCodes?: string[];
  /** Set by the integration layer once a selection is persisted, never by step() itself. */
  imageId?: string;
}

export interface IntakeContext {
  messages: IntakeMessages;
  sports: CatalogSport[];
}

export interface IntakeStepResult {
  state: IntakeState;
  variables: IntakeVariables;
  replies: string[];
}

/** Lowercases, strips accents and common punctuation, and collapses
 * whitespace, so matching is insensitive to case/tildes/¿?¡!.,; and extra
 * spaces. Shared by sport and FAQ resolution. */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[¿?¡!.,;:()"'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `needle` (a single word or a multi-word phrase) appears in
 * `haystack` at word/phrase boundaries — never as a bare substring of an
 * unrelated word (e.g. "envio" must not match inside "reenvioso"). Both
 * strings are expected to already be normalize()d. No fuzzy matching. */
export function containsWholeWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`).test(haystack);
}

/** The longest of `terms` (already normalize()d) that matches `norm` (also
 * already normalize()d), either as the whole message or as a whole
 * word/phrase within it — or null if none match. Used both to pick the most
 * specific match among several candidate terms (sport, FAQ alias) and, by
 * the multi-intent resolver in intake-runner.ts, to estimate how much of a
 * message a deterministic match actually accounts for. */
export function bestMatchingTerm(norm: string, terms: string[]): string | null {
  let best: string | null = null;
  for (const term of terms) {
    if (!term) continue;
    if (term === norm || containsWholeWord(norm, term)) {
      if (!best || term.length > best.length) best = term;
    }
  }
  return best;
}

/**
 * Resolves a sport purely from data supplied by the caller: each sport's own
 * slug, name and aliases (loaded dynamically from Catálogo). There is no
 * hardcoded sport list here, so a newly created category with its own
 * aliases is recognized automatically, with no code change or deploy.
 * Matching is exact-token / whole-word only (no fuzzy/typo-tolerant logic).
 */
export function resolveSport(input: string, sports: CatalogSport[]): CatalogSport | null {
  const norm = normalize(input);
  if (!norm) return null;

  const termsBySport = sports.map((sport) => ({
    sport,
    terms: [sport.slug, sport.name, ...(sport.aliases ?? [])].map(normalize).filter(Boolean)
  }));

  for (const { sport, terms } of termsBySport) {
    if (terms.includes(norm)) return sport;
  }
  for (const { sport, terms } of termsBySport) {
    if (terms.some((term) => containsWholeWord(norm, term))) return sport;
  }
  return null;
}

const CODE_PATTERN = /[A-Za-z]{2,4}-\d{1,4}/;

/**
 * Every valid, distinct code mentioned in `input`, in the order they first
 * appear (e.g. "RUN-08, RUN-14 y RUN-21" -> ["RUN-08","RUN-14","RUN-21"];
 * "RUN-08 RUN-08 RUN-14" -> ["RUN-08","RUN-14"]). A code not present in
 * `validCodes` is silently ignored rather than invented (Fase 8: "RUN-99"
 * never produces an image). No fuzzy matching — "RUN-8" is never treated as
 * "RUN-08" unless it is itself a valid code.
 */
export function resolveCodes(input: string, validCodes: string[]): string[] {
  const matches = input.toUpperCase().matchAll(new RegExp(CODE_PATTERN, "g"));
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const match of matches) {
    const code = match[0];
    if (!validCodes.includes(code) || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

/** Single-best-match convenience wrapper over resolveCodes(), kept for
 * callers (e.g. step() below) that only ever want the first code. */
export function resolveCode(input: string, validCodes: string[]): string | null {
  return resolveCodes(input, validCodes)[0] ?? null;
}

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

/** The WAITING_FOR_SPORT -> WAITING_FOR_SELECTION transition, factored out
 * so both the deterministic step() below and the AI-classifier fallback
 * (see resolveIntakeTurn in intake-runner.ts) apply the exact same
 * transition once a sport has been identified, by whichever means. */
export function applySportSelection(variables: IntakeVariables, sport: CatalogSport, messages: IntakeMessages): IntakeStepResult {
  const nextVariables: IntakeVariables = { ...variables, sportSlug: sport.slug, sportName: sport.name };
  const reply = render(messages.sportRecognized, { sport: sport.name, catalog_url: sport.catalogUrl ?? "" });
  return { state: "WAITING_FOR_SELECTION", variables: nextVariables, replies: [reply] };
}

/**
 * Deterministic, side-effect-free state machine for the initial WhatsApp
 * intake conversation. SHOWING_OPTIONS is the transient state while the
 * options message is composed; a single step settles directly into
 * WAITING_FOR_SELECTION once the sport is recognized, since there is no
 * asynchronous gap between "show options" and "wait for reply" here.
 */
export function step(state: IntakeState, variables: IntakeVariables, input: string, context: IntakeContext): IntakeStepResult {
  const { messages, sports } = context;

  if (state === "HUMAN_HANDOFF") {
    return { state, variables, replies: [] };
  }

  if (state === "NEW") {
    return { state: "WAITING_FOR_SPORT", variables, replies: [messages.greeting] };
  }

  if (state === "WAITING_FOR_SPORT") {
    const sport = resolveSport(input, sports);
    if (!sport) return { state: "WAITING_FOR_SPORT", variables, replies: [messages.sportNotRecognized] };
    return applySportSelection(variables, sport, messages);
  }

  if (state === "WAITING_FOR_SELECTION") {
    const sport = sports.find((candidate) => candidate.slug === variables.sportSlug);
    const code = sport ? resolveCode(input, sport.codes) : null;
    if (!code) return { state, variables, replies: ["No reconocí ese código. Revisa el que aparece bajo la foto que te interesa."] };
    const nextVariables: IntakeVariables = { ...variables, selectedCode: code };
    return { state: "HUMAN_HANDOFF", variables: nextVariables, replies: [render(messages.modelSelected, { code }), messages.handoff] };
  }

  return { state, variables, replies: [] };
}

/** Maps a step result onto the Fase 1 flow_executions row shape, ready for
 * when this connects to real conversations (current_node_id + variables). */
export function toExecutionRow(result: Pick<IntakeStepResult, "state" | "variables">) {
  return { current_node_id: result.state, variables: result.variables };
}

export function fromExecutionRow(row: { current_node_id: string | null; variables: Record<string, unknown> | null }): { state: IntakeState; variables: IntakeVariables } {
  return { state: (row.current_node_id as IntakeState) ?? "NEW", variables: (row.variables ?? {}) as IntakeVariables };
}
