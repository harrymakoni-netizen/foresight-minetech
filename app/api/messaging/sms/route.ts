// SMSGate inbound webhook (sms:received; status events are also accepted).
import { handleInbound } from "@/lib/server/checkins";
import { applyReceipt } from "@/lib/server/messaging";
import { heartbeat } from "@/lib/server/gateway";
import { parseSmsGate, verifyUrlToken } from "@/lib/messaging/webhooks";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  if (!process.env.SMSGATE_WEBHOOK_TOKEN) return new Response("SMS webhook not configured", { status: 503 });
  if (!verifyUrlToken(new URL(request.url), process.env.SMSGATE_WEBHOOK_TOKEN))
    return new Response("Forbidden", { status: 403 });
  const raw = await request.text();
  if (raw.length > 200_000) return new Response("Too large", { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const e = parseSmsGate(body);
  if (e.kind === "received")
    return Response.json(await handleInbound({ provider: "smsgate", channelKey: e.deviceId, channel: "sms", from: e.from, text: e.text, providerMessageId: e.id, receivedAt: e.receivedAt }));
  if (e.kind === "status") return Response.json(await applyReceipt("smsgate", e.id, e.status, e.at, e.detail));
  if (e.kind === "ping") {
    await heartbeat(`gateway-ping:${e.deviceId}`, { at: new Date().toISOString() });
    return Response.json({ ok: true });
  }
  return Response.json({ ignored: e.event });
}
