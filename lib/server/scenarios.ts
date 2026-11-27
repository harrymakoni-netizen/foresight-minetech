// Escape scenarios and Time to act studies (spec §9.4–9.6, §9.10). Runs
// snapshot the published mine model revision and the people source at start;
// later edits never change a run. Long work runs in the simulation worker,
// never inside a web request. A scenario never sends messages or opens a real
// incident: planning responses are marked planning, escalation is explicit.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atomic, get, insert, list, update, DomainError, useBudget, type Context } from "./repository.ts";
import { worker } from "./simulator.ts";
import { publishedModel } from "./mine-model.ts";
import { blocking, preflight, toEscapeNetwork, type MineModel } from "../domain/mine-model.ts";
import { activeCheckIns } from "./checkins.ts";

const minutes = (m: number) => Math.round(m * 60);
export const escapeScenarioSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    template: z.enum(["pump-failure", "blocked-tunnel"]),
    peopleSource: z.enum(["current-declarations", "planned-headcount"]),
    plannedHeadcount: z.record(z.string(), z.number().int().min(0).max(200)).default({}),
    startMethod: z.literal("spread-along-zone"),
    water: z
      .object({
        sumpId: z.string().min(1),
        dutyPumpId: z.string().min(1),
        backupPumpId: z.string().nullable(),
        failAtMinutes: z.number().min(0).max(1440),
        backupStartMinutes: z.number().min(0).max(1440).nullable(),
        inflowM3h: z.number().min(0).max(1e5).nullable(),
        initialVolumeM3: z.number().min(0).max(1e7).nullable(),
      })
      .strict(),
    blockedTunnels: z.array(z.object({ tunnelId: z.string(), atMinutes: z.number().min(0).max(1440) }).strict()).max(20).default([]),
    evacuationOrderMinutes: z.number().min(0).max(1440),
    preMovementMinutes: z.object({ min: z.number().min(0).max(120), max: z.number().min(0).max(120) }).strict(),
    speed: z.object({ mean: z.number().min(0.3).max(2), sd: z.number().min(0).max(0.6), min: z.number().min(0.2).max(2), max: z.number().min(0.3).max(3) }).strict(),
    horizonMinutes: z.number().min(5).max(360),
    seed: z.number().int().min(0).max(2 ** 31 - 1),
    endurance: z.object({ selfRescuerRatedMinutes: z.number().min(1).max(600).nullable(), refugeConsumptionM3PerPersonHour: z.number().min(0.01).max(100).nullable() }).strict(),
    sourceConcernId: z.string().max(80).nullable().default(null),
    sourceReportId: z.string().max(80).nullable().default(null),
  })
  .strict();
export type EscapeScenario = z.infer<typeof escapeScenarioSchema>;
export const requireRunner = (ctx: Context) => {
  if (ctx.role !== "supervisor" && ctx.role !== "administrator")
    throw new DomainError(403, "ROLE_REQUIRED", "A supervisor or administrator role is required to run scenarios.");
};

/** Snapshot the people source. Declared people start in their declared zone,
 * else the first zone reached from their shaft; the assumption is recorded. */
