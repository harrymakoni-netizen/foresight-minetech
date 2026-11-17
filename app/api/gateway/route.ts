// /api/gateway (spec §14): gateway/scheduler health for supervisors and
// administrators; POST binds an SMSGate device or WhatsApp number to this workspace.
import { context } from "@/lib/server/auth";
import { messagingHealth } from "@/lib/server/gateway";
import { POST as workspacePost } from "../workspace/[...path]/route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const ctx = await context(request, "review");
    void ctx;
    return Response.json(await messagingHealth(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const err = e as { status?: number; code?: string; message?: string };
    return Response.json({ code: err.code || "REQUEST_FAILED", message: err.message || "Unavailable" }, { status: err.status || 500 });
  }
}
export const POST = (request: Request) =>
  workspacePost(request, { params: Promise.resolve({ path: ["messaging", "bind"] }) });
