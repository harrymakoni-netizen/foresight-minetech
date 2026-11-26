"use client";
// Scenarios (spec §9, §13.3). Every number shown comes from a recorded run;
// missing inputs block a run; results name the assumed start area.
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { Pause, Play } from "lucide-react";
import type { MineModel } from "@/lib/domain/mine-model";
import { PlanView, zoneColour, type Dot, type Trail } from "./mine";
import type { Playback } from "./tunnels-3d";
const Tunnels3D = dynamic(() => import("./tunnels-3d"), { ssr: false, loading: () => <p role="status">Loading 3D view…</p> });
import { download, ErrorText, Field, rows, Tag, type Row, type ViewProps } from "./shared";

const hm = (s: number | null | undefined) => {
  if (s === null || s === undefined) return "not reached";
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
};
const outcomeText: Record<string, string> = { "reached-exit": "Reached an exit", "reached-refuge": "Reached a refuge", "cut-off": "Cut off", "still-walking": "Still walking at horizon" };
type Result = {
  inputHash: string;
  engines: Record<string, string>;
  flooding: { sumpId: string; dangerLevelM: number; firstDangerSeconds: number | null; peakLevelM: number; series: { t: number; levelM: number }[] };
  closures: { tunnelId: string; atSeconds: number; source: string }[];
  escape: {
    totals: Record<string, number | boolean>;
    times: { t50: number | null; t95: number | null; t100: number | null };
    people: { id: string; name: string | null; zoneId: string; outcome: string; atSeconds: number | null; targetId: string | null; reason: string | null; label: string | null; releaseSeconds: number; speed: number }[];
    assumptions: Record<string, unknown>;
    adapter: Record<string, unknown>;
    seed: number;
  };
  endurance: { label: string; selfRescuer: { available: boolean; reason?: string; ratedMinutes?: number; exceeding?: string[]; formula?: string }; refuges: { name: string; occupants: number; available: boolean; airHours?: number | null; formula?: string; reason?: string; note?: string }[] };
  playback?: { every: number; people: { id: string; name: string | null; outcome: string; start: { x: number; y: number }; endAt: number | null; path: [number, number, number][] }[] };
  congestion?: { available: boolean; reason?: string; method?: string; lines?: { line: string; crossings?: number; firstSeconds?: number; lastSeconds?: number; peakPerMinute?: number; available?: boolean; reason?: string }[] };
  warnings: string[];
};
function hashParams() {
  if (typeof location === "undefined") return new URLSearchParams();
  const q = location.hash.split("?")[1];
  return new URLSearchParams(q || "");
}
export function EscapeScenarios({ data, post, refresh, notify }: ViewProps) {
  const published = rows(data, "mine-model-revision").find((r) => r.data.status === "published");
  const model = published?.data.model as MineModel | undefined;
  const runs = rows(data, "escape-run").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const [selectedId, setSelectedId] = useState<string | null>(runs[0]?.id || null);
  const [live, setLive] = useState<Record<string, Row>>({});
  const selected = selectedId ? live[selectedId] || runs.find((r) => r.id === selectedId) || null : null;
  // Poll unfinished runs and studies.
  useEffect(() => {
    const pending = [...rows(data, "escape-run"), ...rows(data, "time-to-act-study")].filter((r) => ["queued", "running"].includes(String((live[r.id] || r).data.status)));
    if (!pending.length) return;
    const timer = setInterval(async () => {
      for (const r of pending) {
        const path = r.kind === "escape-run" ? "runs" : "time-to-act";
        const res = await fetch(`/api/workspace/escape/${path}/${r.id}`, { cache: "no-store" });
        if (!res.ok) continue;
        const next = (await res.json()) as Row;
        setLive((l) => ({ ...l, [r.id]: next }));
        if (next.data.status === "completed") void refresh();
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [data, live, refresh]);
  if (!model || !published) return <p>Publish a mine model before running escape scenarios.</p>;
  return (
    <section className="fs-scenarios" aria-label="Escape scenarios">
      <div className="fs-scenario-grid">
        <Builder data={data} model={model} revision={Number(published.data.number)} post={post} onStarted={async (r) => (setSelectedId(r.id), await refresh(), notify("Scenario submitted to the simulation worker."))} />
        <div className="fs-scenario-main">
          {selected ? (
            <RunView key={selected.id + String(selected.data.status)} run={selected} model={(selected.data.result as Result | null) ? model : model} data={data} post={post} refresh={refresh} notify={notify} runs={runs} live={live} />
          ) : (
            <section className="fs-panel">
              <p>No escape runs yet. Build a scenario on the left. Results appear here with their assumptions.</p>
            </section>
          )}
          <section className="fs-panel">
            <h3>Saved runs</h3>
            <ul className="fs-runs">
              {runs.map((r) => {
                const res = r.data.result as Result | null;
                return (
                  <li key={r.id}>
                    <button className={"fs-inline-link " + (r.id === selectedId ? "active" : "")} onClick={() => setSelectedId(r.id)}>
                      {String(r.data.name)}
                    </button>{" "}
                    <Tag tone={r.data.status === "completed" ? "teal" : r.data.status === "worker-unavailable" || r.data.status === "failed" ? "red" : "amber"}>{String((live[r.id] || r).data.status)}</Tag>{" "}
                    <small>
                      {res ? `${res.escape.totals["cut-off"]} cut off · T100 ${hm(res.escape.times.t100)}` : ""} · model rev {String(r.data.mineModelRevisionNumber)} · {new Date(r.createdAt).toLocaleString("en-GB", { timeZone: "Africa/Harare" })}
                    </small>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </div>
    </section>
  );
}
function Builder({ data, model, revision, post, onStarted }: { data: ViewProps["data"]; model: MineModel; revision: number; post: ViewProps["post"]; onStarted: (r: Row) => Promise<void> }) {
  const params = hashParams();
  const sump = model.sumps[0];
  const pumps = model.pumps.filter((p) => p.sumpId === sump?.id);
  const duty = pumps.find((p) => p.id === params.get("pump")) || pumps.find((p) => p.role === "duty") || pumps[0];
  const backup = pumps.find((p) => p.role === "backup" && p.id !== duty?.id) || null;
  const declared = rows(data, "check-in").filter((c) => ["declared-underground", "return-overdue", "confirmed-missing"].includes(String(c.data.status))).length;
  const [f, setF] = useState({
    name: params.get("name") || `${duty?.name || "Pump"} failure`,
    template: "pump-failure" as "pump-failure" | "blocked-tunnel",
    peopleSource: (declared ? "current-declarations" : "planned-headcount") as "current-declarations" | "planned-headcount",
    planned: Object.fromEntries(model.zones.map((z) => [z.id, z.id === (params.get("zone") || "zone-b") ? 8 : 4])) as Record<string, number>,
    sumpId: sump?.id || "",
    dutyPumpId: duty?.id || "",
    backupPumpId: backup?.id || "",
    failAt: 0,
    backupStart: "" as string,
    inflow: "",
    initial: "",
    blockedTunnel: model.tunnels[0]?.id || "",
    blockedAt: 0,
    order: 95,
    preMin: 0,
    preMax: 2,
    speedMean: 1.0,
    speedSd: 0.15,
    horizon: 120,
    seed: 11,
    rescuer: "30",
    consumption: "",
  });
  const [checking, setChecking] = useState<{ ok: boolean; problems: string[]; people: number } | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const body = () => ({
    name: f.name,
    template: f.template,
    peopleSource: f.peopleSource,
    plannedHeadcount: f.peopleSource === "planned-headcount" ? f.planned : {},
    startMethod: "spread-along-zone",
    water: {
      sumpId: f.sumpId,
      dutyPumpId: f.dutyPumpId,
      backupPumpId: f.backupPumpId || null,
      failAtMinutes: Number(f.failAt),
      backupStartMinutes: f.backupStart === "" ? null : Number(f.backupStart),
      inflowM3h: f.inflow === "" ? null : Number(f.inflow),
      initialVolumeM3: f.initial === "" ? null : Number(f.initial),
    },
    blockedTunnels: f.template === "blocked-tunnel" ? [{ tunnelId: f.blockedTunnel, atMinutes: Number(f.blockedAt) }] : [],
    evacuationOrderMinutes: Number(f.order),
    preMovementMinutes: { min: Number(f.preMin), max: Number(f.preMax) },
    speed: { mean: Number(f.speedMean), sd: Number(f.speedSd), min: Math.max(0.3, Number(f.speedMean) - 3 * Number(f.speedSd)), max: Number(f.speedMean) + 3 * Number(f.speedSd) },
    horizonMinutes: Number(f.horizon),
    seed: Number(f.seed),
    endurance: { selfRescuerRatedMinutes: f.rescuer === "" ? null : Number(f.rescuer), refugeConsumptionM3PerPersonHour: f.consumption === "" ? null : Number(f.consumption) },
    sourceConcernId: params.get("concern"),
    sourceReportId: params.get("report"),
  });
  const run = async (submit: boolean) => {
    setBusy(true);
    setError("");
    try {
      const c = await post("escape/preflight", body());
      setChecking(c);
      if (submit && c.ok) await onStarted(await post("escape/runs", body()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const prov = (path: string) => model.provenance[path]?.quality || "no provenance";
  const n = (k: keyof typeof f, label: string, help?: string, step = "any") => (
    <Field label={label} help={help}>
      <input type="number" step={step} value={String(f[k])} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </Field>
  );
  return (
    <section className="fs-panel fs-builder" aria-label="Scenario builder">
      <h3>Build a scenario</h3>
      <p className="fs-help">Mine model revision {revision} ({model.meta.fictional ? "fictional training mine" : model.meta.name}). Times are minutes after the scenario starts.</p>
      <Field label="Name">
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <Field label="Template">
        <select value={f.template} onChange={(e) => setF({ ...f, template: e.target.value as typeof f.template })}>
          <option value="pump-failure">Pump failure</option>
          <option value="blocked-tunnel">Pump failure + blocked tunnel</option>
        </select>
      </Field>
      <fieldset className="fs-group">
        <legend>Water</legend>
        <Field label="Failing pump">
          <select value={f.dutyPumpId} onChange={(e) => setF({ ...f, dutyPumpId: e.target.value })}>
            {pumps.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.capacityM3h ?? "capacity not entered"} m³/h, {prov(`${p.id}.capacityM3h`)})
              </option>
            ))}
          </select>
        </Field>
        {n("failAt", "Pump fails at (min)")}
        <Field label="Backup pump">
          <select value={f.backupPumpId} onChange={(e) => setF({ ...f, backupPumpId: e.target.value })}>
            <option value="">None</option>
            {pumps.filter((p) => p.id !== f.dutyPumpId).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        {n("backupStart", "Backup starts at (min, blank = never)")}
      </fieldset>
      {f.template === "blocked-tunnel" && (
        <fieldset className="fs-group">
          <legend>Blocked tunnel</legend>
          <Field label="Tunnel">
            <select value={f.blockedTunnel} onChange={(e) => setF({ ...f, blockedTunnel: e.target.value })}>
              {model.tunnels.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id} {t.name}
                </option>
              ))}
            </select>
          </Field>
          {n("blockedAt", "Blocked at (min)")}
        </fieldset>
      )}
      <fieldset className="fs-group">
        <legend>People</legend>
        <Field label="People source">
          <select value={f.peopleSource} onChange={(e) => setF({ ...f, peopleSource: e.target.value as typeof f.peopleSource })}>
            <option value="current-declarations">Current declarations ({declared} declared underground)</option>
            <option value="planned-headcount">Planned headcount</option>
          </select>
        </Field>
        {f.peopleSource === "planned-headcount" &&
          model.zones.map((z) => (
            <Field key={z.id} label={`${z.name} (people)`}>
              <input type="number" min={0} value={f.planned[z.id] ?? 0} onChange={(e) => setF({ ...f, planned: { ...f.planned, [z.id]: Number(e.target.value) } })} />
            </Field>
          ))}
        <p className="fs-help">Start positions: spread along each person's declared zone (seeded). Assumed, not live locations.</p>
        {n("order", "Evacuation ordered at (min)")}
      </fieldset>
      <details className="fs-advanced">
        <summary>Advanced assumptions (the defaults are fine for a first run)</summary>
      <fieldset className="fs-group">
        <legend>Water</legend>
        {n("inflow", `Inflow override (m³/h, blank = model ${sump?.inflowM3h ?? "not entered"}, ${prov(`${sump?.id}.inflowM3h`)})`)}
        {n("initial", `Starting volume override (m³, blank = model ${sump?.initialVolumeM3 ?? "not entered"})`)}
      </fieldset>
      <fieldset className="fs-group">
        <legend>Movement</legend>
        {n("preMin", "Pre-movement from (min)")}
        {n("preMax", "Pre-movement to (min)")}
        {n("speedMean", "Walking speed mean (m/s, assumed)")}
        {n("speedSd", "Walking speed spread (m/s)")}
      </fieldset>
      <fieldset className="fs-group">
        <legend>Run and endurance inputs</legend>
        {n("horizon", "Horizon (min)")}
        {n("seed", "Seed", undefined, "1")}
        {n("rescuer", "Self-rescuer rated duration (min, blank = not entered)")}
        {n("consumption", "Refuge air use per person (m³/h, blank = not entered)")}
      </fieldset>
      </details>
      {checking && (
        <div className={"fs-note " + (checking.ok ? "" : "fs-tone-red")} role="status">
          {checking.ok ? `Preflight passed: ${checking.people} people.` : <>Preflight blocks this run:<ul>{checking.problems.map((p) => <li key={p}>{p}</li>)}</ul></>}
        </div>
      )}
      <ErrorText message={error} />
      <div className="fs-button-row">
        <button className="fs-button secondary" disabled={busy} onClick={() => void run(false)}>
          Check inputs
        </button>
        <button className="fs-button" disabled={busy} onClick={() => void run(true)}>
          Run scenario
        </button>
      </div>
    </section>
  );
}
function positionAt(path: [number, number, number][], start: { x: number; y: number }, t: number): [number, number] | null {
  if (!path.length) return [start.x, start.y];
  if (t < path[0][0]) return [start.x, start.y];
  for (let i = 0; i < path.length - 1; i++) {
    const [ta, xa, ya] = path[i], [tb, xb, yb] = path[i + 1];
    if (t >= ta && t <= tb) {
      const k = tb > ta ? (t - ta) / (tb - ta) : 0;
      return [xa + (xb - xa) * k, ya + (yb - ya) * k];
    }
  }
  const last = path[path.length - 1];
  return [last[1], last[2]];
}
function RunView({ run, model, data, post, refresh, notify, runs, live }: { run: Row; model: MineModel; data: ViewProps["data"]; post: ViewProps["post"]; refresh: ViewProps["refresh"]; notify: ViewProps["notify"]; runs: Row[]; live: Record<string, Row> }) {
  const r = run.data.result as Result | null;
  const status = String(run.data.status);
  const rev = rows(data, "mine-model-revision").find((x) => x.id === run.data.mineModelRevisionId);
  const runModel = (rev?.data.model as MineModel) || model;
  if (status === "worker-unavailable")
    return (
      <section className="fs-panel">
        <h3>{String(run.data.name)}</h3>
        <p className="fs-tone-red">Not run: the simulation worker with the escape engine is not reachable. {String(run.data.error || "")}</p>
        <p className="fs-help">Start it with <code>npm run worker:simulator</code> using the simulation environment (<code>npm run setup:sim</code>). No result is shown in its place.</p>
      </section>
    );
  if (!r)
    return (
      <section className="fs-panel" role="status">
        <h3>{String(run.data.name)}</h3>
        <p>{status === "failed" ? `Run failed: ${String(run.data.error)}` : "Calculating in the simulation worker…"}</p>
      </section>
    );
  return <Completed run={run} r={r} model={runModel} data={data} post={post} refresh={refresh} notify={notify} runs={runs} live={live} />;
}
function Completed({ run, r, model, data, post, refresh, notify, runs, live }: { run: Row; r: Result; model: MineModel; data: ViewProps["data"]; post: ViewProps["post"]; refresh: ViewProps["refresh"]; notify: ViewProps["notify"]; runs: Row[]; live: Record<string, Row> }) {
  const s = run.data.scenario as { water: { failAtMinutes: number; backupStartMinutes: number | null }; evacuationOrderMinutes: number; name: string };
  const people = r.playback?.people || [];
  const firstRelease = Math.min(...r.escape.people.map((p) => p.releaseSeconds));
  const lastEvent = Math.max(firstRelease + 60, ...r.escape.people.map((p) => p.atSeconds ?? 0), ...(r.closures.map((c) => c.atSeconds)));
  const [t, setT] = useState(Math.max(0, firstRelease - 30));
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<"3d" | "plan">("3d");
  const colour = useMemo(() => zoneColour(model), [model]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setT((x) => (x >= lastEvent ? (setPlaying(false), x) : Math.min(lastEvent, x + (lastEvent - firstRelease) / 150))), 100);
    return () => clearInterval(timer);
  }, [playing, lastEvent, firstRelease]);
  const closed = useMemo(() => new Set(r.closures.filter((c) => c.atSeconds <= t).map((c) => c.tunnelId)), [r.closures, t]);
  const dots: Dot[] = [];
  const trails: Trail[] = [];
  for (const p of people) {
    const res = r.escape.people.find((x) => x.id === p.id);
    if (res && res.atSeconds !== null && t >= res.atSeconds && res.outcome !== "cut-off") continue;
    const pos = positionAt(p.path, p.start, t);
    if (!pos) continue;
    const tone = res?.outcome === "cut-off" && res.atSeconds !== null && t >= res.atSeconds ? "cut-off" : t < (res?.releaseSeconds ?? 0) ? "waiting" : "walking";
    dots.push({ id: p.id, x: pos[0], y: pos[1], tone, label: `${p.name || p.id}: ${outcomeText[p.outcome]}` });
    trails.push({ id: p.id, tone: res?.outcome === "cut-off" ? "cut-off" : "walking", points: p.path.filter((q) => q[0] <= t).map((q) => [q[1], q[2]]) });
  }
  const playLabel = `Scenario playback at ${hm(t)}: ${dots.length} people shown, ${closed.size} tunnels closed. Results are listed beside the map.`;
  // Sump level at time t, interpolated from the recorded flooding series.
  const series = r.flooding.series;
  let levelM = series[0]?.levelM ?? 0;
  for (let i = 0; i < series.length - 1; i++)
    if (t >= series[i].t && t <= series[i + 1].t) {
      const k = (t - series[i].t) / (series[i + 1].t - series[i].t || 1);
      levelM = series[i].levelM + (series[i + 1].levelM - series[i].levelM) * k;
      break;
    } else if (t > series[i + 1].t) levelM = series[i + 1].levelM;
  const playback: Playback = {
    people: dots,
    closed,
    sumps: { [r.flooding.sumpId]: { levelM, dangerLevelM: r.flooding.dangerLevelM } },
    clock: `${hm(t)} · sump ${levelM.toFixed(2)} m of ${r.flooding.dangerLevelM} m danger · ${closed.size} tunnel(s) closed`,
  };
  const totals = r.escape.totals as Record<string, number>;
  const cut = r.escape.people.filter((p) => p.outcome === "cut-off");
  const markers = [
    { at: s.water.failAtMinutes * 60, label: "Pump fails" },
    ...(s.water.backupStartMinutes !== null ? [{ at: s.water.backupStartMinutes * 60, label: "Backup starts" }] : []),
    { at: s.evacuationOrderMinutes * 60, label: "Evacuation ordered" },
    ...(r.flooding.firstDangerSeconds !== null ? [{ at: r.flooding.firstDangerSeconds, label: "Route floods" }] : []),
    ...(r.escape.times.t100 !== null ? [{ at: r.escape.times.t100, label: "Last person out" }] : []),
  ].filter((m) => m.at >= Math.max(0, firstRelease - 30) && m.at <= lastEvent);
  const studies = rows(data, "time-to-act-study").filter((x) => x.data.baseRunId === run.id).map((x) => live[x.id] || x);
  return (
    <>
      <section className="fs-panel">
        <div className="fs-section-heading">
          <div>
            <h3>{String(run.data.name)}</h3>
            <p>
              Run {run.id.slice(0, 8)} · model revision {String(run.data.mineModelRevisionNumber)} · input {r.inputHash.slice(0, 12)} · seed {r.escape.seed} · {Object.entries(r.engines).map(([k, v]) => `${k} ${v}`).join(" · ")}
            </p>
          </div>
          <Tag tone="amber">Planning calculation</Tag>
        </div>
        <div className="fs-seg fs-playback-mode" role="group" aria-label="Playback view">
          <button aria-pressed={mode === "3d"} onClick={() => setMode("3d")}>3D mine</button>
          <button aria-pressed={mode === "plan"} onClick={() => setMode("plan")}>Plan</button>
        </div>
        {mode === "3d" ? (
          <Tunnels3D
            model={model}
            colour={colour}
            playback={playback}
            label={playLabel}
            fallback={<PlanView model={model} closed={closed} dots={dots} trails={trails} height={380} label={playLabel} />}
          />
        ) : (
          <PlanView model={model} closed={closed} dots={dots} trails={trails} height={380} label={playLabel} />
        )}
        <div className="fs-timeline">
          <button className="fs-button secondary" aria-label={playing ? "Pause" : "Play"} onClick={() => (t >= lastEvent && setT(Math.max(0, firstRelease - 30)), setPlaying(!playing))}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <input type="range" aria-label="Scenario time" min={Math.max(0, firstRelease - 30)} max={lastEvent} step={1} value={t} onChange={(e) => (setPlaying(false), setT(Number(e.target.value)))} />
          <span>{hm(t)}</span>
        </div>
        <ul className="fs-markers">
          {markers.map((m) => (
            <li key={m.label}>
              <button className="fs-inline-link" onClick={() => setT(m.at)}>
                {m.label}: {hm(m.at)}
              </button>
            </li>
          ))}
        </ul>
        <p className="fs-help">{mode === "3d" ? "People: white = walking, amber = not yet moving, red (pulsing) = cut off. Red tunnels are closed by water; the sump fills with the recorded level. Start positions are assumed." : "Dots: dark = walking, amber = not yet moving, red = cut off. Red tunnels are closed. Start positions are assumed."}</p>
      </section>
      <section className="fs-panel fs-results" aria-label="Results">
        <h3>Results</h3>
        <p className="fs-accounting">
          {totals.simulated} simulated = {totals["reached-exit"]} reached an exit + {totals["reached-refuge"]} at a refuge + <strong>{totals["cut-off"]} cut off</strong> + {totals["still-walking"]} still walking {r.escape.totals.balanced ? "✓ balanced" : "✗ NOT BALANCED"}
        </p>
        <dl className="fs-meta">
          <dt>Time to 50 % / 95 % / everyone at safety</dt>
          <dd>
            {hm(r.escape.times.t50)} / {hm(r.escape.times.t95)} / {hm(r.escape.times.t100)}
          </dd>
          <dt>Sump danger level ({r.flooding.dangerLevelM} m)</dt>
          <dd>{r.flooding.firstDangerSeconds === null ? `not reached within the horizon (peak ${r.flooding.peakLevelM.toFixed(2)} m)` : `reached at ${hm(r.flooding.firstDangerSeconds)}; closes ${r.closures.map((c) => c.tunnelId).join(", ")}`}</dd>
        </dl>
        <h4>Named results</h4>
        {cut.length ? (
          <ul>
            {cut.map((p) => (
              <li key={p.id}>
                <strong>{p.name || p.id}</strong>: {p.label} — {String(p.reason).replace(/at (\d+(?:\.\d+)?) s/, (_, sec: string) => "at " + hm(Number(sec)))}
              </li>
            ))}
          </ul>
        ) : (
          <p>Nobody cut off from their assumed start under these assumptions.</p>
        )}
        <details>
          <summary>Everyone ({r.escape.people.length})</summary>
          <table className="fs-register">
            <caption className="fs-sr-only">Per-person outcomes</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Outcome</th>
                <th scope="col">At</th>
                <th scope="col">Starts moving</th>
              </tr>
            </thead>
            <tbody>
              {r.escape.people.map((p) => (
                <tr key={p.id}>
                  <td>{p.name || p.id}</td>
                  <td>{outcomeText[p.outcome]}{p.targetId ? ` (${p.targetId})` : ""}</td>
                  <td>{hm(p.atSeconds)}</td>
                  <td>{hm(p.releaseSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        <h4>{r.endurance.label}</h4>
        <ul>
          <li>
            Self-rescuer:{" "}
            {r.endurance.selfRescuer.available
              ? `rated ${r.endurance.selfRescuer.ratedMinutes} min; walking time longer than rated for ${r.endurance.selfRescuer.exceeding?.length ? r.endurance.selfRescuer.exceeding.join(", ") : "nobody"} (${r.endurance.selfRescuer.formula})`
              : r.endurance.selfRescuer.reason}
          </li>
          {r.endurance.refuges.map((x) => (
            <li key={x.name}>
              {x.name}: {x.available ? (x.airHours === null || x.airHours === undefined ? x.note : `${x.airHours} h of air for ${x.occupants} (${x.formula})`) : x.reason}
            </li>
          ))}
        </ul>
        {r.congestion && (
          <>
            <h4>Congestion (PedPy)</h4>
            {r.congestion.available ? (
              <ul>
                {(r.congestion.lines || []).map((l) => (
                  <li key={l.line}>
                    {l.line}: {l.available === false ? `unavailable (${l.reason})` : `${l.crossings} crossings between ${hm(l.firstSeconds)} and ${hm(l.lastSeconds)}, peak ${l.peakPerMinute} per minute`}
                  </li>
                ))}
              </ul>
            ) : (
              <p>{r.congestion.reason}</p>
            )}
            <p className="fs-help">{r.congestion.method}</p>
          </>
        )}
        <TimeToAct run={run} studies={studies} post={post} refresh={refresh} />
        <Compare run={run} r={r} runs={runs} />
        <Responses run={run} post={post} refresh={refresh} notify={notify} role={data.workspace.role} />
        <button className="fs-button secondary" onClick={() => download(`foresight-run-${run.id.slice(0, 8)}.json`, { run: run.data, note: "Planning calculation under stated assumptions" })}>
          Export run (JSON)
        </button>
        <details>
          <summary>Assumptions and warnings</summary>
          <pre className="fs-pre">{JSON.stringify({ assumptions: r.escape.assumptions, adapter: r.escape.adapter, closures: r.closures, warnings: r.warnings, peopleSnapshot: run.data.peopleSnapshot, startAssumption: run.data.startAssumption }, null, 2)}</pre>
        </details>
      </section>
    </>
  );
}
function TimeToAct({ run, studies, post, refresh }: { run: Row; studies: Row[]; post: ViewProps["post"]; refresh: ViewProps["refresh"] }) {
  const s = run.data.scenario as { water: { backupPumpId: string | null; failAtMinutes: number } };
  const [f, setF] = useState({ from: s.water.failAtMinutes + 60, to: s.water.failAtMinutes + 120, step: 5 });
  const [error, setError] = useState("");
  if (!s.water.backupPumpId) return <p className="fs-help">Time to act needs a backup pump in the scenario.</p>;
  return (
    <section className="fs-tta" aria-label="Time to act">
      <h4>Time to act: backup pump start</h4>
      {studies.map((st) => {
        const res = st.data.result as { outcome: string; latestSuccessSeconds: number | null; fromSeconds: number; toSeconds: number; stepSeconds: number; testedCount: number; monotonic: boolean; note: string | null; rows: { backupStartSeconds: number; success: boolean; cutOff: number; stillWalking: number }[] } | null;
        return (
          <div key={st.id} className="fs-note">
            {!res ? (
              <p role="status">{st.data.status === "worker-unavailable" ? "Not run: simulation worker unreachable." : "Searching…"}</p>
            ) : (
              <>
                <p className="fs-tta-result">
                  {res.latestSuccessSeconds !== null
                    ? `Latest tested backup start under these assumptions: ${hm(res.latestSuccessSeconds)} (searched ${hm(res.fromSeconds)} to ${hm(res.toSeconds)} in ${res.testedCount} steps of ${hm(res.stepSeconds)})`
                    : `No tested value met the condition (searched ${hm(res.fromSeconds)} to ${hm(res.toSeconds)} in ${res.testedCount} steps).`}
                </p>
                <p className="fs-help">
                  {res.outcome === "boundary not reached in the tested range" ? "Boundary not reached in the tested range: every tested start met the condition. " : ""}
                  Condition: every simulated person reaches an exit or refuge before the horizon. A planning boundary, not a probability.{res.note ? " " + res.note : ""}
                </p>
                <table className="fs-register">
                  <caption className="fs-sr-only">Tested backup start times</caption>
                  <thead>
                    <tr>
                      <th scope="col">Backup starts</th>
                      <th scope="col">Condition met</th>
                      <th scope="col">Cut off</th>
                      <th scope="col">Still walking</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.rows.map((x) => (
                      <tr key={x.backupStartSeconds}>
                        <td>{hm(x.backupStartSeconds)}</td>
                        <td>{x.success ? "Yes" : "No"}</td>
                        <td>{x.cutOff}</td>
                        <td>{x.stillWalking}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        );
      })}
      <div className="fs-inline-fields">
        <Field label="Search from (min)">
          <input type="number" value={f.from} onChange={(e) => setF({ ...f, from: Number(e.target.value) })} />
        </Field>
        <Field label="to (min)">
          <input type="number" value={f.to} onChange={(e) => setF({ ...f, to: Number(e.target.value) })} />
        </Field>
        <Field label="step (min)">
          <input type="number" value={f.step} onChange={(e) => setF({ ...f, step: Number(e.target.value) })} />
        </Field>
      </div>
      <ErrorText message={error} />
      <button
        className="fs-button"
        onClick={() =>
          void post("escape/time-to-act", { name: `Time to act for ${String(run.data.name)}`, runId: run.id, fromMinutes: f.from, toMinutes: f.to, stepMinutes: f.step })
            .then(refresh)
            .catch((e) => setError(e.message))
        }
      >
        Find latest backup start
      </button>
    </section>
  );
}
function Compare({ run, r, runs }: { run: Row; r: Result; runs: Row[] }) {
  const others = runs.filter((x) => x.id !== run.id && x.data.result);
  const [otherId, setOtherId] = useState("");
  const o = others.find((x) => x.id === otherId)?.data.result as Result | undefined;
  if (!others.length) return null;
  const line = (label: string, a: string, b: string) => (
    <tr>
      <th scope="row">{label}</th>
      <td>{a}</td>
      <td>{b}</td>
    </tr>
  );
  return (
    <section>
      <h4>Compare</h4>
      <select aria-label="Compare with run" value={otherId} onChange={(e) => setOtherId(e.target.value)}>
        <option value="">Choose a completed run</option>
        {others.map((x) => (
          <option key={x.id} value={x.id}>
            {String(x.data.name)} ({x.id.slice(0, 8)})
          </option>
        ))}
      </select>
      {o && (
        <table className="fs-register">
          <caption className="fs-sr-only">Run comparison</caption>
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col">This run</th>
              <th scope="col">Compared run</th>
            </tr>
          </thead>
          <tbody>
            {line("Cut off", String(r.escape.totals["cut-off"]), String(o.escape.totals["cut-off"]))}
            {line("Reached safety", String(Number(r.escape.totals["reached-exit"]) + Number(r.escape.totals["reached-refuge"])), String(Number(o.escape.totals["reached-exit"]) + Number(o.escape.totals["reached-refuge"])))}
            {line("Everyone out (T100)", hm(r.escape.times.t100), hm(o.escape.times.t100))}
            {line("Sump danger level reached", hm(r.flooding.firstDangerSeconds), hm(o.flooding.firstDangerSeconds))}
          </tbody>
        </table>
      )}
    </section>
  );
}
function Responses({ run, post, refresh, notify, role }: { run: Row; post: ViewProps["post"]; refresh: ViewProps["refresh"]; notify: ViewProps["notify"]; role: string }) {
  const [reason, setReason] = useState(""), [owner, setOwner] = useState(""), [error, setError] = useState("");
  if (role !== "supervisor" && role !== "administrator") return null;
  const due = new Date(Date.now() + 7 * 86400e3).toISOString();
  return (
    <section>
      <h4>Responses</h4>
      <div className="fs-inline-fields">
        <Field label="Owner">
          <input value={owner} onChange={(e) => setOwner(e.target.value)} />
        </Field>
        <Field label="Reason or action">
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <ErrorText message={error} />
      <div className="fs-button-row">
        <button className="fs-button secondary" disabled={owner.length < 2 || reason.length < 3} onClick={() => void post(`escape/runs/${run.id}/response`, { title: reason, owner, dueAt: due }).then(async () => (notify("Planning response created. It never sends messages."), await refresh())).catch((e) => setError(e.message))}>
          Create planning response
        </button>
        <button className="fs-button danger" disabled={owner.length < 2 || reason.length < 3} onClick={() => void post(`escape/runs/${run.id}/escalate`, { reason, owner, dueAt: due }).then(async () => (notify("Scenario escalated: escalation record and register entry created."), await refresh())).catch((e) => setError(e.message))}>
          Escalate
        </button>
      </div>
    </section>
  );
}
const WaterLab = dynamic(() => import("./simulator").then((m) => m.Simulator), { loading: () => <p role="status">Loading water laboratory…</p> });
export function Scenarios(props: ViewProps) {
  const [tab, setTab] = useState(() => (typeof location !== "undefined" && location.hash.startsWith("#simulator") ? "water" : "escape"));
  return (
    <>
      {tab === "escape" && (
        <div className="fs-page-heading">
          <div>
            <h1>Scenarios</h1>
            <p>What happens if a pump fails: who could be cut off from their assumed start, and the latest tested backup start. Planning calculations, never a safety certification.</p>
          </div>
        </div>
      )}
      <div className="fs-tabs" role="tablist" aria-label="Scenario type">
        <button role="tab" aria-selected={tab === "escape"} onClick={() => setTab("escape")}>
          Escape and time to act
        </button>
        <button role="tab" aria-selected={tab === "water"} onClick={() => setTab("water")}>
          Water laboratory
        </button>
      </div>
      {tab === "escape" ? <EscapeScenarios {...props} /> : <WaterLab {...props} />}
    </>
  );
}
