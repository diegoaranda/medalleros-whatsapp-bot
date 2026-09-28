import type { NormalizedInboundMessage } from "../core/types.js";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function messageContent(message: UnknownRecord): Record<string, unknown> {
  const type = stringValue(message.type);
  if (!type) return {};
  const value = message[type];
  return isRecord(value) ? value : {};
}

export function normalizeWhatsAppMessages(payload: unknown): NormalizedInboundMessage[] {
  if (!isRecord(payload) || !Array.isArray(payload.entry)) return [];
  const normalized: NormalizedInboundMessage[] = [];

  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isRecord(change) || change.field !== "messages" || !isRecord(change.value)) continue;
      const value = change.value;
      const metadata = isRecord(value.metadata) ? value.metadata : undefined;
      const phoneNumberId = metadata ? stringValue(metadata.phone_number_id) : undefined;
      if (!phoneNumberId || !Array.isArray(value.messages)) continue;

      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      for (const candidate of value.messages) {
        if (!isRecord(candidate)) continue;
        const sender = stringValue(candidate.from);
        const id = stringValue(candidate.id);
        const type = stringValue(candidate.type);
        const unixTimestamp = stringValue(candidate.timestamp);
        if (!sender || !id || !type || !unixTimestamp) continue;
        const timestampMilliseconds = Number(unixTimestamp) * 1000;
        if (!Number.isFinite(timestampMilliseconds)) continue;

        const contact = contacts.find((item) => isRecord(item) && item.wa_id === sender);
        const profile = isRecord(contact) && isRecord(contact.profile) ? contact.profile : undefined;
        const content = messageContent(candidate);
        normalized.push({
          provider: "whatsapp",
          channelExternalId: phoneNumberId,
          senderExternalId: sender,
          externalMessageId: id,
          timestamp: new Date(timestampMilliseconds).toISOString(),
          type,
          text: type === "text" ? stringValue(content.body) : undefined,
          senderName: profile ? stringValue(profile.name) : undefined,
          content
        });
      }
    }
  }

  return normalized;
}