async function peopleSnapshot(ctx: Context, s: EscapeScenario, model: MineModel) {
  const people: { id: string; name: string; zoneId: string; checkInId?: string; assumption: string }[] = [];
  const unplaced: string[] = [];
  if (s.peopleSource === "current-declarations") {
    for (const c of await activeCheckIns(ctx)) {
      const declared = c.data.declaredZoneId as string | null;
      const shaftZone = model.zones.find((z) => z.shaftIds.includes(String(c.data.shaftId)))?.id;
      const zoneId = declared && model.zones.some((z) => z.id === declared) ? declared : shaftZone;
      if (!zoneId) {
        unplaced.push(String(c.data.personName));
        continue;
      }
      people.push({
        id: c.id,
        checkInId: c.id,
        name: String(c.data.personName),
        zoneId,
        assumption: declared ? `declared zone ${zoneId}` : `no declared zone; assumed first zone of ${c.data.shaftName} (${zoneId})`,
      });
    }
  } else
    for (const [zoneId, n] of Object.entries(s.plannedHeadcount)) {
      if (!model.zones.some((z) => z.id === zoneId)) throw new DomainError(422, "ZONE", `Unknown zone ${zoneId} in planned headcount.`);
      for (let i = 0; i < n; i++) people.push({ id: `planned-${zoneId}-${i + 1}`, name: `Planned ${model.zones.find((z) => z.id === zoneId)!.name} ${i + 1}`, zoneId, assumption: "planned headcount" });
    }
  return { people, unplaced };
}
export function chainInput(ctx: Context, s: EscapeScenario, model: MineModel, revisionId: string, people: { id: string; name: string; zoneId: string }[], timeOrigin: string) {
  return {
    workspaceId: ctx.workspaceId,
    mineModelRevisionId: revisionId,
    timeOrigin,
    model,
    network: toEscapeNetwork(model),
    people: people.map((p) => ({ id: p.id, name: p.name, zoneId: p.zoneId })),
    water: {
      sumpId: s.water.sumpId,
      dutyPumpId: s.water.dutyPumpId,
      backupPumpId: s.water.backupPumpId,
      failAtSeconds: minutes(s.water.failAtMinutes),
      backupStartSeconds: s.water.backupStartMinutes === null ? null : minutes(s.water.backupStartMinutes),
      ...(s.water.inflowM3h !== null ? { inflowM3h: s.water.inflowM3h } : {}),
      ...(s.water.initialVolumeM3 !== null ? { initialVolumeM3: s.water.initialVolumeM3 } : {}),
    },
    extraClosures: s.blockedTunnels.map((b) => ({ tunnelId: b.tunnelId, atSeconds: minutes(b.atMinutes), source: "tunnel marked blocked in the scenario" })),
    params: {
      seed: s.seed,
      horizonSeconds: minutes(s.horizonMinutes),
      alarmDelaySeconds: minutes(s.evacuationOrderMinutes),
      preMovementSeconds: { min: minutes(s.preMovementMinutes.min), max: minutes(Math.max(s.preMovementMinutes.min, s.preMovementMinutes.max)) },
      speed: s.speed,
      startMethod: "spread-along-zone",
      recordEverySeconds: 1,
    },
    endurance: s.endurance,
  };
}
/** Preflight before submission (spec §9.10): lists blocking problems. */
export async function scenarioPreflight(ctx: Context, input: unknown) {
  const s = escapeScenarioSchema.parse(input);
  const rev = await publishedModel(ctx);
  if (!rev) return { ok: false, problems: ["No published mine model."], people: 0 };
  const model = rev.data.model as MineModel;
  const problems = blocking(preflight(model)).filter((i) => i.blocks.some((b) => b === "escape" || b === "flooding")).map((i) => i.message);
  const sump = model.sumps.find((x) => x.id === s.water.sumpId);
  if (!sump) problems.push(`Sump ${s.water.sumpId} is not in the published model.`);
  else {
    if ((s.water.inflowM3h ?? sump.inflowM3h) === null) problems.push(`${sump.name} inflow is not entered.`);
    if ((s.water.initialVolumeM3 ?? sump.initialVolumeM3) === null) problems.push(`${sump.name} starting volume is not entered.`);
  }
  for (const id of [s.water.dutyPumpId, ...(s.water.backupPumpId ? [s.water.backupPumpId] : [])]) {
    const p = model.pumps.find((x) => x.id === id);
    if (!p) problems.push(`Pump ${id} is not in the published model.`);
    else if (p.capacityM3h === null) problems.push(`${p.name} capacity is not entered.`);
  }
  for (const b of s.blockedTunnels) if (!model.tunnels.some((t) => t.id === b.tunnelId)) problems.push(`Tunnel ${b.tunnelId} is not in the model.`);
  const { people, unplaced } = await peopleSnapshot(ctx, s, model);
  if (!people.length) problems.push(s.peopleSource === "current-declarations" ? "Nobody is declared underground. Use a planned headcount to plan ahead." : "Planned headcount is empty.");
  if (unplaced.length) problems.push(`No assumed start area for: ${unplaced.join(", ")}.`);
  return { ok: problems.length === 0, problems, people: people.length, revision: rev.data.number };
}
export async function startEscapeRun(ctx: Context, input: unknown) {
  requireRunner(ctx);
  const s = escapeScenarioSchema.parse(input);
  const check = await scenarioPreflight(ctx, s);
  if (!check.ok) throw new DomainError(422, "PREFLIGHT_FAILED", "Scenario preflight failed: " + check.problems.join(" "));
  await useBudget(ctx, "simulation", 40);
  const rev = (await publishedModel(ctx))!;
  const model = rev.data.model as MineModel;
  const { people } = await peopleSnapshot(ctx, s, model);
  const timeOrigin = new Date().toISOString();
  const input2 = chainInput(ctx, s, model, rev.id, people, timeOrigin);
  const run = await insert(
    ctx,
    "escape-run",
    {
      name: s.name,
      scenario: s,
      mineModelRevisionId: rev.id,
      mineModelRevisionNumber: rev.data.number,
      peopleSnapshot: people,
      startAssumption: "Declared or planned people spread along their zone's walkable area (seeded jupedsim.distribute_by_number); not live locations",
      status: "queued",
      jobId: randomUUID(),
      submittedAt: timeOrigin,
      result: null,
      error: null,
    },
    null,
    [{ id: rev.id, relation: "mine-model-revision" }, ...(s.sourceReportId ? [{ id: s.sourceReportId, relation: "source-report" }] : [])],
  );
  return await dispatch(ctx, run, "escape-chain", input2);
}
export async function dispatch(ctx: Context, run: Awaited<ReturnType<typeof insert>>, kind: string, payload: unknown) {
  try {
    await worker(ctx, "/jobs", { id: run.data.jobId, kind, workspaceId: ctx.workspaceId, input: payload });
    return await update(ctx, run, run.revision, { ...run.data, status: "running" });
  } catch (e) {
    return await update(ctx, run, run.revision, { ...run.data, status: "worker-unavailable", error: (e as Error).message });
  }
}
/** Poll the worker; on completion store the result. Trajectories become their own source record. */
export async function pollEscape(ctx: Context, id: string, kind: "escape-run" | "time-to-act-study" | "cage-run" | "ventilation-run") {
  const run = await get(ctx, id, kind);
  if (!["running", "queued"].includes(String(run.data.status))) return run;
  let job: { status: string; result?: Record<string, unknown> | null; error?: string; progress?: number };
  try {
    job = await worker(ctx, `/jobs/${run.data.jobId}`);
  } catch (e) {
    return { ...run, data: { ...run.data, pollError: (e as Error).message } };
  }
  if (job.status === "completed" && job.result)
    return atomic(async () => {
      const fresh = await get(ctx, id, kind);
      if (fresh.data.status === "completed") return fresh;
      const { trajectories, ...result } = job.result as Record<string, unknown>;
      let trajectoryId: string | null = null;
      if (trajectories) trajectoryId = (await insert(ctx, "run-trajectory", { runId: id, format: "columnar t,p,x,y (metres, seconds)", source: trajectories }, null, [{ id, relation: "run" }])).id;
      return await update(ctx, fresh, fresh.revision, { ...fresh.data, status: "completed", result, trajectoryId, completedAt: new Date().toISOString() });
    });
  if (["failed", "cancelled"].includes(job.status))
    return await update(ctx, run, run.revision, { ...run.data, status: job.status, error: job.error || null });
  return { ...run, data: { ...run.data, progress: job.progress ?? null } };
}
export const ttaSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    runId: z.string().min(1),
    fromMinutes: z.number().min(0).max(1440),
    toMinutes: z.number().min(0).max(1440),
    stepMinutes: z.number().min(1).max(240),
  })
  .strict()
  .refine((x) => x.toMinutes >= x.fromMinutes, "Search end must not precede start")
  .refine((x) => Math.floor((x.toMinutes - x.fromMinutes) / x.stepMinutes) + 1 <= 40, "At most 40 tested values");
