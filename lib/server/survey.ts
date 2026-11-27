// Surveyor features (spec 8.3, 8.5): DXF import review, GeoTIFF base maps and
// subsidence marks. The heavy parsing runs in the simulation worker (ezdxf,
// rasterio); this module stores what a person reviewed and nothing is
// published without their confirmations.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError, get, insert, list, update, type Context } from "./repository.ts";
import { worker } from "./simulator.ts";
import { createDraftFromModel, publishedModel } from "./mine-model.ts";
import { newAssessment } from "./concerns.ts";
import { modelFromImport, type ImportProposal } from "../domain/mine-model-import.ts";
import type { MineModel } from "../domain/mine-model.ts";
import { planToMap } from "../domain/basemap-align.ts";

const requireEditor = (ctx: Context) => {
  if (ctx.role !== "supervisor" && ctx.role !== "administrator")
    throw new DomainError(403, "ROLE_REQUIRED", "A supervisor or administrator role is required for surveyor imports and marks.");
};
// Vercel caps a request body at 4.5 MB; these limits keep uploads under it.
export const LIMITS = { dxfBytes: 4_000_000, geotiffBytes: 3_000_000, photoBytes: 2_500_000 };

// ---- stored files (images only; never executed or rendered as HTML) -------------------
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export async function saveFile(ctx: Context, input: { name: string; contentType: string; b64: string; purpose: string }) {
  if (!IMAGE_TYPES.includes(input.contentType)) throw new DomainError(415, "FILE_TYPE", "Only PNG, JPEG or WebP images can be stored.");
  const bytes = Buffer.from(input.b64, "base64");
  const magic = bytes.subarray(0, 4).toString("hex");
  const looksRight = (input.contentType === "image/png" && magic === "89504e47") || (input.contentType === "image/jpeg" && magic.startsWith("ffd8ff")) || (input.contentType === "image/webp" && bytes.subarray(0, 4).toString() === "RIFF");
  if (!looksRight) throw new DomainError(415, "FILE_CONTENT", "The file content is not the image type it claims to be.");
  return await insert(ctx, "file-blob", { name: input.name.slice(0, 120), contentType: input.contentType, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), purpose: input.purpose, base64: input.b64 });
}
export async function readFile(ctx: Context, id: string) {
  const f = await get(ctx, id, "file-blob");
  return { bytes: Buffer.from(String(f.data.base64), "base64"), contentType: String(f.data.contentType) };
}

// ---- generic worker job handling -------------------------------------------------------------
async function submit(ctx: Context, kind: string, input: unknown) {
  const jobId = randomUUID();
  try {
    await worker(ctx, "/jobs", { id: jobId, kind, workspaceId: ctx.workspaceId, input });
    return { jobId, error: null as string | null };
  } catch (e) {
    return { jobId, error: (e as Error).message };
  }
}
async function poll(ctx: Context, jobId: string) {
  try {
    return (await worker(ctx, `/jobs/${jobId}`)) as { status: string; result?: Record<string, unknown> | null; error?: string };
  } catch (e) {
    return { status: "unreachable", error: (e as Error).message };
  }
}

