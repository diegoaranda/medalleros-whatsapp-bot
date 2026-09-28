import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAdminCompany } from "../../src/admin/company.js";
import { getSupabaseAdmin } from "../../src/db/supabase.js";

type PublicImage = { url: string; isPrimary: boolean };
type PublicModel = { code: string; name: string; sportSlug: string; images: PublicImage[] };
type PublicSport = { slug: string; name: string; models: PublicModel[] };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const company = await getAdminCompany();
    const db = getSupabaseAdmin();

    const { data: categories, error: categoryError } = await db
      .from("catalog_categories")
      .select("id,slug,name")
      .eq("company_id", company.id)
      .eq("active", true)
      .order("sort_order")
      .order("name");
    if (categoryError) throw categoryError;

    const categoryIds = (categories ?? []).map((category) => category.id);
    const { data: items, error: itemError } = categoryIds.length
      ? await db
          .from("catalog_items")
          .select("id,category_id,code,name")
          .eq("company_id", company.id)
          .eq("active", true)
          .in("category_id", categoryIds)
          .order("sort_order")
          .order("name")
      : { data: [], error: null };
    if (itemError) throw itemError;

    const itemIds = (items ?? []).map((item) => item.id);
    const { data: media, error: mediaError } = itemIds.length
      ? await db
          .from("catalog_item_media")
          .select("item_id,storage_path,sort_order")
          .in("item_id", itemIds)
          .order("sort_order")
      : { data: [], error: null };
    if (mediaError) throw mediaError;

    const imagesByItem = new Map<string, PublicImage[]>();
    for (const entry of media ?? []) {
      const { data } = db.storage.from("catalog-media").getPublicUrl(entry.storage_path);
      const list = imagesByItem.get(entry.item_id) ?? [];
      list.push({ url: data.publicUrl, isPrimary: list.length === 0 });
      imagesByItem.set(entry.item_id, list);
    }

    const categoryBySlug = new Map((categories ?? []).map((category) => [category.id, category]));
    const modelsByCategory = new Map<string, PublicModel[]>();
    for (const item of items ?? []) {
      const category = categoryBySlug.get(item.category_id);
      if (!category) continue;
      const model: PublicModel = { code: item.code, name: item.name, sportSlug: category.slug, images: imagesByItem.get(item.id) ?? [] };
      const list = modelsByCategory.get(category.id) ?? [];
      list.push(model);
      modelsByCategory.set(category.id, list);
    }

    const sports: PublicSport[] = (categories ?? []).map((category) => ({
      slug: category.slug,
      name: category.name,
      models: modelsByCategory.get(category.id) ?? [],
    }));

    const code = typeof req.query.code === "string" ? req.query.code.trim().toUpperCase() : "";
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    if (code) {
      const model = sports.flatMap((sport) => sport.models).find((entry) => entry.code === code);
      if (!model) return res.status(404).json({ error: "Modelo no encontrado" });
      return res.status(200).json({ model });
    }
    return res.status(200).json({ sports });
  } catch (error) {
    console.error("public_catalog_failed", { error: error instanceof Error ? error.message : "unknown" });
    return res.status(500).json({ error: "No se pudo cargar el catálogo" });
  }
}
