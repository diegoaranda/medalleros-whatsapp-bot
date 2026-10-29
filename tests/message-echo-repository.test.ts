import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { SupabaseMessageEchoRepository } from "../src/db/message-echo-repository.js";
import type { NormalizedMessageEcho } from "../src/core/types.js";

type Row = Record<string, any>;

/** Exercise the real Supabase/PostgREST client against an in-memory HTTP transport.
 * No Supabase server, production credentials or network requests are used. */
function database() {
  const tables: Record<string, Row[]> = {
    channels: [{ id: "channel-1", company_id: "company-1", external_id: "414146038441176", provider: "whatsapp", status: "active" }],
    contacts: [], conversations: [], messages: []
  };
  const calls: { table: string; method: string; body?: Row; url: URL; headers: Headers }[] = [];
  let sequence = 0;
  let failTable: string | undefined;
  let failMethod: string | undefined;
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const table = url.pathname.split("/").at(-1)!;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ table, method, body, url, headers });
    const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (table === failTable && method === failMethod) {
      failTable = undefined;
      return response({ code: "TEST", message: "simulated database failure" }, 500);
    }
    const rows = tables[table];
    if (!rows) throw new Error(`Unexpected table: ${table}`);
    function matches(row: Row) {
      for (const [key, filter] of url.searchParams) {
        if (filter.startsWith("eq.") && String(row[key]) !== filter.slice(3)) return false;
      }
      const or = url.searchParams.get("or");
      if (or) {
        const timestamp = or.match(/last_message_at\.lt\.(.*?)\)$/)?.[1];
        if (!timestamp) throw new Error(`Unexpected activity condition: ${or}`);
        if (row.last_message_at != null && row.last_message_at >= timestamp) return false;
      }
      return true;
    }
    if (method === "GET") {
      const found = rows.filter(matches);
      if (headers.get("Accept")?.includes("vnd.pgrst.object")) {
        return found.length === 1 ? response(found[0]) : response({ code: "PGRST116", message: "Expected one row" }, 406);
      }
      return response(found);
    }
    if (method === "POST") {
      const conflictKeys = url.searchParams.get("on_conflict")?.split(",");
      if (!conflictKeys || !headers.get("Prefer")?.includes("resolution=ignore-duplicates")) {
        throw new Error("Expected conflict-safe insert without overwriting existing rows");
      }
      const existing = rows.find((row) => conflictKeys.every((key) => row[key] === body[key]));
      if (existing) return response([]);
      const row = { id: `row-${++sequence}`, ...body };
      rows.push(row);
      return response([row], 201);
    }
    if (method === "PATCH") {
      const changed = rows.filter(matches);
      changed.forEach((row) => Object.assign(row, body));
      return response(changed);
    }
    throw new Error(`Unexpected database operation: ${method}`);
  });
  const client = createClient("https://supabase.test", "test-service-role", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: transport }
  });
  return {
    tables, calls, repository: new SupabaseMessageEchoRepository(client),
    failNext: (table: string, method: string) => { failTable = table; failMethod = method; }
  };
}

function echo(overrides: Partial<NormalizedMessageEcho> = {}): NormalizedMessageEcho {
  return {
    provider: "whatsapp", channelExternalId: "414146038441176", recipientExternalId: "59170000001",
    externalMessageId: "wamid.echo", timestamp: "2026-09-28T00:00:00.000Z", type: "text", text: "Confirmado",
    content: { type: "text", text: { body: "Confirmado" }, context: { id: "wamid.previous" } }, ...overrides
  };
}