// ---- DXF import -------------------------------------------------------------------------------
export const dxfUploadSchema = z.object({ filename: z.string().trim().min(1).max(160), text: z.string().min(20) }).strict();
export async function startDxfImport(ctx: Context, input: unknown) {
  requireEditor(ctx);
  const b = dxfUploadSchema.parse(input);
  if (Buffer.byteLength(b.text) > LIMITS.dxfBytes) throw new DomainError(413, "SIZE_LIMIT", `DXF files up to ${LIMITS.dxfBytes / 1e6} MB can be imported here. Export only the centreline layers, or split the drawing.`);
  if (!/^\s*0\s*\r?\n\s*SECTION/.test(b.text)) throw new DomainError(422, "NOT_ASCII_DXF", "This is not an ASCII DXF file. Binary DXF and DWG are not supported: export an ASCII DXF.");
  const source = await insert(ctx, "model-import-source", { text: b.text });
  const sub = await submit(ctx, "dxf-inspect", { text: b.text });
  return await insert(
    ctx,
    "model-import",
    { filename: b.filename, size: Buffer.byteLength(b.text), sha256: createHash("sha256").update(b.text).digest("hex"), sourceId: source.id, status: sub.error ? "worker-unavailable" : "inspecting", jobId: sub.jobId, error: sub.error, inspect: null, selection: null, proposal: null, revisionId: null, startedBy: ctx.actor },
    null,
    [{ id: source.id, relation: "source" }],
  );
}
export async function pollImport(ctx: Context, id: string) {
  const imp = await get(ctx, id, "model-import");
  if (!["inspecting", "building"].includes(String(imp.data.status))) return imp;
  const job = await poll(ctx, String(imp.data.jobId));
  if (job.status === "unreachable") return { ...imp, data: { ...imp.data, pollError: job.error } };
  if (job.status === "completed" && job.result) {
    const { status: _s, ...result } = job.result as Record<string, unknown>;
    void _s;
    return await update(ctx, imp, imp.revision, imp.data.status === "inspecting" ? { ...imp.data, status: "inspected", inspect: result } : { ...imp.data, status: "proposed", proposal: result });
  }
  if (["failed", "cancelled"].includes(job.status)) return await update(ctx, imp, imp.revision, { ...imp.data, status: "failed", error: job.error || "The worker could not read the file" });
  return imp;
}
export const dxfSelectionSchema = z
  .object({
    layers: z.array(z.string().min(1).max(255)).min(1).max(100),
    unit: z.enum(["m", "mm", "cm", "ft", "in", "km", "yd"]),
    snapMetres: z.number().min(0).max(5).default(0.1),
    nearMissMetres: z.number().min(0).max(50).default(3),
    elevation: z.object({ mode: z.enum(["dxf", "constant", "unknown"]), constant: z.number().min(-5000).max(5000).nullable().default(null) }).strict(),
    acceptNearMiss: z.array(z.string().max(20)).max(500).default([]),
  })
  .strict()
  .refine((s) => s.nearMissMetres >= s.snapMetres, "The near-miss distance must be at least the snap distance")
  .refine((s) => s.elevation.mode !== "constant" || s.elevation.constant !== null, "Enter the constant elevation");
export async function buildDxfProposal(ctx: Context, id: string, input: unknown) {
  requireEditor(ctx);
  const sel = dxfSelectionSchema.parse(input);
  const imp = await get(ctx, id, "model-import");
  if (!["inspected", "proposed", "failed"].includes(String(imp.data.status)) || (imp.data.status === "failed" && !imp.data.inspect))
    throw new DomainError(409, "IMPORT_STATE", "Wait for the file to be read before choosing layers.");
  const source = await get(ctx, String(imp.data.sourceId), "model-import-source");
  const sub = await submit(ctx, "dxf-build", { text: source.data.text, layers: sel.layers, unit: sel.unit, snapMetres: sel.snapMetres, nearMissMetres: sel.nearMissMetres, elevation: sel.elevation, acceptNearMiss: sel.acceptNearMiss });
  return await update(ctx, imp, imp.revision, { ...imp.data, status: sub.error ? "worker-unavailable" : "building", jobId: sub.jobId, error: sub.error, selection: sel, proposal: null });
}
export const dxfAcceptSchema = z.object({ unitsConfirmed: z.literal(true), elevationsConfirmed: z.literal(true) }).strict();
/** Creates a draft revision from the reviewed proposal. Both confirmations are required and recorded. */
export async function acceptDxfImport(ctx: Context, id: string, input: unknown) {
  requireEditor(ctx);
  dxfAcceptSchema.parse(input);
  const imp = await get(ctx, id, "model-import");
  if (imp.data.status !== "proposed" || !imp.data.proposal) throw new DomainError(409, "IMPORT_STATE", "Review a proposal before creating a draft.");
  const model = modelFromImport(imp.data.proposal as ImportProposal, String(imp.data.filename), ctx.actor, new Date().toISOString());
  const draft = await createDraftFromModel(ctx, model, { importId: imp.id, importConfirmations: { unitsConfirmed: true, elevationsConfirmed: true, by: ctx.actor, at: new Date().toISOString() } });
  await update(ctx, imp, imp.revision, { ...imp.data, status: "accepted", revisionId: draft.id });
  return draft;
}

