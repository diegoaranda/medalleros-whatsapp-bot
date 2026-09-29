import type { SupabaseClient } from "@supabase/supabase-js";
import type { AutomationFaq } from "../flows/automation-faq.js";
import type { IntakeAutomationGateway, IntakeExecution, IntakeExecutionStatus, IntakeFlowConfig } from "../flows/intake-runner.js";
import { DEFAULT_INTAKE_MESSAGES, type CatalogSport, type IntakeMessages, type IntakeState } from "../flows/whatsapp-intake.js";

const FLOW_NAME = "Atención inicial de WhatsApp";
const VALID_STATES: IntakeState[] = ["NEW", "WAITING_FOR_SPORT", "SHOWING_OPTIONS", "WAITING_FOR_SELECTION", "HUMAN_HANDOFF"];

function getPublicBaseUrl(): string {
  return process.env.PUBLIC_BASE_URL || "https://medalleros-whatsapp-bot.vercel.app";
}

export class SupabaseIntakeAutomationGateway implements IntakeAutomationGateway {
  constructor(private readonly client: SupabaseClient) {}

  async getFlowConfig(companyId: string): Promise<IntakeFlowConfig | null> {
    const { data: flow, error: flowError } = await this.client
      .from("flows")
      .select("id,status")
      .eq("company_id", companyId)
      .eq("name", FLOW_NAME)
      .maybeSingle();
    if (flowError) throw new Error(`Flow lookup failed: ${flowError.message}`);
    if (!flow) return null;

    const { data: version, error: versionError } = await this.client
      .from("flow_versions")
      .select("id,definition")
      .eq("flow_id", flow.id)
      .eq("published", true)
      .maybeSingle();
    if (versionError) throw new Error(`Flow version lookup failed: ${versionError.message}`);
    if (!version) return null;

    const definition = (version.definition ?? {}) as { messages?: Partial<IntakeMessages> };
    const messages: IntakeMessages = { ...DEFAULT_INTAKE_MESSAGES, ...definition.messages };
    return { flowId: flow.id, flowVersionId: version.id, active: flow.status === "active", messages };
  }

  async getActiveFaqs(companyId: string, flowId: string): Promise<AutomationFaq[]> {
    const { data: faqs, error: faqError } = await this.client
      .from("automation_faqs")
      .select("id,title,answer,classifier_description,sort_order")
      .eq("company_id", companyId)
      .eq("flow_id", flowId)
      .eq("active", true)
      .order("sort_order");
    if (faqError) throw new Error(`FAQ lookup failed: ${faqError.message}`);
    const faqIds = (faqs ?? []).map((faq) => faq.id);

    const { data: aliasRows, error: aliasError } = faqIds.length
      ? await this.client.from("automation_faq_aliases").select("faq_id,alias").in("faq_id", faqIds)
      : { data: [], error: null };
    if (aliasError) throw new Error(`FAQ alias lookup failed: ${aliasError.message}`);

    const aliasesByFaq = new Map<string, string[]>();
    for (const row of aliasRows ?? []) {
      const list = aliasesByFaq.get(row.faq_id) ?? [];
      list.push(row.alias);
      aliasesByFaq.set(row.faq_id, list);
    }

    return (faqs ?? []).map((faq) => ({
      id: faq.id,
      title: faq.title,
      answer: faq.answer,
      classifierDescription: faq.classifier_description,
      aliases: aliasesByFaq.get(faq.id) ?? [],
      sortOrder: faq.sort_order
    }));
  }

