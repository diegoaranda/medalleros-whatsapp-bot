import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { formatBoliviaDateTime } from "../src/admin/date.js";
import { conversationsPage, loadConversations, loadConversationMessages, renderConversations, type ConversationMessage, type ConversationSummary } from "../src/admin/conversations.js";

function conversation(id = "conversation-1"): ConversationSummary {
  return { id, status: "open", automation_status: "active", last_message_at: "2026-10-29T17:05:15+00:00",
    contacts: { display_name: `Contacto ${id}`, external_id: "59170000001" }, channels: { display_name: "Medalleros", external_id: "414146038441176" } };
}

function message(id: string, overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return { id, direction: "inbound", message_type: "text", text_body: `Mensaje ${id}`, content: {},
    occurred_at: "2026-10-29T17:05:15+00:00", created_at: "2026-10-29T17:05:18+00:00", ...overrides };
}

/** Real Supabase client with a GET-only transport. Pagination and ordering are
 * checked at the HTTP boundary; no connection to the actual database. */
function database(conversations: ConversationSummary[], messages: ConversationMessage[]) {
  const requests: URL[] = [];
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    const url = new URL(String(input));
    requests.push(url);
    expect(url.searchParams.get("company_id")).toBe("eq.company-1");
    const isMessages = url.pathname.endsWith("/messages");
    const rows = isMessages ? messages : conversations;
    if (isMessages) {
      expect(url.searchParams.get("conversation_id")).toBe("eq.conversation-2");
      expect(url.searchParams.get("direction")).toBeNull();
      expect(url.searchParams.get("order")).toBe("occurred_at.asc,created_at.asc,id.asc");
    } else {
      expect(url.searchParams.get("select")).not.toContain("messages(");
      expect(url.searchParams.get("order")).toBe("last_message_at.desc.nullslast,id.asc");
    }
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit"));
    expect(limit).toBe(200);
    return new Response(JSON.stringify(rows.slice(offset, offset + limit)), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const db = createClient("https://supabase.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: transport }
  });
  return { db, requests };
}

describe("Bolivia presentation dates", () => {
  it("renders the UTC instant as Bolivia time without changing the timestamp", () => {
    const timestamp = "2026-10-29T17:05:15+00:00";
    expect(formatBoliviaDateTime(timestamp)).toContain("13:05");
    expect(timestamp).toBe("2026-10-29T17:05:15+00:00");
  });

  it("shows the preceding local calendar day near UTC midnight", () => {
    const formatted = formatBoliviaDateTime("2026-10-29T02:30:00Z");
    expect(formatted).toContain("28 oct");
    expect(formatted).toContain("22:30");
  });

  it("renders equivalent instants identically regardless of their stored offset", () => {
    expect(formatBoliviaDateTime("2026-10-29T17:05:15Z"))
      .toBe(formatBoliviaDateTime("2026-10-29T13:05:15-04:00"));
  });

  it.each([null, undefined, "", "invalid"])("handles missing/invalid dates: %j", (value) => {
    expect(formatBoliviaDateTime(value)).toBe("—");
  });
});

describe("conversation history", () => {
  it("loads all stored messages beyond one API page, in a stable chronological order", async () => {
    const messages = Array.from({ length: 451 }, (_, i) => message(`message-${i}`, { direction: i % 2 ? "outbound" : "inbound" }));
    const { db, requests } = database([], messages);
    const result = await loadConversationMessages(db, "company-1", "conversation-2");
    expect(result).toEqual(messages);
    expect(requests.map((url) => url.searchParams.get("offset"))).toEqual(["0", "200", "400"]);
  });

  it("paginates the conversation list too", async () => {
    const rows = Array.from({ length: 205 }, (_, i) => conversation(`conversation-${i}`));
    const { db } = database(rows, []);
    expect(await loadConversations(db, "company-1")).toEqual(rows);
  });

  it("selects the requested conversation and renders both authors and every message", async () => {
    const rows = [conversation(), conversation("conversation-2")];
    const { db } = database(rows, [message("first"), message("second", { direction: "outbound" }), message("third")]);
    const html = await conversationsPage(db, "company-1", "conversation-2");
    expect(html).toContain('href="/conversations?conversation=conversation-1"');
    expect(html).toContain('href="/conversations?conversation=conversation-2" aria-current="true"');
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain("<strong>Cliente</strong>");
    expect(html).toContain("<strong>Jhoselin</strong>");
    expect(html).toContain('class="message inbound"');
    expect(html).toContain('class="message outbound"');
    expect(html).toContain("3 mensajes");
    expect(html.indexOf('data-message-id="first"')).toBeLessThan(html.indexOf('data-message-id="second"'));
    expect(html.indexOf('data-message-id="second"')).toBeLessThan(html.indexOf('data-message-id="third"'));
    expect(html).toContain('datetime="2026-10-29T17:05:15+00:00"');
    expect(html).toContain("13:05");
  });

  it("defaults to the first conversation only when no selection was supplied", async () => {
    const { db } = database([conversation("conversation-2"), conversation()], []);
    expect(await conversationsPage(db, "company-1")).toContain('conversation=conversation-2" aria-current="true"');
  });

  it("does not query messages of an unavailable or foreign conversation", async () => {
    const { db, requests } = database([conversation()], []);
    expect(await conversationsPage(db, "company-1", "foreign-id")).toContain("La conversación seleccionada no está disponible");
    expect(requests).toHaveLength(1);
  });

  it("renders clear empty list/history states", () => {
    expect(renderConversations([], undefined, [])).toContain("Aún no hay conversaciones");
    const row = conversation();
    expect(renderConversations([row], row, [])).toContain("Esta conversación aún no tiene mensajes almacenados");
  });

  it("shows captions and filenames from both inbound and echo JSON layouts", () => {
    const row = conversation();
    const html = renderConversations([row], row, [
      message("image-in", { text_body: null, message_type: "image", content: { caption: "Foto del cliente" } }),
      message("image-out", { direction: "outbound", text_body: null, message_type: "image", content: { image: { caption: "Foto de Jhoselin" } } }),
      message("doc", { direction: "outbound", text_body: null, message_type: "document", content: { document: { filename: "Diseño.pdf" } } }),
      message("audio", { text_body: null, message_type: "audio", content: null })
    ]);
    for (const text of ["Foto del cliente", "Foto de Jhoselin", "Diseño.pdf", "[Audio]"]) expect(html).toContain(text);
  });

  it("escapes message and profile HTML while preserving text line breaks", () => {
    const row = conversation();
    row.contacts!.display_name = '<script>alert("profile")</script>';
    const html = renderConversations([row], row, [message("x", { text_body: '<img src=x onerror="alert(1)">\nSegunda línea' })]);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("\nSegunda línea");
  });

  it("reports a database error instead of showing a partial history as complete", async () => {
    const db = createClient("https://supabase.test", "test-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async () => new Response(JSON.stringify({ message: "read failed" }), { status: 400 }) }
    });
    await expect(loadConversationMessages(db, "company-1", "conversation-2")).rejects.toThrow("Conversation messages lookup failed");
    await expect(loadConversations(db, "company-1")).rejects.toThrow("Conversation list lookup failed");
  });
});
