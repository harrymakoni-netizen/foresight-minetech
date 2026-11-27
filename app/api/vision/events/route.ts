import { jsonBody } from "@/lib/server/http";
import { z } from "zod";
import { ingest } from "@/lib/server/vision";
import { DomainError } from "@/lib/server/repository";
export async function POST(request: Request) {
  try {
    const body = z
      .object({ jobId: z.string().uuid(), event: z.unknown() })
      .strict()
      .parse(await jsonBody(request, 30000));
    return Response.json(
      await ingest(
        body.jobId,
        body.event,
        request.headers.get("x-job-token") || "",
      ),
      { status: 201 },
    );
  } catch (e) {
    return Response.json(
      {
        message: e instanceof DomainError ? e.message : "Invalid vision event.",
      },
      { status: e instanceof DomainError ? e.status : 422 },
    );
  }
}
