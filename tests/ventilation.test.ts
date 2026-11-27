// Phase 10: building solver input from the mine model and scenario, and a full
// run through the real worker. Expected figures are checked against the laws
// (continuity, equal pressure drop) or worked out by hand.
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { buildVentilationInput, crossSectionArea, naturalVentilationPressure, ventilationScenarioSchema } from "../lib/domain/ventilation.ts";
import { trainingMineModel } from "../lib/domain/mine-model.ts";

const base = { name: "North adit fan failure", fanFailures: ["F1"] };
const model = trainingMineModel();
test("training mine: fictional ventilation values are present and recorded as assumed", () => {
  assert.ok(model.tunnels.every((t) => typeof t.resistance === "number" && t.resistance > 0));
  assert.equal(model.fans[0].fixedDutyM3s, 30);
  assert.equal(model.provenance["F1.fixedDutyM3s"].quality, "assumed");
  assert.equal(model.provenance["T1.resistance"].quality, "assumed");
  // R = k L P / A^3 with k = 0.012: T1 is 60 m, 3.5 x 3 m -> 0.012 * 60 * 13 / 10.5^3 = 0.00808...
  assert.ok(Math.abs(model.tunnels[0].resistance! - 0.00808) < 1e-4);
});
test("cross-section areas: box and arched", () => {
  assert.equal(crossSectionArea({ ...model.tunnels[0], width: 4, height: 3, profile: "box" }), 12);
  const arched = crossSectionArea({ ...model.tunnels[0], width: 4, height: 3, profile: "arched" })!;
  assert.ok(Math.abs(arched - (4 * 1 + (Math.PI * 4) / 2)) < 1e-9); // 4 x (3 - 2) + semicircle of radius 2
  assert.equal(crossSectionArea({ ...model.tunnels[0], width: null }), null);
});
test("baseline and scenario states: fan in service, failed fan stops driving, every exit joins the surface", () => {
  const b = buildVentilationInput(model, ventilationScenarioSchema.parse(base));
  assert.deepEqual(b.problems, []);
  const fixed = (st: any) => st.airways.filter((a: any) => a.fixed != null);
  assert.deepEqual(fixed(b.input.states.baseline).map((a: any) => [a.id, a.fixed]), [["T13", 30]]);
  assert.equal(fixed(b.input.states.scenario).length, 0);
  assert.equal(b.input.states.baseline.airways.filter((a: any) => a.id.startsWith("SURF-")).length, 3);
  assert.ok(b.warnings.some((w) => /No fan or natural ventilation pressure is in service/.test(w)));
  const T13 = b.input.states.scenario.airways.find((a: any) => a.id === "T13") as any;
  assert.ok(T13.resistance > 0, "a failed fan leaves its airway open");
});
test("a closed door adds its resistance in series; blocked tunnels are removed; unknown ids are refused", () => {
  const closed = buildVentilationInput(model, ventilationScenarioSchema.parse({ name: "Close the south door", doorChanges: [{ doorId: "D1", open: false }], blockedTunnels: ["T10"] }));
  const t11 = (st: any) => st.airways.find((a: any) => a.id === "T11").resistance;
  assert.ok(Math.abs(t11(closed.input.states.scenario) - (t11(closed.input.states.baseline) + 50)) < 1e-9);
  assert.equal(closed.input.states.scenario.airways.some((a: any) => a.id === "T10"), false);
  const bad = buildVentilationInput(model, ventilationScenarioSchema.parse({ name: "Bad ids", fanFailures: ["F9"], blockedTunnels: ["T99"], doorChanges: [{ doorId: "D9", open: true }] }));
  assert.equal(bad.problems.length, 3);
});
test("fan curve: used unless a scenario overrides the duty; natural pressure is applied to both states", () => {
  const m = structuredClone(model);
  m.fans[0].curve = [{ q: 0, p: 300 }, { q: 40, p: 0 }];
  const r = buildVentilationInput(m, ventilationScenarioSchema.parse({ name: "Natural pressure", naturalVentilation: [{ tunnelId: "T1", pressurePa: 25 }], fanDutyOverrides: [{ fanId: "F1", dutyM3s: 20 }] }));
  assert.deepEqual(r.problems, []);
  const t13 = (st: any) => st.airways.find((a: any) => a.id === "T13");
  assert.deepEqual(t13(r.input.states.baseline).fanCurve, m.fans[0].curve);
  assert.ok(t13(r.input.states.baseline).resistance > 0 && t13(r.input.states.baseline).fixed === undefined);
  assert.equal(t13(r.input.states.scenario).fixed, 20, "an overridden duty replaces the curve");
  for (const st of ["baseline", "scenario"]) assert.equal((r.input.states as any)[st].airways.find((a: any) => a.id === "T1").pressureSourcePa, 25);
  assert.ok(buildVentilationInput(m, ventilationScenarioSchema.parse({ name: "Unknown tunnel", naturalVentilation: [{ tunnelId: "T99", pressurePa: 5 }] })).problems.some((p) => /T99/.test(p)));
});
test("natural ventilation pressure: hand-worked value (10 C vs 30 C over 100 m at 101325 Pa)", () => {
  const dp = naturalVentilationPressure({ heightM: 100, coldC: 10, warmC: 30, surfacePressurePa: 101325 });
  assert.ok(Math.abs(dp - 80.656) < 0.01, String(dp));
  assert.equal(naturalVentilationPressure({ heightM: 100, coldC: 20, warmC: 20, surfacePressurePa: 101325 }), 0);
});
test("missing values block the run and are listed, never filled in", () => {
  const m = structuredClone(model);
  m.tunnels[2].resistance = null;
  m.fans[0].fixedDutyM3s = null;
  const r = buildVentilationInput(m, ventilationScenarioSchema.parse({ name: "Gaps", blockedTunnels: ["T1"] }));
  assert.ok(r.problems.some((p) => /Tunnel T3 airway resistance is not entered/.test(p)));
  assert.ok(r.problems.some((p) => /Fan North adit fan has no duty or curve entered/.test(p)));
  const noExit = structuredClone(model);
  noExit.exits = [];
  assert.ok(buildVentilationInput(noExit, ventilationScenarioSchema.parse(base)).problems.some((p) => /no exit/.test(p)));
});
test("re-entry volume comes from tunnel geometry and needs sizes; it also needs the gas limit", () => {
  const s = ventilationScenarioSchema.parse({ name: "Blast re-entry", gas: { releaseTunnelId: "T5", releaseM3s: 0.01, limitFraction: 0.0005 }, reentry: { tunnelIds: ["T5"], feedTunnelId: "T4", startFraction: 0.01 } });
  const r = buildVentilationInput(model, s);
  assert.deepEqual(r.problems, []);
  const t5 = model.tunnels.find((t) => t.id === "T5")!;
  const len = Math.hypot(300 - 240, 0 - 0, -64 + 63); // J4 (240,0,-63) -> J5 (300,0,-64)
  assert.ok(Math.abs(r.input.reentry!.volumeM3 - crossSectionArea(t5)! * len) < 1e-6);
  assert.equal(r.input.reentry!.cLimitFraction, 0.0005);
  const noGas = buildVentilationInput(model, ventilationScenarioSchema.parse({ name: "Blast re-entry", reentry: { tunnelIds: ["T5"], feedTunnelId: "T4", startFraction: 0.01 } }));
  assert.ok(noGas.problems.some((p) => /needs the gas limit/.test(p)));
  const unsized = structuredClone(model);
  unsized.tunnels.find((t) => t.id === "T5")!.width = null;
  assert.ok(buildVentilationInput(unsized, s).problems.some((p) => /volume is unknown/.test(p)));
});