  async getCatalogSports(companyId: string): Promise<{ sports: CatalogSport[]; imageIdByCode: Map<string, string> }> {
    const { data: categories, error: categoryError } = await this.client
      .from("catalog_categories")
      .select("id,slug,name")
      .eq("company_id", companyId)
      .eq("active", true)
      .order("sort_order")
      .order("name");
    if (categoryError) throw new Error(`Active categories lookup failed: ${categoryError.message}`);

    const categoryIds = (categories ?? []).map((category) => category.id);
    const [{ data: media, error: mediaError }, { data: aliasRows, error: aliasError }] = categoryIds.length
      ? await Promise.all([
          this.client.from("catalog_category_media").select("id,category_id,code").in("category_id", categoryIds).order("sort_order"),
          this.client.from("catalog_category_aliases").select("category_id,alias").in("category_id", categoryIds)
        ])
      : [{ data: [], error: null }, { data: [], error: null }];
    if (mediaError) throw new Error(`Category media lookup failed: ${mediaError.message}`);
    if (aliasError) throw new Error(`Category aliases lookup failed: ${aliasError.message}`);

    const codesByCategory = new Map<string, string[]>();
    const imageIdByCode = new Map<string, string>();
    for (const entry of media ?? []) {
      const list = codesByCategory.get(entry.category_id) ?? [];
      list.push(entry.code);
      codesByCategory.set(entry.category_id, list);
      imageIdByCode.set(entry.code, entry.id);
    }
    const aliasesByCategory = new Map<string, string[]>();
    for (const entry of aliasRows ?? []) {
      const list = aliasesByCategory.get(entry.category_id) ?? [];
      list.push(entry.alias);
      aliasesByCategory.set(entry.category_id, list);
    }

    const baseUrl = getPublicBaseUrl();
    const sports: CatalogSport[] = (categories ?? []).map((category) => ({
      slug: category.slug,
      name: category.name,
      codes: codesByCategory.get(category.id) ?? [],
      aliases: aliasesByCategory.get(category.id) ?? [],
      catalogUrl: `${baseUrl}/catalogo/${category.slug}`
    }));

    return { sports, imageIdByCode };
  }

  async getLatestExecution(flowVersionId: string, conversationId: string): Promise<IntakeExecution | null> {
    const { data, error } = await this.client
      .from("flow_executions")
      .select("id,status,current_node_id,variables")
      .eq("flow_version_id", flowVersionId)
      .eq("conversation_id", conversationId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Execution lookup failed: ${error.message}`);
    if (!data) return null;

    const state: IntakeState = VALID_STATES.includes(data.current_node_id as IntakeState) ? (data.current_node_id as IntakeState) : "NEW";
    return { id: data.id, status: data.status as IntakeExecutionStatus, state, variables: data.variables ?? {} };
  }

  async createExecution(params: {
    companyId: string;
    flowVersionId: string;
    conversationId: string;
    contactId: string;
    status: IntakeExecutionStatus;
    state: IntakeState;
    variables: Record<string, unknown>;
  }): Promise<void> {
    const nowIso = new Date().toISOString();
    const { error } = await this.client.from("flow_executions").insert({
      company_id: params.companyId,
      flow_version_id: params.flowVersionId,
      conversation_id: params.conversationId,
      contact_id: params.contactId,
      status: params.status,
      current_node_id: params.state,
      variables: params.variables,
      started_at: nowIso,
      updated_at: nowIso,
      completed_at: params.status === "completed" ? nowIso : null
    });
    if (error) throw new Error(`Execution creation failed: ${error.message}`);
  }

  async updateExecution(id: string, params: { status: IntakeExecutionStatus; state: IntakeState; variables: Record<string, unknown> }): Promise<void> {
    const nowIso = new Date().toISOString();
    const { error } = await this.client
      .from("flow_executions")
      .update({
        status: params.status,
        current_node_id: params.state,
        variables: params.variables,
        updated_at: nowIso,
        completed_at: params.status === "completed" ? nowIso : null
      })
      .eq("id", id);
    if (error) throw new Error(`Execution update failed: ${error.message}`);
  }

  async pauseConversation(conversationId: string): Promise<void> {
    const { error } = await this.client
      .from("conversations")
      .update({ automation_status: "paused_human", updated_at: new Date().toISOString() })
      .eq("id", conversationId);
    if (error) throw new Error(`Conversation pause failed: ${error.message}`);
  }

  async resumeConversation(conversationId: string): Promise<void> {
    const { error } = await this.client
      .from("conversations")
      .update({ automation_status: "active", updated_at: new Date().toISOString() })
      .eq("id", conversationId);
    if (error) throw new Error(`Conversation resume failed: ${error.message}`);
  }
}
