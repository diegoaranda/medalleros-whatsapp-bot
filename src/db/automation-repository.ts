import type { SupabaseClient } from "@supabase/supabase-js";
import type { AutomationRepository, ExecutionUpdate, FlowExecution, IngestedMessageContext, NormalizedInboundMessage } from "../core/types.js";

interface IngestRow {
  duplicate: boolean;
  company_id: string;
  channel_id: string;
  contact_id: string;
  conversation_id: string;
  message_id: string | null;
  automation_status: "active" | "paused_human";
  credential_env_key: string;
  previous_last_message_at: string | null;
}

export class SupabaseAutomationRepository implements AutomationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async ingestInboundMessage(message: NormalizedInboundMessage): Promise<IngestedMessageContext> {
    const { data, error } = await this.client.rpc("ingest_inbound_message", {
      p_provider: message.provider,
      p_channel_external_id: message.channelExternalId,
      p_sender_external_id: message.senderExternalId,
      p_sender_name: message.senderName ?? null,
      p_external_message_id: message.externalMessageId,
      p_message_timestamp: message.timestamp,
      p_message_type: message.type,
      p_text_body: message.text ?? null,
      p_content: message.content
    });
    if (error) throw new Error(`Inbound message persistence failed: ${error.message}`);
    const row = (data as IngestRow[] | null)?.[0];
    if (!row) throw new Error("Inbound message persistence returned no result");

    return {
      duplicate: row.duplicate,
      companyId: row.company_id,
      channelId: row.channel_id,
      contactId: row.contact_id,
      conversationId: row.conversation_id,
      messageId: row.message_id ?? undefined,
      automationStatus: row.automation_status,
      channelExternalId: message.channelExternalId,
      channelCredentialEnvKey: row.credential_env_key,
      senderExternalId: message.senderExternalId,
      previousLastMessageAt: row.previous_last_message_at
    };
  }

  async findWaitingExecution(conversationId: string): Promise<FlowExecution | null> {
    const { data, error } = await this.client
      .from("flow_executions")
      .select("id,company_id,conversation_id,status,runtime_state")
      .eq("conversation_id", conversationId)
      .eq("status", "waiting_reply")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Waiting execution lookup failed: ${error.message}`);
    if (!data) return null;
    return {
      id: data.id,
      companyId: data.company_id,
      conversationId: data.conversation_id,
      status: data.status,
      runtimeState: data.runtime_state ?? {}
    } as FlowExecution;
  }

  async updateExecution(executionId: string, update: ExecutionUpdate): Promise<void> {
    const values: Record<string, unknown> = { status: update.status, updated_at: new Date().toISOString() };
    if (update.runtimeState !== undefined) values.runtime_state = update.runtimeState;
    if (update.error !== undefined) values.error = update.error;
    if (update.completedAt !== undefined) values.completed_at = update.completedAt;
    const { error } = await this.client.from("flow_executions").update(values).eq("id", executionId);
    if (error) throw new Error(`Flow execution update failed: ${error.message}`);
  }

  async setAutomationPaused(conversationId: string, paused: boolean): Promise<void> {
    const now = new Date().toISOString();
    const { error: conversationError } = await this.client
      .from("conversations")
      .update({ automation_status: paused ? "paused_human" : "active", updated_at: now })
      .eq("id", conversationId);
    if (conversationError) throw new Error(`Conversation automation update failed: ${conversationError.message}`);

    if (paused) {
      const { data, error } = await this.client
        .from("flow_executions")
        .select("id,status,runtime_state")
        .eq("conversation_id", conversationId)
        .in("status", ["running", "waiting_reply"]);
      if (error) throw new Error(`Active execution lookup failed: ${error.message}`);
      for (const execution of data ?? []) {
        await this.updateExecution(execution.id, {
          status: "paused_human",
          runtimeState: { ...(execution.runtime_state ?? {}), resume_status: execution.status }
        });
      }
      return;
    }

    const { data, error } = await this.client
      .from("flow_executions")
      .select("id,runtime_state")
      .eq("conversation_id", conversationId)
      .eq("status", "paused_human");
    if (error) throw new Error(`Paused execution lookup failed: ${error.message}`);
    for (const execution of data ?? []) {
      const runtimeState = { ...(execution.runtime_state ?? {}) };
      const resumeStatus = runtimeState.resume_status === "running" ? "running" : "waiting_reply";
      delete runtimeState.resume_status;
      await this.updateExecution(execution.id, { status: resumeStatus, runtimeState });
    }
  }
}
