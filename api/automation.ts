import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAdminCompany } from "../src/admin/company.js";
import { getSupabaseAdmin } from "../src/db/supabase.js";
import { DEFAULT_INTAKE_MESSAGES, normalize, type IntakeMessages } from "../src/flows/whatsapp-intake.js";

const FLOW_NAME = "Atención inicial de WhatsApp";

type Db = ReturnType<typeof getSupabaseAdmin>;

function getBaseUrl(req: VercelRequest): string {
  const host = req.headers.host ?? "localhost:3000";
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = typeof forwardedProto === "string" ? forwardedProto.split(",")[0] : host.startsWith("localhost") ? "http" : "https";
  return `${proto}://${host}`;
}

async function getOrCreateFlow(db: Db, companyId: string) {
  const { data: existing, error } = await db.from("flows").select("id,status").eq("company_id", companyId).eq("name", FLOW_NAME).maybeSingle();
  if (error) throw error;
  if (existing) return existing;
  const { data: created, error: insertError } = await db.from("flows").insert({ company_id: companyId, name: FLOW_NAME, status: "draft" }).select("id,status").single();
  if (insertError) throw insertError;
  return created;
}

async function getOrCreatePublishedVersion(db: Db, companyId: string, flowId: string) {
  const { data: existing, error } = await db.from("flow_versions").select("id,definition").eq("flow_id", flowId).eq("published", true).maybeSingle();
  if (error) throw error;
  if (existing) return existing;
  const definition = { schema: 1, nodes: [], edges: [], messages: DEFAULT_INTAKE_MESSAGES };
  const { data: created, error: insertError } = await db
    .from("flow_versions")
    .insert({ company_id: companyId, flow_id: flowId, version: 1, published: true, definition })
    .select("id,definition")
    .single();
  if (insertError) throw insertError;
  return created;
}

async function getActiveSportsWithCodes(db: Db, companyId: string, baseUrl: string) {
  const { data: categories, error: categoryError } = await db
    .from("catalog_categories")
    .select("id,slug,name")
    .eq("company_id", companyId)
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

  return (categories ?? []).map((category) => ({
    slug: category.slug,
    name: category.name,
    codes: codesByCategory.get(category.id) ?? [],
    aliases: aliasesByCategory.get(category.id) ?? [],
    catalogUrl: `${baseUrl}/catalogo/${category.slug}`
  }));
}

async function getFaqsWithAliases(db: Db, companyId: string, flowId: string) {
  const { data: faqs, error: faqError } = await db
    .from("automation_faqs")
    .select("id,title,answer,classifier_description,active,sort_order")
    .eq("company_id", companyId)
    .eq("flow_id", flowId)
    .order("sort_order")
    .order("title");
  if (faqError) throw faqError;

  const faqIds = (faqs ?? []).map((faq) => faq.id);
  const { data: aliasRows, error: aliasError } = faqIds.length
    ? await db.from("automation_faq_aliases").select("id,faq_id,alias").in("faq_id", faqIds).order("alias")
    : { data: [], error: null };
  if (aliasError) throw aliasError;

  const aliasesByFaq = new Map<string, { id: string; alias: string }[]>();
  for (const row of aliasRows ?? []) {
    const list = aliasesByFaq.get(row.faq_id) ?? [];
    list.push({ id: row.id, alias: row.alias });
    aliasesByFaq.set(row.faq_id, list);
  }

  return (faqs ?? []).map((faq) => ({
    id: faq.id,
    title: faq.title,
    answer: faq.answer,
    classifierDescription: faq.classifier_description,
    active: faq.active,
    sortOrder: faq.sort_order,
    aliases: aliasesByFaq.get(faq.id) ?? []
  }));
}

