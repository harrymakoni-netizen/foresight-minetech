import { context } from "@/lib/server/auth";
import { get, DomainError } from "@/lib/server/repository";
import { visionConfig } from "@/lib/server/vision";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string; frameId: string }> },
) {
  try {
    const ctx = await context(request),
      { jobId, frameId } = await params;
    get(ctx, jobId, "vision-job");
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(frameId))
      throw new DomainError(422, "FRAME", "Invalid frame reference.");
    const { url, token } = visionConfig();
    const response = await fetch(`${url}/jobs/${jobId}/frames/${frameId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Workspace-Id": ctx.workspaceId,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new DomainError(
        response.status,
        "FRAME",
        "Frame expired or unavailable.",
      );
    return new Response(await response.arrayBuffer(), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return Response.json(
      { message: e instanceof DomainError ? e.message : "Frame unavailable." },
      { status: e instanceof DomainError ? e.status : 503 },
    );
  }
}
