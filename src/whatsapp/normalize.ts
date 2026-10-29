import type { NormalizedInboundMessage, NormalizedMessageEcho } from "../core/types.js";

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

/** Business app echoes are outbound events, never customer input to a flow. */
export function normalizeWhatsAppMessageEchoes(payload: unknown): NormalizedMessageEcho[] {
  if (!isRecord(payload) || !Array.isArray(payload.entry)) return [];
  const normalized: NormalizedMessageEcho[] = [];

  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isRecord(change) || change.field !== "smb_message_echoes" || !isRecord(change.value)) continue;
      const value = change.value;
      const metadata = isRecord(value.metadata) ? value.metadata : undefined;
      const channelExternalId = metadata ? stringValue(metadata.phone_number_id) : undefined;
      if (!channelExternalId || !Array.isArray(value.message_echoes)) continue;

      for (const candidate of value.message_echoes) {
        if (!isRecord(candidate)) continue;
        const recipient = stringValue(candidate.to);
        const id = stringValue(candidate.id);
        const type = stringValue(candidate.type);
        const timestamp = candidate.timestamp;
        if (!recipient || !id || !type ||
          !((typeof timestamp === "string" && /^\d+$/.test(timestamp)) ||
            (typeof timestamp === "number" && Number.isInteger(timestamp) && timestamp >= 0))) continue;
        const date = new Date(Number(timestamp) * 1000);
        if (!Number.isFinite(date.getTime())) continue;

        normalized.push({
          provider: "whatsapp",
          channelExternalId,
          // Echoes may include '+', whereas inbound `from` uses country-code digits.
          recipientExternalId: recipient.replace(/^\+(?=\d+$)/, ""),
          externalMessageId: id,
          timestamp: date.toISOString(),
          type,
          text: type === "text" ? stringValue(messageContent(candidate).body) : undefined,
          content: { ...candidate }
        });
      }
    }
  }

  return normalized;
}
