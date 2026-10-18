import { randomUUID } from "node:crypto";
import { lock } from "./db.ts";
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
export const serverlessSimulator = () =>
  Boolean(
    process.env.FORESIGHT_SIMULATOR_MODE === "serverless" ||
    (process.env.VERCEL && !process.env.FORESIGHT_SIMULATOR_URL),
  );
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
export async function createSnapshot(ctx: Context) {
  return await insert(ctx, "snapshot", {
    mode: "laboratory-baseline",
    frozenAt: new Date().toISOString(),
    siteId: "fictional-mine-001",
    sourceEntities: (await list(ctx)).filter((e) =>
      ["observation", "assessment", "worker", "inspection"].includes(e.kind),
    ),
    physicalInputsStatus:
      "No measured storage geometry or flow is configured. Lab parameters require explicit assumptions.",
  });
}
export async function createScenario(ctx: Context, input: unknown) {
  const body = z
    .object({
      name: z.string().trim().min(3).max(120),
      baselineSnapshotId: z.string(),
      scenario: scenarioSchema,
      assumptionsAccepted: z.literal(true),
    })
    .strict()
    .parse(input);
  await get(ctx, body.baselineSnapshotId, "snapshot");
  if (
    body.scenario.workspaceId !== ctx.workspaceId ||
    body.scenario.baselineSnapshotId !== body.baselineSnapshotId
  )
    throw new DomainError(
      403,
      "SCENARIO_SCOPE",
      "Scenario must use this workspace and frozen baseline.",
    );
  return await insert(ctx, "scenario", { ...body, mode: "laboratory" }, null, [
    { id: body.baselineSnapshotId, relation: "baseline" },
  ]);
}
export async function startRun(ctx: Context, id: string, key: string) {
  const scenario = await get(ctx, id, "scenario");
  // Job creation is persisted before remote submission; the same ID can safely be resubmitted after transport failure.
  const { idempotent } = await import("./repository.ts");
  const run = await idempotent(
    ctx,
    key,
    { operation: "run", scenarioId: id },
    async () => {
      await useBudget(ctx, "simulation", 100);
      return await insert(
        ctx,
        "run",
        {
          scenarioId: id,
          name: scenario.data.name,
          status: "queued",
          progress: 0,
          scenario: scenario.data.scenario,
        },
        null,
        [{ id, relation: "scenario" }],
      );
    },
  );
  if (["completed", "cancelled", "failed"].includes(String(run.data.status)))
    return run;
  return serverlessSimulator() ? run : dispatchRun(ctx, run.id);
}
export async function pollRun(ctx: Context, id: string) {
  const run = await get(ctx, id, "run");
  if (
    ["completed", "cancelled", "failed", "dispatch-pending"].includes(
      String(run.data.status),
    )
  )
    return run;
  if (serverlessSimulator()) {
    const expires =
      run.data.leaseUntil ||
      new Date(Date.parse(run.createdAt) + 180000).toISOString();
    if (Date.parse(String(expires)) < Date.now())
      return atomic(async () => {
        const current = await get(ctx, id, "run");
        if (
          ["completed", "failed", "cancelled"].includes(
            String(current.data.status),
          )
        )
          return current;
        return update(ctx, current, current.revision, {
          ...current.data,
          status: "dispatch-pending",
          error: "Execution was interrupted. Retry this saved run.",
        });
      });
    return run;
  }
  const job = await worker(ctx, "/jobs/" + id);
  return await atomic(async () => {
    const current = await get(ctx, id, "run");
    if (
      ["completed", "cancelled", "failed"].includes(String(current.data.status))
    )
      return current;
    return await update(ctx, current, current.revision, {
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
    scenario = await get(ctx, id, "scenario");
  const { idempotent } = await import("./repository.ts");
  const run = await idempotent(
    ctx,
    key,
    { operation: "sensitivity", scenarioId: id, sensitivity },
    async () => {
      await useBudget(ctx, "ensemble", 5);
      return await insert(
        ctx,
        "run",
        {
          scenarioId: id,
          name: scenario.data.name,
          status: "queued",
          progress: 0,
          scenario: scenario.data.scenario,
          sensitivity,
        },
        null,
        [{ id, relation: "scenario" }],
      );
    },
  );
  return serverlessSimulator() ? run : dispatchRun(ctx, run.id);
}
export async function dispatchRun(ctx: Context, id: string) {
  if (serverlessSimulator()) return dispatchServerless(ctx, id);
  const run = await get(ctx, id, "run");
  try {
    await worker(ctx, "/jobs", {
      id: run.id,
      scenario: run.data.scenario,
      ...(run.data.sensitivity ? { sensitivity: run.data.sensitivity } : {}),
    });
    if (run.data.status === "dispatch-pending")
      return await atomic(async () => {
        const current = await get(ctx, id, "run");
        return await update(ctx, current, current.revision, {
          ...current.data,
          status: "queued",
          error: null,
        });
      });
    return run;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return await atomic(async () => {
      const current = await get(ctx, id, "run");
      return await update(ctx, current, current.revision, {
        ...current.data,
        status: [400, 409, 422].includes(error.status)
          ? "failed"
          : "dispatch-pending",
        error: error.message,
      });
    });
  }
}

export async function cancelRun(ctx: Context, id: string) {
  await get(ctx, id, "run");
  if (!serverlessSimulator()) return worker(ctx, "/jobs/" + id + "/cancel", {});
  return atomic(async () => {
    await lock(`simulation:${ctx.workspaceId}:${id}`);
    const current = await get(ctx, id, "run");
    if (
      ["completed", "cancelled", "failed"].includes(String(current.data.status))
    )
      return current;
    return update(ctx, current, current.revision, {
      ...current.data,
      status: "cancelled",
      cancelRequestedAt: new Date().toISOString(),
    });
  });
}
async function dispatchServerless(ctx: Context, id: string) {
  const executionId = randomUUID();
  const run = await atomic(async () => {
    await lock(`simulation:${ctx.workspaceId}:${id}`);
    const current = await get(ctx, id, "run");
    if (
      ["completed", "cancelled", "failed"].includes(String(current.data.status))
    )
      return current;
    if (
      current.data.status === "running" &&
      Date.parse(String(current.data.leaseUntil)) > Date.now()
    )
      return current;
    return update(ctx, current, current.revision, {
      ...current.data,
      status: "running",
      executionId,
      leaseUntil: new Date(Date.now() + 180000).toISOString(),
      startedAt: new Date().toISOString(),
      error: null,
    });
  });
  if (run.data.executionId !== executionId) return run;
  let outcome: Record<string, unknown>;
  try {
    const token = process.env.FORESIGHT_WORKER_TOKEN;
    if (!token) throw new Error("Simulation authentication is not configured.");
    const response = await fetch(
      `https://${process.env.VERCEL_URL}/api/simulation`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Workspace-Id": ctx.workspaceId,
        },
        body: JSON.stringify({
          scenario: run.data.scenario,
          ...(run.data.sensitivity
            ? { sensitivity: run.data.sensitivity }
            : {}),
        }),
        signal: AbortSignal.timeout(150000),
        cache: "no-store",
      },
    );
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || "Simulation request failed.");
    outcome = {
      status: result.status,
      progress: result.status === "completed" ? 1 : 0,
      result,
      finishedAt: new Date().toISOString(),
    };
  } catch (error) {
    outcome = {
      status: "dispatch-pending",
      error:
        error instanceof Error
          ? error.message
          : "Simulation unavailable. Retry the saved run.",
    };
  }
  return atomic(async () => {
    await lock(`simulation:${ctx.workspaceId}:${id}`);
    const current = await get(ctx, id, "run");
    // Cancellation or a newer retry wins over a late result from this attempt.
    if (
      current.data.status === "cancelled" ||
      current.data.executionId !== executionId
    )
      return current;
    return update(ctx, current, current.revision, {
      ...current.data,
      ...outcome,
      leaseUntil: null,
    });
  });
}
