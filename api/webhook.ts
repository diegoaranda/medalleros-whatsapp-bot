import { createHmac, timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export const config = { api: { bodyParser: false } };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function readRawBody(request: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function isValidSignature(rawBody: Buffer, signature: string | undefined, secret: string | undefined): boolean {
  if (!signature || !secret || !signature.startsWith("sha256=")) return false;

  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function logMessages(payload: unknown): void {
  if (!isRecord(payload) || !Array.isArray(payload.entry)) return;

  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isRecord(change) || change.field !== "messages" || !isRecord(change.value)) continue;
      const value = change.value;
      const metadata = isRecord(value.metadata) ? value.metadata : {};
      const phoneNumberId = firstString(metadata.phone_number_id);
      if (!Array.isArray(value.messages)) continue;

      for (const message of value.messages) {
        if (!isRecord(message)) continue;
        const type = firstString(message.type);
        const text = isRecord(message.text) ? firstString(message.text.body) : undefined;
        console.info("whatsapp_message_received", {
          phone_number_id: phoneNumberId,
          wa_id: firstString(message.from),
          message_id: firstString(message.id),
          timestamp: firstString(message.timestamp),
          type,
          ...(type === "text" && text !== undefined ? { body: text } : {})
        });
      }
    }
  }
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method === "GET") {
    const mode = firstString(request.query["hub.mode"]);
    const verifyToken = firstString(request.query["hub.verify_token"]);
    const challenge = firstString(request.query["hub.challenge"]);

    if (mode === "subscribe" && verifyToken === process.env.WHATSAPP_VERIFY_TOKEN && challenge !== undefined) {
      return response.status(200).send(challenge);
    }
    return response.status(403).send("Forbidden");
  }

  if (request.method !== "POST") return response.status(405).send("Method Not Allowed");

  const rawBody = await readRawBody(request);
  const signature = firstString(request.headers["x-hub-signature-256"]);
  if (!isValidSignature(rawBody, signature, process.env.META_APP_SECRET)) {
    return response.status(401).send("Unauthorized");
  }

  try {
    logMessages(JSON.parse(rawBody.toString("utf8")));
  } catch {
    // Signature validity is authoritative; malformed or unknown event bodies are ignored.
  }
  return response.status(200).send("OK");
}
