// Metric catalogue for scenario runs (spec §12). Every number an explanation
// may state is a named metric of a recorded run, so a citation is a
// (run id, metric id) pair that can be checked. Pure: no I/O.

export type Metric = {
  id: string;
  label: string;
  /** Value as recorded; null when the run could not produce it. */
  value: number | string | null;
  unit: "people" | "seconds" | "metres" | "count" | "text";
  available: boolean;
  /** Why an unavailable metric is unavailable. */
  reason?: string;
};
export type MetricRun = { id: string; kind: "escape-run" | "cage-run"; name: string; inputHash: string; metrics: Metric[]; assumptions: string[]; mineModelRevision: number | null };

const m = (id: string, label: string, value: number | string | null, unit: Metric["unit"], reason?: string): Metric => ({ id, label, value, unit, available: value !== null, ...(value === null && reason ? { reason } : {}) });

type EscapeResult = {
  inputHash?: string;
  flooding?: { dangerLevelM?: number; firstDangerSeconds: number | null; peakLevelM: number };
  closures?: { tunnelId: string; atSeconds: number }[];
  escape?: { totals: Record<string, number | boolean>; times: { t50: number | null; t95: number | null; t100: number | null }; assumptions?: Record<string, unknown>; seed?: number };
  endurance?: { selfRescuer?: { available: boolean; reason?: string; exceeding?: string[] }; refuges?: { name: string; available: boolean; reason?: string; airHours?: number | null }[] };
  congestion?: { available: boolean; reason?: string; lines?: { line: string; peakPerMinute?: number; available?: boolean }[] };
};
type CageResult = {
  inputHash?: string;
  totals: Record<string, number | boolean>;
  lastSurfaceSeconds: number | null;
  lastReachedSeconds: number | null;
  effect: { delaySeconds: number | null; baselineLastSurfaceSeconds: number | null; movedToLadder: number } | null;
  assumptions?: string[];
};

export function escapeMetrics(r: EscapeResult): Metric[] {
  const t = r.escape?.totals || {};
  const times = r.escape?.times;
  const out: Metric[] = [
    m("escape.people.simulated", "People simulated", num(t.simulated), "people"),
    m("escape.people.reached-exit", "Reached an exit", num(t["reached-exit"]), "people"),
    m("escape.people.reached-refuge", "At a refuge", num(t["reached-refuge"]), "people"),
    m("escape.people.cut-off", "Cut off from their assumed start", num(t["cut-off"]), "people"),
    m("escape.people.still-walking", "Still walking at the horizon", num(t["still-walking"]), "people"),
    m("escape.time.t50", "Time until 50 % are at safety", times?.t50 ?? null, "seconds", "Not reached within the horizon"),
    m("escape.time.t95", "Time until 95 % are at safety", times?.t95 ?? null, "seconds", "Not reached within the horizon"),
    m("escape.time.t100", "Time until everyone is at safety", times?.t100 ?? null, "seconds", "Not everyone reaches safety within the horizon"),
    m("flooding.first-danger", "Sump reaches its danger level", r.flooding?.firstDangerSeconds ?? null, "seconds", "Danger level not reached within the horizon"),
    m("flooding.peak-level", "Peak sump level", r.flooding?.peakLevelM ?? null, "metres"),
    m("flooding.closures", "Tunnels closed by water", r.closures ? r.closures.length : null, "count"),
  ];
  const sr = r.endurance?.selfRescuer;
  out.push(m("endurance.self-rescuer-exceeding", "People whose route exceeds the self-rescuer duration", sr?.available ? (sr.exceeding || []).length : null, "people", sr?.reason || "Self-rescuer rated duration was not entered"));
  const peak = r.congestion?.available ? Math.max(0, ...(r.congestion.lines || []).map((l) => l.peakPerMinute ?? 0)) : null;
  out.push(m("congestion.peak-per-minute", "Peak crossings per minute at the measurement lines", peak, "count", r.congestion?.reason || "Congestion measurement unavailable"));
  return out;
}
export function cageMetrics(r: CageResult): Metric[] {
  const t = r.totals;
  return [
    m("cage.people.total", "People modelled", num(t.people), "people"),
    m("cage.people.by-cage", "Brought up by the cage", num(t.byCage), "people"),
    m("cage.people.by-ladder", "Brought up by the ladderway", num(t.byLadder), "people"),
    m("cage.people.not-reached", "Not at the surface by the horizon", num(t.notReached), "people"),
    m("cage.time.last-surface", "Last person at the surface", r.lastSurfaceSeconds, "seconds", "At least one person is not at the surface by the horizon"),
    m("cage.time.baseline-last-surface", "Last person at the surface without a hoist failure", r.effect ? r.effect.baselineLastSurfaceSeconds : null, "seconds", r.effect ? "Not everyone reaches the surface in the no-failure comparison" : "No hoist failure was modelled"),
    m("cage.failure.delay", "Delay caused by the hoist failure", r.effect ? r.effect.delaySeconds : null, "seconds", r.effect ? "Cannot be compared: someone is not reached" : "No hoist failure was modelled"),
    m("cage.failure.moved-to-ladder", "People moved to the ladderway by the failure", r.effect ? r.effect.movedToLadder : null, "people", "No hoist failure was modelled"),
  ];
}
const num = (x: unknown) => (typeof x === "number" ? x : null);

