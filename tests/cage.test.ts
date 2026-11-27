// Phase 7 server tests: how a cage scenario is built from the published mine
// model and the chosen people source. The SimPy engine itself is tested in
// services/simulator/test_cage.py with hand-calculated times.
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "foresight-cage-"));
process.env.FORESIGHT_DATABASE_PATH = path.join(directory, "test.sqlite");
process.env.FORESIGHT_SIMULATOR_URL = "http://127.0.0.1:9"; // nothing listens: the worker is unreachable
process.env.FORESIGHT_WORKER_TOKEN = "cage-test-token-0123456789abcdef0123";
const { closeDatabase } = await import("../lib/server/db.ts");
const repo = await import("../lib/server/repository.ts");
const cg = await import("../lib/server/cage.ts");
const ci = await import("../lib/server/checkins.ts");
const mm = await import("../lib/server/mine-model.ts");
after(async () => closeDatabase());
const run = randomUUID();
const ws = async (name: string) => {
  const ctx = await repo.workspaceFor(`cage-${run}-${name}`);
  await mm.resetTrainingMine(ctx);
  return ctx;
};
const base = { name: "Hoist failure", shaftExitId: "X-MS", source: "manual" as const, manual: [{ level: "60 m level", count: 10, arriveMinutes: 0 }], outages: [{ fromMinutes: 5, toMinutes: null }] };

test("manual source: counts become people at the entered level with the model's hoist values", async () => {
  const ctx = await ws("manual");
  const b = await cg.buildCageInput(ctx, cg.cageScenarioSchema.parse(base));
  assert.deepEqual(b.problems, []);
  assert.equal(b.people, 10);
  assert.deepEqual(b.input!.shaft, {
    id: "X-MS", name: "Main shaft", cageCapacity: 8, loadingSeconds: 45, unloadSeconds: null, ladderClimbSeconds: 900,
    levels: [{ level: "60 m level", junction: "JMS", tripSeconds: 90 }],
  });
  assert.deepEqual(b.input!.outages, [{ fromSeconds: 300, toSeconds: null }]);
  assert.equal(b.input!.horizonSeconds, 240 * 60);
});
test("cage count is part of the scenario and the engine input (1 to 4)", async () => {
  const ctx = await ws("cages");
  const one = await cg.buildCageInput(ctx, cg.cageScenarioSchema.parse(base));
  assert.equal(one.input!.cageCount, 1);
  const two = await cg.buildCageInput(ctx, cg.cageScenarioSchema.parse({ ...base, cageCount: 2 }));
  assert.equal(two.input!.cageCount, 2);
  for (const bad of [0, 5, 1.5]) assert.throws(() => cg.cageScenarioSchema.parse({ ...base, cageCount: bad }));
});
test("preflight lists blocking problems instead of guessing", async () => {
  const ctx = await ws("preflight");
  assert.match((await cg.cagePreflight(ctx, { ...base, shaftExitId: "X-EI" })).problems[0], /has no hoist entered/);
  assert.match((await cg.cagePreflight(ctx, { ...base, shaftExitId: "nope" })).problems[0], /not in the published model/);
  const wrongLevel = await cg.cagePreflight(ctx, { ...base, manual: [{ level: "999 m level", count: 3, arriveMinutes: 0 }] });
  assert.match(wrongLevel.problems.join(" "), /no trip time/);
  const none = await cg.cagePreflight(ctx, { ...base, source: "declared" });
  assert.match(none.problems.join(" "), /Nobody is declared underground at Main shaft/);
  assert.equal((await cg.cagePreflight(ctx, { ...base, source: "escape-run", escapeRunId: null })).ok, false);
  assert.equal((await cg.cagePreflight(ctx, base)).ok, true);
  assert.throws(() => cg.cageScenarioSchema.parse({ ...base, outages: [{ fromMinutes: 10, toMinutes: 5 }] }), /must end after it starts/);
});
test("declared source: everyone declared at the shaft is placed at the station level; people at other shafts are not", async () => {
  const ctx = await ws("declared");
  const people = [];
  for (const [i, shaft] of [["1", "main-shaft"], ["2", "main-shaft"], ["3", "east-incline"]] as const) {
    const p = await ci.createPerson(ctx, { name: `Miner ${i}`, phone: `+9990000010${i}`, role: "miner", channels: { whatsapp: false, sms: true } });
    await ci.recordConsent(ctx, p.id, "in-person", true, "test consent");
    people.push(await ci.createCheckIn(ctx, { personId: p.id, shaftId: shaft, zoneId: null, expectedReturn: new Date(Date.now() + 3600e3).toISOString(), buddyPersonId: null, method: "manual", declaredBy: "test" }));
  }
  const b = await cg.buildCageInput(ctx, cg.cageScenarioSchema.parse({ ...base, source: "declared", assemblyMinutes: 3 }));
  assert.deepEqual(b.problems, []);
  assert.equal(b.people, 2);
  assert.ok(b.input!.arrivals.every((a) => a.level === "60 m level" && a.atSeconds === 180));
  assert.match((b.notes || []).join(" "), /Declared zones do not say which level/);
});
test("starting a run snapshots the model and people; an unreachable worker is recorded, never faked", async () => {
  const ctx = await ws("start");
  const saved = await cg.startCageRun(ctx, base);
  assert.equal(saved.data.status, "worker-unavailable");
  assert.equal(saved.data.result, null);
  assert.equal((saved.data.peopleSnapshot as unknown[]).length, 10);
  assert.equal((saved.data.shaftInput as { cageCapacity: number }).cageCapacity, 8);
  await assert.rejects(() => cg.startCageRun({ ...ctx, role: "reporter" }, base), /supervisor or administrator/);
  await assert.rejects(() => cg.startCageRun(ctx, { ...base, shaftExitId: "X-EI" }), /Cage scenario preflight failed/);
});
