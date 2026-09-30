/**
 * Fase 8 (Media V1): a single reply is no longer always plain text — a turn
 * can answer with a sequence of text and image items (e.g. an FAQ's text
 * followed by its attached photo, or one image per selected RUN-XX design).
 * Kept deliberately minimal: two variants, no envelope/metadata beyond what
 * WhatsApp's Cloud API itself needs (`link` + optional `caption`).
 */
export type ReplyItem = { type: "text"; text: string } | { type: "image"; url: string; caption?: string };

export function textReply(text: string): ReplyItem {
  return { type: "text", text };
}

export function imageReply(url: string, caption?: string): ReplyItem {
  return caption ? { type: "image", url, caption } : { type: "image", url };
}

/** Drops text items that are empty/whitespace-only (e.g. an unfilled
 * admin-configured message) so a blank template never becomes a visibly
 * empty WhatsApp message. Image items are never considered "blank". */
export function filterBlankReplyItems(items: ReplyItem[]): ReplyItem[] {
  return items.filter((item) => item.type === "image" || item.text.trim().length > 0);
}