function payload(req: VercelRequest) {
  if (typeof req.body === "string") return JSON.parse(req.body) as Record<string, unknown>;
  return (req.body ?? {}) as Record<string, unknown>;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const company = await getAdminCompany();
    const db = getSupabaseAdmin();
    const flow = await getOrCreateFlow(db, company.id);

    if (req.method === "GET") {
      const version = await getOrCreatePublishedVersion(db, company.id, flow.id);
      const definition = (version.definition ?? {}) as { messages?: Partial<IntakeMessages> };
      const messages: IntakeMessages = { ...DEFAULT_INTAKE_MESSAGES, ...definition.messages };
      const sports = await getActiveSportsWithCodes(db, company.id, getBaseUrl(req));
      const faqs = await getFaqsWithAliases(db, company.id, flow.id);
      return res.status(200).json({ active: flow.status === "active", messages, sports, faqs });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const body = payload(req);
    const action = String(body.action ?? "");

    if (action === "toggle") {
      const active = Boolean(body.active);
      const { error } = await db.from("flows").update({ status: active ? "active" : "draft", updated_at: new Date().toISOString() }).eq("id", flow.id);
      if (error) throw error;
      return res.status(204).end();
    }

    if (action === "update-messages") {
      const version = await getOrCreatePublishedVersion(db, company.id, flow.id);
      const incoming = (body.messages ?? {}) as Partial<IntakeMessages>;
      const messages: IntakeMessages = { ...DEFAULT_INTAKE_MESSAGES, ...incoming };
      const existingDefinition = (version.definition ?? {}) as Record<string, unknown>;
      const definition = { ...existingDefinition, messages };
      const { error } = await db.from("flow_versions").update({ definition }).eq("id", version.id);
      if (error) throw error;
      return res.status(204).end();
    }

    if (action === "create-faq") {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const answer = typeof body.answer === "string" ? body.answer.trim() : "";
      const classifierDescriptionRaw = typeof body.classifierDescription === "string" ? body.classifierDescription.trim() : "";
      const classifierDescription = classifierDescriptionRaw || null;
      if (!title || !answer) return res.status(400).json({ error: "Título y respuesta son obligatorios" });

      const { data: existing, error: countError } = await db.from("automation_faqs").select("id,title").eq("company_id", company.id).eq("flow_id", flow.id);
      if (countError) throw countError;

      // Defends against accidental duplicate creation (e.g. a double
      // submit that slipped past the UI guard) without a new migration:
      // same normalization already used for message/alias matching
      // (trim + lowercase + accent-insensitive + collapsed whitespace),
      // scoped to this company's FAQs only.
      const normalizedTitle = normalize(title);
      const duplicate = (existing ?? []).some((faq) => normalize(faq.title) === normalizedTitle);
      if (duplicate) return res.status(409).json({ error: "FAQ_ALREADY_EXISTS" });

      const { error } = await db
        .from("automation_faqs")
        .insert({ company_id: company.id, flow_id: flow.id, title, answer, classifier_description: classifierDescription, sort_order: (existing ?? []).length });
      if (error) throw error;
      return res.status(204).end();
    }

    if (action === "update-faq") {
      const id = typeof body.id === "string" ? body.id : "";
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const answer = typeof body.answer === "string" ? body.answer.trim() : "";
      const classifierDescriptionRaw = typeof body.classifierDescription === "string" ? body.classifierDescription.trim() : "";
      const classifierDescription = classifierDescriptionRaw || null;
      if (!id || !title || !answer) return res.status(400).json({ error: "Datos inválidos" });
      const { error } = await db
        .from("automation_faqs")
        .update({ title, answer, classifier_description: classifierDescription, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("company_id", company.id);
      if (error) throw error;
      return res.status(204).end();
    }

    if (action === "toggle-faq") {
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) return res.status(400).json({ error: "FAQ inválida" });
      const { error } = await db.from("automation_faqs").update({ active: Boolean(body.active), updated_at: new Date().toISOString() }).eq("id", id).eq("company_id", company.id);
      if (error) throw error;
      return res.status(204).end();
    }

    if (action === "delete-faq") {
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) return res.status(400).json({ error: "FAQ inválida" });
      const { error } = await db.from("automation_faqs").delete().eq("id", id).eq("company_id", company.id);
      if (error) throw error;
      return res.status(204).end();
    }

    if (action === "add-faq-alias") {
      const faqId = typeof body.faqId === "string" ? body.faqId : "";
      const rawAlias = typeof body.alias === "string" ? body.alias.trim() : "";
      const normalized = normalize(rawAlias);
      if (!faqId || !rawAlias || !normalized) return res.status(400).json({ error: "Alias inválido" });

      const { data: faq, error: faqError } = await db.from("automation_faqs").select("id").eq("id", faqId).eq("company_id", company.id).maybeSingle();
      if (faqError || !faq) return res.status(404).json({ error: "FAQ no encontrada" });

      const { data: existingAliases, error: aliasFetchError } = await db.from("automation_faq_aliases").select("alias").eq("company_id", company.id);
      if (aliasFetchError) throw aliasFetchError;
      if ((existingAliases ?? []).some((a) => normalize(a.alias) === normalized)) {
        return res.status(400).json({ error: "Ese alias ya está en uso por otra FAQ" });
      }

      const { error: insertError } = await db.from("automation_faq_aliases").insert({ company_id: company.id, faq_id: faqId, alias: rawAlias, alias_normalized: normalized });
      if (insertError) return res.status(400).json({ error: "No se pudo agregar el alias" });
      return res.status(204).end();
    }

    if (action === "remove-faq-alias") {
      const aliasId = typeof body.id === "string" ? body.id : "";
      if (!aliasId) return res.status(400).json({ error: "Alias inválido" });
      const { error } = await db.from("automation_faq_aliases").delete().eq("id", aliasId).eq("company_id", company.id);
      if (error) throw error;
      return res.status(204).end();
    }

    return res.status(400).json({ error: "Acción no soportada" });
  } catch (error) {
    console.error("automation_failed", { error: error instanceof Error ? error.message : "unknown" });
    return res.status(500).json({ error: "No se pudo procesar la automatización" });
  }
}
