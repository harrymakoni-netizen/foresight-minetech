// Phase 9 server tests: DXF import review, GeoTIFF base maps and subsidence
// marks, through the real simulation worker (ezdxf, rasterio). Skipped when the
// simulation environment (.venv-sim, `npm run setup:sim`) is not installed.
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

const python = ".venv-sim/bin/python";
const haveWorker = existsSync(python);
const directory = mkdtempSync(path.join(tmpdir(), "foresight-survey-"));
process.env.FORESIGHT_DATABASE_PATH = path.join(directory, "test.sqlite");
const token = "survey-test-token-0123456789abcdef0123";
process.env.FORESIGHT_WORKER_TOKEN = token;
const { closeDatabase } = await import("../lib/server/db.ts");
const repo = await import("../lib/server/repository.ts");
const mm = await import("../lib/server/mine-model.ts");
const sv = await import("../lib/server/survey.ts");
let worker: ChildProcess | undefined;
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
before(async () => {
  if (!haveWorker) return;
  const port = await freePort();
  process.env.FORESIGHT_SIMULATOR_URL = `http://127.0.0.1:${port}`;
  worker = spawn(python, ["-m", "services.simulator.server"], { stdio: "ignore", env: { ...process.env, FORESIGHT_SIMULATOR_PORT: String(port), FORESIGHT_SIMULATOR_HOST: "127.0.0.1", FORESIGHT_JOB_DATABASE: path.join(directory, "jobs.sqlite"), FORESIGHT_WORKER_TOKEN: token } });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
});
after(async () => { worker?.kill(); await closeDatabase(); });
const run = randomUUID();
const ws = async (name: string) => {
  const ctx = await repo.workspaceFor(`survey-${run}-${name}`);
  await mm.resetTrainingMine(ctx);
  return ctx;
};
const until = async <T>(fn: () => Promise<T>, done: (v: T) => boolean) => {
  for (let i = 0; i < 100; i++) { const v = await fn(); if (done(v)) return v; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("timed out waiting for the worker");
};
// Minimal ASCII DXF: metres, layer DRIVES with a 100 m drive and a 60 m side drive that ends 0.02 m short, plus a drive 1.5 m from the end.
const dxf = (units: number, lines: [string, number, number, number, number, number?][]) =>
  `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n9\n$INSUNITS\n70\n${units}\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n` +
  lines.map(([layer, x1, y1, x2, y2, z = 0]) => `0\nLINE\n8\n${layer}\n10\n${x1}\n20\n${y1}\n30\n${z}\n11\n${x2}\n21\n${y2}\n31\n${z}\n`).join("") +
  `0\nENDSEC\n0\nEOF\n`;
const drawing = dxf(6, [["DRIVES", 0, 0, 100, 0], ["DRIVES", 100.02, 0, 100.02, 60], ["DRIVES", 100.02, 61.5, 100.02, 90], ["NOTES", 0, 0, 5, 5]]);

test("DXF import: layers and units are read, near misses are proposed not applied, and nothing is published", { skip: !haveWorker }, async () => {
  const ctx = await ws("dxf");
  await assert.rejects(() => sv.startDxfImport({ ...ctx, role: "reporter" }, { filename: "a.dxf", text: drawing }), /supervisor or administrator/);
  await assert.rejects(() => sv.startDxfImport(ctx, { filename: "a.dxf", text: "this is not a dxf file at all, really" }), /not an ASCII DXF/);
  const started = await sv.startDxfImport(ctx, { filename: "mine-level-1.dxf", text: drawing });
  assert.equal(started.data.status, "inspecting");
  const inspected = await until(() => sv.pollImport(ctx, started.id), (e) => e.data.status !== "inspecting");
  assert.equal(inspected.data.status, "inspected");
  const info = inspected.data.inspect as { insunits: { unit: string }; layers: { name: string; supported: number }[] };
  assert.equal(info.insunits.unit, "m");
  assert.deepEqual(info.layers.map((l) => [l.name, l.supported]), [["DRIVES", 3], ["NOTES", 1]]);
  // A unit must be chosen and a bad selection is refused before it reaches the worker.
  await assert.rejects(() => sv.buildDxfProposal(ctx, started.id, { layers: ["DRIVES"], elevation: { mode: "unknown" } }));
  const building = await sv.buildDxfProposal(ctx, started.id, { layers: ["DRIVES"], unit: "m", elevation: { mode: "unknown" } });
  assert.equal(building.data.status, "building");
  const proposed = await until(() => sv.pollImport(ctx, started.id), (e) => e.data.status !== "building");
  assert.equal(proposed.data.status, "proposed");
  const p = proposed.data.proposal as { stats: Record<string, number>; nearMisses: { id: string; distanceM: number }[]; junctions: { z: number | null }[]; components: string[][] };
  assert.equal(p.stats.junctions, 5); // (0,0) (100.01,0) (100.02,60) (100.02,61.5) (100.02,90)
  assert.equal(p.stats.tunnels, 3);
  assert.deepEqual(p.nearMisses.map((n) => n.distanceM), [1.5]);
  assert.equal(p.components.length, 2);
  assert.ok(p.junctions.every((j) => j.z === null), "no elevation was supplied, so none is invented");
  // Accepting the near miss in a second build connects the drive.
  await sv.buildDxfProposal(ctx, started.id, { layers: ["DRIVES"], unit: "m", elevation: { mode: "unknown" }, acceptNearMiss: [p.nearMisses[0].id] });
  const joined = await until(() => sv.pollImport(ctx, started.id), (e) => e.data.status !== "building");
  assert.equal((joined.data.proposal as { components: string[][] }).components.length, 1);
  // Both confirmations are required before a draft exists.
  await assert.rejects(() => sv.acceptDxfImport(ctx, started.id, { unitsConfirmed: true }));
  await assert.rejects(() => sv.acceptDxfImport(ctx, started.id, { unitsConfirmed: true, elevationsConfirmed: false }));
  const before = (await repo.list(ctx, "mine-model-revision")).length;
  const draft = await sv.acceptDxfImport(ctx, started.id, { unitsConfirmed: true, elevationsConfirmed: true });
  assert.equal((await repo.list(ctx, "mine-model-revision")).length, before + 1);
  assert.equal(draft.data.status, "draft");
  const model = draft.data.model as import("../lib/domain/mine-model.ts").MineModel;
  assert.equal(model.meta.source, "dxf");
  assert.equal(model.units.confirmed, true);
  assert.equal(model.junctions.length, 4);
  assert.ok(model.junctions.every((j) => j.z === null));
  assert.equal(model.provenance["J1.x"].quality, "survey-plan");
  assert.equal(model.tunnels[0].width, null, "width was not in the drawing and stays not entered");
  assert.deepEqual((draft.data.importConfirmations as { unitsConfirmed: boolean }).unitsConfirmed, true);
  // The draft cannot be published until it has exits, zones and the rest.
  await assert.rejects(() => mm.publish(ctx, draft.id, draft.revision), /blocking problem/);
  assert.notEqual((await mm.publishedModel(ctx))!.id, draft.id, "the imported draft is not published; the training model stays published");
});
test("DXF import: unit choice changes the geometry and elevation modes are honest", { skip: !haveWorker }, async () => {
  const ctx = await ws("dxf-units");
  // Elevations are in drawing units too: -60000 mm = -60 m.
  const text = dxf(4, [["L", 0, 0, 12000, 0, -60000], ["L", 12000, 0, 12000, 5000, -62000]]);
  const imp = await sv.startDxfImport(ctx, { filename: "mm.dxf", text });
  await until(() => sv.pollImport(ctx, imp.id), (e) => e.data.status === "inspected");
  const insp = (await repo.get(ctx, imp.id, "model-import")).data.inspect as { insunits: { unit: string }; layers: { hasZ: boolean }[] };
  assert.equal(insp.insunits.unit, "mm");
  assert.equal(insp.layers[0].hasZ, true);
  await sv.buildDxfProposal(ctx, imp.id, { layers: ["L"], unit: "mm", elevation: { mode: "dxf" } });
  const done = await until(() => sv.pollImport(ctx, imp.id), (e) => e.data.status === "proposed");
  const p = done.data.proposal as { junctions: { x: number; y: number; z: number }[] };
  assert.deepEqual(p.junctions.map((j) => [j.x, j.y, j.z]).sort(), [[0, 0, -60], [12, 0, -61], [12, 5, -62]].sort());
  await sv.buildDxfProposal(ctx, imp.id, { layers: ["L"], unit: "mm", elevation: { mode: "constant", constant: -45 } });
  const constant = await until(() => sv.pollImport(ctx, imp.id), (e) => e.data.status === "proposed");
  const draft = await sv.acceptDxfImport(ctx, imp.id, { unitsConfirmed: true, elevationsConfirmed: true });
  assert.ok((constant.data.proposal as { junctions: { z: number }[] }).junctions.every((j) => j.z === -45));
  assert.equal((draft.data.model as import("../lib/domain/mine-model.ts").MineModel).provenance["J1.z"].quality, "assumed", "a constant elevation is an assumption, not a survey value");
});
test("worker problems are reported, not hidden", { skip: !haveWorker }, async () => {
  const ctx = await ws("dxf-bad");
  // Looks like DXF to the sniff test but cannot be read.
  const revisions = (await repo.list(ctx, "mine-model-revision")).length;
  const imp = await sv.startDxfImport(ctx, { filename: "bad.dxf", text: "0\nSECTION\n2\nENTITIES\n0\nLINE\nthis is garbage garbage garbage\n" });
  const failed = await until(() => sv.pollImport(ctx, imp.id), (e) => e.data.status !== "inspecting");
  assert.equal(failed.data.status, "failed");
  assert.match(String(failed.data.error), /not a readable|DXF/i);
  assert.equal((await repo.list(ctx, "mine-model-revision")).length, revisions, "no draft was created");
});

test("base map: bounds and pixel size come from the file; alignment and metres must be confirmed; one is active at a time", { skip: !haveWorker }, async () => {
  const ctx = await ws("basemap");
  const b64 = readFileSync("tests/fixtures/orthophoto-utm36s.tif").toString("base64");
  await assert.rejects(() => sv.uploadBaseMap(ctx, { name: "Not a tiff", filename: "x.tif", b64: Buffer.from("definitely not a tiff, just text".repeat(10)).toString("base64") }), /not a TIFF/);
  const up = await sv.uploadBaseMap(ctx, { name: "Orthophoto 2026-11", filename: "ortho.tif", b64 });
  assert.equal(up.data.status, "processing");
  assert.equal(up.data.originalKept, false);
  const ready = await until(() => sv.pollBaseMap(ctx, up.id), (e) => e.data.status !== "processing");
  assert.equal(ready.data.status, "ready");
  assert.deepEqual(ready.data.bounds, { west: 310000, south: 8000000, east: 310300, north: 8000200 });
  assert.deepEqual(ready.data.pixelSizeM, [5, 5]);
  assert.equal(ready.data.epsg, 32736);
  const png = await sv.readFile(ctx, String(ready.data.pngFileId));
  assert.equal(png.contentType, "image/png");
  assert.equal(png.bytes.subarray(1, 4).toString(), "PNG");
  await assert.rejects(() => sv.setBaseMapActive(ctx, up.id, true), /Align the base map/);
  await assert.rejects(() => sv.alignBaseMap(ctx, up.id, { planOriginEasting: 310000, planOriginNorthing: 8000000 }));
  // Origin far from the map: no junction falls inside, and the person is told.
  const far = await sv.alignBaseMap(ctx, up.id, { planOriginEasting: 500000, planOriginNorthing: 8500000, confirmMetres: true });
  assert.match((far.data.alignment as { warnings: string[] }).warnings.join(" "), /no part of the mine plan falls inside/);
  // Training mine spans x 0..420, y -100..180: this origin covers most of it with the 300 x 200 m map.
  const aligned = await sv.alignBaseMap(ctx, up.id, { planOriginEasting: 310000, planOriginNorthing: 8000100, confirmMetres: true });
  assert.equal(aligned.data.active, true);
  assert.match((aligned.data.alignment as { warnings: string[] }).warnings.join(" "), /fall outside the base map/);
  const second = await sv.uploadBaseMap(ctx, { name: "Second", filename: "b.tif", b64 });
  await until(() => sv.pollBaseMap(ctx, second.id), (e) => e.data.status === "ready");
  await sv.alignBaseMap(ctx, second.id, { planOriginEasting: 310000, planOriginNorthing: 8000100, confirmMetres: true });
  assert.equal((await repo.get(ctx, up.id, "base-map")).data.active, false, "only one base map is shown");
});

// ---- subsidence marks ------------------------------------------------------------------------
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==";
const observedAt = () => new Date(Date.now() - 3600e3).toISOString();
test("subsidence marks: placed near a zone they become evidence for a concern; far away they are only recorded", async () => {
  const ctx = await ws("marks");
  // The training mine's East drive T4 (zone-b) runs from (180,0) to (240,0).
  const near = sv.nearestZone((await mm.publishedModel(ctx))!.data.model as import("../lib/domain/mine-model.ts").MineModel, 200, 20);
  assert.deepEqual(near, { zoneId: "zone-b", tunnelId: "T4", distanceM: 20 });
  const mark = await sv.recordSubsidenceMark(ctx, { x: 200, y: 20, description: "Open crack 2 m long above the East drive", observedAt: observedAt(), photo: { filename: "crack.png", contentType: "image/png", b64: PNG_1X1 } });
  assert.equal(mark.data.zoneId, "zone-b");
  assert.equal(mark.data.status, "active");
  assert.ok(mark.data.photoFileId);
  assert.equal((await sv.readFile(ctx, String(mark.data.photoFileId))).contentType, "image/png");
  const concern = ((await repo.list(ctx, "assessment"))[0].data.concerns as any[]).find((c) => c.id === `subsidence-${mark.id}`);
  assert.ok(concern, "the mark raised a concern");
  assert.equal(concern.priority, "review");
  assert.equal(concern.zoneId, "zone-b");
  assert.deepEqual(concern.rules, ["subsidence-mark"]);
  assert.match(concern.reason, /Open crack 2 m long/);
  const farMark = await sv.recordSubsidenceMark(ctx, { x: 5000, y: 5000, description: "Settlement far from the workings", observedAt: observedAt() });
  assert.equal(farMark.data.zoneId, null);
  assert.equal(Number(farMark.data.distanceM) > 100, true);
  assert.equal(((await repo.list(ctx, "assessment"))[0].data.concerns as any[]).some((c) => c.id === `subsidence-${farMark.id}`), false);
  await sv.retractSubsidenceMark(ctx, mark.id, "Checked: old shrinkage crack");
  assert.equal(((await repo.list(ctx, "assessment"))[0].data.concerns as any[]).some((c) => c.id === `subsidence-${mark.id}`), false);
  await assert.rejects(() => sv.retractSubsidenceMark(ctx, mark.id, "again"), /already retracted/);
});
test("subsidence marks: roles, photo type and content, future dates", async () => {
  const ctx = await ws("marks-guard");
  const base = { x: 200, y: 20, description: "Crack above the drive", observedAt: observedAt() };
  await assert.rejects(() => sv.recordSubsidenceMark({ ...ctx, role: "reporter" }, base), /supervisor or administrator/);
  await assert.rejects(() => sv.recordSubsidenceMark(ctx, { ...base, observedAt: new Date(Date.now() + 86400e3).toISOString() }), /future/);
  await assert.rejects(() => sv.recordSubsidenceMark(ctx, { ...base, photo: { filename: "a.svg", contentType: "image/svg+xml", b64: Buffer.from("<svg onload=alert(1)/>").toString("base64") } }), /Only PNG, JPEG or WebP/);
  await assert.rejects(() => sv.recordSubsidenceMark(ctx, { ...base, photo: { filename: "fake.png", contentType: "image/png", b64: Buffer.from("<html><script>alert(1)</script></html>").toString("base64") } }), /not the image type/);
  assert.equal((await repo.list(ctx, "subsidence-mark")).length, 0);
});

test("base map: a degrees file is refused unless reprojection is chosen; reprojected maps report it; rotation changes what falls inside", { skip: !haveWorker }, async () => {
  const ctx = await ws("basemap-reproject");
  const b64 = readFileSync("tests/fixtures/orthophoto-wgs84.tif").toString("base64");
  const refused = await sv.uploadBaseMap(ctx, { name: "WGS84 orthophoto", filename: "w.tif", b64 });
  const failed = await until(() => sv.pollBaseMap(ctx, refused.id), (e) => e.data.status !== "processing");
  assert.equal(failed.data.status, "failed");
  assert.match(String(failed.data.error), /degrees/);
  const up = await sv.uploadBaseMap(ctx, { name: "WGS84 reprojected", filename: "w.tif", b64, reproject: true });
  const ready = await until(() => sv.pollBaseMap(ctx, up.id), (e) => e.data.status !== "processing");
  assert.equal(ready.data.status, "ready");
  assert.equal(ready.data.epsg, 32736);
  assert.equal((ready.data.reprojected as { from: string; to: string }).from, "EPSG:4326");
  assert.equal((ready.data.reprojected as { to: string }).to, "EPSG:32736");
  assert.match(String((ready.data.reprojected as { note: string }).note), /resampled/);
  // Alignment: JMS at plan (0, 0) is always at the origin. Put the origin at the middle of the map and count junctions by hand.
  const b = ready.data.bounds as { west: number; south: number; east: number; north: number };
  // Origin 50 m inside the west edge, halfway up: the plan runs east from it, or west when turned 180 degrees.
  const E0 = b.west + 50, N0 = (b.south + b.north) / 2;
  const model = (await mm.publishedModel(ctx))!.data.model as import("../lib/domain/mine-model.ts").MineModel;
  const countInside = (deg: number) => {
    const t = (deg * Math.PI) / 180;
    return model.junctions.filter((j) => {
      const e = E0 + j.x * Math.cos(t) - j.y * Math.sin(t), n = N0 + j.x * Math.sin(t) + j.y * Math.cos(t);
      return e >= b.west && e <= b.east && n >= b.south && n <= b.north;
    }).length;
  };
  for (const deg of [0, 180]) {
    const aligned = await sv.alignBaseMap(ctx, up.id, { planOriginEasting: E0, planOriginNorthing: N0, rotationDegrees: deg, confirmMetres: true });
    assert.equal((aligned.data.alignment as { rotationDegrees: number }).rotationDegrees, deg);
    const outside = model.junctions.length - countInside(deg);
    const w = (aligned.data.alignment as { warnings: string[] }).warnings.join(" ");
    if (outside === 0) assert.equal(w, "");
    else assert.match(w, new RegExp(`${outside} of ${model.junctions.length} junctions fall outside`));
  }
  assert.equal(countInside(0), model.junctions.length);
  assert.ok(countInside(180) < model.junctions.length);
  assert.notEqual(countInside(0), countInside(180), "the rotation changes which junctions are inside the picture");
  await assert.rejects(() => sv.alignBaseMap(ctx, up.id, { planOriginEasting: E0, planOriginNorthing: N0, rotationDegrees: 200, confirmMetres: true }));
});