// ---- GeoTIFF base maps ---------------------------------------------------------------------------
export const baseMapUploadSchema = z.object({ name: z.string().trim().min(3).max(120), filename: z.string().max(160), b64: z.string().min(100), reproject: z.boolean().default(false) }).strict();
export async function uploadBaseMap(ctx: Context, input: unknown) {
  requireEditor(ctx);
  const b = baseMapUploadSchema.parse(input);
  const raw = Buffer.from(b.b64, "base64");
  if (raw.length > LIMITS.geotiffBytes) throw new DomainError(413, "SIZE_LIMIT", `GeoTIFF files up to ${LIMITS.geotiffBytes / 1e6} MB can be uploaded here. Reduce the resolution first, for example gdal_translate -outsize 2000 0.`);
  const magic = raw.subarray(0, 4).toString("hex");
  if (!["49492a00", "4d4d002a", "49492b00", "4d4d002b"].includes(magic)) throw new DomainError(422, "NOT_TIFF", "This is not a TIFF file.");
  const sub = await submit(ctx, "basemap", { b64: b.b64, maxPixels: 1600, reproject: b.reproject });
  return await insert(ctx, "base-map", { name: b.name, filename: b.filename, size: raw.length, sha256: createHash("sha256").update(raw).digest("hex"), status: sub.error ? "worker-unavailable" : "processing", jobId: sub.jobId, error: sub.error, alignment: null, active: false, uploadedBy: ctx.actor, originalKept: false });
}
export async function pollBaseMap(ctx: Context, id: string) {
  const m = await get(ctx, id, "base-map");
  if (m.data.status !== "processing") return m;
  const job = await poll(ctx, String(m.data.jobId));
  if (job.status === "unreachable") return { ...m, data: { ...m.data, pollError: job.error } };
  if (job.status === "completed" && job.result) {
    const { png, status: _s, ...info } = job.result as { png: string } & Record<string, unknown>;
    void _s;
    const file = await saveFile(ctx, { name: `${m.data.name}.png`, contentType: "image/png", b64: png, purpose: "base-map" });
    return await update(ctx, m, m.revision, { ...m.data, ...info, status: "ready", pngFileId: file.id });
  }
  if (["failed", "cancelled"].includes(job.status)) return await update(ctx, m, m.revision, { ...m.data, status: "failed", error: job.error || "The worker could not read the file" });
  return m;
}
export const alignSchema = z.object({ planOriginEasting: z.number().finite(), planOriginNorthing: z.number().finite(), rotationDegrees: z.number().min(-180).max(180).default(0), confirmMetres: z.literal(true) }).strict();
/** The plan's (0, 0) sits at this map coordinate, with the plan grid rotated by rotationDegrees (counter-clockwise from map east); both are in metres. */
export async function alignBaseMap(ctx: Context, id: string, input: unknown) {
  requireEditor(ctx);
  const b = alignSchema.parse(input);
  const m = await get(ctx, id, "base-map");
  if (m.data.status !== "ready") throw new DomainError(409, "NOT_READY", "The base map has not been processed.");
  const bounds = m.data.bounds as { west: number; south: number; east: number; north: number };
  const model = (await publishedModel(ctx))?.data.model as MineModel | undefined;
  const warnings: string[] = [];
  if (model?.junctions.length) {
    const pts = model.junctions.map((j) => planToMap(b, j.x, j.y));
    const inside = pts.filter((p) => p.easting >= bounds.west && p.easting <= bounds.east && p.northing >= bounds.south && p.northing <= bounds.north).length;
    if (inside === 0) warnings.push("With this origin no part of the mine plan falls inside the base map. Check the coordinates.");
    else if (inside < model.junctions.length) warnings.push(`${model.junctions.length - inside} of ${model.junctions.length} junctions fall outside the base map.`);
  }
  for (const other of await list(ctx, "base-map")) if (other.id !== id && other.data.active) await update(ctx, other, other.revision, { ...other.data, active: false });
  return await update(ctx, m, m.revision, { ...m.data, alignment: { planOriginEasting: b.planOriginEasting, planOriginNorthing: b.planOriginNorthing, rotationDegrees: b.rotationDegrees, confirmedMetres: true, by: ctx.actor, at: new Date().toISOString(), warnings }, active: true });
}
export async function setBaseMapActive(ctx: Context, id: string, active: boolean) {
  requireEditor(ctx);
  const m = await get(ctx, id, "base-map");
  if (active && !m.data.alignment) throw new DomainError(409, "NOT_ALIGNED", "Align the base map to the plan before showing it.");
  if (active) for (const other of await list(ctx, "base-map")) if (other.id !== id && other.data.active) await update(ctx, other, other.revision, { ...other.data, active: false });
  return await update(ctx, m, m.revision, { ...m.data, active });
}

