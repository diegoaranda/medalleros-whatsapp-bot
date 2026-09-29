import { bestMatchingTerm, normalize } from "./whatsapp-intake.js";

export interface AutomationFaq {
  id: string;
  answer: string;
  aliases: string[];
  sortOrder: number;
  /** Optional; only used to give the AI classifier fallback a human-readable
   * label for this FAQ (see intake-runner.ts). The deterministic resolver
   * below never reads it. */
  title?: string;
  /** Optional, admin-editable context sent to the GPT classifier ONLY (never
   * to the customer, never part of `answer`) to help it decide when this FAQ
   * applies, especially when title/aliases alone are ambiguous. The
   * deterministic resolver below never reads it. */
  classifierDescription?: string | null;
}

/**
 * Deterministic multi-FAQ resolver, transversal over the intake state
 * machine (it is not a node in it — see resolveIntakeTurn in
 * intake-runner.ts, which checks this before advancing state). Only ACTIVE
 * faqs should be passed in by the caller. No fuzzy matching, no AI: exact
 * match first, then whole word/phrase containment.
 *
 * A single message CAN match more than one FAQ (Fase 5 multi-intent, e.g.
 * "cuánto tardan y cómo puedo pagar?" -> tiempo de entrega + forma de pago),
 * so every FAQ with a matching alias is returned — one entry per FAQ,
 * ordered by specificity (longest matching alias first, then the
 * admin-configured sortOrder as a tiebreak). The caller decides how many of
 * them to actually use.
 */
export function resolveFaqs(input: string, faqs: AutomationFaq[]): AutomationFaq[] {
  const norm = normalize(input);
  if (!norm) return [];

  const matches: { faq: AutomationFaq; length: number }[] = [];
  for (const faq of faqs) {
    const terms = faq.aliases.map(normalize).filter(Boolean);
    const term = bestMatchingTerm(norm, terms);
    if (term) matches.push({ faq, length: term.length });
  }

  matches.sort((a, b) => b.length - a.length || a.faq.sortOrder - b.faq.sortOrder);
  return matches.map((match) => match.faq);
}

/** Single-best-match convenience wrapper over resolveFaqs(), kept for
 * callers that only ever want (at most) one FAQ answer. */
export function resolveFaq(input: string, faqs: AutomationFaq[]): AutomationFaq | null {
  return resolveFaqs(input, faqs)[0] ?? null;
}
