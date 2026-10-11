/** Pure WhatsApp message → inbox row helpers (no socket, unit-tested). */

export const PLACEHOLDERS = {
  photo: "[عکس]",
  video: "[ویدیو]",
  voice: "[پیام صوتی]",
  audio: "[فایل صوتی]",
  file: "[فایل]",
  sticker: "[استیکر]",
  location: "[موقعیت مکانی]",
  contact: "[مخاطب]",
  other: "[پیام پشتیبانی‌نشده]",
};

/** Content types that are protocol noise, not something a customer "said". */
const SKIP_TYPES = new Set([
  "protocolMessage",
  "reactionMessage",
  "senderKeyDistributionMessage",
  "messageContextInfo",
  "pollUpdateMessage",
  "keepInChatMessage",
  "pinInChatMessage",
]);

/**
 * @param {Record<string, any>|null|undefined} content normalized proto.IMessage
 * @param {string|undefined} type key from getContentType()
 * @returns {{ kind: string, text: string } | null} null when the message should be skipped
 */
export function describeContent(content, type) {
  if (!content || !type || SKIP_TYPES.has(type)) return null;
  const body = content[type] ?? {};
  switch (type) {
    case "conversation":
      return { kind: "text", text: String(content.conversation ?? "").trim() };
    case "extendedTextMessage":
      return { kind: "text", text: String(body.text ?? "").trim() };
    case "imageMessage":
      return { kind: "photo", text: String(body.caption ?? "").trim() };
    case "videoMessage":
    case "ptvMessage":
      return { kind: "video", text: String(body.caption ?? "").trim() };
    case "audioMessage":
      return { kind: body.ptt ? "voice" : "audio", text: "" };
    case "documentMessage":
    case "documentWithCaptionMessage": {
      const doc = type === "documentWithCaptionMessage"
        ? body.message?.documentMessage ?? {}
        : body;
      return { kind: "file", text: String(doc.caption ?? doc.fileName ?? "").trim() };
    }
    case "stickerMessage":
      return { kind: "sticker", text: "" };
    case "locationMessage":
    case "liveLocationMessage":
      return { kind: "location", text: String(body.name ?? body.address ?? "").trim() };
    case "contactMessage":
    case "contactsArrayMessage":
      return { kind: "contact", text: String(body.displayName ?? "").trim() };
    default:
      return { kind: "other", text: "" };
  }
}

/** Text shown in the inbox: media without caption becomes a Persian placeholder. */
export function displayText(kind, text) {
  const clean = String(text ?? "").trim();
  if (kind === "text") return clean;
  const placeholder = PLACEHOLDERS[kind] ?? PLACEHOLDERS.other;
  return clean ? `${placeholder} ${clean}` : placeholder;
}

/** Only 1:1 chats belong in the support inbox. */
export function isPrivateJid(jid) {
  const value = String(jid ?? "");
  return value.endsWith("@s.whatsapp.net") || value.endsWith("@lid");
}

/** `989121234567@s.whatsapp.net` → `09121234567` (Iranian mobiles), else `+<digits>`. */
export function phoneFromJid(jid) {
  const value = String(jid ?? "");
  if (!value.endsWith("@s.whatsapp.net")) return null;
  const digits = value.split("@")[0].split(":")[0];
  if (!/^\d{6,15}$/.test(digits)) return null;
  if (digits.startsWith("98") && digits.length === 12) return `0${digits.slice(2)}`;
  return `+${digits}`;
}

/** `09121234567`, `+98912…`, `98912…`, `912…` → `989121234567@s.whatsapp.net`. */
export function jidFromPhone(phone) {
  const digits = String(phone ?? "")
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/\D/g, "");
  if (!digits) return null;
  let intl = digits;
  if (intl.startsWith("0098")) intl = intl.slice(2);
  else if (intl.startsWith("09") && intl.length === 11) intl = `98${intl.slice(1)}`;
  else if (intl.startsWith("9") && intl.length === 10) intl = `98${intl}`;
  if (!/^\d{8,15}$/.test(intl)) return null;
  return `${intl}@s.whatsapp.net`;
}

/** WhatsApp timestamps are seconds (number or Long-like). */
export function timestampMs(ts) {
  if (ts == null) return Date.now();
  const n = typeof ts === "number" ? ts : Number(ts?.low ?? ts?.toString?.() ?? ts);
  return Number.isFinite(n) && n > 0 ? n * 1000 : Date.now();
}