/** Time to act reuses a run's frozen inputs and varies only the backup start. */
export async function startTimeToAct(ctx: Context, input: unknown) {
  requireRunner(ctx);
  const s = ttaSchema.parse(input);
  const base = await get(ctx, s.runId, "escape-run");
  const scenario = base.data.scenario as EscapeScenario;
  if (!scenario.water.backupPumpId) throw new DomainError(422, "NO_BACKUP", "The base scenario has no backup pump to start.");
  const rev = await get(ctx, String(base.data.mineModelRevisionId), "mine-model-revision");
  await useBudget(ctx, "simulation", 40);
  const payload = {
    chain: chainInput(ctx, scenario, rev.data.model as MineModel, rev.id, base.data.peopleSnapshot as { id: string; name: string; zoneId: string }[], String(base.data.submittedAt)),
    fromSeconds: minutes(s.fromMinutes),
    toSeconds: minutes(s.toMinutes),
    stepSeconds: minutes(s.stepMinutes),
  };
  const study = await insert(
    ctx,
    "time-to-act-study",
    { ...s, variable: "backup pump start", baseRunId: base.id, mineModelRevisionId: rev.id, condition: "every simulated person reaches an exit or refuge before the horizon", status: "queued", jobId: randomUUID(), submittedAt: new Date().toISOString(), result: null },
    null,
    [{ id: base.id, relation: "base-run" }],
  );
  return await dispatch(ctx, study, "time-to-act", payload);
}
/** Explicit escalation by an authorised user: an escalation record and a
 * register entry marked as an escalated scenario. Still never sends messages. */
