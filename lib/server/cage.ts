// Cage and hoist evacuation scenarios (spec 9.7, 9.10). Runs snapshot the
// published mine model and the people source at start; later edits never
// change a run. The calculation runs in the simulation worker (SimPy).
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError, get, insert, useBudget, type Context } from "./repository.ts";
import { publishedModel } from "./mine-model.ts";
import { activeCheckIns } from "./checkins.ts";
import { dispatch, requireRunner } from "./scenarios.ts";
import type { MineModel } from "../domain/mine-model.ts";

export const cageScenarioSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    shaftExitId: z.string().min(1).max(80),
    source: z.enum(["declared", "escape-run", "manual"]),
    escapeRunId: z.string().max(80).nullable().default(null),
    manual: z.array(z.object({ level: z.string().min(1).max(40), count: z.number().int().min(1).max(200), arriveMinutes: z.number().min(0).max(1440) }).strict()).max(20).default([]),
    /** Declared people: minutes after the scenario starts before they are at the shaft station. */
    assemblyMinutes: z.number().min(0).max(240).default(0),
    outages: z.array(z.object({ fromMinutes: z.number().min(0).max(1440), toMinutes: z.number().min(0).max(1440).nullable() }).strict()).max(5).default([]),
    unloadSeconds: z.number().min(0).max(3600).nullable().default(null),
    /** Independent cages sharing the level queues (the model does not record a cage count). */
    cageCount: z.number().int().min(1).max(4).default(1),
    horizonMinutes: z.number().min(5).max(720).default(240),
    sourceConcernId: z.string().max(80).nullable().default(null),
  })
  .strict()
  .refine((s) => s.outages.every((o) => o.toMinutes === null || o.toMinutes > o.fromMinutes), "A hoist outage must end after it starts");
export type CageScenario = z.infer<typeof cageScenarioSchema>;
const secs = (m: number) => Math.round(m * 60);

