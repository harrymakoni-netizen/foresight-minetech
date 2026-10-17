import { z } from "zod";
import { scenarioSchema, fictionalScenario } from "../domain/scenario.ts";
import {
  atomic,
  get,
  list,
  insert,
  update,
  useBudget,
  DomainError,
  type Context,
} from "./repository.ts";
export async function worker(ctx: Context, path: string, body?: unknown) {
  const url =
    process.env.FORESIGHT_SIMULATOR_URL ||
    (process.env.NODE_ENV !== "production" ? "http://127.0.0.1:8100" : null);
  const token =
    process.env.FORESIGHT_WORKER_TOKEN ||
    (process.env.NODE_ENV !== "production" ? "development-worker-token" : null);
  if (!url || !token)
    throw new DomainError(
      503,
      "SIMULATOR_UNAVAILABLE",
      "Simulator worker is not configured. Start the documented Python service.",
    );
  try {
    const response = await fetch(url + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Workspace-Id": ctx.workspaceId,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!response.ok) {
      const d = await response.json();
      throw new DomainError(
        response.status,
        "WORKER_REJECTED",
        d.error || "Worker rejected the scenario.",
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      503,
      "SIMULATOR_UNAVAILABLE",
      "Simulator worker unavailable. Scenario is saved; start the Python service and retry.",
    );
  }
}
export function createSnapshot(ctx: Context) {
  return insert(ctx, "snapshot", {
    mode: "laboratory-baseline",
    frozenAt: new Date().toISOString(),
    siteId: "fictional-mine-001",
    sourceEntities: list(ctx).filter((e) =>
      ["observation", "assessment", "worker", "inspection"].includes(e.kind),
    ),
    physicalInputsStatus:
      "No measured storage geometry or flow is configured. Lab parameters require explicit assumptions.",
  });
}
export function createScenario(ctx: Context, input: unknown) {
  const body = z
    .object({
      name: z.string().trim().min(3).max(120),
      baselineSnapshotId: z.string(),
      scenario: scenarioSchema,
      assumptionsAccepted: z.literal(true),
    })
    .strict()
    .parse(input);
  get(ctx, body.baselineSnapshotId, "snapshot");
  if (
    body.scenario.workspaceId !== ctx.workspaceId ||
    body.scenario.baselineSnapshotId !== body.baselineSnapshotId
  )
    throw new DomainError(
      403,
      "SCENARIO_SCOPE",
      "Scenario must use this workspace and frozen baseline.",
    );
  return insert(ctx, "scenario", { ...body, mode: "laboratory" }, null, [
    { id: body.baselineSnapshotId, relation: "baseline" },
  ]);
}
export async function startRun(ctx: Context, id: string, key: string) {
  const scenario = get(ctx, id, "scenario");
  useBudget(ctx, "simulation", 100);
  // Job creation is persisted before remote submission; the same ID can safely be resubmitted after transport failure.
  const { idempotent } = await import("./repository.ts");
  const run = idempotent(ctx, key, { operation: "run", scenarioId: id }, () =>
    insert(
      ctx,
      "run",
      {
        scenarioId: id,
        status: "queued",
        progress: 0,
        scenario: scenario.data.scenario,
      },
      null,
      [{ id, relation: "scenario" }],
    ),
  );
  if (["completed", "cancelled", "failed"].includes(String(run.data.status)))
    return run;
  return dispatchRun(ctx, run.id);
}
export async function pollRun(ctx: Context, id: string) {
  const run = get(ctx, id, "run");
  if (
    ["completed", "cancelled", "failed", "dispatch-pending"].includes(
      String(run.data.status),
    )
  )
    return run;
  const job = await worker(ctx, "/jobs/" + id);
  return atomic(() => {
    const current = get(ctx, id, "run");
    if (
      ["completed", "cancelled", "failed"].includes(String(current.data.status))
    )
      return current;
    return update(ctx, current, current.revision, {
      ...current.data,
      ...job,
      workerId: job.id,
    });
  });
}

export const sensitivitySchema = z
  .object({
    samples: z.number().int().min(1).max(100),
    seed: z.number().int(),
    inflowM3s: z.tuple([
      z.number().min(0).max(100),
      z.number().min(0).max(100),
    ]),
    pumpCapacityM3s: z.tuple([
      z.number().min(0).max(100),
      z.number().min(0).max(100),
    ]),
    backupDelaySeconds: z.tuple([
      z.number().min(0).max(86400),
      z.number().min(0).max(86400),
    ]),
  })
  .strict();
export async function startSensitivity(
  ctx: Context,
  id: string,
  input: unknown,
  key: string,
) {
  const sensitivity = sensitivitySchema.parse(input),
    scenario = get(ctx, id, "scenario");
  useBudget(ctx, "ensemble", 5);
  const { idempotent } = await import("./repository.ts");
  const run = idempotent(
    ctx,
    key,
    { operation: "sensitivity", scenarioId: id, sensitivity },
    () =>
      insert(
        ctx,
        "run",
        {
          scenarioId: id,
          status: "queued",
          progress: 0,
          scenario: scenario.data.scenario,
          sensitivity,
        },
        null,
        [{ id, relation: "scenario" }],
      ),
  );
  return dispatchRun(ctx, run.id);
}

export async function dispatchRun(ctx: Context, id: string) {
  const run = get(ctx, id, "run");
  try {
    await worker(ctx, "/jobs", {
      id: run.id,
      scenario: run.data.scenario,
      ...(run.data.sensitivity ? { sensitivity: run.data.sensitivity } : {}),
    });
    if (run.data.status === "dispatch-pending")
      return atomic(() => {
        const current = get(ctx, id, "run");
        return update(ctx, current, current.revision, {
          ...current.data,
          status: "queued",
          error: null,
        });
      });
    return run;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return atomic(() => {
      const current = get(ctx, id, "run");
      return update(ctx, current, current.revision, {
        ...current.data,
        status: [400, 409, 422].includes(error.status)
          ? "failed"
          : "dispatch-pending",
        error: error.message,
      });
    });
  }
}
