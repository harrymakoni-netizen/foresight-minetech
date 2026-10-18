import { ZodError } from "zod";
import { get as getBlob, del } from "@vercel/blob";
import { formBody, jsonBody } from "@/lib/server/http";
import { context } from "@/lib/server/auth";
import {
  atomic,
  insert,
  get,
  hash,
  DomainError,
  useBudget,
  update,
} from "@/lib/server/repository";
import {
  visionConfig,
  visionStatus,
  assertClipPath,
} from "@/lib/server/vision";
import { instant } from "@/lib/domain/contracts";
import { randomBytes } from "node:crypto";
export const runtime = "nodejs";
export const maxDuration = 90;
export async function POST(request: Request) {
  try {
    const ctx = await context(request, "review"),
      { url, token } = visionConfig();
    if (!(await visionStatus()).ready)
      throw new DomainError(
        503,
        "VISION_UNAVAILABLE",
        "Video inference is unavailable. The worker needs compatible, licensed PPE weights.",
      );
    let bytes: Buffer,
      cameraId: string,
      recorded: unknown,
      consent: unknown,
      pathname: string | undefined;
    if (request.headers.get("content-type")?.includes("application/json")) {
      const body = (await jsonBody(request, 10000)) as Record<string, unknown>;
      pathname = String(body.pathname);
      assertClipPath(ctx, pathname);
      cameraId = String(body.cameraId);
      recorded = body.recordedAt;
      consent = body.consent;
      const blob = await getBlob(pathname, {
        access: "private",
        useCache: false,
      });
      if (!blob || blob.statusCode !== 200)
        throw new DomainError(404, "CLIP", "Uploaded clip not found.");
      if (blob.blob.size > 50 * 1024 * 1024) {
        await blob.stream.cancel();
        throw new DomainError(413, "SIZE", "Clip limit is 50 MB.");
      }
      bytes = Buffer.from(await new Response(blob.stream).arrayBuffer());
    } else {
      const limit = (process.env.VERCEL ? 4 : 51) * 1024 * 1024;
      const form = await formBody(request, limit),
        file = form.get("file");
      if (
        !(file instanceof File) ||
        file.size > 50 * 1024 * 1024 ||
        file.size < 16 ||
        file.type !== "video/mp4"
      )
        throw new DomainError(
          422,
          "CLIP",
          "Choose an MP4 clip up to 50 MB; use direct upload on hosted deployments.",
        );
      cameraId = String(form.get("cameraId"));
      recorded = form.get("recordedAt");
      consent = form.get("consent") === "true";
      bytes = Buffer.from(await file.arrayBuffer());
    }
    if (consent !== true)
      throw new DomainError(
        422,
        "CONSENT",
        "Confirm permission to process this recorded clip.",
      );
    const recordedAt = instant.parse(recorded),
      camera = await get(ctx, cameraId, "camera");
    if (bytes.length < 16 || bytes.length > 50 * 1024 * 1024)
      throw new DomainError(413, "SIZE", "MP4 limit is 50 MB.");
    if (bytes.toString("ascii", 4, 8) !== "ftyp")
      throw new DomainError(
        422,
        "FORMAT",
        "A valid MP4 container is required.",
      );
    await useBudget(ctx, "vision", 12);
    const credential = randomBytes(32).toString("base64url"),
      job = await atomic(
        async () =>
          await insert(
            ctx,
            "vision-job",
            {
              cameraId: camera.id,
              recordedAt,
              consent: true,
              sourceBytes: bytes.length,
              callbackHash: hash(credential),
              status: "queued",
              progress: 0,
            },
            camera.zoneId,
          ),
      );
    const config = {
      id: job.id,
      consent: true,
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
    try {
      const response = await fetch(url + "/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "video/mp4",
          "Content-Length": String(bytes.length),
          "X-Workspace-Id": ctx.workspaceId,
          "X-Job-Config": Buffer.from(JSON.stringify(config)).toString(
            "base64",
          ),
        },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) {
        const body = await response.json();
        throw new DomainError(
          response.status,
          "VISION_REJECTED",
          body.error || "Vision worker rejected the clip.",
        );
      }
    } catch (error) {
      await atomic(async () => {
        const current = await get(ctx, job.id, "vision-job");
        await update(ctx, current, current.revision, {
          ...current.data,
          status: "failed",
          error:
            "Clip could not be queued by the PPE worker. Check worker readiness, connection and upload limits, then submit again.",
        });
      });
      throw error;
    } finally {
      if (pathname) await del(pathname).catch(() => {});
    }
    return Response.json({ id: job.id, status: "queued" }, { status: 202 });
  } catch (e) {
    return Response.json(
      {
        code: e instanceof DomainError ? e.code : "VISION_UNAVAILABLE",
        message:
          e instanceof DomainError
            ? e.message
            : e instanceof ZodError
              ? "Check the camera, recording time and explicit clip permission, then submit again."
              : "Vision worker unavailable; no detections have been claimed.",
      },
      {
        status:
          e instanceof DomainError
            ? e.status
            : e instanceof ZodError
              ? 422
              : 503,
      },
    );
  }
}