export async function escalateRun(ctx: Context, id: string, input: unknown) {
  requireRunner(ctx);
  const b = z.object({ reason: z.string().trim().min(3).max(1000), owner: z.string().trim().min(2).max(100), dueAt: z.string().datetime({ offset: true }) }).strict().parse(input);
  const run = await get(ctx, id, "escape-run");
  if (run.data.status !== "completed") throw new DomainError(409, "RUN_NOT_COMPLETE", "Only a completed run can be escalated.");
  const result = run.data.result as { escape: { totals: Record<string, number>; people: { outcome: string; label: string | null; name: string }[] }; flooding: { firstDangerSeconds: number | null }; inputHash: string };
  return atomic(async () => {
    const escalation = await insert(ctx, "scenario-escalation", { runId: id, reason: b.reason, by: ctx.actor, at: new Date().toISOString() }, null, [{ id, relation: "run" }]);
    const zone = (run.data.peopleSnapshot as { zoneId: string }[])[0]?.zoneId || null;
    const cut = result.escape.people.filter((p) => p.outcome === "cut-off");
    const kase = await insert(
      ctx,
      "case",
      {
        title: `Escalated scenario: ${run.data.name}`,
        zoneId: zone,
        category: "planning",
        source: "escalated-scenario",
        description: `Escalated by ${ctx.actor}: ${b.reason}. Run ${id.slice(0, 8)} (input ${result.inputHash.slice(0, 12)}): ${result.escape.totals["cut-off"]} cut off from assumed starts${cut.length ? " (" + cut.map((p) => p.name).join(", ") + ")" : ""}. Planning calculation under stated assumptions.`,
        peopleAffected: [],
        owner: b.owner,
        dueAt: b.dueAt,
        planning: true,
        sourceRunId: id,
        status: "open",
        actions: [],
        history: [{ at: new Date().toISOString(), actor: ctx.actor, status: "open", reason: "Scenario escalated" }],
      },
      zone,
      [{ id, relation: "laboratory-run" }, { id: escalation.id, relation: "escalation" }],
    );
    return { escalation, case: kase };
  });
}
/** Planning response from a run: marked planning, never sends messages. */
export async function planningResponse(ctx: Context, id: string, input: unknown) {
  requireRunner(ctx);
  const b = z.object({ title: z.string().trim().min(3).max(140), owner: z.string().trim().min(2).max(100), dueAt: z.string().datetime({ offset: true }) }).strict().parse(input);
  const run = await get(ctx, id, "escape-run");
  if (run.data.status !== "completed") throw new DomainError(409, "RUN_NOT_COMPLETE", "Only a completed run can create a planning response.");
  const zone = (run.data.peopleSnapshot as { zoneId: string }[])[0]?.zoneId || null;
  return await insert(
    ctx,
    "case",
    { title: b.title, zoneId: zone, category: "planning", source: "planning-scenario", description: `Planning response from run ${id.slice(0, 8)} (${run.data.name}).`, peopleAffected: [], owner: b.owner, dueAt: b.dueAt, planning: true, sourceRunId: id, status: "open", actions: [], history: [{ at: new Date().toISOString(), actor: ctx.actor, status: "open", reason: "Planning response created from a scenario run" }] },
    zone,
    [{ id, relation: "laboratory-run" }],
  );
}
export async function escapeRuns(ctx: Context) {
  return await list(ctx, "escape-run");
}
