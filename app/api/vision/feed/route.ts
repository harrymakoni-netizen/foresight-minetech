import { randomBytes } from "node:crypto";
import { jsonBody } from "@/lib/server/http";
import { z } from "zod";
import { context } from "@/lib/server/auth";
import {
  atomic,
  get,
  insert,
  hash,
  DomainError,
  useBudget,
} from "@/lib/server/repository";
import { visionConfig } from "@/lib/server/vision";
export async function POST(request: Request) {
  try {
    const ctx = await context(request, "review"),
      { url, token } = visionConfig(),
      alias = process.env.FORESIGHT_CAMERA_FEED_ALIAS;
    if (!alias)
      throw new DomainError(
        503,
        "FEED_UNAVAILABLE",
        "No administrator-configured camera feed alias is available.",
      );
    const body = z
        .object({ cameraId: z.string().uuid() })
        .strict()
        .parse(await jsonBody(request, 2000)),
      camera = get(ctx, String(body.cameraId), "camera");
    useBudget(ctx, "vision", 12);
    const credential = randomBytes(32).toString("base64url"),
      job = atomic(() =>
        insert(
          ctx,
          "vision-job",
          {
            cameraId: camera.id,
            callbackHash: hash(credential),
            status: "queued",
            progress: 0,
            source: "configured-feed",
            timestampBasis:
              "Monotonic processing time; hardware capture time unverified",
          },
          camera.zoneId,
        ),
      );
    const config = {
      id: job.id,
      workspaceId: ctx.workspaceId,
      cameraId: camera.id,
      zoneId: camera.zoneId,
      required: ["helmet", "vest"],
      restrictedRegion: camera.data.restrictedRegion || null,
      policyVersion: camera.data.policyVersion,
      callbackToken: credential,
      timeOrigin: new Date().toISOString(),
      feedAlias: alias,
      maxSeconds: 120,
      inferenceFps: 5,
    };
    const header = Buffer.alloc(16);
    header.write("ftyp", 4);
    const response = await fetch(url + "/jobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": "16",
        "X-Workspace-Id": ctx.workspaceId,
        "X-Job-Config": Buffer.from(JSON.stringify(config)).toString("base64"),
      },
      body: header,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const r = await response.json();
      throw new DomainError(
        response.status,
        "FEED_REJECTED",
        r.error || "Configured feed unavailable.",
      );
    }
    return Response.json({ id: job.id, status: "queued" }, { status: 202 });
  } catch (e) {
    return Response.json(
      {
        message:
          e instanceof DomainError ? e.message : "Configured feed unavailable.",
      },
      { status: e instanceof DomainError ? e.status : 503 },
    );
  }
}
