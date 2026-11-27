// Builds the ventilation solver input from the mine model and a scenario
// (spec 9.8). Pure. Missing values block a run instead of being filled in.
import { z } from "zod";
import { tunnelLength, type MineModel, type Tunnel } from "./mine-model.ts";

export const SURFACE = "SURFACE";
export const ventilationScenarioSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    fanFailures: z.array(z.string().max(60)).max(50).default([]),
    fanDutyOverrides: z.array(z.object({ fanId: z.string().max(60), dutyM3s: z.number().min(0).max(1e4) }).strict()).max(50).default([]),
    doorChanges: z.array(z.object({ doorId: z.string().max(60), open: z.boolean() }).strict()).max(50).default([]),
    blockedTunnels: z.array(z.string().max(60)).max(200).default([]),
    gas: z.object({ releaseTunnelId: z.string().max(60), releaseM3s: z.number().min(0).max(1e3), limitFraction: z.number().gt(0).lte(1) }).strict().nullable().default(null),
    reentry: z.object({ tunnelIds: z.array(z.string().max(60)).min(1).max(200), feedTunnelId: z.string().max(60), startFraction: z.number().gt(0).lte(1) }).strict().nullable().default(null),
    tolerance: z.number().min(1e-10).max(1e-2).default(1e-6),
    maxIterations: z.number().int().min(1).max(100000).default(10000),
  })
  .strict();
export type VentilationScenario = z.infer<typeof ventilationScenarioSchema>;

/** Cross-section area (m^2): a box, or a box with a semicircular roof for arched profiles. */
export function crossSectionArea(t: Tunnel): number | null {
  if (t.width === null || t.height === null) return null;
  if (t.profile === "box") return t.width * t.height;
  const wall = Math.max(0, t.height - t.width / 2);
  return t.width * wall + (Math.PI * (t.width / 2) ** 2) / 2;
}
type Mods = { failedFans: Set<string>; duty: Map<string, number>; doorOpen: Map<string, boolean>; blocked: Set<string> };
function stateFor(model: MineModel, mods: Mods, problems: Set<string>, warnings: Set<string>) {
  const nodes = [SURFACE, ...model.junctions.map((j) => j.id)];
  const airways: { id: string; from: string; to: string; resistance?: number; fixed?: number | null; areaM2?: number }[] = [];
  for (const t of model.tunnels) {
    if (mods.blocked.has(t.id)) continue;
    const area = crossSectionArea(t);
    const fan = model.fans.find((f) => f.tunnelId === t.id);
    const live = fan && !mods.failedFans.has(fan.id);
    const dutyEntered = fan ? (mods.duty.get(fan.id) ?? fan.fixedDutyM3s) : null;
    if (live && dutyEntered === null) problems.add(`Fan ${fan!.name} has no duty entered.`);
    const door = model.doors.find((d) => d.tunnelId === t.id);
    const open = door ? (mods.doorOpen.get(door.id) ?? door.open) : true;
    if (live && dutyEntered !== null) {
      airways.push({ id: t.id, from: t.from, to: t.to, fixed: dutyEntered, ...(area ? { areaM2: area } : {}) });
      continue;
    }
    if (t.resistance === null) {
      problems.add(`Tunnel ${t.id} airway resistance is not entered.`);
      continue;
    }
    let r = t.resistance;
    if (door && !open) {
      if (door.resistance === null) problems.add(`Door ${door.name} is closed and its resistance is not entered.`);
      else r += door.resistance;
    }
    airways.push({ id: t.id, from: t.from, to: t.to, resistance: r, ...(area ? { areaM2: area } : {}) });
  }
  for (const e of model.exits) airways.push({ id: `SURF-${e.id}`, from: SURFACE, to: e.junction, resistance: 0 });
  if (!model.exits.length) problems.add("The model has no exit, so there is no connection to the surface.");
  if (!airways.some((a) => a.fixed != null)) warnings.add("No fan is in service: nothing drives air in this state, so every flow is zero (natural ventilation is not modelled).");
  return { nodes, airways, slack: [SURFACE] };
}
export function buildVentilationInput(model: MineModel, s: VentilationScenario, withScenario = true) {
  const problems = new Set<string>(), warnings = new Set<string>();
  const ids = { fans: new Set(model.fans.map((f) => f.id)), doors: new Set(model.doors.map((d) => d.id)), tunnels: new Set(model.tunnels.map((t) => t.id)) };
  for (const f of [...s.fanFailures, ...s.fanDutyOverrides.map((x) => x.fanId)]) if (!ids.fans.has(f)) problems.add(`Fan ${f} is not in the model.`);
  for (const d of s.doorChanges) if (!ids.doors.has(d.doorId)) problems.add(`Door ${d.doorId} is not in the model.`);
  for (const t of s.blockedTunnels) if (!ids.tunnels.has(t)) problems.add(`Tunnel ${t} is not in the model.`);
  const none: Mods = { failedFans: new Set(), duty: new Map(), doorOpen: new Map(), blocked: new Set() };
  const changed: Mods = { failedFans: new Set(s.fanFailures), duty: new Map(s.fanDutyOverrides.map((x) => [x.fanId, x.dutyM3s])), doorOpen: new Map(s.doorChanges.map((d) => [d.doorId, d.open])), blocked: new Set(s.blockedTunnels) };
  const hasChange = s.fanFailures.length + s.fanDutyOverrides.length + s.doorChanges.length + s.blockedTunnels.length > 0;
  const states: Record<string, ReturnType<typeof stateFor>> = { baseline: stateFor(model, none, problems, warnings) };
  if (withScenario && hasChange) states.scenario = stateFor(model, changed, problems, warnings);
  else if (withScenario) warnings.add("The scenario changes nothing, so only the baseline is solved.");
  let gas: { airwayId: string; releaseM3s: number } | undefined;
  if (s.gas) {
    if (!ids.tunnels.has(s.gas.releaseTunnelId)) problems.add(`Release tunnel ${s.gas.releaseTunnelId} is not in the model.`);
    gas = { airwayId: s.gas.releaseTunnelId, releaseM3s: s.gas.releaseM3s };
  }
  let reentry: { airwayIds: string[]; volumeM3: number; feedAirwayId: string; cStartFraction: number; cLimitFraction: number } | undefined;
  if (s.reentry) {
    if (!s.gas) problems.add("A re-entry estimate needs the gas limit: enter the gas section too.");
    let volume = 0;
    for (const id of s.reentry.tunnelIds) {
      const t = model.tunnels.find((x) => x.id === id);
      if (!t) { problems.add(`Re-entry tunnel ${id} is not in the model.`); continue; }
      const a = crossSectionArea(t);
      if (a === null) problems.add(`Tunnel ${id} width or height is not entered, so its volume is unknown.`);
      else volume += a * (tunnelLength(model, t) ?? 0);
    }
    if (!ids.tunnels.has(s.reentry.feedTunnelId)) problems.add(`Feed tunnel ${s.reentry.feedTunnelId} is not in the model.`);
    reentry = { airwayIds: s.reentry.tunnelIds, volumeM3: volume, feedAirwayId: s.reentry.feedTunnelId, cStartFraction: s.reentry.startFraction, cLimitFraction: s.gas?.limitFraction ?? 1 };
    if (volume <= 0 && !problems.size) problems.add("The re-entry volume is zero.");
  }
  const input = { states, tolerance: s.tolerance, maxIterations: s.maxIterations, ...(gas ? { gas } : {}), ...(reentry ? { reentry } : {}) };
  return { input, problems: [...problems], warnings: [...warnings], hasScenario: Boolean(states.scenario) };
}
