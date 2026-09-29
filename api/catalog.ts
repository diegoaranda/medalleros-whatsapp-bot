import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAdminCompany } from "../src/admin/company.js";
import { getSupabaseAdmin } from "../src/db/supabase.js";
import { normalize } from "../src/flows/whatsapp-intake.js";

function slugify(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function payload(req: VercelRequest) {
  if (typeof req.body === "string") return JSON.parse(req.body) as Record<string, unknown>;
  return (req.body ?? {}) as Record<string, unknown>;
}

function codePrefixFor(slug: string) {
  const letters = slug.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
  return letters || "GEN";
}

async function generateItemCode(db: ReturnType<typeof getSupabaseAdmin>, companyId: string, categorySlug: string) {
  const prefix = codePrefixFor(categorySlug);
  const { data: existing, error } = await db
    .from("catalog_items")
    .select("code")
    .eq("company_id", companyId)
    .like("code", `${prefix}-%`);
  if (error) throw error;
  const maxSeq = (existing ?? []).reduce((max, row) => {
    const match = /^-(\d+)$/.exec(row.code.slice(prefix.length));
    const value = match ? Number(match[1]) : 0;
    return Number.isFinite(value) && value > max ? value : max;
  }, 0);
  return `${prefix}-${String(maxSeq + 1).padStart(2, "0")}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const company = await getAdminCompany();
    const db = getSupabaseAdmin();
    if (req.method === "GET") {
      const [{ data: categories, error: categoryError }, { data: items, error: itemError }, { data: aliasRows, error: aliasError }] = await Promise.all([
        db.from("catalog_categories").select("id,name,slug,active,sort_order").eq("company_id", company.id).order("sort_order").order("name"),
        db.from("catalog_items").select("id,category_id,name,code,active,sort_order,metadata").eq("company_id", company.id).order("sort_order").order("name"),
        db.from("catalog_category_aliases").select("id,category_id,alias").eq("company_id", company.id).order("alias")
      ]);
      if (categoryError || itemError || aliasError) throw categoryError ?? itemError ?? aliasError;
      const aliasesByCategory = new Map<string, { id: string; alias: string }[]>();
      for (const row of aliasRows ?? []) {
        const list = aliasesByCategory.get(row.category_id) ?? [];
        list.push({ id: row.id, alias: row.alias });
        aliasesByCategory.set(row.category_id, list);
      }
      const categoriesWithAliases = (categories ?? []).map((category) => ({ ...category, aliases: aliasesByCategory.get(category.id) ?? [] }));
      const itemIds = (items ?? []).map((item) => item.id);
      const { data: media, error: mediaError } = itemIds.length
        ? await db.from("catalog_item_media").select("id,item_id,storage_path,sort_order").in("item_id", itemIds).order("sort_order")
        : { data: [], error: null };
      if (mediaError) throw mediaError;
      const signedMedia = await Promise.all((media ?? []).map(async (entry) => {
        const { data } = await db.storage.from("catalog-media").createSignedUrl(entry.storage_path, 3600);
        return { ...entry, url: data?.signedUrl ?? null };
      }));
      const categoryIds = (categories ?? []).map((category) => category.id);
      const { data: categoryMedia, error: categoryMediaError } = categoryIds.length
        ? await db.from("catalog_category_media").select("id,category_id,code,storage_path,sort_order").in("category_id", categoryIds).order("sort_order")
        : { data: [], error: null };
      if (categoryMediaError) throw categoryMediaError;
      const signedCategoryMedia = await Promise.all((categoryMedia ?? []).map(async (entry) => {
        const { data } = await db.storage.from("catalog-media").createSignedUrl(entry.storage_path, 3600);
        return { ...entry, url: data?.signedUrl ?? null };
      }));
      return res.status(200).json({ company, categories: categoriesWithAliases, items: items ?? [], media: signedMedia, categoryMedia: signedCategoryMedia });
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
      const { data: category, error: categoryError } = await db.from("catalog_categories").select("slug").eq("id", categoryId).eq("company_id", company.id).maybeSingle();
      if (categoryError || !category) return res.status(400).json({ error: "Deporte no encontrado" });
      let insertError: { code?: string; message: string } | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const code = await generateItemCode(db, company.id, category.slug);
        const result = await db.from("catalog_items").insert({ company_id: company.id, category_id: categoryId, name, code, sort_order: Number(body.sortOrder ?? 0) });
        insertError = result.error;
        if (!insertError || insertError.code !== "23505") break;
      }
      if (insertError) throw insertError;
    } else if (action === "update-item") {
      if (!id || !name) return res.status(400).json({ error: "Datos inválidos" });
      const categoryId = String(body.categoryId ?? "");
      if (!categoryId) return res.status(400).json({ error: "El deporte es obligatorio" });
      const { error } = await db.from("catalog_items").update({ name, category_id: categoryId, active: Boolean(body.active), updated_at: new Date().toISOString() }).eq("id", id).eq("company_id", company.id);
      if (error) throw error;
    } else if (action === "toggle-item" || action === "sort-item") {
      const values = action === "toggle-item" ? { active: Boolean(body.active), updated_at: new Date().toISOString() } : { sort_order: Number(body.sortOrder), updated_at: new Date().toISOString() };
      const { error } = await db.from("catalog_items").update(values).eq("id", id).eq("company_id", company.id);
      if (error) throw error;
    } else if (action === "add-alias") {
      const categoryId = String(body.categoryId ?? "");
      const rawAlias = typeof body.alias === "string" ? body.alias.trim() : "";
      const normalized = normalize(rawAlias);
      if (!categoryId || !rawAlias || !normalized) return res.status(400).json({ error: "Alias inválido" });

      const { data: companyCategories, error: categoriesError } = await db.from("catalog_categories").select("id,name,slug").eq("company_id", company.id);
      if (categoriesError) throw categoriesError;
      const category = (companyCategories ?? []).find((c) => c.id === categoryId);
      if (!category) return res.status(404).json({ error: "Deporte no encontrado" });

      const collidesWithSport = (companyCategories ?? []).some((c) => normalize(c.name) === normalized || normalize(c.slug) === normalized);
      if (collidesWithSport) return res.status(400).json({ error: "Ese alias coincide con el nombre de un deporte existente" });

      const { data: existingAliases, error: aliasFetchError } = await db.from("catalog_category_aliases").select("alias").eq("company_id", company.id);
      if (aliasFetchError) throw aliasFetchError;
      if ((existingAliases ?? []).some((a) => normalize(a.alias) === normalized)) {
        return res.status(400).json({ error: "Ese alias ya está en uso por otro deporte" });
      }

      const { error: insertError } = await db.from("catalog_category_aliases").insert({ company_id: company.id, category_id: categoryId, alias: rawAlias, alias_normalized: normalized });
      if (insertError) return res.status(400).json({ error: "No se pudo agregar el alias" });
    } else if (action === "remove-alias") {
      if (!id) return res.status(400).json({ error: "Alias inválido" });
      const { error } = await db.from("catalog_category_aliases").delete().eq("id", id).eq("company_id", company.id);
      if (error) throw error;
    } else return res.status(400).json({ error: "Acción no soportada" });
    return res.status(204).end();
  } catch (error) {
    console.error("catalog_admin_failed", { error: error instanceof Error ? error.message : "unknown" });
    return res.status(500).json({ error: "No se pudo actualizar el catálogo" });
  }
}
