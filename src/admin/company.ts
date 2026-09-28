import { getSupabaseAdmin } from "../db/supabase.js";

export const MEDALLEROS_COMPANY_NAME = "Medalleros Santa Cruz";

export async function getAdminCompany() {
  const { data, error } = await getSupabaseAdmin()
    .from("companies")
    .select("id,name")
    .eq("name", MEDALLEROS_COMPANY_NAME)
    .maybeSingle();
  if (error || !data) throw new Error("La empresa administrativa no está disponible");
  return data;
}
