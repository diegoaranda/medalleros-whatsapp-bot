import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAdminCompany } from "../src/admin/company.js";
import { loadIntentClassifierConfigFromEnv, OpenAiCompletionClient } from "../src/ai/intent-classifier.js";
import { getSupabaseAdmin } from "../src/db/supabase.js";
import { resolveIntakeTurn } from "../src/flows/intake-runner.js";
import { DEFAULT_INTAKE_MESSAGES, type IntakeMessages, type IntakeState, type IntakeVariables } from "../src/flows/whatsapp-intake.js";

const FLOW_NAME = "Atención inicial de WhatsApp";
const VALID_STATES: IntakeState[] = ["NEW", "WAITING_FOR_SPORT", "SHOWING_OPTIONS", "WAITING_FOR_SELECTION", "HUMAN_HANDOFF"];

function payload(req: VercelRequest) {
  if (typeof req.body === "string") return JSON.parse(req.body) as Record<string, unknown>;
  return (req.body ?? {}) as Record<string, unknown>;
}

function getBaseUrl(req: VercelRequest): string {
  const host = req.headers.host ?? "localhost:3000";
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = typeof forwardedProto === "string" ? forwardedProto.split(",")[0] : host.startsWith("localhost") ? "http" : "https";
  return `${proto}://${host}`;
}

/**
 * Pure preview endpoint: no WhatsApp message is ever sent and no
 * conversation/contact/flow_execution row is created or modified here. The
 * caller (the /automations simulator UI) holds the running state client-side
 * across turns and posts it back each time.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const company = await getAdminCompany();
    const db = getSupabaseAdmin();
    const body = payload(req);

    const state: IntakeState = VALID_STATES.includes(body.state as IntakeState) ? (body.state as IntakeState) : "NEW";
    const variables = (body.variables ?? {}) as IntakeVariables;
    const input = String(body.input ?? "");

    const { data: flow, error: flowError } = await db.from("flows").select("id").eq("company_id", company.id).eq("name", FLOW_NAME).maybeSingle();
    if (flowError) throw flowError;

    let messages: IntakeMessages = DEFAULT_INTAKE_MESSAGES;
    if (flow) {
      const { data: version, error: versionError } = await db.from("flow_versions").select("definition").eq("flow_id", flow.id).eq("published", true).maybeSingle();
      if (versionError) throw versionError;
      const definition = (version?.definition ?? {}) as { messages?: Partial<IntakeMessages> };
      messages = { ...DEFAULT_INTAKE_MESSAGES, ...definition.messages };
    }

    const { data: categories, error: categoryError } = await db
      .from("catalog_categories")
      .select("id,slug,name")
      .eq("company_id", company.id)
      .eq("active", true)
      .order("sort_order")
      .order("name");
    if (categoryError) throw categoryError;

    const categoryIds = (categories ?? []).map((category) => category.id);
    const [{ data: media, error: mediaError }, { data: aliasRows, error: aliasError }] = categoryIds.length
      ? await Promise.all([
          db.from("catalog_category_media").select("category_id,code").in("category_id", categoryIds).order("sort_order"),
          db.from("catalog_category_aliases").select("category_id,alias").in("category_id", categoryIds)
        ])
      : [{ data: [], error: null }, { data: [], error: null }];
    if (mediaError) throw mediaError;
    if (aliasError) throw aliasError;

    const codesByCategory = new Map<string, string[]>();
    for (const entry of media ?? []) {
      const list = codesByCategory.get(entry.category_id) ?? [];
      list.push(entry.code);
      codesByCategory.set(entry.category_id, list);
    }
    const aliasesByCategory = new Map<string, string[]>();
    for (const entry of aliasRows ?? []) {
      const list = aliasesByCategory.get(entry.category_id) ?? [];
      list.push(entry.alias);
      aliasesByCategory.set(entry.category_id, list);
    }
    const baseUrl = getBaseUrl(req);
    const sports = (categories ?? []).map((category) => ({
      slug: category.slug,
      name: category.name,
      codes: codesByCategory.get(category.id) ?? [],
      aliases: aliasesByCategory.get(category.id) ?? [],
      catalogUrl: `${baseUrl}/catalogo/${category.slug}`
    }));

    // FAQs are transversal: checked before the normal step whenever the bot
    // still controls the conversation, and never while handed off.
    let faqs: { id: string; title: string; answer: string; classifierDescription: string | null; sortOrder: number; aliases: string[] }[] = [];
    if (state !== "HUMAN_HANDOFF" && flow) {
      const { data: faqRows, error: faqError } = await db
        .from("automation_faqs")
        .select("id,title,answer,classifier_description,sort_order")
        .eq("company_id", company.id)
        .eq("flow_id", flow.id)
        .eq("active", true)
        .order("sort_order");
      if (faqError) throw faqError;
      const faqIds = (faqRows ?? []).map((faq) => faq.id);
      const { data: faqAliasRows, error: faqAliasError } = faqIds.length
        ? await db.from("automation_faq_aliases").select("faq_id,alias").in("faq_id", faqIds)
        : { data: [], error: null };
      if (faqAliasError) throw faqAliasError;
      const faqAliasesByFaq = new Map<string, string[]>();
      for (const row of faqAliasRows ?? []) {
        const list = faqAliasesByFaq.get(row.faq_id) ?? [];
        list.push(row.alias);
        faqAliasesByFaq.set(row.faq_id, list);
      }
      faqs = (faqRows ?? []).map((faq) => ({
        id: faq.id,
        title: faq.title,
        answer: faq.answer,
        classifierDescription: faq.classifier_description,
        sortOrder: faq.sort_order,
        aliases: faqAliasesByFaq.get(faq.id) ?? []
      }));
    }

    // Same resolution order as the real webhook (deterministic code/sport,
    // then FAQ, then the GPT classifier fallback only if configured via
    // OPENAI_API_KEY): see resolveIntakeTurn in src/flows/intake-runner.ts.
    // This is a dev-only preview endpoint — no message/execution is ever
    // persisted here, so it is safe to call even while automation is INACTIVA.
    const aiConfig = loadIntentClassifierConfigFromEnv();
    const ai = aiConfig ? { config: aiConfig, client: new OpenAiCompletionClient() } : undefined;
    const outcome = await resolveIntakeTurn({ state, variables, input, messages, sports, faqs, ai });
    return res.status(200).json({
      state: outcome.state,
      variables: outcome.variables,
      replies: outcome.replies,
      resolvedIntents: outcome.resolvedIntents,
      aiCalled: outcome.aiCalled,
      aiLatencyMs: outcome.aiLatencyMs,
      aiModel: outcome.aiModel
    });
  } catch (error) {
    console.error("automation_simulate_failed", { error: error instanceof Error ? error.message : "unknown" });
    return res.status(500).json({ error: "No se pudo simular el flujo" });
  }
}
