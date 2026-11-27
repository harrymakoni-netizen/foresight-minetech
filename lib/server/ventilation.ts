// Ventilation scenarios (spec 9.8, 9.10): steady-state airflow by Hardy Cross,
// with screening gas dilution and re-entry estimates. Runs snapshot the
// published mine model; the worker does the calculation.
import { randomUUID } from "node:crypto";
import { DomainError, insert, useBudget, type Context } from "./repository.ts";
import { publishedModel } from "./mine-model.ts";
import { dispatch, requireRunner } from "./scenarios.ts";
import { buildVentilationInput, ventilationScenarioSchema } from "../domain/ventilation.ts";
import type { MineModel } from "../domain/mine-model.ts";

async function build(ctx: Context, body: unknown) {
  const s = ventilationScenarioSchema.parse(body);
  const rev = await publishedModel(ctx);
  if (!rev) return { s, rev: null, problems: ["No published mine model."], warnings: [] as string[], built: null };
  const built = buildVentilationInput(rev.data.model as MineModel, s);
  return { s, rev, problems: built.problems, warnings: built.warnings, built };
}
export async function ventilationPreflight(ctx: Context, body: unknown) {
  const b = await build(ctx, body);
  return { ok: b.problems.length === 0, problems: b.problems, warnings: b.warnings, revision: b.rev?.data.number ?? null };
}
export async function startVentilationRun(ctx: Context, body: unknown) {
  requireRunner(ctx);
  const b = await build(ctx, body);
  if (b.problems.length || !b.built || !b.rev) throw new DomainError(422, "PREFLIGHT_FAILED", "Ventilation preflight failed: " + b.problems.join(" "));
  await useBudget(ctx, "simulation", 40);
  const run = await insert(
    ctx,
    "ventilation-run",
    { name: b.s.name, scenario: b.s, mineModelRevisionId: b.rev.id, mineModelRevisionNumber: b.rev.data.number, warnings: b.warnings, hasScenario: b.built.hasScenario, status: "queued", jobId: randomUUID(), submittedAt: new Date().toISOString(), result: null, error: null },
    null,
    [{ id: b.rev.id, relation: "mine-model-revision" }],
  );
  return await dispatch(ctx, run, "ventilation", b.built.input);
}
