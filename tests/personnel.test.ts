import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

process.env.FORESIGHT_DATABASE_PATH = path.join(mkdtempSync(path.join(tmpdir(), "foresight-personnel-")), "test.sqlite");
process.env.FORESIGHT_PERSONNEL_DEMO = "1";
const { closeDatabase } = await import("../lib/server/db.ts");
const { workspaceFor, list } = await import("../lib/server/repository.ts");
const { acknowledgePersonnelAlert, ingestPersonnel, provisionPersonnelDevice } = await import("../lib/server/personnel.ts");
after(closeDatabase);

test("personnel telemetry scopes identities and keeps late SOS separate from latest location and accountability", async () => {
  const ctx = await workspaceFor(randomUUID());
  const [person] = await list(ctx, "person");
  const initialRoll = await list(ctx, "check-in");
  await provisionPersonnelDevice(ctx, { kind: "receiver", source: "physical", code: "east", zoneId: "zone-b" });
  await provisionPersonnelDevice(ctx, { kind: "receiver", source: "physical", code: "north", zoneId: "zone-a" });
  await provisionPersonnelDevice(ctx, { kind: "wearable", source: "physical", code: "tag", personId: person.id });
  const receipt = new Date();
  const event = {
    mineId: ctx.workspaceId, eventId: "seen", deviceId: "tag", receiverId: "east", type: "observation",
    observedAt: receipt.toISOString(), sequence: 3, rssi: -65, batteryPercent: 84,
  };
  await assert.rejects(ingestPersonnel(ctx, event, "demo", receipt), /Provision/);
  await assert.rejects(ingestPersonnel(ctx, { ...event, mineId: randomUUID() }, "physical", receipt), /different mine/);
  await assert.rejects(ingestPersonnel(ctx, { ...event, batteryPercent: 101 }, "physical", receipt));
  const seen = await ingestPersonnel(ctx, event, "physical", receipt);
  assert.equal(seen.applied, true);
  assert.deepEqual(await ingestPersonnel(ctx, event, "physical", new Date(receipt.getTime() + 1000)), seen);
  await assert.rejects(ingestPersonnel(ctx, { ...event, rssi: -80 }, "physical", receipt), /already used/);

  const sos = { ...event, eventId: "sos", receiverId: "north", type: "sos", sequence: 2,
    observedAt: new Date(receipt.getTime() - 1000).toISOString() };
  assert.equal((await ingestPersonnel(ctx, sos, "physical", receipt)).applied, false);
  await ingestPersonnel(ctx, { ...sos, receiverId: "east" }, "physical", receipt);
  const [alert] = await list(ctx, "personnel-alert");
  assert.equal((await list(ctx, "personnel-alert")).length, 1);
  const tag = (await list(ctx, "personnel-device")).find((d) => d.data.kind === "wearable");
  assert.equal(tag?.data.lastZoneId, "zone-b");
  assert.equal(tag?.data.batteryPercent, 84);
  const acknowledged = await acknowledgePersonnelAlert(ctx, alert.id);
  assert.equal(acknowledged.data.status, "open");
  assert.ok(acknowledged.data.acknowledgedAt);
  assert.deepEqual(await list(ctx, "check-in"), initialRoll);
});
