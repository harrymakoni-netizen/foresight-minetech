import { context } from "@/lib/server/auth";
import { visionJob } from "@/lib/server/vision";
import { DomainError } from "@/lib/server/repository";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return Response.json(
      await visionJob(await context(request), (await params).id),
    );
  } catch (e) {
    return Response.json(
      {
        message:
          e instanceof DomainError ? e.message : "Vision job unavailable.",
      },
      { status: e instanceof DomainError ? e.status : 503 },
    );
  }
}
