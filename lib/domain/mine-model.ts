// Mine model (spec §8): a tunnel network, not a video reconstruction. Every
// entered value carries provenance in `provenance["<elementId>.<field>"]`.
// "Not measured" is null, never zero; missing values block the engines that
// need them. Shared by the server, the browser editor and the scenario engines.
import { z } from "zod";

export const quality = z.enum(["measured", "survey-plan", "assumed", "default"]);
export type Quality = z.infer<typeof quality>;
export const provenanceSchema = z
  .object({ quality, note: z.string().max(300), author: z.string().max(100), at: z.string().max(40) })
  .strict();
export type Provenance = z.infer<typeof provenanceSchema>;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const num = (min: number, max: number) => z.number().finite().min(min).max(max).nullable();
export const mineModelSchema = z
  .object({
    schemaVersion: z.literal("mine-model-1"),
    meta: z
      .object({
        name: z.string().min(2).max(100),
        fictional: z.boolean(),
        datum: z.string().max(200),
        source: z.enum(["template", "editor", "dxf"]),
      })
      .strict(),
    units: z.object({ length: z.literal("m"), confirmed: z.boolean() }).strict(),
    junctions: z.array(z.object({ id, x: z.number().finite(), y: z.number().finite(), z: num(-5000, 5000), name: z.string().max(60).optional() }).strict()).max(2000),
    tunnels: z
      .array(
        z
          .object({
            id,
            from: id,
            to: id,
            name: z.string().max(60).optional(),
            length: num(0.1, 20000),
            width: num(0.3, 50),
            height: num(0.3, 50),
            profile: z.enum(["box", "arched"]),
            walkable: z.boolean(),
            resistance: num(0, 1e6),
          })
          .strict(),
      )
      .max(4000),
    exits: z
      .array(
        z
          .object({
            id,
            junction: id,
            name: z.string().max(60),
            kind: z.enum(["shaft", "adit", "incline", "portal"]),
            shaftId: z.string().max(64).nullable(),
            usableForEscape: z.boolean(),
            hoist: z
              .object({
                cageCapacity: num(1, 200),
                loadingSeconds: num(0, 3600),
                tripSecondsByLevel: z.array(z.object({ level: z.string().max(40), junction: id, seconds: z.number().min(1).max(7200) }).strict()).max(50),
              })
              .strict()
              .nullable(),
            ladderClimbSeconds: num(1, 36000),
          })
          .strict(),
      )
      .max(50),
    refuges: z.array(z.object({ id, junction: id, name: z.string().max(60), capacity: num(0, 1000), airSupplyM3: num(0, 1e6) }).strict()).max(100),
    sumps: z
      .array(
        z
          .object({
            id,
            junction: id,
            name: z.string().max(60),
            levelVolume: z.array(z.object({ levelM: z.number().min(0).max(1000), volumeM3: z.number().min(0).max(1e8) }).strict()).max(50),
            dangerLevelM: num(0, 1000),
            initialVolumeM3: num(0, 1e8),
            inflowM3h: num(0, 1e6),
            closesTunnelIds: z.array(id).max(50),
          })
          .strict(),
      )
      .max(50),
    pumps: z.array(z.object({ id, sumpId: id, name: z.string().max(60), capacityM3h: num(0, 1e5), role: z.enum(["duty", "backup"]) }).strict()).max(100),
    fans: z.array(z.object({ id, tunnelId: id, name: z.string().max(60), fixedDutyM3s: num(0, 1e4), pressurePa: num(0, 1e5) }).strict()).max(50),
    doors: z.array(z.object({ id, tunnelId: id, name: z.string().max(60), open: z.boolean(), resistance: num(0, 1e6) }).strict()).max(200),
    zones: z.array(z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), name: z.string().min(1).max(60), tunnelIds: z.array(id).max(500), shaftIds: z.array(z.string().max(64)).max(20) }).strict()).max(100),
    storageLinks: z
      .object({ reviewed: z.boolean(), reviewedBy: z.string().max(100).nullable(), links: z.array(z.object({ fromSumpId: id, toSumpId: id, note: z.string().max(300) }).strict()).max(100) })
      .strict(),
    provenance: z.record(z.string().max(140), provenanceSchema),
  })
  .strict();
