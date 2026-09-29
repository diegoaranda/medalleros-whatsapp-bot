import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAdminCompany } from "../../src/admin/company.js";
import { getSupabaseAdmin } from "../../src/db/supabase.js";

type PublicImage = { id: string; code: string; url: string; sort_order: number };
type PublicSport = { slug: string; name: string; images: PublicImage[] };

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
    const { data: media, error: mediaError } = categoryIds.length
      ? await db
          .from("catalog_category_media")
          .select("id,category_id,code,storage_path,sort_order")
          .in("category_id", categoryIds)
          .order("sort_order")
      : { data: [], error: null };
    if (mediaError) throw mediaError;

    const imagesByCategory = new Map<string, PublicImage[]>();
    for (const entry of media ?? []) {
      const { data } = db.storage.from("catalog-media").getPublicUrl(entry.storage_path);
      const list = imagesByCategory.get(entry.category_id) ?? [];
      list.push({ id: entry.id, code: entry.code, url: data.publicUrl, sort_order: entry.sort_order });
      imagesByCategory.set(entry.category_id, list);
    }

    const sports: PublicSport[] = (categories ?? []).map((category) => ({
      slug: category.slug,
      name: category.name,
      images: imagesByCategory.get(category.id) ?? [],
    }));

    const code = typeof req.query.code === "string" ? req.query.code.trim().toUpperCase() : "";
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    if (code) {
      for (const sport of sports) {
        const image = sport.images.find((entry) => entry.code === code);
        if (image) return res.status(200).json({ sport: { slug: sport.slug, name: sport.name }, image });
      }
      return res.status(404).json({ error: "Imagen no encontrada" });
    }
    return res.status(200).json({ sports });
  } catch (error) {
    console.error("public_catalog_failed", { error: error instanceof Error ? error.message : "unknown" });
    return res.status(500).json({ error: "No se pudo cargar el catálogo" });
  }
}
