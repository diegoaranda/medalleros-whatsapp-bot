import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebhookHandler } from "../api/webhook.js";

function responseMock() {
  const response = { statusCode: 0, body: undefined as unknown, status: vi.fn(), send: vi.fn(), json: vi.fn() };
  response.status.mockImplementation((code: number) => { response.statusCode = code; return response; });
  response.send.mockImplementation((body: unknown) => { response.body = body; return response; });
  response.json.mockImplementation((body: unknown) => { response.body = body; return response; });
  return response;
}

function requestMock(method: string, options: { query?: Record<string, string>; body?: string; signature?: string } = {}) {
  const request = Readable.from(method === "POST" ? [Buffer.from(options.body ?? "")] : []) as Readable & Record<string, unknown>;
  request.method = method;
  request.query = options.query ?? {};
  request.headers = options.signature ? { "x-hub-signature-256": options.signature } : {};
  return request;
}

describe("WhatsApp webhook", () => {
  const secret = "test-app-secret";
  let processPayload: ReturnType<typeof vi.fn>;
  let deferred: Promise<unknown>[];
  let webhook: ReturnType<typeof createWebhookHandler>;

  beforeEach(() => { process.env.WHATSAPP_VERIFY_TOKEN = "verify-token"; process.env.META_APP_SECRET = secret; });

  beforeEach(() => {
    processPayload = vi.fn().mockResolvedValue(undefined);
    deferred = [];
    webhook = createWebhookHandler({ processPayload, defer: (work) => deferred.push(work) });
  });

  it("verifies Meta subscriptions", async () => {
    const response = responseMock();
    await webhook(requestMock("GET", { query: { "hub.mode": "subscribe", "hub.verify_token": "verify-token", "hub.challenge": "challenge-value" } }) as never, response as never);
    expect(response.statusCode).toBe(200); expect(response.body).toBe("challenge-value");
  });

  it("rejects an incorrect verify token", async () => {
    const response = responseMock();
    await webhook(requestMock("GET", { query: { "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "x" } }) as never, response as never);
    expect(response.statusCode).toBe(403);
  });

  it("accepts a signed text message", async () => {
    const body = JSON.stringify({ entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "414146038441176" }, messages: [{ from: "59167889020", id: "wamid.1", timestamp: "1", type: "text", text: { body: "Hola" } }] } }] }] });
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const response = responseMock();
    await webhook(requestMock("POST", { body, signature }) as never, response as never);
    await Promise.all(deferred);
    expect(response.statusCode).toBe(200);
    expect(processPayload).toHaveBeenCalledWith(JSON.parse(body));
  });

  it("rejects an invalid signature", async () => {
    const response = responseMock();
    await webhook(requestMock("POST", { body: "{}", signature: "sha256=invalid" }) as never, response as never);
    expect(response.statusCode).toBe(401);
  });

  it("accepts signed events without messages", async () => {
    const body = JSON.stringify({ entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "wamid.1", status: "delivered" }] } }] }] });
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const response = responseMock();
    await webhook(requestMock("POST", { body, signature }) as never, response as never);
    expect(response.statusCode).toBe(200);
  });
});
