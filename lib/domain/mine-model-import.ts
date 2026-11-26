// Turns a reviewed DXF proposal (worker output) into a mine model draft.
// Imported values carry "survey-plan" provenance; anything the drawing did not
// supply (width, height, exits, sumps, zones, elevation without a source) stays
// not entered so preflight blocks runs until a person fills it in.
import { mineModelSchema, type MineModel, type Provenance } from "./mine-model.ts";

export type ImportProposal = {
  unit: string;
  factorToMetres: number;
  junctions: { id: string; x: number; y: number; z: number | null }[];
  tunnels: { id: string; from: string; to: string; length: number | null; layer: string; sourceHandle: string }[];
  elevation: { mode: "dxf" | "constant" | "unknown"; constant: number | null };
  warnings: string[];
  stats: Record<string, number>;
};
export function modelFromImport(p: ImportProposal, filename: string, author: string, at: string): MineModel {
  const prov = (quality: Provenance["quality"], note: string): Provenance => ({ quality, note, author, at });
  const model: MineModel = {
    schemaVersion: "mine-model-1",
    meta: {
      name: `Imported: ${filename}`.slice(0, 100),
      fictional: false,
      datum: `DXF coordinates as drawn, converted from ${p.unit} to metres; the drawing's survey datum is not recorded here`,
      source: "dxf",
    },
    units: { length: "m", confirmed: true },
    junctions: p.junctions.map((j) => ({ id: j.id, x: j.x, y: j.y, z: j.z })),
    tunnels: p.tunnels.map((t) => ({
      id: t.id,
      from: t.from,
      to: t.to,
      name: t.layer.slice(0, 60),
      length: t.length,
      width: null,
      height: null,
      profile: "arched" as const,
      walkable: true,
      resistance: null,
    })),
    exits: [],
    refuges: [],
    sumps: [],
    pumps: [],
    fans: [],
    doors: [],
    zones: [],
    storageLinks: { reviewed: false, reviewedBy: null, links: [] },
    provenance: {},
  };
  for (const j of p.junctions) {
    model.provenance[`${j.id}.x`] = prov("survey-plan", "Position from the imported DXF centreline");
    model.provenance[`${j.id}.y`] = prov("survey-plan", "Position from the imported DXF centreline");
    if (j.z !== null)
      model.provenance[`${j.id}.z`] =
        p.elevation.mode === "constant"
          ? prov("assumed", `One constant elevation (${p.elevation.constant} m) was entered for every junction at import; it is not a measurement`)
          : prov("survey-plan", "Elevation from the imported DXF");
  }
  for (const t of p.tunnels)
    if (t.length !== null) model.provenance[`${t.id}.length`] = prov("survey-plan", `Drawn path length on layer ${t.layer} (handle ${t.sourceHandle})`);
  return mineModelSchema.parse(model);
}
