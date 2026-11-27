// Provider webhook parsing and authenticity checks (spec §6.6, §15).
import { createHmac, timingSafeEqual } from "node:crypto";

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
/**
 * Meta signs the raw request body with the app secret:
 * X-Hub-Signature-256: sha256=<hex HMAC-SHA256>. Awaiting verification with a
 * real test app (Meta's docs host is outside this build environment).
 */
export function verifyWhatsAppSignature(raw: string, header: string | null, appSecret: string) {
  if (!header?.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", appSecret).update(raw, "utf8").digest("hex");
  return safeEqual(expected, header);
}
export function whatsAppChallenge(url: URL, verifyToken: string) {
  const mode = url.searchParams.get("hub.mode"),
    token = url.searchParams.get("hub.verify_token"),
    challenge = url.searchParams.get("hub.challenge");
  return mode === "subscribe" && token !== null && safeEqual(token, verifyToken) && challenge ? challenge : null;
}
export type ParsedWhatsApp = {
  messages: { phoneNumberId: string; from: string; id: string; text: string; timestamp: string }[];
  statuses: { id: string; status: string; timestamp: string; detail: string }[];
};
export function parseWhatsApp(body: unknown): ParsedWhatsApp {
  const out: ParsedWhatsApp = { messages: [], statuses: [] };
  const entries = (body as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries as { changes?: { value?: Record<string, any> }[] }[])
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const phoneNumberId = String(v.metadata?.phone_number_id || "");
      for (const m of v.messages || [])
        out.messages.push({
          phoneNumberId,
          from: "+" + String(m.from || "").replace(/^\+/, ""),
          id: String(m.id),
          text: m.type === "text" ? String(m.text?.body || "") : m.type === "button" ? String(m.button?.text || "") : m.type === "interactive" ? String(m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "") : "",
          timestamp: new Date(Number(m.timestamp) * 1000 || Date.now()).toISOString(),
        });
      for (const st of v.statuses || [])
        out.statuses.push({
          id: String(st.id),
          status: String(st.status),
          timestamp: new Date(Number(st.timestamp) * 1000 || Date.now()).toISOString(),
          detail: Array.isArray(st.errors) ? st.errors.map((e: any) => `${e.code}: ${e.title || e.message || ""}`).join("; ") : "",
        });
    }
  return out;
}
/** SMSGate posts no documented signature reachable from this build, so the
 * webhook URL carries a secret token (spec fallback). */
export function verifyUrlToken(url: URL, expected: string | undefined) {
  const token = url.searchParams.get("token");
  return Boolean(expected && expected.length >= 24 && token && safeEqual(token, expected));
}
export type ParsedSmsGate =
  | { kind: "received"; id: string; from: string; text: string; receivedAt: string; deviceId: string }
  | { kind: "status"; id: string; status: "sent" | "delivered" | "failed"; at: string; detail: string }
  | { kind: "ping"; deviceId: string }
  | { kind: "ignored"; event: string };
/** Envelope `{event, payload, deviceId?}`; payload field names from the official client. */
export function parseSmsGate(body: any): ParsedSmsGate {
  const event = String(body?.event || "");
  const p = body?.payload || {};
  const deviceId = String(body?.deviceId || "default");
  if (event === "sms:received")
    return { kind: "received", id: String(p.messageId || body?.id), from: String(p.phoneNumber || p.sender), text: String(p.message || ""), receivedAt: String(p.receivedAt || new Date().toISOString()), deviceId };
  if (event === "sms:sent" || event === "sms:delivered" || event === "sms:failed")
    return { kind: "status", id: String(p.messageId || p.id), status: event.slice(4) as "sent" | "delivered" | "failed", at: String(p.deliveredAt || p.sentAt || p.failedAt || new Date().toISOString()), detail: String(p.reason || p.error || "") };
  if (event === "system:ping") return { kind: "ping", deviceId };
  return { kind: "ignored", event };
}
