import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { query } from "./db.ts";
import { visionEventSchema } from "../domain/contracts.ts";
import {
  atomic,
  insert,
  get,
  list,
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
  const body = visionEventSchema
    .extend({ eventId: z.string().uuid() })
    .parse(eventInput);
  if (body.workspaceId !== ctx.workspaceId || body.cameraId !== job.cameraId)
    throw new DomainError(
      403,
      "VISION_SCOPE",
      "Camera event belongs to another workspace or job.",
    );
  const camera = await get(ctx, body.cameraId, "camera");
  if (camera.zoneId !== body.zoneId)
    throw new DomainError(
      422,
      "CAMERA_ZONE",
      "Camera mapping does not match event zone.",
    );
  if (Date.parse(body.endsAt) < Date.parse(body.startsAt))
    throw new DomainError(422, "TIME_INTERVAL", "Event end precedes start.");
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
export async function visionJob(ctx: Context, id: string) {
  const job = await get(ctx, id, "vision-job"),
    { url, token } = visionConfig();
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
    if (result.result?.events) {
      for (const event of result.result.events) {
        const { startSeconds, endSeconds, ...payload } = event;
        const existing = (await list(ctx, "vision-event")).find(
          (e) => e.data.eventId === payload.eventId,
        );
        if (!existing)
          await atomic(async () => {
            if (
              payload.workspaceId !== ctx.workspaceId ||
              payload.cameraId !== job.data.cameraId ||
              payload.zoneId !==
                (await get(ctx, String(job.data.cameraId), "camera")).zoneId
            )
              throw new DomainError(
                403,
                "VISION_SCOPE",
                "Invalid worker event scope.",
              );
            const { eventId, ...rest } = payload;
            visionEventSchema.parse(payload);
            await insert(
              ctx,
              "vision-event",
              { ...rest, eventId, jobId: id, reviewHistory: [] },
              rest.zoneId,
              [{ id, relation: "inference-job" }],
            );
          });
      }
    }
    const updated = await atomic(async () => {
      const current = await get(ctx, id, "vision-job");
      return await update(ctx, current, current.revision, {
        ...current.data,
        status: result.status,
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
