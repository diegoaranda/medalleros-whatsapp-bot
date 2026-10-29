import type { SupabaseClient } from "@supabase/supabase-js";
import { formatBoliviaDateTime } from "./date.js";

export interface ConversationSummary {
  id: string;
  status: string;
  automation_status: string;
  last_message_at: string | null;
  contacts: { display_name: string | null; external_id: string } | null;
  channels: { display_name: string | null; external_id: string } | null;
}

export interface ConversationMessage {
  id: string;
  direction: "inbound" | "outbound";
  message_type: string;
  text_body: string | null;
  content: Record<string, unknown> | null;
  occurred_at: string;
  created_at: string;
}

const PAGE_SIZE = 200;
const esc = (value: string) => value.replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);

export async function loadConversations(db: SupabaseClient, companyId: string): Promise<ConversationSummary[]> {
  const rows: ConversationSummary[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await db.from("conversations")
      .select("id,status,automation_status,last_message_at,contacts(display_name,external_id),channels(display_name,external_id)")
      .eq("company_id", companyId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`Conversation list lookup failed: ${error.message}`);
    const page = (data ?? []) as unknown as ConversationSummary[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

export async function loadConversationMessages(db: SupabaseClient, companyId: string, conversationId: string): Promise<ConversationMessage[]> {
  const rows: ConversationMessage[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await db.from("messages")
      .select("id,direction,message_type,text_body,content,occurred_at,created_at")
      .eq("company_id", companyId)
      .eq("conversation_id", conversationId)
      .order("occurred_at", { ascending: true })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`Conversation messages lookup failed: ${error.message}`);
    const page = (data ?? []) as ConversationMessage[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function messageText(message: ConversationMessage): string {
  if (message.text_body != null) return message.text_body;
  const content = message.content ?? {};
  // Inbound content holds the type object; echoes retain the complete envelope.
  const typed = record(content[message.message_type]);
  for (const value of [typed.body, typed.caption, typed.filename, content.body, content.caption, content.filename]) {
    if (typeof value === "string") return value;
  }
  const labels: Record<string, string> = {
    image: "Imagen", document: "Documento", audio: "Audio", video: "Video",
    sticker: "Sticker", edit: "Edición de mensaje", revoke: "Mensaje eliminado"
  };
  return `[${labels[message.message_type] ?? message.message_type}]`;
}

export function renderConversations(rows: ConversationSummary[], selected: ConversationSummary | undefined, messages: ConversationMessage[]): string {
  const list = rows.map((row) => {
    const active = row.id === selected?.id;
    return `<a class="row conversation-item${active ? " selected" : ""}" href="/conversations?conversation=${encodeURIComponent(row.id)}"${active ? ' aria-current="true"' : ""}><div><strong>${esc(row.contacts?.display_name || row.contacts?.external_id || "Contacto")}</strong><small>${esc(row.contacts?.external_id || "")}</small><small>${esc(formatBoliviaDateTime(row.last_message_at))}</small></div></a>`;
  }).join("") || '<div class="empty">Aún no hay conversaciones.</div>';

  const history = messages.map((message) => {
    const outbound = message.direction === "outbound";
    return `<article class="message ${outbound ? "outbound" : "inbound"}" data-message-id="${esc(message.id)}"><div class="message-meta"><strong>${outbound ? "Jhoselin" : "Cliente"}</strong><time datetime="${esc(message.occurred_at)}">${esc(formatBoliviaDateTime(message.occurred_at))}</time></div><div class="message-body">${esc(messageText(message))}</div></article>`;
  }).join("") || '<div class="empty">Esta conversación aún no tiene mensajes almacenados.</div>';

  const detail = selected
    ? `<header class="conversation-header"><h3>${esc(selected.contacts?.display_name || selected.contacts?.external_id || "Contacto")}</h3><p class="meta">Canal: ${esc(selected.channels?.display_name || selected.channels?.external_id || "WhatsApp")} · <span class="status ${selected.automation_status === "paused_human" ? "paused" : ""}">Automatización: ${selected.automation_status === "paused_human" ? "pausada por humano" : "activa"}</span></p><p class="meta">${messages.length} ${messages.length === 1 ? "mensaje" : "mensajes"} · Horas de Bolivia (UTC−4)</p></header><div class="conversation-history" role="region" aria-label="Historial de mensajes" tabindex="0">${history}</div>`
    : `<div class="empty">${rows.length ? "La conversación seleccionada no está disponible." : "Selecciona una conversación."}</div>`;

  return `<style>
    .conversation{align-items:start}.conversation-list{max-height:75vh;overflow-y:auto}.conversation-item{color:inherit;text-decoration:none;margin:4px;overflow-wrap:anywhere}.conversation-item:focus-visible{outline:2px solid var(--teal);outline-offset:-2px}.conversation .detail{min-width:0}.conversation-header{border-bottom:1px solid var(--line);padding-bottom:10px}.conversation-history{max-height:65vh;overflow-y:auto;padding:12px 0;display:flex;flex-direction:column;gap:12px}.conversation .message{margin:0;max-width:85%;min-width:0;align-self:flex-start;border:1px solid var(--line)}.conversation .message.outbound{align-self:flex-end;background:#e0f4f3;border-color:#b5dfdc}.message-meta{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;margin-bottom:6px;font-size:12px}.message-meta time{color:var(--muted)}.message-body{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}@media(max-width:760px){.conversation-list{max-height:240px}.conversation-history{max-height:65vh}.conversation .message{max-width:95%}.conversation .detail{padding:16px}}
    </style><div class="titlebar"><div><h1>Conversaciones</h1><div class="subtitle">Vista de solo lectura · America/La_Paz</div></div></div><div class="panel conversation"><nav class="conversation-list" aria-label="Conversaciones">${list}</nav><section class="detail">${detail}</section></div>`;
}

export async function conversationsPage(db: SupabaseClient, companyId: string, selectedId?: string): Promise<string> {
  const rows = await loadConversations(db, companyId);
  const selected = selectedId ? rows.find((row) => row.id === selectedId) : rows[0];
  const messages = selected ? await loadConversationMessages(db, companyId, selected.id) : [];
  return renderConversations(rows, selected, messages);
}
