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
  } catch (error) {
    const candidate = (error as { code?: unknown })?.code;
    const errorCode =
      typeof candidate === "string" &&
      (/^[0-9A-Z]{5}$/.test(candidate) ||
        [
          "ECONNREFUSED",
          "ECONNRESET",
          "ETIMEDOUT",
          "ENOTFOUND",
          "SELF_SIGNED_CERT_IN_CHAIN",
          "DEPTH_ZERO_SELF_SIGNED_CERT",
          "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
          "CERT_HAS_EXPIRED",
        ].includes(candidate))
        ? candidate
        : "CONNECTION_FAILED";
    return Response.json(
      { status: "database-unavailable", errorCode },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