/** The plain-language assumptions a result always carries with it. */
export function escapeAssumptions(run: { data: Record<string, unknown> }): string[] {
  const out = [String(run.data.startAssumption || "People start where the scenario assumes, not at live locations.")];
  const s = run.data.scenario as { evacuationOrderMinutes?: number; preMovementMinutes?: { min: number; max: number }; speed?: { mean: number }; seed?: number; peopleSource?: string } | undefined;
  if (s) {
    out.push(`Evacuation ordered at ${s.evacuationOrderMinutes} min; pre-movement ${s.preMovementMinutes?.min}–${s.preMovementMinutes?.max} min; mean walking speed ${s.speed?.mean} m/s (assumed); seed ${s.seed}.`);
    out.push(s.peopleSource === "current-declarations" ? "People are those declared underground when the run started (from check-ins, not tracked)." : "People are a planned headcount, not real declarations.");
  }
  return out;
}
export function toMetricRun(run: { id: string; kind: string; data: Record<string, unknown> }): MetricRun | null {
  const result = run.data.result as (EscapeResult & CageResult) | null;
  if (!result || run.data.status !== "completed") return null;
  if (run.kind === "escape-run")
    return { id: run.id, kind: "escape-run", name: String(run.data.name), inputHash: String(result.inputHash || ""), metrics: escapeMetrics(result), assumptions: escapeAssumptions(run), mineModelRevision: Number(run.data.mineModelRevisionNumber) || null };
  if (run.kind === "cage-run")
    return { id: run.id, kind: "cage-run", name: String(run.data.name), inputHash: String(result.inputHash || ""), metrics: cageMetrics(result), assumptions: [...((run.data.assumptionsNote as string[]) || []), ...(result.assumptions || [])], mineModelRevision: Number(run.data.mineModelRevisionNumber) || null };
  return null;
}

