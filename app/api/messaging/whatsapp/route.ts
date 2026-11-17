// WhatsApp Cloud API webhook: verification challenge and signed events.
import { handleInbound } from "@/lib/server/checkins";
import { applyReceipt } from "@/lib/server/messaging";
import { parseWhatsApp, verifyWhatsAppSignature, whatsAppChallenge } from "@/lib/messaging/webhooks";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const token = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!token) return new Response("WhatsApp webhook not configured", { status: 503 });
  const challenge = whatsAppChallenge(new URL(request.url), token);
  return challenge ? new Response(challenge, { status: 200 }) : new Response("Forbidden", { status: 403 });
}
export async function POST(request: Request) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return new Response("WhatsApp webhook not configured", { status: 503 });
  const raw = await request.text();
  if (raw.length > 1_000_000) return new Response("Too large", { status: 413 });
  if (!verifyWhatsAppSignature(raw, request.headers.get("x-hub-signature-256"), secret))
    return new Response("Invalid signature", { status: 401 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const parsed = parseWhatsApp(body);
  const results = [];
  for (const m of parsed.messages)
    results.push(await handleInbound({ provider: "whatsapp", channelKey: m.phoneNumberId, channel: "whatsapp", from: m.from, text: m.text, providerMessageId: m.id, receivedAt: m.timestamp }));
  for (const st of parsed.statuses) {
    const status = st.status === "delivered" || st.status === "read" ? st.status : st.status === "failed" ? "failed" : "sent";
    results.push(await applyReceipt("whatsapp", st.id, status, st.timestamp, st.detail));
  }
  // Meta retries non-2xx responses; outcomes are recorded server-side.
  return Response.json({ received: results.length });
}