// ---- subsidence marks -------------------------------------------------------------------------------
/** Development default: a mark within this many metres (plan distance) of a zone's tunnel counts as near it. Not a validated value. */
export const NEAR_ZONE_METRES = 100;
export function nearestZone(model: MineModel, x: number, y: number) {
  const byId = new Map(model.junctions.map((j) => [j.id, j]));
  let best: { tunnelId: string; distanceM: number } | null = null;
  for (const t of model.tunnels) {
    const a = byId.get(t.from), b = byId.get(t.to);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const k = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
    const d = Math.hypot(a.x + dx * k - x, a.y + dy * k - y);
    if (!best || d < best.distanceM) best = { tunnelId: t.id, distanceM: d };
  }
  if (!best) return { zoneId: null, tunnelId: null, distanceM: null };
  const zone = model.zones.find((z) => z.tunnelIds.includes(best!.tunnelId));
  return { zoneId: best.distanceM <= NEAR_ZONE_METRES && zone ? zone.id : null, tunnelId: best.tunnelId, distanceM: Number(best.distanceM.toFixed(1)) };
}
export const subsidenceSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    description: z.string().trim().min(3).max(500),
    observedAt: z.string().datetime({ offset: true }),
    photo: z.object({ filename: z.string().max(120), contentType: z.string().max(40), b64: z.string().min(20) }).strict().nullable().default(null),
  })
  .strict();
export async function recordSubsidenceMark(ctx: Context, input: unknown) {
  requireEditor(ctx);
  const b = subsidenceSchema.parse(input);
  if (Date.parse(b.observedAt) > Date.now() + 5 * 60e3) throw new DomainError(422, "FUTURE", "A mark cannot be observed in the future.");
  const model = (await publishedModel(ctx))?.data.model as MineModel | undefined;
  if (!model) throw new DomainError(404, "NO_MODEL", "Publish a mine model first so the mark can be placed near a zone.");
  let photoFileId: string | null = null;
  if (b.photo) {
    if (Buffer.from(b.photo.b64, "base64").length > LIMITS.photoBytes) throw new DomainError(413, "SIZE_LIMIT", `Photos up to ${LIMITS.photoBytes / 1e6} MB can be attached.`);
    photoFileId = (await saveFile(ctx, { name: b.photo.filename, contentType: b.photo.contentType, b64: b.photo.b64, purpose: "subsidence-photo" })).id;
  }
  const near = nearestZone(model, b.x, b.y);
  const mark = await insert(
    ctx,
    "subsidence-mark",
    { x: b.x, y: b.y, zoneId: near.zoneId, nearTunnelId: near.tunnelId, distanceM: near.distanceM, nearThresholdM: NEAR_ZONE_METRES, description: b.description, note: `${b.description} (observed ${b.observedAt.slice(0, 10)}, recorded by ${ctx.actor})`, observedAt: b.observedAt, observer: ctx.actor, markedAt: new Date().toISOString(), photoFileId, status: "active" },
    near.zoneId,
    photoFileId ? [{ id: photoFileId, relation: "photo" }] : [],
  );
  // A mark near a zone is evidence for a concern: reassess now.
  if (near.zoneId) await newAssessment(ctx);
  return mark;
}
export async function retractSubsidenceMark(ctx: Context, id: string, reason: string) {
  requireEditor(ctx);
  const m = await get(ctx, id, "subsidence-mark");
  if (m.data.status !== "active") throw new DomainError(409, "NOT_ACTIVE", "This mark is already retracted.");
  const out = await update(ctx, m, m.revision, { ...m.data, status: "retracted", retractedBy: ctx.actor, retractedAt: new Date().toISOString(), retractedReason: reason });
  await newAssessment(ctx);
  return out;
}
