import { createHash, timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import { jsonBody } from "@/lib/server/http";
import { ingestPersonnel } from "@/lib/server/personnel";
import { DomainError } from "@/lib/server/repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const token = process.env.FORESIGHT_PERSONNEL_GATEWAY_TOKEN;
  const workspaceId = process.env.FORESIGHT_PERSONNEL_MINE_ID;
  if (!workspaceId || !token || token.length < 32)
    return Response.json({ code: "TELEMETRY_DISABLED" }, { status: 503 });
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${token}`)))
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  try {
    return Response.json(await ingestPersonnel({
      workspaceId, userId: "personnel-gateway", role: "supervisor", actor: "Personnel gateway", mode: "local",
    }, await jsonBody(request, 8192), "physical"));
  } catch (error) {
    if (error instanceof DomainError) return Response.json({ code: error.code, message: error.message }, { status: error.status });
    if (error instanceof ZodError) return Response.json({ code: "INVALID_TELEMETRY", issues: error.issues }, { status: 422 });
    console.error("Personnel telemetry ingestion failed", error);
    return Response.json({ code: "TELEMETRY_FAILED" }, { status: 500 });
  }
}