describe("SupabaseMessageEchoRepository", () => {
  it("persists an outbound echo in the existing recipient conversation without overwriting names/status", async () => {
    const db = database();
    db.tables.contacts.push({ id: "contact-1", company_id: "company-1", channel_id: "channel-1", external_id: "59170000001", display_name: "Cliente conocido", metadata: { existing: true } });
    db.tables.conversations.push({ id: "conversation-1", company_id: "company-1", channel_id: "channel-1", contact_id: "contact-1", status: "closed", automation_status: "paused_human" });
    expect(await db.repository.ingestOutboundMessage(echo())).toEqual({ duplicate: false });
    expect(db.tables.messages).toEqual([expect.objectContaining({
      company_id: "company-1", channel_id: "channel-1", contact_id: "contact-1", conversation_id: "conversation-1",
      direction: "outbound", external_message_id: "wamid.echo", message_type: "text", text_body: "Confirmado",
      occurred_at: "2026-09-28T00:00:00.000Z", content: echo().content
    })]);
    expect(db.tables.contacts).toHaveLength(1);
    expect(db.tables.contacts[0]).toMatchObject({ display_name: "Cliente conocido", metadata: { existing: true } });
    expect(db.tables.conversations).toHaveLength(1);
    expect(db.tables.conversations[0]).toMatchObject({ status: "closed", automation_status: "paused_human", last_message_at: echo().timestamp });
    expect(db.calls.some((call) => call.table.startsWith("flow"))).toBe(false);
  });

  it("creates missing contact/conversation without inventing a profile or message text", async () => {
    const db = database();
    const media = echo({ type: "image", text: undefined, content: { type: "image", image: { id: "media-1", caption: "Diseño" } } });
    await db.repository.ingestOutboundMessage(media);
    expect(db.tables.contacts[0]).toMatchObject({ external_id: "59170000001" });
    expect(db.tables.contacts[0]).not.toHaveProperty("display_name");
    expect(db.tables.messages[0]).toMatchObject({ direction: "outbound", text_body: null, content: media.content });
  });

  it("deduplicates concurrent redeliveries using the existing channel/message unique key", async () => {
    const db = database();
    const results = await Promise.all([db.repository.ingestOutboundMessage(echo()), db.repository.ingestOutboundMessage(echo())]);
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
    expect(db.tables.messages).toHaveLength(1);
    expect(db.tables.contacts).toHaveLength(1);
    expect(db.tables.conversations).toHaveLength(1);
    const messageInsert = db.calls.find((call) => call.table === "messages" && call.method === "POST")!;
    expect(messageInsert.url.searchParams.get("on_conflict")).toBe("channel_id,external_message_id");
    expect(messageInsert.headers.get("Prefer")).toContain("resolution=ignore-duplicates");
  });

  it("does not overwrite a message already persisted under the same channel/id", async () => {
    const db = database();
    await db.repository.ingestOutboundMessage(echo());
    expect(await db.repository.ingestOutboundMessage(echo({ text: "Different redelivery" }))).toEqual({ duplicate: true });
    expect(db.tables.messages[0].text_body).toBe("Confirmado");
  });

  it("keeps identical external IDs in different channels/companies separate", async () => {
    const db = database();
    db.tables.channels.push({ id: "channel-2", company_id: "company-2", external_id: "other-channel", provider: "whatsapp", status: "active" });
    await db.repository.ingestOutboundMessage(echo());
    expect(await db.repository.ingestOutboundMessage(echo({ channelExternalId: "other-channel" }))).toEqual({ duplicate: false });
    expect(db.tables.messages.map((message) => message.company_id)).toEqual(["company-1", "company-2"]);
    expect(db.tables.contacts).toHaveLength(2);
  });

  it("does not rewind last_message_at when an older echo arrives", async () => {
    const db = database();
    await db.repository.ingestOutboundMessage(echo({ timestamp: "2026-09-29T00:00:00.000Z" }));
    await db.repository.ingestOutboundMessage(echo({ externalMessageId: "wamid.older" }));
    expect(db.tables.conversations[0].last_message_at).toBe("2026-09-29T00:00:00.000Z");
    expect(db.tables.messages).toHaveLength(2);
  });

  it.each(["missing", "disabled"])("rejects a %s channel before creating any rows", async (state) => {
    const db = database();
    if (state === "missing") db.tables.channels = [];
    else db.tables.channels[0].status = "disabled";
    await expect(db.repository.ingestOutboundMessage(echo())).rejects.toThrow("Echo channel lookup failed");
    expect(db.tables.contacts).toHaveLength(0);
    expect(db.tables.messages).toHaveLength(0);
  });

  it.each([
    ["contacts", "POST"], ["contacts", "GET"], ["conversations", "POST"],
    ["conversations", "GET"], ["messages", "POST"], ["conversations", "PATCH"]
  ])("reports %s %s failure and can finish a subsequent redelivery", async (table, method) => {
    const db = database();
    db.failNext(table, method);
    await expect(db.repository.ingestOutboundMessage(echo())).rejects.toThrow();
    await db.repository.ingestOutboundMessage(echo());
    expect(db.tables.messages).toHaveLength(1);
    expect(db.tables.conversations[0].last_message_at).toBe(echo().timestamp);
  });
});
