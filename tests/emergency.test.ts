// Collapse response mode tests (spec §16.1 Emergency).
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const directory = mkdtempSync(path.join(tmpdir(), "foresight-emg-"));
process.env.FORESIGHT_DATABASE_PATH = path.join(directory, "test.sqlite");
process.env.MESSAGING_MODE = "dry-run";
const { closeDatabase } = await import("../lib/server/db.ts");
const repo = await import("../lib/server/repository.ts");
const ci = await import("../lib/server/checkins.ts");
const em = await import("../lib/server/emergency.ts");
after(async () => closeDatabase());
const run = randomUUID();
const hour = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();

async function mine() {
  const ctx = await repo.workspaceFor(`emg-${run}-${randomUUID()}`);
  const buddy = await ci.createPerson(ctx, { name: "Buddy One", phone: "+99900000111", role: "miner" });
  const a = await ci.createPerson(ctx, { name: "Miner A", phone: "+99900000112", role: "miner", nextOfKin: [{ name: "Kin of A", phone: "+99900000113" }] });
  const b = await ci.createPerson(ctx, { name: "Miner B", phone: "+99900000114", role: "miner" });
  const c = await ci.createPerson(ctx, { name: "Miner C", phone: "+99900000115", role: "miner" });
  const d = await ci.createPerson(ctx, { name: "Miner D (checked out)", phone: "+99900000116", role: "miner" });
  for (const p of [a, b, c, d]) await ci.recordConsent(ctx, p.id, "in-person", true, "test");
  const ins = async (p: { id: string }, shaftId: string, buddyPersonId: string | null = null) =>
    ci.createCheckIn(ctx, { personId: p.id, shaftId, zoneId: null, expectedReturn: hour(3), buddyPersonId, method: "manual", declaredBy: "test" });
  const ca = await ins(a, "east-incline", buddy.id);
  await ins(b, "east-incline");
  await ins(c, "main-shaft");
  await ins(d, "east-incline");
  await ci.checkOut(ctx, d.id);
  return { ctx, a, b, c, ca };
}
test("declaration needs a supervisor and explicit confirmation; roll snapshot lists declared people at the shaft only", async () => {
  const { ctx } = await mine();
  await assert.rejects(() => em.declareEmergency(ctx, { shaftId: "east-incline", type: "collapse" }));
  await assert.rejects(() => em.declareEmergency({ ...ctx, role: "reporter" }, { shaftId: "east-incline", type: "collapse", confirmReal: true }), /supervisor or administrator/);
  const started = performance.now();
  const e = await em.declareEmergency(ctx, { shaftId: "east-incline", type: "collapse", confirmReal: true, note: "Fall of ground reported at level 2" });
  const ms = performance.now() - started;
  const snap = e.data.rollSnapshot as { name: string; buddyName: string | null; phoneMasked: string; expectedReturn: string }[];
  assert.deepEqual(snap.map((r) => r.name).sort(), ["Miner A", "Miner B"]);
  assert.equal(snap.find((r) => r.name === "Miner A")!.buddyName, "Buddy One");
  assert.match(snap[0].phoneMasked, /^\+999•••••\d{3}$/);
  assert.deepEqual((e.data.otherShaftsSnapshot as { name: string }[]).map((r) => r.name), ["Miner C"]);
  assert.ok(ms < 2000, `roll produced in ${ms.toFixed(0)} ms`);
  const incident = await repo.get(ctx, String(e.data.incidentId), "case");
  assert.equal(incident.data.source, "declared-emergency");
  assert.equal(incident.data.category, "collapse");
  assert.equal((await repo.list(ctx, "roll-entry")).length, 3);
  await assert.rejects(() => em.declareEmergency(ctx, { shaftId: "east-incline", type: "collapse", confirmReal: true }), /already active/);
  const roll = await em.rescueRoll(ctx, e.id);
  assert.ok(roll.snapshot.some((r: { phone?: string | null }) => r.phone === "+99900000112"), "supervisor roll includes phone");
});
test("one action alerts buddies and next of kin in the current messaging mode and opens a mine-wide muster", async () => {
  const { ctx } = await mine();
  const e = await em.declareEmergency(ctx, { shaftId: "east-incline", type: "flooding", confirmReal: true });
  const r = await em.alertAndMuster(ctx, e.id);
  assert.equal(r.mode, "dry-run");
  assert.deepEqual(r.queued.sort(), ["Buddy One", "Kin of A (next of kin of Miner A) #0"]);
  const again = await em.alertAndMuster(ctx, e.id);
  assert.equal(again.musterId, r.musterId);
  const msgs = (await repo.list(ctx, "message")).filter((m) => m.data.purpose === "emergency");
  assert.equal(msgs.length, 2, "repeat action does not duplicate messages");
  assert.match(String(msgs.find((m) => m.data.templateKey === "emergency.buddy")!.data.text), /emergency \(flooding\) was declared at East incline\. Miner A/);
  const muster = await repo.get(ctx, r.musterId, "muster");
  assert.equal(muster.data.scope, "mine");
  assert.equal((muster.data.members as unknown[]).length, 3);
});
test("rescuers mark people; changes are timestamped, audited and update check-ins; the snapshot never changes", async () => {
  const { ctx, a, ca } = await mine();
  const e = await em.declareEmergency(ctx, { shaftId: "east-incline", type: "collapse", confirmReal: true });
  const entries = await repo.list(ctx, "roll-entry");
  const entryA = entries.find((x) => x.data.personId === a.id)!;
  const entryB = entries.find((x) => x.data.name === "Miner B")!;
  await em.updateRollEntry(ctx, entryA.id, { expectedRevision: entryA.revision, status: "injured", note: "Found at level 1 with leg injury" });
  await em.updateRollEntry(ctx, entryB.id, { expectedRevision: entryB.revision, status: "confirmed-missing", note: "Not found after level 2 search" });
  assert.equal((await repo.get(ctx, ca.id, "check-in")).data.status, "accounted-for");
  const b = (await repo.list(ctx, "check-in")).find((c) => c.data.personName === "Miner B")!;
  assert.equal(b.data.status, "confirmed-missing");
  assert.equal((await repo.list(ctx, "case")).length, 1, "missing person links to the emergency incident, no second incident");
  const after = await repo.get(ctx, e.id, "emergency");
  assert.deepEqual(after.data.rollSnapshot, e.data.rollSnapshot);
  const hist = (await repo.get(ctx, entryA.id, "roll-entry")).data.history as { status: string; actor: string; at: string }[];
  assert.deepEqual(hist.map((h) => h.status), ["unconfirmed", "injured"]);
  assert.ok(hist.every((h) => h.at && h.actor));
  const audit = await repo.auditLog(ctx);
  assert.ok(audit.some((x) => x.entity_id === entryA.id && x.operation === "update:roll-entry"));
  const report = await em.incidentReport(ctx, String(e.data.incidentId));
  const pdf = report.pdf.toString("latin1");
  assert.ok(pdf.startsWith("%PDF-1.4"));
  assert.ok(pdf.trimEnd().endsWith("%%EOF"));
  assert.match(pdf, /Rescue roll at declaration/);
  assert.match(pdf, /Miner B/);
  assert.match(pdf, /injured by/);
  assert.ok(Number(pdf.match(/\/Count (\d+)/)![1]) >= 1);
});
test("no scenario or simulator code path can declare an emergency", () => {
  const root = path.join(import.meta.dirname, "..");
  const files = ["lib/server/simulator.ts", ...readdirSync(path.join(root, "services/simulator")).map((f) => "services/simulator/" + f)];
  for (const f of files.filter((x) => /\.(ts|py)$/.test(x)))
    assert.doesNotMatch(readFileSync(path.join(root, f), "utf8"), /declareEmergency|\/emergencies/, f);
});
