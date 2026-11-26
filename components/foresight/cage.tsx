"use client";
// Cage and hoist evacuation (spec 9.7). Every figure shown comes from a
// recorded run of the SimPy worker; nothing is estimated in the browser except
// where a person is at a chosen moment, which is read from the run's cycles.
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { Pause, Play } from "lucide-react";
import type { MineModel } from "@/lib/domain/mine-model";
import { zoneColour } from "./mine";
import type { Playback } from "./tunnels-3d";
import { ErrorText, Field, rows, Tag, type Row, type ViewProps } from "./shared";

const Tunnels3D = dynamic(() => import("./tunnels-3d"), { ssr: false, loading: () => <p role="status">Loading 3D view…</p> });
const sec = (s: number | null | undefined) => (s === null || s === undefined ? "not reached" : s >= 60 ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s` : `${Math.round(s)} s`);

type Person = { id: string; name: string | null; level: string; arrivedAt: number; route: "cage" | "ladder" | null; surfaceAt: number | null; reason: string | null; cageTrips: number; movedToLadderAt: number | null; aboardAt: number | null };
type Result = {
  engine: string;
  simpy: string;
  inputHash: string;
  totals: { people: number; byCage: number; byLadder: number; notReached: number; balanced: boolean };
  lastSurfaceSeconds: number | null;
  lastReachedSeconds: number | null;
  people: Person[];
  queueSeries: { level: string; points: [number, number][] }[];
  cycles: { startSeconds: number; level: string; boarded: number; completed: boolean; endSeconds: number | null }[];
  outages: { fromSeconds: number; toSeconds: number | null }[];
  effect: { baselineLastSurfaceSeconds: number | null; withFailureLastSurfaceSeconds: number | null; delaySeconds: number | null; movedToLadder: number } | null;
  assumptions: string[];
  warnings: string[];
  horizonSeconds: number;
};
type ShaftInput = { cageCapacity: number; loadingSeconds: number; unloadSeconds: number | null; ladderClimbSeconds: number | null; levels: { level: string; junction: string; tripSeconds: number }[] };

export function CageScenarios({ data, post, refresh, notify }: ViewProps) {
  const published = rows(data, "mine-model-revision").find((r) => r.data.status === "published");
  const model = published?.data.model as MineModel | undefined;
  const runs = rows(data, "cage-run").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const [selectedId, setSelectedId] = useState<string | null>(runs[0]?.id || null);
  const [live, setLive] = useState<Record<string, Row>>({});
  const selected = selectedId ? live[selectedId] || runs.find((r) => r.id === selectedId) || null : null;
  useEffect(() => {
    const pending = runs.filter((r) => ["queued", "running"].includes(String((live[r.id] || r).data.status)));
    if (!pending.length) return;
    const timer = setInterval(async () => {
      for (const r of pending) {
        const res = await fetch(`/api/workspace/cage/runs/${r.id}`, { cache: "no-store" });
        if (!res.ok) continue;
        const next = (await res.json()) as Row;
        setLive((l) => ({ ...l, [r.id]: next }));
        if (next.data.status === "completed") void refresh();
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [runs, live, refresh]);
  if (!model || !published) return <p>Publish a mine model before running cage scenarios.</p>;
  const hoists = model.exits.filter((e) => e.hoist);
  return (
    <section className="fs-scenarios" aria-label="Cage and hoist scenarios">
      <div className="fs-page-heading">
        <div>
          <h2 className="fs-embedded-title">Cage and hoist evacuation</h2>
          <p>How long it takes to bring people up a shaft by cage, and what a hoist failure does. Planning calculation under stated assumptions, never a safety certification.</p>
        </div>
      </div>
      {!hoists.length ? (
        <section className="fs-panel">
          <p>No shaft in the published mine model has hoist data. Enter the cage capacity, loading time and trip times in the mine model first.</p>
        </section>
      ) : (
        <div className="fs-scenario-grid">
          <Builder data={data} model={model} post={post} onStarted={async (r) => (setSelectedId(r.id), await refresh(), notify("Cage scenario submitted to the simulation worker."))} />
          <div className="fs-scenario-main">
            {selected ? <RunView key={selected.id + String(selected.data.status)} run={selected} model={model} /> : <section className="fs-panel"><p>No cage runs yet. Build a scenario on the left.</p></section>}
            <section className="fs-panel">
              <h3>Saved cage runs</h3>
              <ul className="fs-runs">
                {runs.map((r) => {
                  const res = (live[r.id] || r).data.result as Result | null;
                  return (
                    <li key={r.id}>
                      <button className={"fs-inline-link " + (r.id === selectedId ? "active" : "")} onClick={() => setSelectedId(r.id)}>
                        {String(r.data.name)}
                      </button>{" "}
                      <Tag tone={r.data.status === "completed" ? "teal" : ["failed", "worker-unavailable"].includes(String(r.data.status)) ? "red" : "amber"}>{String((live[r.id] || r).data.status)}</Tag>{" "}
                      <small>{res ? `last up ${sec(res.lastSurfaceSeconds)}` : ""} · model rev {String(r.data.mineModelRevisionNumber)}</small>
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>
        </div>
      )}
    </section>
  );
}

function Builder({ data, model, post, onStarted }: { data: ViewProps["data"]; model: MineModel; post: ViewProps["post"]; onStarted: (r: Row) => Promise<void> }) {
  const hoists = model.exits.filter((e) => e.hoist);
  const escapeRuns = rows(data, "escape-run").filter((r) => r.data.status === "completed");
  const [f, setF] = useState({ name: `${hoists[0].name} hoist failure`, exitId: hoists[0].id, source: "declared" as "declared" | "escape-run" | "manual", escapeRunId: escapeRuns[0]?.id || "", assembly: "0", fail: true, failAt: "10", restore: false, restoreAt: "40", unload: "", horizon: "240" });
  const exit = hoists.find((e) => e.id === f.exitId)!;
  const [manual, setManual] = useState<Record<string, string>>({});
  const [arrive, setArrive] = useState("0");
  const [error, setError] = useState("");
  const [check, setCheck] = useState<{ ok: boolean; problems: string[]; warnings: string[]; people: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const declared = rows(data, "check-in").filter((c) => ["declared-underground", "return-overdue", "confirmed-missing"].includes(String(c.data.status)) && c.data.shaftId === exit.shaftId).length;
  const body = () => ({
    name: f.name,
    shaftExitId: f.exitId,
    source: f.source,
    escapeRunId: f.source === "escape-run" ? f.escapeRunId || null : null,
    manual: f.source === "manual" ? exit.hoist!.tripSecondsByLevel.map((l) => ({ level: l.level, count: Number(manual[l.level] || 0), arriveMinutes: Number(arrive) })).filter((m) => m.count > 0) : [],
    assemblyMinutes: Number(f.assembly),
    outages: f.fail ? [{ fromMinutes: Number(f.failAt), toMinutes: f.restore ? Number(f.restoreAt) : null }] : [],
    unloadSeconds: f.unload.trim() === "" ? null : Number(f.unload),
    horizonMinutes: Number(f.horizon),
  });
  async function go(run: boolean) {
    setBusy(true);
    setError("");
    try {
      if (!run) setCheck(await post("cage/preflight", body()));
      else {
        const r = await post("cage/runs", body());
        setCheck(null);
        await onStarted(r);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const h = exit.hoist!;
  return (
    <section className="fs-panel fs-builder" aria-label="Cage scenario builder">
      <h3>Build a cage scenario</h3>
      <Field label="Name">
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <Field label="Shaft">
        <select value={f.exitId} onChange={(e) => setF({ ...f, exitId: e.target.value })}>
          {hoists.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </Field>
      <fieldset className="fs-group">
        <legend>From the mine model (edit in Mine → Edit)</legend>
        <p className="fs-help">
          Cage holds {h.cageCapacity ?? "not entered"} · loading {h.loadingSeconds ?? "not entered"} s · ladder climb {exit.ladderClimbSeconds === null ? "not entered" : `${exit.ladderClimbSeconds} s`}
          <br />
          Trip to the surface: {h.tripSecondsByLevel.map((l) => `${l.level} ${l.seconds} s`).join(", ") || "no level entered"}
        </p>
      </fieldset>
      <fieldset className="fs-group">
        <legend>People waiting</legend>
        <Field label="Source">
          <select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value as typeof f.source })}>
            <option value="declared">Declared underground at this shaft ({declared} now)</option>
            <option value="escape-run">People an escape run brought to this shaft</option>
            <option value="manual">Enter numbers by level</option>
          </select>
        </Field>
        {f.source === "declared" && (
          <Field label="Minutes until they are at the shaft station" help="Declared zones do not say which level someone is on, so everyone is placed at the station level.">
            <input type="number" min={0} value={f.assembly} onChange={(e) => setF({ ...f, assembly: e.target.value })} />
          </Field>
        )}
        {f.source === "escape-run" && (
          <Field label="Escape run">
            <select value={f.escapeRunId} onChange={(e) => setF({ ...f, escapeRunId: e.target.value })}>
              <option value="">Choose a completed run</option>
              {escapeRuns.map((r) => (
                <option key={r.id} value={r.id}>
                  {String(r.data.name)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {f.source === "manual" && (
          <>
            {h.tripSecondsByLevel.map((l) => (
              <Field key={l.level} label={`People at ${l.level}`}>
                <input type="number" min={0} value={manual[l.level] ?? ""} onChange={(e) => setManual({ ...manual, [l.level]: e.target.value })} />
              </Field>
            ))}
            <Field label="Minutes until they are ready to ride">
              <input type="number" min={0} value={arrive} onChange={(e) => setArrive(e.target.value)} />
            </Field>
          </>
        )}
      </fieldset>
      <fieldset className="fs-group">
        <legend>Hoist availability</legend>
        <label className="fs-3d-check">
          <input type="checkbox" checked={f.fail} onChange={(e) => setF({ ...f, fail: e.target.checked })} /> The hoist fails
        </label>
        {f.fail && (
          <>
            <Field label="Hoist fails at (min)">
              <input type="number" min={0} value={f.failAt} onChange={(e) => setF({ ...f, failAt: e.target.value })} />
            </Field>
            <label className="fs-3d-check">
              <input type="checkbox" checked={f.restore} onChange={(e) => setF({ ...f, restore: e.target.checked })} /> It is repaired
            </label>
            {f.restore && (
              <Field label="Back in service at (min)">
                <input type="number" min={0} value={f.restoreAt} onChange={(e) => setF({ ...f, restoreAt: e.target.value })} />
              </Field>
            )}
          </>
        )}
      </fieldset>
      <details className="fs-advanced">
        <summary>Advanced assumptions</summary>
        <Field label="Unloading time at the surface (s, blank = same as loading)">
          <input type="number" min={0} value={f.unload} onChange={(e) => setF({ ...f, unload: e.target.value })} />
        </Field>
        <Field label="Horizon (min)">
          <input type="number" min={5} value={f.horizon} onChange={(e) => setF({ ...f, horizon: e.target.value })} />
        </Field>
      </details>
      {check && (
        <div className={"fs-note " + (check.ok ? "" : "fs-tone-red")} role="status">
          {check.ok ? `Preflight passed: ${check.people} people.` : <>Preflight blocks this run:<ul>{check.problems.map((p) => <li key={p}>{p}</li>)}</ul></>}
          {check.warnings.map((w) => <p key={w}>{w}</p>)}
        </div>
      )}
      <ErrorText message={error} />
      <div className="fs-button-row">
        <button className="fs-button secondary" disabled={busy} onClick={() => void go(false)}>
          Check inputs
        </button>
        <button className="fs-button" disabled={busy} onClick={() => void go(true)}>
          Run cage scenario
        </button>
      </div>
    </section>
  );
}

/** Where the cage and every person are at time t, read from the run's recorded cycles. */
function stateAt(run: Row, r: Result, t: number, station: { x: number; y: number }, exitId: string) {
  const shaft = run.data.shaftInput as ShaftInput;
  const trip = Object.fromEntries(shaft.levels.map((l) => [l.level, l.tripSeconds]));
  const L = shaft.loadingSeconds, U = shaft.unloadSeconds ?? shaft.loadingSeconds;
  const outage = r.outages.find((o) => t >= o.fromSeconds && (o.toSeconds === null || t < o.toSeconds)) || null;
  let fraction = 1, aboard = 0;
  const posIn = (T: number, start: number, tt: number) => (tt < start + T ? 1 - (tt - start) / T : tt < start + T + L ? 0 : tt < start + 2 * T + L ? (tt - (start + T + L)) / T : 1);
  for (const c of r.cycles) {
    if (t < c.startSeconds) break;
    const T = trip[c.level];
    if (c.completed) {
      const end = c.startSeconds + 2 * T + L + U;
      if (t <= end) {
        fraction = posIn(T, c.startSeconds, t);
        aboard = t >= c.startSeconds + T && t < end ? c.boarded : 0;
      }
    } else {
      const hit = r.outages.find((o) => o.fromSeconds > c.startSeconds);
      const ft = hit?.fromSeconds ?? t;
      if (t >= c.startSeconds) {
        // Frozen where it was when the hoist failed; back at the surface once repaired.
        fraction = hit && hit.toSeconds !== null && t >= hit.toSeconds ? 1 : posIn(T, c.startSeconds, Math.min(t, ft));
        aboard = 0;
      }
    }
  }
  const people: Playback["people"] = [];
  let waiting = 0, inCage = 0, surfaced = 0, climbing = 0;
  for (const p of r.people) {
    if (t < p.arrivedAt) continue;
    const T = trip[p.level];
    if (p.surfaceAt !== null && t >= p.surfaceAt) {
      surfaced++;
      continue;
    }
    if (p.route === "cage" && p.surfaceAt !== null) {
      const boardAt = p.surfaceAt - (T + L + T + U) + T;
      if (t >= boardAt) {
        inCage++;
        people.push({ id: p.id, x: station.x, y: station.y, tone: "walking", shaft: { exitId, fraction } });
        continue;
      }
    }
    if (p.route === "ladder" && p.movedToLadderAt !== null && t >= p.movedToLadderAt) {
      if (p.surfaceAt !== null) {
        climbing++;
        people.push({ id: p.id, x: station.x, y: station.y, tone: "walking", shaft: { exitId, fraction: (t - p.movedToLadderAt) / (p.surfaceAt - p.movedToLadderAt) } });
      } else people.push({ id: p.id, x: station.x, y: station.y, tone: "cut-off", label: p.name || p.id, shaft: { exitId, fraction: 0 } });
      continue;
    }
    waiting++;
    people.push({ id: p.id, x: station.x, y: station.y, tone: "waiting", shaft: { exitId, fraction: 0 } });
  }
  return { fraction, aboard, failed: Boolean(outage), people, waiting, inCage, surfaced, climbing };
}

function RunView({ run, model }: { run: Row; model: MineModel }) {
  const r = run.data.result as Result | null;
  const status = String(run.data.status);
  const colour = useMemo(() => zoneColour(model), [model]);
  const exit = model.exits.find((e) => e.name === run.data.shaftName);
  const junction = model.junctions.find((j) => j.id === run.data.stationJunction);
  const horizon = r?.horizonSeconds ?? 0;
  const tEnd = r ? Math.min(horizon, Math.max(60, (r.lastReachedSeconds ?? 0) + 60, ...r.cycles.map((c) => c.endSeconds ?? c.startSeconds), ...r.outages.map((o) => o.fromSeconds + 120))) : 0;
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setT((x) => (x >= tEnd ? (setPlaying(false), x) : Math.min(tEnd, x + tEnd / 150))), 100);
    return () => clearInterval(timer);
  }, [playing, tEnd]);
  if (status === "worker-unavailable")
    return (
      <section className="fs-panel">
        <h3>{String(run.data.name)}</h3>
        <p className="fs-tone-red">Not run: the simulation worker is not reachable. {String(run.data.error || "")}</p>
        <p className="fs-help">No result is shown in its place.</p>
      </section>
    );
  if (!r)
    return (
      <section className="fs-panel" role="status">
        <h3>{String(run.data.name)}</h3>
        <p>{status === "failed" ? `Run failed: ${String(run.data.error)}` : "Calculating in the simulation worker…"}</p>
      </section>
    );
  const state = junction && exit ? stateAt(run, r, t, junction, exit.id) : null;
  const playback: Playback | undefined = state && exit
    ? {
        people: state.people,
        closed: new Set(),
        cage: { exitId: exit.id, fraction: state.fraction, aboard: state.aboard, failed: state.failed },
        clock: `${sec(t)} · ${state.waiting} waiting · ${state.inCage} in cage · ${state.climbing} on ladder · ${state.surfaced}/${r.totals.people} at surface${state.failed ? " · HOIST FAILED" : ""}`,
      }
    : undefined;
  return (
    <>
      <section className="fs-panel">
        <div className="fs-section-heading">
          <div>
            <h3>{String(run.data.name)}</h3>
            <p>
              {String(run.data.shaftName)} · model revision {String(run.data.mineModelRevisionNumber)} · input {r.inputHash.slice(0, 12)} · {r.engine} (SimPy {r.simpy})
            </p>
          </div>
          <Tag tone="amber">Planning calculation</Tag>
        </div>
        <Tunnels3D model={model} colour={colour} playback={playback} label={`Cage playback at ${sec(t)}`} />
        <div className="fs-timeline">
          <button className="fs-button secondary" aria-label={playing ? "Pause" : "Play"} onClick={() => (t >= tEnd && setT(0), setPlaying(!playing))}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <input type="range" aria-label="Scenario time" min={0} max={Math.round(tEnd)} step={1} value={Math.round(t)} onChange={(e) => (setPlaying(false), setT(Number(e.target.value)))} />
          <span>{sec(t)}</span>
        </div>
        <p className="fs-help">White = riding the cage or climbing the ladderway, amber = waiting at the station, red = cannot reach the surface. The cage turns red while the hoist is out of service.</p>
      </section>
      <section className="fs-panel fs-results" aria-label="Cage results">
        <h3>Results</h3>
        <p className="fs-accounting">
          {r.totals.people} people = {r.totals.byCage} by cage + {r.totals.byLadder} by the ladderway + <strong>{r.totals.notReached} not reached</strong> {r.totals.balanced ? "✓ balanced" : "✗ NOT BALANCED"}
        </p>
        <dl className="fs-meta">
          <dt>Last person at the surface</dt>
          <dd>
            {r.lastSurfaceSeconds === null ? (
              <>
                <strong>Not reached</strong>: {r.totals.notReached} people are not at the surface by the {sec(r.horizonSeconds)} horizon{r.lastReachedSeconds !== null ? `; the last person who did arrive was up at ${sec(r.lastReachedSeconds)}` : ""}
              </>
            ) : (
              sec(r.lastSurfaceSeconds)
            )}
          </dd>
          {r.effect && (
            <>
              <dt>Without a hoist failure</dt>
              <dd>{sec(r.effect.baselineLastSurfaceSeconds)}</dd>
              <dt>Effect of the failure</dt>
              <dd>
                {r.effect.delaySeconds === null ? "cannot be compared (someone is not reached)" : `${r.effect.delaySeconds >= 0 ? "+" : ""}${sec(Math.abs(r.effect.delaySeconds))} ${r.effect.delaySeconds >= 0 ? "later" : "earlier"}`} · {r.effect.movedToLadder} moved to the ladderway
              </dd>
            </>
          )}
        </dl>
        <QueueChart r={r} />
        <h4>Cage trips</h4>
        <div className="fs-table-wrap">
          <table className="fs-register">
            <thead>
              <tr>
                <th scope="col">Starts</th>
                <th scope="col">Level</th>
                <th scope="col">Carried</th>
                <th scope="col">At the surface</th>
              </tr>
            </thead>
            <tbody>
              {r.cycles.map((c, i) => (
                <tr key={i}>
                  <td>{sec(c.startSeconds)}</td>
                  <td>{c.level}</td>
                  <td>{c.boarded}</td>
                  <td>{c.completed ? sec(c.endSeconds) : "interrupted by the hoist failure"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details>
          <summary>Each person ({r.people.length})</summary>
          <div className="fs-table-wrap">
            <table className="fs-register">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Level</th>
                  <th scope="col">Ready at</th>
                  <th scope="col">Route</th>
                  <th scope="col">At the surface</th>
                </tr>
              </thead>
              <tbody>
                {r.people.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name || p.id}</td>
                    <td>{p.level}</td>
                    <td>{sec(p.arrivedAt)}</td>
                    <td>{p.route === "cage" ? "Cage" : p.route === "ladder" ? "Ladderway" : "—"}</td>
                    <td>{p.surfaceAt !== null ? sec(p.surfaceAt) : `Not reached: ${p.reason ?? ""}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
        <h4>Assumptions</h4>
        <ul>
          {(run.data.assumptionsNote as string[]).map((a) => (
            <li key={a}>{a}</li>
          ))}
          {r.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        {r.warnings.map((w) => (
          <p key={w} className="fs-tone-red">
            {w}
          </p>
        ))}
      </section>
    </>
  );
}

