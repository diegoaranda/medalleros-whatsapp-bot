import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAdminCompany } from "../src/admin/company.js";
import { getSupabaseAdmin } from "../src/db/supabase.js";
import { DEFAULT_INTAKE_MESSAGES, step, type IntakeMessages, type IntakeState, type IntakeVariables } from "../src/flows/whatsapp-intake.js";

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

    const result = step(state, variables, input, { messages, sports });
    return res.status(200).json(result);
  } catch (error) {
    console.error("automation_simulate_failed", { error: error instanceof Error ? error.message : "unknown" });
    return res.status(500).json({ error: "No se pudo simular el flujo" });
  }
}
