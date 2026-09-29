import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAdminCompany } from "../../src/admin/company.js";
import { getSupabaseAdmin } from "../../src/db/supabase.js";

const WHATSAPP_NUMBER = "59167889020";

const esc = (value: string | null | undefined) =>
  (value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);

function whatsappUrl(code: string) {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(`Hola, me interesa el diseño ${code}`)}`;
}

function page(title: string, body: string) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
  :root{--ink:#132238;--muted:#69798c;--line:#e5e9ef;--bg:#f7f9fc;--wa:#25d366}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);font:15px/1.4 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink)}
  header{padding:22px 16px 14px;text-align:center}
  header h1{margin:0;font-size:20px;font-weight:800;letter-spacing:-.3px}
  header .lead{margin:6px 0 0;font-size:14px;color:var(--ink)}
  header .hint{margin:4px 0 0;font-size:12px;color:var(--muted)}
  main{max-width:1040px;margin:0 auto;padding:4px 10px 28px}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
  @media(min-width:640px){.grid{grid-template-columns:repeat(3,1fr);gap:14px}}
  @media(min-width:900px){.grid{grid-template-columns:repeat(4,1fr)}}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(16,44,71,.06)}
  .card .photo{aspect-ratio:4/3;background:#f2f0ea;display:flex;align-items:center;justify-content:center}
  .card .photo img{width:100%;height:100%;object-fit:contain;display:block}
  .card .cta{display:block;text-align:center;background:var(--wa);color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:13px 6px;min-height:44px;line-height:1.2;display:flex;align-items:center;justify-content:center}
  .empty{padding:60px 20px;text-align:center;color:var(--muted)}
  footer{text-align:center;padding:18px 16px 28px;color:var(--muted);font-size:12px}
  </style></head><body>${body}</body></html>`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const sportSlug = String(req.query.sport ?? "").trim();
    const company = await getAdminCompany();
    const db = getSupabaseAdmin();

    const { data: category, error: categoryError } = await db
      .from("catalog_categories")
      .select("id,slug,name")
      .eq("company_id", company.id)
      .eq("slug", sportSlug)
      .eq("active", true)
      .maybeSingle();
    if (categoryError) throw categoryError;

    if (!category) {
      res.status(404).setHeader("content-type", "text/html; charset=utf-8");
      return res.send(page("Catálogo no encontrado", `<main class="empty"><h1>No encontramos este catálogo</h1><p>Puede que el deporte ya no esté disponible.</p></main>`));
    }

    const { data: media, error: mediaError } = await db
      .from("catalog_category_media")
      .select("code,storage_path,sort_order")
      .eq("category_id", category.id)
      .order("sort_order");
    if (mediaError) throw mediaError;

    const images = (media ?? []).map((entry) => {
      const { data } = db.storage.from("catalog-media").getPublicUrl(entry.storage_path);
      return { code: entry.code, url: data.publicUrl };
    });

    const grid = images.length
      ? `<div class="grid">${images
          .map(
            (image) =>
              `<article class="card"><div class="photo"><img src="${esc(image.url)}" alt="${esc(category.name)} ${esc(image.code)}" loading="lazy"></div><a class="cta" href="${esc(whatsappUrl(image.code))}" target="_blank" rel="noreferrer">Elegir · ${esc(image.code)}</a></article>`
          )
          .join("")}</div>`
      : `<div class="empty">Todavía no hay fotos disponibles para ${esc(category.name)}.</div>`;

    const body = `<header><h1>Medalleros ${esc(category.name)}</h1><p class="lead">Elige el diseño que más te guste</p><p class="hint">Al elegirlo volverás a WhatsApp para continuar tu pedido.</p></header><main>${grid}</main><footer>Medalleros Santa Cruz</footer>`;
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.status(200).setHeader("content-type", "text/html; charset=utf-8").send(page(`${category.name} · Catálogo Medalleros`, body));
  } catch (error) {
    console.error("public_catalog_page_failed", { error: error instanceof Error ? error.message : "unknown" });
    res.status(500).setHeader("content-type", "text/html; charset=utf-8").send(page("Error", `<main class="empty"><h1>No se pudo cargar el catálogo</h1></main>`));
  }
}
