import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAdminCompany } from "../src/admin/company.js";
import { getSupabaseAdmin } from "../src/db/supabase.js";

function slugify(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function payload(req: VercelRequest) {
  if (typeof req.body === "string") return JSON.parse(req.body) as Record<string, unknown>;
  return (req.body ?? {}) as Record<string, unknown>;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const company = await getAdminCompany();
    const db = getSupabaseAdmin();
    if (req.method === "GET") {
      const [{ data: categories, error: categoryError }, { data: items, error: itemError }] = await Promise.all([
        db.from("catalog_categories").select("id,name,slug,active,sort_order").eq("company_id", company.id).order("sort_order").order("name"),
        db.from("catalog_items").select("id,category_id,name,active,sort_order,metadata").eq("company_id", company.id).order("sort_order").order("name")
      ]);
      if (categoryError || itemError) throw categoryError ?? itemError;
      const itemIds = (items ?? []).map((item) => item.id);
      const { data: media, error: mediaError } = itemIds.length
        ? await db.from("catalog_item_media").select("id,item_id,storage_path,sort_order").in("item_id", itemIds).order("sort_order")
        : { data: [], error: null };
      if (mediaError) throw mediaError;
      const signedMedia = await Promise.all((media ?? []).map(async (entry) => {
        const { data } = await db.storage.from("catalog-media").createSignedUrl(entry.storage_path, 3600);
        return { ...entry, url: data?.signedUrl ?? null };
      }));
      return res.status(200).json({ company, categories: categories ?? [], items: items ?? [], media: signedMedia });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const body = payload(req);
    const action = String(body.action ?? "");
    const id = typeof body.id === "string" ? body.id : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (action === "create-category") {
      if (!name) return res.status(400).json({ error: "El nombre es obligatorio" });
      const { error } = await db.from("catalog_categories").insert({ company_id: company.id, name, slug: slugify(name), sort_order: Number(body.sortOrder ?? 0) });
      if (error) throw error;
    } else if (action === "update-category") {
      if (!id || !name) return res.status(400).json({ error: "Datos inválidos" });
      const { error } = await db.from("catalog_categories").update({ name, slug: slugify(name), updated_at: new Date().toISOString() }).eq("id", id).eq("company_id", company.id);
      if (error) throw error;
    } else if (action === "toggle-category" || action === "sort-category") {
      const values = action === "toggle-category" ? { active: Boolean(body.active), updated_at: new Date().toISOString() } : { sort_order: Number(body.sortOrder), updated_at: new Date().toISOString() };
      const { error } = await db.from("catalog_categories").update(values).eq("id", id).eq("company_id", company.id);
      if (error) throw error;
    } else if (action === "create-item") {
      const categoryId = String(body.categoryId ?? "");
      if (!name || !categoryId) return res.status(400).json({ error: "Modelo y deporte son obligatorios" });
      const { error } = await db.from("catalog_items").insert({ company_id: company.id, category_id: categoryId, name, sort_order: Number(body.sortOrder ?? 0) });
      if (error) throw error;
    } else if (action === "update-item") {
      if (!id || !name) return res.status(400).json({ error: "Datos inválidos" });
      const { error } = await db.from("catalog_items").update({ name, updated_at: new Date().toISOString() }).eq("id", id).eq("company_id", company.id);
      if (error) throw error;
    } else if (action === "toggle-item" || action === "sort-item") {
      const values = action === "toggle-item" ? { active: Boolean(body.active), updated_at: new Date().toISOString() } : { sort_order: Number(body.sortOrder), updated_at: new Date().toISOString() };
      const { error } = await db.from("catalog_items").update(values).eq("id", id).eq("company_id", company.id);
      if (error) throw error;
    } else return res.status(400).json({ error: "Acción no soportada" });
    return res.status(204).end();
  } catch (error) {
    console.error("catalog_admin_failed", { error: error instanceof Error ? error.message : "unknown" });
    return res.status(500).json({ error: "No se pudo actualizar el catálogo" });
  }
}
