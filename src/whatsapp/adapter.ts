import type { ChannelAdapter, OutboundTarget } from "../core/types.js";

interface WhatsAppAdapterOptions {
  graphApiVersion?: string;
  fetch?: typeof globalThis.fetch;
}

export class WhatsAppCloudAdapter implements ChannelAdapter {
  private readonly graphApiVersion: string;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(options: WhatsAppAdapterOptions = {}) {
    this.graphApiVersion = options.graphApiVersion ?? process.env.WHATSAPP_GRAPH_API_VERSION ?? "v23.0";
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  sendText(target: OutboundTarget, text: string): Promise<string> {
    return this.send(target, { type: "text", text: { body: text } });
  }

  sendImage(target: OutboundTarget, imageUrl: string, caption?: string): Promise<string> {
    return this.send(target, { type: "image", image: { link: imageUrl, ...(caption ? { caption } : {}) } });
  }

  sendInteractive(target: OutboundTarget, interactive: Record<string, unknown>): Promise<string> {
    return this.send(target, { type: "interactive", interactive });
  }

  private async send(target: OutboundTarget, message: Record<string, unknown>): Promise<string> {
    const token = process.env[target.credentialEnvKey];
    if (!token) throw new Error(`Missing server credential: ${target.credentialEnvKey}`);

    const response = await this.fetchImplementation(
      `https://graph.facebook.com/${this.graphApiVersion}/${encodeURIComponent(target.channelExternalId)}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: target.recipientExternalId, ...message })
      }
    );
    if (!response.ok) throw new Error(`WhatsApp send failed with HTTP ${response.status}`);

    const body = await response.json() as { messages?: Array<{ id?: string }> };
    const id = body.messages?.[0]?.id;
    if (!id) throw new Error("WhatsApp send response did not include a message id");
    return id;
  }
}