/** Everything the engine needs, plus the problems that block a run. */
export async function buildCageInput(ctx: Context, s: CageScenario) {
  const rev = await publishedModel(ctx);
  const problems: string[] = [];
  if (!rev) return { problems: ["No published mine model."], rev: null, input: null, people: 0 };
  const model = rev.data.model as MineModel;
  const exit = model.exits.find((e) => e.id === s.shaftExitId);
  if (!exit) return { problems: [`Shaft ${s.shaftExitId} is not in the published model.`], rev, input: null, people: 0 };
  const h = exit.hoist;
  if (!h) problems.push(`${exit.name} has no hoist entered in the mine model.`);
  else {
    if (h.cageCapacity === null) problems.push(`${exit.name} cage capacity is not entered.`);
    if (h.loadingSeconds === null) problems.push(`${exit.name} loading time is not entered.`);
    if (!h.tripSecondsByLevel.length) problems.push(`${exit.name} has no trip time to any level.`);
  }
  const levels = h ? h.tripSecondsByLevel.map((l) => ({ level: l.level, junction: l.junction, tripSeconds: l.seconds })) : [];
  const station = levels.find((l) => l.junction === exit.junction) || null;
  const arrivals: { id: string; name: string | null; level: string; atSeconds: number }[] = [];
  const notes: string[] = [];
  if (s.source === "declared") {
    if (!station) problems.push(`The shaft station of ${exit.name} has no trip time, so declared people cannot be placed at a level.`);
    const here = (await activeCheckIns(ctx)).filter((c) => c.data.shaftId === exit.shaftId);
    if (!here.length) problems.push(`Nobody is declared underground at ${exit.name}.`);
    if (station)
      for (const c of here) arrivals.push({ id: c.id, name: String(c.data.personName), level: station.level, atSeconds: secs(s.assemblyMinutes) });
    notes.push(`Declared people at ${exit.name} are assumed to be at the station level (${station?.level ?? "?"}) ${s.assemblyMinutes} min after the scenario starts. Declared zones do not say which level someone is on.`);
  } else if (s.source === "escape-run") {
    if (!s.escapeRunId) problems.push("Choose a completed escape run.");
    else {
      const run = await get(ctx, s.escapeRunId, "escape-run").catch(() => null);
      if (!run) problems.push("That escape run was not found.");
      else if (run.data.status !== "completed" || !run.data.result) problems.push("That escape run is not complete.");
      else if (run.data.mineModelRevisionId !== rev.id) problems.push(`That escape run used mine model revision ${String(run.data.mineModelRevisionNumber)}, not the published revision ${String(rev.data.number)}.`);
      else {
        if (!station) problems.push(`The shaft station of ${exit.name} has no trip time.`);
        const result = run.data.result as { escape: { people: { id: string; name: string | null; outcome: string; targetId: string | null; atSeconds: number | null }[] } };
        const using = result.escape.people.filter((p) => p.outcome === "reached-exit" && p.targetId === exit.id && p.atSeconds !== null);
        if (!using.length) problems.push(`No one in that run reached ${exit.name}. The run sent people to other exits.`);
        if (station) for (const p of using) arrivals.push({ id: p.id, name: p.name, level: station.level, atSeconds: Math.round(p.atSeconds!) });
        notes.push(`People are those the escape run (${s.escapeRunId.slice(0, 8)}) brought to ${exit.name}, arriving at the times the run calculated. Others used different exits.`);
      }
    }
  } else {
    if (!s.manual.length) problems.push("Enter at least one level with a number of people.");
    for (const m of s.manual) {
      if (!levels.some((l) => l.level === m.level)) problems.push(`Level "${m.level}" has no trip time in the mine model.`);
      for (let i = 0; i < m.count; i++) arrivals.push({ id: `manual-${m.level}-${i + 1}`, name: `Person ${i + 1} at ${m.level}`, level: m.level, atSeconds: secs(m.arriveMinutes) });
    }
    notes.push("People counts and arrival times were entered by hand.");
  }
  if (arrivals.length > 2000) problems.push("At most 2000 people can be modelled.");
  const input = h
    ? {
        shaft: { id: exit.id, name: exit.name, cageCapacity: h.cageCapacity, loadingSeconds: h.loadingSeconds, unloadSeconds: s.unloadSeconds, ladderClimbSeconds: exit.ladderClimbSeconds, levels },
        arrivals,
        outages: s.outages.map((o) => ({ fromSeconds: secs(o.fromMinutes), toSeconds: o.toMinutes === null ? null : secs(o.toMinutes) })),
        horizonSeconds: secs(s.horizonMinutes),
        cageCount: s.cageCount,
      }
    : null;
  return { problems, rev, input, people: arrivals.length, notes, exit };
}
export async function cagePreflight(ctx: Context, body: unknown) {
  const s = cageScenarioSchema.parse(body);
  const b = await buildCageInput(ctx, s);
  const warnings: string[] = [];
  if (b.exit && b.exit.ladderClimbSeconds === null && s.outages.length) warnings.push(`${b.exit.name} has no ladder climb time: after a hoist failure people on the ladderway are reported as not reached.`);
  return { ok: b.problems.length === 0, problems: b.problems, warnings, people: b.people, revision: b.rev?.data.number ?? null };
}
export async function startCageRun(ctx: Context, body: unknown) {
  requireRunner(ctx);
  const s = cageScenarioSchema.parse(body);
  const b = await buildCageInput(ctx, s);
  if (b.problems.length || !b.input || !b.rev) throw new DomainError(422, "PREFLIGHT_FAILED", "Cage scenario preflight failed: " + b.problems.join(" "));
  await useBudget(ctx, "simulation", 40);
  const run = await insert(
    ctx,
    "cage-run",
    {
      name: s.name,
      scenario: s,
      mineModelRevisionId: b.rev.id,
      mineModelRevisionNumber: b.rev.data.number,
      shaftName: b.exit!.name,
      peopleSnapshot: b.input.arrivals,
      shaftInput: b.input.shaft,
      stationJunction: b.exit!.junction,
      assumptionsNote: b.notes,
      status: "queued",
      jobId: randomUUID(),
      submittedAt: new Date().toISOString(),
      result: null,
      error: null,
    },
    null,
    [{ id: b.rev.id, relation: "mine-model-revision" }, ...(s.escapeRunId ? [{ id: s.escapeRunId, relation: "escape-run" }] : [])],
  );
  return await dispatch(ctx, run, "cage", b.input);
}
