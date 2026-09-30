import { randomUUID } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAdminCompany } from "../src/admin/company.js";
import { getSupabaseAdmin } from "../src/db/supabase.js";

// Fase 8 (Media V1): FAQ image attachments. Mirrors api/category-media.ts's
// upload/delete/sort shape exactly — browser -> this JSON route -> Supabase
// Storage from the server (service role never reaches the browser).
export const config = { api: { bodyParser: { sizeLimit: "6mb" } } };

const BUCKET = "automation-media";

function body(req: VercelRequest) {
  return (typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {})) as Record<string, unknown>;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const company = await getAdminCompany();
    const db = getSupabaseAdmin();
    const data = body(req);
    const action = String(data.action ?? "");

    if (action === "upload") {
      const faqId = String(data.faqId ?? "");
      const { data: faq, error: faqError } = await db.from("automation_faqs").select("id").eq("id", faqId).eq("company_id", company.id).maybeSingle();
      if (faqError || !faq) return res.status(404).json({ error: "FAQ no encontrada" });

      const base64 = String(data.base64 ?? "");
      const contentType = String(data.contentType ?? "image/jpeg");
      if (!base64 || !contentType.startsWith("image/")) return res.status(400).json({ error: "Imagen inválida" });
      const bytes = Buffer.from(base64, "base64");
      if (!bytes.length || bytes.length > 4 * 1024 * 1024) return res.status(400).json({ error: "La imagen debe pesar menos de 4 MB" });

      const extension = contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "jpg";
      const storagePath = `${company.id}/faq/${faqId}/${randomUUID()}.${extension}`;
      const { error: uploadError } = await db.storage.from(BUCKET).upload(storagePath, bytes, { contentType, upsert: false });
      if (uploadError) throw uploadError;

      const { error: insertError } = await db
        .from("automation_faq_media")
        .insert({ company_id: company.id, faq_id: faqId, storage_path: storagePath, sort_order: Number(data.sortOrder ?? 0) });
      if (insertError) {
        await db.storage.from(BUCKET).remove([storagePath]);
        throw insertError;
      }
    } else if (action === "delete") {
      const mediaId = String(data.mediaId ?? "");
      const { data: media, error } = await db.from("automation_faq_media").select("id,storage_path").eq("id", mediaId).eq("company_id", company.id).maybeSingle();
      if (error || !media) return res.status(404).json({ error: "Imagen no encontrada" });
      const { error: deleteError } = await db.from("automation_faq_media").delete().eq("id", media.id);
      if (deleteError) throw deleteError;
      const { error: storageError } = await db.storage.from(BUCKET).remove([media.storage_path]);
      if (storageError) console.error("automation_faq_media_storage_delete_failed", { mediaId: media.id });
    } else if (action === "sort") {
      const mediaId = String(data.mediaId ?? "");
      const { error } = await db.from("automation_faq_media").update({ sort_order: Number(data.sortOrder) }).eq("id", mediaId).eq("company_id", company.id);
      if (error) throw error;
    } else return res.status(400).json({ error: "Acción no soportada" });

    return res.status(204).end();
  } catch (error) {
    console.error("faq_media_failed", { error: error instanceof Error ? error.message : "unknown" });
    return res.status(500).json({ error: "No se pudo actualizar la imagen" });
  }
}