export type MineModel = z.infer<typeof mineModelSchema>;
export type Tunnel = MineModel["tunnels"][number];

export const planLength = (m: MineModel, t: Tunnel) => {
  const a = m.junctions.find((j) => j.id === t.from), b = m.junctions.find((j) => j.id === t.to);
  if (!a || !b) return null;
  const dz = a.z !== null && b.z !== null ? b.z - a.z : 0;
  return Math.hypot(b.x - a.x, b.y - a.y, dz);
};
export const tunnelLength = (m: MineModel, t: Tunnel) => t.length ?? planLength(m, t);

// ---- preflight (spec §8.4) ---------------------------------------------------------
export type Engine = "escape" | "flooding" | "routes" | "cage" | "ventilation";
export type Issue = { severity: "error" | "warning"; code: string; message: string; elementId?: string; blocks: Engine[] };
function components(m: MineModel, tunnelOk: (t: Tunnel) => boolean) {
  const parent = new Map(m.junctions.map((j) => [j.id, j.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  for (const t of m.tunnels) if (tunnelOk(t) && parent.has(t.from) && parent.has(t.to)) parent.set(find(t.from), find(t.to));
  return find;
}
function segmentsCross(p1: number[], p2: number[], p3: number[], p4: number[]) {
  const d = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
export function preflight(m: MineModel): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Issue["severity"], code: string, message: string, blocks: Engine[], elementId?: string) => issues.push({ severity, code, message, blocks, elementId });
  const jIds = new Set(m.junctions.map((j) => j.id));
  const tIds = new Set(m.tunnels.map((t) => t.id));
  const dup = (list: { id: string }[], label: string) => {
    const seen = new Set<string>();
    for (const x of list) {
      if (seen.has(x.id)) add("error", "DUPLICATE_ID", `${label} id ${x.id} is used twice.`, ["escape", "routes", "flooding"], x.id);
      seen.add(x.id);
    }
  };
  dup(m.junctions, "Junction");
  dup(m.tunnels, "Tunnel");
  if (!m.units.confirmed) add("error", "UNITS_UNCONFIRMED", "Units are not confirmed. Confirm that coordinates and sizes are in metres.", ["escape", "routes", "flooding", "cage", "ventilation"]);
  for (const t of m.tunnels) {
    if (!jIds.has(t.from) || !jIds.has(t.to)) add("error", "TUNNEL_ENDPOINT", `Tunnel ${t.id} is not connected to known junctions.`, ["escape", "routes"], t.id);
    if (t.from === t.to) add("error", "TUNNEL_LOOP", `Tunnel ${t.id} starts and ends at the same junction.`, ["escape", "routes"], t.id);
    if (t.walkable && t.width === null) add("error", "MISSING_WIDTH", `Tunnel ${t.id} width is not entered.`, ["escape"], t.id);
    if (t.height === null) add("warning", "MISSING_HEIGHT", `Tunnel ${t.id} height is not entered (3D view uses no height).`, ["ventilation"], t.id);
    if (t.resistance === null) add("warning", "MISSING_RESISTANCE", `Tunnel ${t.id} airway resistance is not entered.`, ["ventilation"], t.id);
    const a = m.junctions.find((j) => j.id === t.from), b = m.junctions.find((j) => j.id === t.to);
    if (a && b) {
      if (a.z === null || b.z === null) add("warning", "MISSING_ELEVATION", `Tunnel ${t.id} has a junction without elevation.`, ["flooding", "cage"], t.id);
      else {
        const plan = Math.hypot(b.x - a.x, b.y - a.y);
        const slope = plan > 0 ? Math.abs(b.z - a.z) / plan : Infinity;
        if (slope > 0.6) add("error", "ELEVATION_INCONSISTENT", `Tunnel ${t.id} rises ${Math.abs(b.z - a.z).toFixed(1)} m over ${plan.toFixed(1)} m plan length (> 60%). Check elevations or model it as a shaft.`, ["escape", "routes"], t.id);
        else if (t.walkable && slope > 0.35) add("warning", "STEEP_WALKWAY", `Tunnel ${t.id} slopes ${(slope * 100).toFixed(0)}%: assumed walking speeds may be optimistic.`, [], t.id);
      }
      if (t.length !== null) {
        const p = planLength(m, t)!;
        if (Math.abs(t.length - p) / p > 0.25) add("warning", "LENGTH_MISMATCH", `Tunnel ${t.id} entered length ${t.length} m differs from its geometry (${p.toFixed(1)} m) by more than 25%.`, [], t.id);
      }
    }
  }
  // Plan crossings without a shared junction would merge walkable areas in 2-D.
  const walk = m.tunnels.filter((t) => t.walkable && jIds.has(t.from) && jIds.has(t.to));
  const xy = (jid: string) => { const j = m.junctions.find((x) => x.id === jid)!; return [j.x, j.y]; };
  for (let i = 0; i < walk.length; i++)
    for (let k = i + 1; k < walk.length; k++) {
      const s = walk[i], u = walk[k];
      if (new Set([s.from, s.to, u.from, u.to]).size < 4) continue;
      if (segmentsCross(xy(s.from), xy(s.to), xy(u.from), xy(u.to)))
        add("error", "PLAN_CROSSING", `Tunnels ${s.id} and ${u.id} cross in plan without a junction. If they are on different levels, the 2-D escape engine cannot model them together.`, ["escape"], s.id);
    }
  // Connectivity.
  const find = components(m, (t) => true);
  const roots = new Map<string, string[]>();
  for (const j of m.junctions) roots.set(find(j.id), [...(roots.get(find(j.id)) || []), j.id]);
  if (roots.size > 1)
    for (const [, members] of [...roots.entries()].sort((a, b) => a[1].length - b[1].length).slice(0, roots.size - 1))
      add("error", "ISOLATED_PART", `Isolated part not connected to the rest of the network: ${members.slice(0, 8).join(", ")}${members.length > 8 ? "…" : ""}.`, ["escape", "routes"], members[0]);
  const walkFind = components(m, (t) => t.walkable);
  const targets = [...m.exits.filter((e) => e.usableForEscape).map((e) => e.junction), ...m.refuges.map((r) => r.junction)];
  if (!targets.length) add("error", "NO_EXIT", "No usable exit or refuge is defined.", ["escape", "routes"]);
  for (const e of m.exits) if (!jIds.has(e.junction)) add("error", "EXIT_JUNCTION", `Exit ${e.name} is not on a known junction.`, ["escape", "routes"], e.id);
  for (const r of m.refuges) {
    if (!jIds.has(r.junction)) add("error", "REFUGE_JUNCTION", `Refuge ${r.name} is not on a known junction.`, ["escape"], r.id);
    if (r.capacity === null) add("error", "REFUGE_CAPACITY", `Refuge ${r.name} capacity is not entered.`, ["escape"], r.id);
    if (r.airSupplyM3 === null) add("warning", "REFUGE_AIR", `Refuge ${r.name} air supply is not entered; endurance check unavailable.`, [], r.id);
  }
  for (const z of m.zones) {
    const missing = z.tunnelIds.filter((t) => !tIds.has(t));
    if (missing.length) add("error", "ZONE_TUNNEL", `Zone ${z.name} lists unknown tunnels ${missing.join(", ")}.`, ["escape"], z.id);
    const zoneTunnels = m.tunnels.filter((t) => z.tunnelIds.includes(t.id) && t.walkable);
    if (!zoneTunnels.length) {
      add("error", "ZONE_EMPTY", `Zone ${z.name} has no walkable tunnel.`, ["escape"], z.id);
      continue;
    }
    if (!zoneTunnels.some((t) => targets.some((j) => walkFind(j) === walkFind(t.from))))
      add("warning", "ZONE_NO_ROUTE", `Zone ${z.name} has no walkable route to any exit or refuge.`, [], z.id);
  }
  // Water.
  const sumpIds = new Set(m.sumps.map((s) => s.id));
  for (const p of m.pumps) {
    if (!sumpIds.has(p.sumpId)) add("error", "PUMP_SUMP", `Pump ${p.name} is not attached to a known sump.`, ["flooding"], p.id);
    if (p.capacityM3h === null) add("error", "PUMP_CAPACITY", `Pump ${p.name} effective capacity is not entered.`, ["flooding"], p.id);
  }
  for (const s of m.sumps) {
    if (!jIds.has(s.junction)) add("error", "SUMP_JUNCTION", `Sump ${s.name} is not on a known junction.`, ["flooding"], s.id);
    const lv = s.levelVolume;
    if (lv.length < 2) add("error", "SUMP_GEOMETRY", `Sump ${s.name} needs a level–volume table with at least two rows.`, ["flooding"], s.id);
    else if (lv.some((r, i) => i > 0 && (r.levelM <= lv[i - 1].levelM || r.volumeM3 <= lv[i - 1].volumeM3)))
      add("error", "SUMP_GEOMETRY_ORDER", `Sump ${s.name} level–volume rows must increase in both level and volume.`, ["flooding"], s.id);
    if (s.dangerLevelM === null) add("error", "SUMP_DANGER", `Sump ${s.name} danger level is not entered.`, ["flooding"], s.id);
    if (s.inflowM3h === null) add("warning", "SUMP_INFLOW", `Sump ${s.name} inflow is not entered; scenarios must supply it.`, ["flooding"], s.id);
    if (s.initialVolumeM3 === null) add("warning", "SUMP_INITIAL", `Sump ${s.name} starting volume is not entered; scenarios must supply it.`, ["flooding"], s.id);
    for (const t of s.closesTunnelIds) if (!tIds.has(t)) add("error", "SUMP_CLOSES", `Sump ${s.name} closes unknown tunnel ${t}.`, ["flooding", "escape"], s.id);
    if (!m.pumps.some((p) => p.sumpId === s.id)) add("warning", "SUMP_NO_PUMP", `Sump ${s.name} has no pump.`, [], s.id);
  }
  if (m.sumps.length > 1 && !m.storageLinks.reviewed)
    add("warning", "STORAGE_UNREVIEWED", "More than one sump, but storage links are not reviewed: flooding is shown for single sumps only.", [], undefined);
  for (const f of m.fans) if (!tIds.has(f.tunnelId)) add("error", "FAN_AIRWAY", `Fan ${f.name} is not on a known airway.`, ["ventilation"], f.id);
  for (const d of m.doors) if (!tIds.has(d.tunnelId)) add("error", "DOOR_AIRWAY", `Door ${d.name} is not on a known airway.`, ["ventilation"], d.id);
  for (const e of m.exits)
    if (e.kind === "shaft" && e.usableForEscape && !e.hoist && e.ladderClimbSeconds === null)
      add("warning", "SHAFT_EGRESS", `Shaft ${e.name} has neither hoist data nor a ladder climb time.`, ["cage"], e.id);
  // Provenance: every numeric value should say where it came from.
  const unattributed = valuePaths(m).filter((p) => !m.provenance[p]);
  if (unattributed.length)
    add("warning", "PROVENANCE_MISSING", `${unattributed.length} values have no recorded provenance (treated as defaults), e.g. ${unattributed.slice(0, 3).join(", ")}.`, []);
  return issues;
}
export function valuePaths(m: MineModel) {
  const out: string[] = [];
  for (const j of m.junctions) out.push(`${j.id}.x`, `${j.id}.y`, ...(j.z !== null ? [`${j.id}.z`] : []));
  for (const t of m.tunnels) for (const f of ["width", "height", "length", "resistance"] as const) if (t[f] !== null) out.push(`${t.id}.${f}`);
  for (const p of m.pumps) if (p.capacityM3h !== null) out.push(`${p.id}.capacityM3h`);
  for (const s of m.sumps) for (const f of ["dangerLevelM", "inflowM3h", "initialVolumeM3"] as const) if (s[f] !== null) out.push(`${s.id}.${f}`);
  for (const s of m.sumps) if (s.levelVolume.length) out.push(`${s.id}.levelVolume`);
  for (const r of m.refuges) for (const f of ["capacity", "airSupplyM3"] as const) if (r[f] !== null) out.push(`${r.id}.${f}`);
  for (const f of m.fans) if (f.fixedDutyM3s !== null) out.push(`${f.id}.fixedDutyM3s`);
  for (const d of m.doors) if (d.resistance !== null) out.push(`${d.id}.resistance`);
  return out;
}
export const blocking = (issues: Issue[], engine?: Engine) =>
  issues.filter((i) => i.severity === "error" && (!engine || i.blocks.includes(engine)));

// ---- conversion for the escape engine ------------------------------------------------
export function toEscapeNetwork(m: MineModel) {
  return {
    junctions: m.junctions.map((j) => ({ id: j.id, x: j.x, y: j.y })),
    tunnels: m.tunnels.map((t) => ({ id: t.id, from: t.from, to: t.to, width: t.width, walkable: t.walkable })),
    exits: m.exits.map((e) => ({ id: e.id, junction: e.junction, kind: e.kind, usableForEscape: e.usableForEscape })),
    refuges: m.refuges.map((r) => ({ id: r.id, junction: r.junction, capacity: r.capacity })),
    zones: m.zones.map((z) => ({ id: z.id, name: z.name, tunnelIds: z.tunnelIds })),
  };
}

// ---- training template (fictional) ---------------------------------------------------
export function trainingMineModel(author = "Foresight template", at = "2026-11-17T00:00:00Z"): MineModel {
  const J = (id: string, x: number, y: number, z: number, name?: string) => ({ id, x, y, z, ...(name ? { name } : {}) });
  const T = (id: string, from: string, to: string, width: number, name: string, walkable = true) => ({ id, from, to, name, length: null, width, height: 3, profile: "arched" as const, walkable, resistance: null });
  const m: MineModel = {
    schemaVersion: "mine-model-1",
    meta: { name: "Mavambo training mine", fictional: true, datum: "Fictional local plan datum; metres; origin at main shaft; not surveyed", source: "template" },
    units: { length: "m", confirmed: true },
    junctions: [
      J("JMS", 0, 0, -60, "Main shaft station"), J("J1", 60, 0, -60), J("J2", 120, 0, -61), J("J3", 180, 0, -62, "Refuge bay"),
      J("J4", 240, 0, -63), J("J5", 300, 0, -64, "East face"), J("J6", 240, -50, -65, "East sump"), J("J7", 120, -80, -61),
      J("J8", 40, -100, -60, "South face"), J("J9", 120, 80, -58), J("J10", 60, 130, -50, "North adit portal"),
      J("J11", 300, 60, -60, "Incline foot"), J("J12", 420, 180, -20, "East incline portal"),
    ],
    tunnels: [
      T("T1", "JMS", "J1", 3.5, "Main haulage"), T("T2", "J1", "J2", 3.5, "Main haulage"), T("T3", "J2", "J3", 3.0, "East drive"),
      T("T4", "J3", "J4", 3.0, "East development"), T("T5", "J4", "J5", 2.8, "East development face"), T("T6", "J4", "J6", 2.5, "Sump access"),
      T("T7", "J5", "J11", 2.8, "East cross-cut"), T("T8", "J11", "J12", 3.0, "East incline"), T("T9", "J2", "J7", 2.5, "South drive"),
      T("T10", "J7", "J8", 2.5, "South working"), T("T11", "J8", "JMS", 2.2, "South return airway"), T("T12", "J1", "J9", 2.5, "North drive"),
      T("T13", "J9", "J10", 2.5, "North adit"),
    ],
    exits: [
      { id: "X-MS", junction: "JMS", name: "Main shaft", kind: "shaft", shaftId: "main-shaft", usableForEscape: true, hoist: { cageCapacity: 8, loadingSeconds: 45, tripSecondsByLevel: [{ level: "60 m level", junction: "JMS", seconds: 90 }] }, ladderClimbSeconds: 900 },
      { id: "X-EI", junction: "J12", name: "East incline", kind: "incline", shaftId: "east-incline", usableForEscape: true, hoist: null, ladderClimbSeconds: null },
      { id: "X-NA", junction: "J10", name: "North adit", kind: "adit", shaftId: "north-adit", usableForEscape: true, hoist: null, ladderClimbSeconds: null },
    ],
    refuges: [{ id: "R1", junction: "J3", name: "Refuge bay 1", capacity: 12, airSupplyM3: 80 }],
    sumps: [{ id: "S1", junction: "J6", name: "East sump", levelVolume: [{ levelM: 0, volumeM3: 0 }, { levelM: 5, volumeM3: 150 }], dangerLevelM: 2, initialVolumeM3: 30, inflowM3h: 18, closesTunnelIds: ["T6", "T4"] }],
    pumps: [
      { id: "P1", sumpId: "S1", name: "P1 duty pump", capacityM3h: 24, role: "duty" },
      { id: "P2", sumpId: "S1", name: "P2 backup pump", capacityM3h: 24, role: "backup" },
    ],
    fans: [{ id: "F1", tunnelId: "T13", name: "North adit fan", fixedDutyM3s: null, pressurePa: null }],
    doors: [{ id: "D1", tunnelId: "T11", name: "South return door", open: true, resistance: null }],
    zones: [
      { id: "zone-a", name: "North working", tunnelIds: ["T12", "T13"], shaftIds: ["main-shaft", "north-adit"] },
      { id: "zone-b", name: "East development", tunnelIds: ["T4", "T5", "T6", "T7"], shaftIds: ["east-incline"] },
      { id: "zone-c", name: "South working", tunnelIds: ["T9", "T10", "T11"], shaftIds: ["main-shaft"] },
    ],
    storageLinks: { reviewed: false, reviewedBy: null, links: [] },
    provenance: {},
  };
  // Fictional ventilation values so the training mine can demonstrate the solver:
  // Atkinson R = k L P / A^3 with an ASSUMED friction factor k = 0.012 kg/m^3, a
  // fictional 30 m^3/s exhaust fan and a fictional door resistance. Not measured.
  for (const t of m.tunnels) {
    const w = t.width ?? 3, h = t.height ?? 3;
    t.resistance = Number(((0.012 * (tunnelLength(m, t) ?? 0) * 2 * (w + h)) / Math.pow(w * h, 3)).toFixed(5));
  }
  m.fans[0]!.fixedDutyM3s = 30;
  m.doors[0]!.resistance = 50;
  const p = (quality: Quality, note: string): Provenance => ({ quality, note, author, at });
  for (const path of valuePaths(m))
    m.provenance[path] = p("assumed", "Fictional training-mine value; not measured");
  m.provenance["S1.dangerLevelM"] = p("assumed", "Fictional 2 m threshold carried over from the water laboratory exercise");
  m.provenance["S1.inflowM3h"] = p("assumed", "Fictional inflow carried over from the water laboratory baseline");
  return m;
}
