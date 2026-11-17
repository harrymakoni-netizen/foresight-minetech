// For an external uptime monitor: 503 when the escalation scheduler has not
// reported recently, so someone is paged even if Foresight itself cannot send.
import { messagingHealth } from "@/lib/server/gateway";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const health = await messagingHealth();
  return Response.json(
    { scheduler: health.scheduler, gateways: health.gateways.map(({ gateway, status, stale }) => ({ gateway, status, stale })) },
    { status: health.scheduler.running ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
