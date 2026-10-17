import { formBody } from "@/lib/server/http";
import { context } from "@/lib/server/auth";
import {
  atomic,
  insert,
  get,
  hash,
  DomainError,
  useBudget,
} from "@/lib/server/repository";
import { visionConfig } from "@/lib/server/vision";
import { instant } from "@/lib/domain/contracts";
import { randomBytes } from "node:crypto";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const ctx = await context(request, "review"),
      { url, token } = visionConfig();
    if (Number(request.headers.get("content-length")) > 51 * 1024 * 1024)
      throw new DomainError(413, "SIZE", "Clip limit is 50 MB.");
    const form = await formBody(request, 51 * 1024 * 1024),
      file = form.get("file");
    if (
      !(file instanceof File) ||
      file.size > 50 * 1024 * 1024 ||
      file.size < 16
    )
      throw new DomainError(422, "CLIP", "Choose an MP4 clip up to 50 MB.");
    const recordedAt = instant.parse(form.get("recordedAt"));
    const camera = get(ctx, String(form.get("cameraId")), "camera"),
      bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.toString("ascii", 4, 8) !== "ftyp")
      throw new DomainError(
        422,
        "FORMAT",
        "A valid MP4 container is required.",
      );
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
          },
          camera.zoneId,
        ),
      );
    const config = {
      id: job.id,
      workspaceId: ctx.workspaceId,
      cameraId: camera.id,
      zoneId: camera.zoneId,
      timeOrigin: recordedAt,
      required: ["helmet", "vest"],
      restrictedRegion: camera.data.restrictedRegion || null,
      policyVersion: camera.data.policyVersion,
      callbackToken: credential,
      maxSeconds: 120,
      inferenceFps: 5,
    };
    const response = await fetch(url + "/jobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "video/mp4",
        "Content-Length": String(bytes.length),
        "X-Workspace-Id": ctx.workspaceId,
        "X-Job-Config": Buffer.from(JSON.stringify(config)).toString("base64"),
      },
      body: bytes,
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      const body = await response.json();
      throw new DomainError(
        response.status,
        "VISION_REJECTED",
        body.error || "Vision worker rejected the clip.",
      );
    }
    return Response.json({ id: job.id, status: "queued" }, { status: 202 });
  } catch (e) {
    return Response.json(
      {
        code: e instanceof DomainError ? e.code : "VISION_UNAVAILABLE",
        message:
          e instanceof DomainError
            ? e.message
            : "Vision worker unavailable; no detections have been claimed.",
      },
      { status: e instanceof DomainError ? e.status : 503 },
    );
  }
}
