import { workspaceConfiguration } from "@/lib/server/configuration";
import { query, hostedDatabase } from "@/lib/server/db";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const missing = workspaceConfiguration();
  if (missing.length)
    return Response.json(
      { status: "configuration-required", missing },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  try {
    await query("SELECT 1 AS ready");
    return Response.json(
      {
        status: "ready",
        database: hostedDatabase() ? "postgresql" : "local-sqlite",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "database-unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
