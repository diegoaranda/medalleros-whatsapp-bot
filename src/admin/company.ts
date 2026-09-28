import { getSupabaseAdmin } from "../db/supabase.js";

export async function getAdminCompany() {
  const companyId = process.env.ADMIN_COMPANY_ID;
  if (!companyId) throw new Error("ADMIN_COMPANY_ID is required for the administrative UI");
  const { data, error } = await getSupabaseAdmin()
    .from("companies")
    .select("id,name")
    .eq("id", companyId)
    .maybeSingle();
  if (error || !data) throw new Error("La empresa administrativa no está disponible");
  return data;
}