// ---- formatting ---------------------------------------------------------------
export function formatMetric(x: Metric): string {
  if (!x.available || x.value === null) return `unavailable${x.reason ? ` (${x.reason})` : ""}`;
  if (x.unit === "seconds") {
    const s = Number(x.value);
    return s >= 60 ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s` : `${Math.round(s)} s`;
  }
  if (x.unit === "metres") return `${Number(x.value).toFixed(2)} m`;
  return String(x.value);
}

// ---- comparison -----------------------------------------------------------------
export type MetricDelta = { id: string; label: string; a: string; b: string; change: string };
export function compareRuns(a: MetricRun, b: MetricRun) {
  const prefix = a.kind;
  if (a.kind !== b.kind) throw new Error("Runs of different kinds cannot be compared.");
  const byId = new Map(b.metrics.map((x) => [x.id, x]));
  const deltas: MetricDelta[] = a.metrics.map((x) => {
    const y = byId.get(x.id)!;
    let change = "";
    if (typeof x.value === "number" && typeof y.value === "number") {
      const d = y.value - x.value;
      change = d === 0 ? "no change" : `${d > 0 ? "+" : "−"}${formatMetric({ ...x, value: Math.abs(d) })}`;
    } else if (x.available !== y.available) change = x.available ? "became unavailable" : "became available";
    else change = "both unavailable";
    return { id: x.id, label: x.label, a: formatMetric(x), b: formatMetric(y), change };
  });
  return { kind: prefix, deltas, sameInputs: a.inputHash === b.inputHash, sameModelRevision: a.mineModelRevision === b.mineModelRevision };
}

// ---- grounded explanation --------------------------------------------------------
/** Deterministic summary: needs no AI, cites every figure. */
export function deterministicExplanation(run: MetricRun) {
  const get = (id: string) => run.metrics.find((x) => x.id === id)!;
  const cite = (id: string) => ({ runId: run.id, metricId: id });
  const line = (text: string, ids: string[]) => ({ text, citations: ids.map(cite) });
  const paragraphs =
    run.kind === "escape-run"
      ? [
          line(`${formatMetric(get("escape.people.simulated"))} people were simulated: ${formatMetric(get("escape.people.reached-exit"))} reached an exit, ${formatMetric(get("escape.people.reached-refuge"))} a refuge, ${formatMetric(get("escape.people.cut-off"))} were cut off from their assumed start and ${formatMetric(get("escape.people.still-walking"))} were still walking at the horizon.`, ["escape.people.simulated", "escape.people.reached-exit", "escape.people.reached-refuge", "escape.people.cut-off", "escape.people.still-walking"]),
          line(`Time until everyone is at safety: ${formatMetric(get("escape.time.t100"))}. Time until 50 %: ${formatMetric(get("escape.time.t50"))}; until 95 %: ${formatMetric(get("escape.time.t95"))}.`, ["escape.time.t100", "escape.time.t50", "escape.time.t95"]),
          line(`The sump reaches its danger level: ${formatMetric(get("flooding.first-danger"))}. Peak sump level ${formatMetric(get("flooding.peak-level"))}; tunnels closed by water: ${formatMetric(get("flooding.closures"))}.`, ["flooding.first-danger", "flooding.peak-level", "flooding.closures"]),
        ]
      : [
          line(`${formatMetric(get("cage.people.total"))} people were modelled: ${formatMetric(get("cage.people.by-cage"))} by cage, ${formatMetric(get("cage.people.by-ladder"))} by the ladderway and ${formatMetric(get("cage.people.not-reached"))} not reached.`, ["cage.people.total", "cage.people.by-cage", "cage.people.by-ladder", "cage.people.not-reached"]),
          line(`Last person at the surface: ${formatMetric(get("cage.time.last-surface"))}. Without a hoist failure: ${formatMetric(get("cage.time.baseline-last-surface"))}; delay from the failure: ${formatMetric(get("cage.failure.delay"))}.`, ["cage.time.last-surface", "cage.time.baseline-last-surface", "cage.failure.delay"]),
        ];
  return {
    runId: run.id,
    mode: "deterministic" as const,
    paragraphs,
    assumptions: run.assumptions,
    unavailable: run.metrics.filter((x) => !x.available).map((x) => ({ metricId: x.id, label: x.label, reason: x.reason || "unavailable" })),
    limitation: "Planning calculation under the stated assumptions; a person must decide what to do.",
  };
}

/** Numbers a paragraph may state: the cited metrics' values in any unit shown to people, plus small structural numbers. */
function allowedNumbers(metrics: Metric[]) {
  const ok = new Set<string>();
  for (const x of metrics) {
    // Numbers that are part of the metric's own name (for example "50 %") are not claims.
    for (const n of `${x.label} ${x.reason || ""}`.match(/\d+(?:\.\d+)?/g) || []) ok.add(n);
    if (typeof x.value !== "number") continue;
    const v = x.value;
    ok.add(String(v));
    ok.add(String(Math.round(v)));
    ok.add(v.toFixed(1));
    ok.add(v.toFixed(2));
    if (x.unit === "seconds") {
      ok.add(String(Math.round(v / 60)));
      ok.add((v / 60).toFixed(1));
      ok.add(String(Math.floor(v / 60)));
      ok.add(String(Math.round(v % 60)).padStart(2, "0"));
      ok.add(String(Math.round(v % 60)));
    }
  }
  return ok;
}
export type Citation = { runId: string; metricId: string };
export type ExplanationParagraph = { text: string; citations: Citation[] };
/**
 * Checks an AI explanation against the recorded runs. Rejects: a citation to a
 * run or metric that does not exist, a paragraph with no citation, a number that
 * is not one of the cited metrics' values, and a claim of a figure for a metric
 * that is unavailable. Returns the problems; empty means grounded.
 */
export function groundingProblems(paragraphs: ExplanationParagraph[], runs: MetricRun[]): string[] {
  const problems: string[] = [];
  const byRun = new Map(runs.map((r) => [r.id, r]));
  paragraphs.forEach((p, i) => {
    if (!p.citations.length) problems.push(`Paragraph ${i + 1} cites no run and metric.`);
    const cited: Metric[] = [];
    for (const c of p.citations) {
      const run = byRun.get(c.runId);
      const metric = run?.metrics.find((x) => x.id === c.metricId);
      if (!run) problems.push(`Paragraph ${i + 1} cites an unknown run ${c.runId}.`);
      else if (!metric) problems.push(`Paragraph ${i + 1} cites an unknown metric ${c.metricId}.`);
      else cited.push(metric);
    }
    const allowed = allowedNumbers(cited);
    // Strip metric/run identifiers and ordinals before looking for stated numbers.
    const text = p.text.replace(/[a-z]+\.[a-z0-9.-]+/gi, " ").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, " ").replace(/\b[0-9a-f]{8}\b/g, " ");
    for (const n of text.match(/\d+(?:\.\d+)?/g) || []) if (!allowed.has(n) && !allowed.has(String(Number(n)))) problems.push(`Paragraph ${i + 1} states ${n}, which is not a value of the metrics it cites.`);
    for (const x of cited)
      if (!x.available && /\b(was|were|is|are|reaches|reached|took)\b[^.]*\d/.test(p.text) && (p.text.match(/\d+/g) || []).length && !/unavailable|not reached|not available|not entered/i.test(p.text))
        problems.push(`Paragraph ${i + 1} gives a figure while ${x.id} is unavailable.`);
  });
  return problems;
}