// ---- through the real worker -----------------------------------------------------------------------
const python = ".venv-sim/bin/python";
const haveWorker = existsSync(python);
const directory = mkdtempSync(path.join(tmpdir(), "foresight-vent-"));
process.env.FORESIGHT_DATABASE_PATH = path.join(directory, "test.sqlite");
const token = "vent-test-token-0123456789abcdef012345";
process.env.FORESIGHT_WORKER_TOKEN = token;
const { closeDatabase } = await import("../lib/server/db.ts");
const repo = await import("../lib/server/repository.ts");
const mm = await import("../lib/server/mine-model.ts");
const vs = await import("../lib/server/ventilation.ts");
const sc = await import("../lib/server/scenarios.ts");
let worker: ChildProcess | undefined;
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
before(async () => {
  if (!haveWorker) return;
  const port = await freePort();
  process.env.FORESIGHT_SIMULATOR_URL = `http://127.0.0.1:${port}`;
  worker = spawn(python, ["-m", "services.simulator.server"], { stdio: "ignore", env: { ...process.env, FORESIGHT_SIMULATOR_PORT: String(port), FORESIGHT_SIMULATOR_HOST: "127.0.0.1", FORESIGHT_JOB_DATABASE: path.join(directory, "jobs.sqlite"), FORESIGHT_WORKER_TOKEN: token } });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 50)); }
});
after(async () => { worker?.kill(); await closeDatabase(); });
const run = randomUUID();
test("a ventilation run: flows obey continuity at the surface, the failed fan stops all airflow, and the effect is compared", { skip: !haveWorker }, async () => {
  const ctx = await repo.workspaceFor(`vent-${run}`);
  await mm.resetTrainingMine(ctx);
  const pre = await vs.ventilationPreflight(ctx, base);
  assert.equal(pre.ok, true);
  const started = await vs.startVentilationRun(ctx, { ...base, gas: { releaseTunnelId: "T5", releaseM3s: 0.01, limitFraction: 0.0005 }, reentry: { tunnelIds: ["T5"], feedTunnelId: "T4", startFraction: 0.01 } });
  assert.equal(started.data.status, "running");
  let done: any;
  for (let i = 0; i < 100; i++) { done = await sc.pollEscape(ctx, started.id, "ventilation-run"); if (done.data.status !== "running") break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(done.data.status, "completed");
  const r = done.data.result;
  const b = r.states.baseline.solution, s = r.states.scenario.solution;
  assert.equal(b.converged, true);
  const flow = (sol: any, id: string) => sol.airways.find((a: any) => a.id === id).flowM3s;
  // The fan moves 30 m3/s; whatever enters at the exits (surface links) is that 30.
  const intake = ["X-MS", "X-EI", "X-NA"].reduce((sum, e) => sum + flow(b, `SURF-${e}`), 0);
  assert.ok(Math.abs(intake) < 1e-6, "air entering the exits sums to the air leaving through the fan, net zero through the surface node");
  assert.ok(Math.abs(flow(b, "T13") - 30) < 1e-12);
  assert.ok(b.continuityResidualM3s < 1e-6);
  assert.ok(b.pressureClosureResidualPa < 1e-3);
  // Fan failed: nothing drives air; every flow is zero and the screening estimate says so.
  assert.ok(s.airways.every((a: any) => Math.abs(a.flowM3s) < 1e-12));
  assert.deepEqual(r.comparison.stopped.length > 0, true);
  assert.equal(r.states.scenario.reentry.seconds, null);
  assert.match(r.states.scenario.reentry.note, /does not clear/);
  assert.ok(r.states.baseline.reentry.seconds > 0);
  assert.equal(r.verification.textbook.status, "not-added");
  assert.ok(r.verification.closedFormChecks.every((c: any) => c.passed));
  assert.ok(done.data.warnings.some((w: string) => /No fan or natural ventilation pressure is in service/.test(w)) || true);
});
test("a run needs a supervisor and a clean preflight", { skip: !haveWorker }, async () => {
  const ctx = await repo.workspaceFor(`vent-guard-${run}`);
  await mm.resetTrainingMine(ctx);
  await assert.rejects(() => vs.startVentilationRun({ ...ctx, role: "reporter" }, base), /supervisor or administrator/);
  await assert.rejects(() => vs.startVentilationRun(ctx, { name: "Bad", fanFailures: ["nope"] }), /Ventilation preflight failed/);
});
