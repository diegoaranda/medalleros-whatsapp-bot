import { createHmac, timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { processWhatsAppWebhook } from "../src/application/process-webhook.js";

export const config = { api: { bodyParser: false } };

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

interface WebhookDependencies {
  processPayload: (payload: unknown) => Promise<void>;
  defer: (work: Promise<unknown>) => void;
}

export function createWebhookHandler(dependencies: WebhookDependencies) {
  return async function handler(request: VercelRequest, response: VercelResponse) {
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
      const payload: unknown = JSON.parse(rawBody.toString("utf8"));
      dependencies.defer(dependencies.processPayload(payload));
    } catch {
      // A valid but malformed body contains no processable event.
    }
    return response.status(200).send("OK");
  };
}

export default createWebhookHandler({ processPayload: processWhatsAppWebhook, defer: waitUntil });
