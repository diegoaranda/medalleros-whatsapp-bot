import { randomUUID } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAdminCompany } from "../src/admin/company.js";
import { getSupabaseAdmin } from "../src/db/supabase.js";

export const config = { api: { bodyParser: { sizeLimit: "6mb" } } };

function body(req: VercelRequest) {
  return (typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}) as Record<string, unknown>;
}

function codePrefixFor(slug: string) {
  const letters = slug.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
  return letters || "GEN";
}

async function nextMediaCode(db: ReturnType<typeof getSupabaseAdmin>, categoryId: string, categorySlug: string) {
  const { data: seq, error } = await db.rpc("next_catalog_media_seq", { p_category_id: categoryId });
  if (error) throw error;
  return `${codePrefixFor(categorySlug)}-${String(seq).padStart(2, "0")}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const company = await getAdminCompany();
    const db = getSupabaseAdmin();
    const data = body(req);
    const action = String(data.action ?? "");

    if (action === "upload") {
      const categoryId = String(data.categoryId ?? "");
      const { data: category, error: categoryError } = await db.from("catalog_categories").select("id,slug").eq("id", categoryId).eq("company_id", company.id).maybeSingle();
      if (categoryError || !category) return res.status(404).json({ error: "Deporte no encontrado" });
      const base64 = String(data.base64 ?? "");
      const contentType = String(data.contentType ?? "image/jpeg");
      if (!base64 || !contentType.startsWith("image/")) return res.status(400).json({ error: "Imagen inválida" });
      const bytes = Buffer.from(base64, "base64");
      if (!bytes.length || bytes.length > 4 * 1024 * 1024) return res.status(400).json({ error: "La imagen debe pesar menos de 4 MB" });
      const extension = contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "jpg";
      const storagePath = `${company.id}/category/${categoryId}/${randomUUID()}.${extension}`;
      const { error: uploadError } = await db.storage.from("catalog-media").upload(storagePath, bytes, { contentType, upsert: false });
      if (uploadError) throw uploadError;
      let insertError: { code?: string; message: string } | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const code = await nextMediaCode(db, categoryId, category.slug);
        const result = await db.from("catalog_category_media").insert({ category_id: categoryId, company_id: company.id, storage_path: storagePath, code, sort_order: Number(data.sortOrder ?? 0) });
        insertError = result.error;
        if (!insertError || insertError.code !== "23505") break;
      }
      if (insertError) {
        await db.storage.from("catalog-media").remove([storagePath]);
        throw insertError;
      }
    } else if (action === "delete") {
      const mediaId = String(data.mediaId ?? "");
      const { data: media, error } = await db.from("catalog_category_media").select("id,storage_path").eq("id", mediaId).eq("company_id", company.id).maybeSingle();
      if (error || !media) return res.status(404).json({ error: "Imagen no encontrada" });
      const { error: deleteError } = await db.from("catalog_category_media").delete().eq("id", media.id);
      if (deleteError) throw deleteError;
      const { error: storageError } = await db.storage.from("catalog-media").remove([media.storage_path]);
      if (storageError) console.error("catalog_category_media_storage_delete_failed", { mediaId: media.id });
    } else if (action === "sort") {
      const mediaId = String(data.mediaId ?? "");
      const { error } = await db.from("catalog_category_media").update({ sort_order: Number(data.sortOrder) }).eq("id", mediaId).eq("company_id", company.id);
      if (error) throw error;
    } else return res.status(400).json({ error: "Acción no soportada" });
    return res.status(204).end();
  } catch (error) {
    console.error("category_media_failed", { error: error instanceof Error ? error.message : "unknown" });
    return res.status(500).json({ error: "No se pudo actualizar la imagen" });
  }
}
