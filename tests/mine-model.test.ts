// Mine model tests (spec §16.1 Mine model): schema, preflight, revisions, zones.
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mineModelSchema, preflight, trainingMineModel, toEscapeNetwork, blocking, type MineModel } from "../lib/domain/mine-model.ts";
const directory = mkdtempSync(path.join(tmpdir(), "foresight-mm-"));
process.env.FORESIGHT_DATABASE_PATH = path.join(directory, "test.sqlite");
const { closeDatabase } = await import("../lib/server/db.ts");
const repo = await import("../lib/server/repository.ts");
const mm = await import("../lib/server/mine-model.ts");
after(async () => closeDatabase());
const clone = (m: MineModel): MineModel => JSON.parse(JSON.stringify(m));
const codes = (m: MineModel) => preflight(m).map((i) => `${i.severity}:${i.code}`);

test("training template is valid, fictional, fully attributed and passes preflight without errors", () => {
  const m = trainingMineModel();
  mineModelSchema.parse(m);
  assert.equal(m.meta.fictional, true);
  const issues = preflight(m);
  assert.deepEqual(blocking(issues), [], JSON.stringify(blocking(issues)));
  assert.ok(!issues.some((i) => i.code === "PROVENANCE_MISSING"));
  assert.equal(m.provenance["P1.capacityM3h"].quality, "assumed");
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, "../fixtures/mine/training-template.json"), "utf8"));
  assert.deepEqual(fixture.escapeNetwork, toEscapeNetwork(trainingMineModel(fixture.model.provenance["P1.capacityM3h"].author, fixture.model.provenance["P1.capacityM3h"].at)));
});
test("preflight flags missing values with the engines they block, never filling them", () => {
  const m = clone(trainingMineModel());
  m.tunnels[0].width = null;
  m.pumps[0].capacityM3h = null;
  m.sumps[0].levelVolume = [{ levelM: 0, volumeM3: 0 }];
  m.units.confirmed = false;
  const issues = preflight(m);
  const width = issues.find((i) => i.code === "MISSING_WIDTH")!;
  assert.deepEqual(width.blocks, ["escape"]);
  assert.deepEqual(issues.find((i) => i.code === "PUMP_CAPACITY")!.blocks, ["flooding"]);
  assert.ok(codes(m).includes("error:SUMP_GEOMETRY"));
  assert.ok(codes(m).includes("error:UNITS_UNCONFIRMED"));
  assert.equal(m.tunnels[0].width, null, "never filled");
});
test("preflight: isolated parts, plan crossings, inconsistent elevation, zone without route, pumps and fans attached", () => {
  const m = clone(trainingMineModel());
  m.junctions.push({ id: "K1", x: 900, y: 900, z: -60 }, { id: "K2", x: 950, y: 900, z: -60 });
  m.tunnels.push({ id: "TK", from: "K1", to: "K2", length: null, width: 2, height: 2, profile: "box", walkable: true, resistance: null });
  m.junctions.push({ id: "C1", x: 90, y: 20, z: -60 }, { id: "C2", x: 90, y: -20, z: -60 });
  m.tunnels.push({ id: "TC", from: "C1", to: "C2", length: null, width: 2, height: 2, profile: "box", walkable: true, resistance: null });
  m.junctions.find((j) => j.id === "J5")!.z = 20;
  m.zones.push({ id: "zone-k", name: "Island", tunnelIds: ["TK"], shaftIds: [] });
  m.pumps.push({ id: "P9", sumpId: "nope", name: "Lost pump", capacityM3h: 10, role: "duty" });
  m.fans.push({ id: "F9", tunnelId: "nope", name: "Lost fan", fixedDutyM3s: null, pressurePa: null, curve: null });
  const c = codes(m);
  for (const code of ["error:ISOLATED_PART", "error:PLAN_CROSSING", "error:ELEVATION_INCONSISTENT", "warning:ZONE_NO_ROUTE", "error:PUMP_SUMP", "error:FAN_AIRWAY"])
    assert.ok(c.includes(code), code + " in " + c.join(","));
  m.sumps.push({ ...m.sumps[0], id: "S2", name: "Second sump" });
  assert.ok(codes(m).includes("warning:STORAGE_UNREVIEWED"));
});
test("revisions: workspace starts with the published template; drafts edit, publish needs clean preflight, published is immutable; zones follow it", async () => {
  const ctx = await repo.workspaceFor("mm-" + randomUUID());
  const first = await mm.publishedModel(ctx);
  assert.equal(first!.data.status, "published");
  assert.deepEqual((await repo.knownZones(ctx)).map((z) => z.id), ["zone-a", "zone-b", "zone-c"]);
  const draft = await mm.createDraft(ctx, "published");
  const model = clone(draft.data.model as MineModel);
  model.tunnels[0].width = null;
  const saved = await mm.saveDraft(ctx, draft.id, { expectedRevision: draft.revision, model });
  await assert.rejects(() => mm.publish(ctx, draft.id, saved.revision), /blocking problem/);
  model.tunnels[0].width = 3.4;
  model.provenance["T1.width"] = { quality: "measured", note: "Tape measure at station", author: "Surveyor", at: new Date().toISOString() };
  model.zones.push({ id: "east-face", name: "East face", tunnelIds: ["T5"], shaftIds: ["east-incline"] });
  const saved2 = await mm.saveDraft(ctx, draft.id, { expectedRevision: saved.revision, model });
  const pub = await mm.publish(ctx, draft.id, saved2.revision);
  assert.equal(pub.data.status, "published");
  assert.equal((await repo.get(ctx, first!.id, "mine-model-revision")).data.status, "superseded");
  await assert.rejects(() => mm.saveDraft(ctx, draft.id, { expectedRevision: pub.revision, model }), /cannot change/);
  assert.ok((await repo.knownZones(ctx)).some((z) => z.id === "east-face"));
  await repo.insert(ctx, "report", { text: "x" }, "east-face");
  await repo.insert(ctx, "report", { text: "legacy zone stays valid" }, "zone-b");
  await assert.rejects(() => mm.createDraft({ ...ctx, role: "reporter" }, "template"), /supervisor or administrator/);
});
test("escape scenarios: preflight blocks missing inputs; an unreachable worker is shown as not run, never as a result", async () => {
  process.env.FORESIGHT_SIMULATOR_URL = "http://127.0.0.1:9";
  const sc = await import("../lib/server/scenarios.ts");
  const ctx = await repo.workspaceFor("esc-" + randomUUID());
  const body = {
    name: "P1 failure",
    template: "pump-failure",
    peopleSource: "current-declarations",
    plannedHeadcount: {},
    startMethod: "spread-along-zone",
    water: { sumpId: "S1", dutyPumpId: "P1", backupPumpId: "P2", failAtMinutes: 0, backupStartMinutes: null, inflowM3h: null, initialVolumeM3: null },
    blockedTunnels: [],
    evacuationOrderMinutes: 95,
    preMovementMinutes: { min: 0, max: 2 },
    speed: { mean: 1, sd: 0.15, min: 0.55, max: 1.45 },
    horizonMinutes: 120,
    seed: 11,
    endurance: { selfRescuerRatedMinutes: 30, refugeConsumptionM3PerPersonHour: null },
  };
  const none = await sc.scenarioPreflight(ctx, body);
  assert.equal(none.ok, false);
  assert.match(none.problems.join(" "), /Nobody is declared underground/);
  await assert.rejects(() => sc.startEscapeRun(ctx, body), /preflight failed/);
  const planned = { ...body, peopleSource: "planned-headcount", plannedHeadcount: { "zone-b": 3 } };
  assert.equal((await sc.scenarioPreflight(ctx, planned)).ok, true);
  const run = await sc.startEscapeRun(ctx, planned);
  assert.equal(run.data.status, "worker-unavailable");
  assert.equal(run.data.result, null);
  assert.equal((run.data.peopleSnapshot as unknown[]).length, 3);
  await assert.rejects(() => sc.startEscapeRun({ ...ctx, role: "reporter" }, planned), /supervisor or administrator/);
  delete process.env.FORESIGHT_SIMULATOR_URL;
});
test("demo reset publishes the training template as a new revision and deletes nothing", async () => {
  const ctx = await repo.workspaceFor("reset-" + randomUUID());
  await repo.insert(ctx, "report", { text: "kept" }, "zone-b");
  const before = (await repo.list(ctx)).length;
  const r = await mm.resetTrainingMine(ctx);
  assert.equal(r.revision, 2);
  const after = await repo.list(ctx);
  assert.ok(after.length > before);
  assert.equal(after.filter((e) => e.kind === "report").length, 1);
  assert.equal((await mm.publishedModel(ctx))!.id, r.revisionId);
});

test("fan curve must have strictly increasing flows; a curve with a duty is warned about", () => {
  const m = structuredClone(trainingMineModel());
  m.fans[0]!.curve = [{ q: 0, p: 300 }, { q: 10, p: 200 }, { q: 10, p: 100 }];
  assert.ok(codes(m).includes("error:FAN_CURVE_ORDER"));
  m.fans[0]!.curve = [{ q: 0, p: 300 }, { q: 40, p: 0 }];
  assert.ok(!codes(m).includes("error:FAN_CURVE_ORDER"));
  assert.ok(codes(m).includes("warning:FAN_CURVE_AND_DUTY"));
});