const palette = ["#2b5ea7", "#b0661b", "#0b7a75", "#7a4fa3"];
function QueueChart({ r }: { r: Result }) {
  const W = 560, H = 170, pad = 34;
  const tMax = Math.max(60, ...r.queueSeries.flatMap((s) => s.points.map((p) => p[0])), ...r.outages.map((o) => o.fromSeconds), r.lastReachedSeconds ?? 0);
  const yMax = Math.max(1, ...r.queueSeries.flatMap((s) => s.points.map((p) => p[1])));
  const x = (t: number) => pad + (t / tMax) * (W - pad - 8);
  const y = (n: number) => H - 22 - (n / yMax) * (H - 40);
  return (
    <figure className="fs-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="People waiting for the cage over time, by level" width="100%">
        {r.outages.map((o, i) => (
          <rect key={i} x={x(o.fromSeconds)} y={8} width={Math.max(2, x(o.toSeconds ?? tMax) - x(o.fromSeconds))} height={H - 30} fill="#d92d20" opacity={0.12} />
        ))}
        <line x1={pad} x2={W - 8} y1={y(0)} y2={y(0)} stroke="#9aa8b4" />
        <line x1={pad} x2={pad} y1={8} y2={y(0)} stroke="#9aa8b4" />
        <text x={4} y={14} fontSize={11} fill="#576776">{yMax}</text>
        <text x={pad - 4} y={H - 8} fontSize={11} fill="#576776">0</text>
        <text x={W - 70} y={H - 8} fontSize={11} fill="#576776">{sec(tMax)}</text>
        {r.queueSeries.map((s, i) => {
          const pts = [...s.points, [tMax, s.points[s.points.length - 1][1]]];
          const d = pts.map((p, k) => (k === 0 ? `M ${x(p[0])} ${y(p[1])}` : `L ${x(p[0])} ${y(pts[k - 1][1])} L ${x(p[0])} ${y(p[1])}`)).join(" ");
          return <path key={s.level} d={d} fill="none" stroke={palette[i % palette.length]} strokeWidth={2.2} />;
        })}
      </svg>
      <figcaption>
        People waiting for the cage ({r.queueSeries.map((s, i) => <span key={s.level} style={{ color: palette[i % palette.length] }}>● {s.level} </span>)}){r.outages.length ? "; shaded = hoist out of service" : ""}
      </figcaption>
    </figure>
  );
}
