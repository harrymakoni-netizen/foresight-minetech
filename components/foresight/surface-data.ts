// Plan overlays derived from stored base maps and subsidence marks.
import type { PlanBaseMap, PlanMark } from "./mine";
import { rows, type ViewProps } from "./shared";

export function activeBaseMap(data: ViewProps["data"]): PlanBaseMap | null {
  const m = rows(data, "base-map").find((x) => x.data.active && x.data.alignment && x.data.pngFileId);
  if (!m) return null;
  const a = m.data.alignment as { planOriginEasting: number; planOriginNorthing: number; rotationDegrees?: number };
  const b = m.data.bounds as { west: number; south: number; east: number; north: number };
  return { href: `/api/workspace/files/${String(m.data.pngFileId)}`, west: b.west - a.planOriginEasting, east: b.east - a.planOriginEasting, south: b.south - a.planOriginNorthing, north: b.north - a.planOriginNorthing, rotationDegrees: a.rotationDegrees ?? 0 };
}
export function planMarks(data: ViewProps["data"]): PlanMark[] {
  return rows(data, "subsidence-mark")
    .filter((m) => m.data.status === "active")
    .map((m) => ({ id: m.id, x: Number(m.data.x), y: Number(m.data.y), label: String(m.data.description), tone: m.data.zoneId ? ("near" as const) : ("far" as const) }));
}
