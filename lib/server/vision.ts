import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { query } from "./db.ts";
import { visionEventSchema } from "../domain/contracts.ts";
import {
  atomic,
  insert,
  get,
  update,
  idempotent,
  hash,
  DomainError,
  type Context,
} from "./repository.ts";
export function visionConfig() {
  const url = process.env.FORESIGHT_VISION_URL,
    token =
      process.env.FORESIGHT_WORKER_TOKEN ||
      (process.env.NODE_ENV !== "production"
        ? "development-worker-token"
        : undefined);
  if (!url || !token)
    throw new DomainError(
      503,
      "VISION_UNAVAILABLE",
      "Vision unavailable. Configure a worker, licensed helmet/vest/person weights and consented clips.",
    );
  return { url, token };
}
export async function visionStatus() {
  try {
    const { url, token } = visionConfig();
    const response = await fetch(url + "/health", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    const body = response.ok ? await response.json() : null;
    return {
      ready: body?.status === "ready",
      message:
        body?.status === "ready"
          ? "Model loaded by the worker; licence review is recorded in its manifest. Consented recordings can be processed."
          : "Video inference is unavailable until an administrator loads compatible, licensed PPE weights.",
    };
  } catch {
    return {
      ready: false,
      message:
        "Video inference is unavailable. Ask an administrator to connect the PPE worker; no detections are being claimed.",
    };
  }
}
export function assertClipPath(ctx: Context, pathname: string) {
  const prefix = `clips/${ctx.workspaceId}/`;
  if (
    !pathname.startsWith(prefix) ||
    !/^[a-f0-9-]+\.mp4$/.test(pathname.slice(prefix.length))
  )
    throw new DomainError(
      403,
      "CLIP_SCOPE",
      "The clip must belong to this workspace.",
    );
}
async function saveEvent(
  ctx: Context,
  jobId: string,
  job: Record<string, any>,
  eventInput: unknown,
) {
  const body = visionEventSchema.parse(eventInput);
  if (
    body.workspaceId !== ctx.workspaceId ||
    body.cameraId !== job.cameraId ||
    body.sessionId !== jobId
  )
    throw new DomainError(
      403,
      "VISION_SCOPE",
      "Camera event belongs to another workspace or job.",
    );
  const camera = await get(ctx, body.cameraId, "camera");
  if (
    camera.zoneId !== body.zoneId ||
    Date.parse(body.endsAt) < Date.parse(body.startsAt)
  )
    throw new DomainError(
      422,
      "VISION_EVENT",
      "Invalid camera zone or event interval.",
    );
  return await idempotent(
    ctx,
    body.eventId,
    body,
    async () =>
      await insert(
        ctx,
        "vision-event",
        { ...body, jobId, reviewHistory: [] },
        body.zoneId,
        [
          { id: jobId, relation: "inference-job" },
          { id: body.cameraId, relation: "camera" },
        ],
      ),
  );
}
export async function ingest(
  jobId: string,
  eventInput: unknown,
  credential: string,
) {
  const {
    rows: [row],
  } = await query(
    "SELECT workspace_id,payload FROM foresight.entities WHERE id=$1 AND kind=$2",
    [jobId, "vision-job"],
  );
  if (!row) throw new DomainError(404, "JOB", "Vision job not found.");
  const job = JSON.parse(row.payload),
    expected = Buffer.from(String(job.callbackHash)),
    actual = Buffer.from(hash(credential));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new DomainError(
      403,
      "WORKER_CREDENTIAL",
      "Scoped worker credential rejected.",
    );
  const ctx: Context = {
    workspaceId: row.workspace_id,
    userId: "vision-worker",
    actor: "Scoped vision worker",
    role: "reporter",
    mode: "demonstration",
  };
  return await saveEvent(ctx, jobId, job, eventInput);
}

export async function visionJob(ctx: Context, id: string) {
  const job = await get(ctx, id, "vision-job");
  if (["completed", "failed", "cancelled"].includes(String(job.data.status))) {
    const { callbackHash, ...publicData } = job.data;
    return { ...job, data: publicData };
  }
  const { url, token } = visionConfig();
  try {
    const response = await fetch(url + "/jobs/" + id, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Workspace-Id": ctx.workspaceId,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error();
    const result = await response.json();
    if (
      ![
        "queued",
        "processing",
        "running",
        "completed",
        "failed",
        "cancelled",
      ].includes(result.status)
    )
      throw new Error("Invalid worker status");
    for (const event of result.result?.events || []) {
      const { startSeconds, endSeconds, ...payload } = event;
      await saveEvent(ctx, id, job.data, payload);
    }
    const updated = await atomic(async () => {
      const current = await get(ctx, id, "vision-job");
      return await update(ctx, current, current.revision, {
        ...current.data,
        status: result.status === "running" ? "processing" : result.status,
        progress: result.progress,
        result: result.result,
        error: result.error,
      });
    });
    const { callbackHash, ...publicData } = updated.data;
    return { ...updated, data: publicData };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      503,
      "VISION_UNAVAILABLE",
      "Vision worker unavailable. The saved job remains traceable.",
    );
  }
}
