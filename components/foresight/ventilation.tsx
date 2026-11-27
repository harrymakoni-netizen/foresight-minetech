"use client";
// Ventilation (spec 9.8): steady airflow by Hardy Cross, fan failure, door and
// blocked-airway what-ifs, and screening gas dilution and re-entry estimates.
// Every figure comes from a recorded worker run.
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import type { MineModel } from "@/lib/domain/mine-model";
import { zoneColour } from "./mine";
import type { Playback } from "./tunnels-3d";
import { naturalVentilationPressure } from "@/lib/domain/ventilation";
import { ErrorText, Field, rows, Tag, type Row, type ViewProps } from "./shared";

const Tunnels3D = dynamic(() => import("./tunnels-3d"), { ssr: false, loading: () => <p role="status">Loading 3D view…</p> });
type Airway = { id: string; from: string; to: string; flowM3s: number; fixed: boolean; reversedFromDrawn: boolean; velocityMs?: number; pressureDropPa?: number; fanPressureRisePa?: number | null; fanPowerW?: number | null; fanCurve?: { flowM3s: number; pressureRisePa: number; rangeM3s: [number, number]; inRange: boolean; reverseFlow: boolean }; naturalPressurePa?: number };
type Solution = { converged: boolean; tolerance: number; maxIterations: number; iterations: number; finalMaxCorrection: number; loops: number; continuityResidualM3s: number; pressureClosureResidualPa: number; airways: Airway[]; sections: { nodes: string[]; status: string; note?: string }[]; fanWarnings?: { id: string; problem: string }[] };
type Gas = { airwayId: string; releaseM3s: number; concentration: Record<string, number>; stagnant: boolean; recirculation: boolean; notes: string[] };
type Reentry = { seconds: number | null; volumeM3: number; flowM3s: number; startFraction: number; limitFraction: number; formula: string; note: string };
type State = { solution: Solution; gas?: Gas; reentry?: Reentry };
type Result = {
  engine: string;
  verification: { closedFormChecks: { name: string; passed: boolean; maxAbsError: number; tolerance: number }[]; textbook: { status: string; note: string }; note: string };
  states: { baseline: State; scenario?: State };
  comparison: { airways: { id: string; baselineM3s: number; scenarioM3s: number; deltaM3s: number; reversedVsBaseline: boolean; stoppedVsBaseline: boolean }[]; reversed: string[]; stopped: string[] } | null;
  assumptions: string[];
};
const q = (n: number) => (Math.abs(n) < 1e-9 ? "0" : n.toFixed(2));
const mins = (s: number | null) => (s === null ? "does not clear" : s < 90 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`);
const pct = (f: number) => `${(f * 100).toPrecision(3)} %`;

export function VentilationScenarios({ data, post, refresh, notify }: ViewProps) {
  const published = rows(data, "mine-model-revision").find((r) => r.data.status === "published");
  const model = published?.data.model as MineModel | undefined;
  const runs = rows(data, "ventilation-run").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const [selectedId, setSelectedId] = useState<string | null>(runs[0]?.id || null);
  const [live, setLive] = useState<Record<string, Row>>({});
  const stored = runs.find((r) => r.id === selectedId) || null;
  const polled = selectedId ? live[selectedId] : undefined;
  const selected = polled && (!stored || polled.revision >= stored.revision) ? polled : stored;
  useEffect(() => {
    const pending = runs.filter((r) => ["queued", "running"].includes(String((live[r.id] || r).data.status)));
    if (!pending.length) return;
    const t = setInterval(async () => {
      for (const r of pending) {
        const res = await fetch(`/api/workspace/ventilation/runs/${r.id}`, { cache: "no-store" });
        if (!res.ok) continue;
        const next = (await res.json()) as Row;
        setLive((l) => ({ ...l, [r.id]: next }));
        if (next.data.status === "completed") void refresh();
      }
    }, 1200);
    return () => clearInterval(t);
  }, [runs, live, refresh]);
  if (!model || !published) return <p>Publish a mine model before running ventilation scenarios.</p>;
  return (
    <section className="fs-scenarios" aria-label="Ventilation scenarios">
      <div className="fs-page-heading">
        <div>
          <h2 className="fs-embedded-title">Ventilation, gas and re-entry</h2>
          <p>Steady airflow through the tunnel network, what a fan failure or a door change does to it, and screening estimates of gas dilution and re-entry time. Planning calculations, never a safety certification.</p>
        </div>
      </div>
      <div className="fs-scenario-grid">
        <Builder data={data} model={model} post={post} onStarted={async (r) => (setSelectedId(r.id), await refresh(), notify("Ventilation scenario submitted to the simulation worker."))} />
        <div className="fs-scenario-main">
          {selected ? <RunView key={selected.id + String(selected.data.status)} run={selected} model={model} /> : <section className="fs-panel"><p>No ventilation runs yet. Build a scenario on the left.</p></section>}
          <section className="fs-panel">
            <h3>Saved ventilation runs</h3>
            <ul className="fs-runs">
              {runs.map((r) => (
                <li key={r.id}>
                  <button className={"fs-inline-link " + (r.id === selectedId ? "active" : "")} onClick={() => setSelectedId(r.id)}>
                    {String(r.data.name)}
                  </button>{" "}
                  <Tag tone={r.data.status === "completed" ? "teal" : ["failed", "worker-unavailable"].includes(String(r.data.status)) ? "red" : "amber"}>{String((live[r.id] || r).data.status)}</Tag> <small>model rev {String(r.data.mineModelRevisionNumber)}</small>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </section>
  );
}

function Builder({ data, model, post, onStarted }: { data: ViewProps["data"]; model: MineModel; post: ViewProps["post"]; onStarted: (r: Row) => Promise<void> }) {
  void data;
  const [name, setName] = useState(model.fans[0] ? `${model.fans[0].name} failure` : "Ventilation scenario");
  const [failed, setFailed] = useState<string[]>(model.fans[0] ? [model.fans[0].id] : []);
  const [doors, setDoors] = useState<Record<string, "" | "open" | "closed">>({});
  const [blocked, setBlocked] = useState<string[]>([]);
  const [gasOn, setGasOn] = useState(false);
  const [rel, setRel] = useState({ tunnel: model.tunnels[0]?.id || "", rate: "", limit: "" });
  const [nat, setNat] = useState<{ tunnelId: string; pressure: string }[]>([]);
  const [helper, setHelper] = useState({ height: "", cold: "", warm: "", pressure: "" });
  const [reOn, setReOn] = useState(false);
  const [re, setRe] = useState({ tunnels: [] as string[], feed: model.tunnels[0]?.id || "", start: "" });
  const [check, setCheck] = useState<{ ok: boolean; problems: string[]; warnings: string[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const body = () => ({
    name,
    fanFailures: failed,
    doorChanges: Object.entries(doors).filter(([, v]) => v).map(([doorId, v]) => ({ doorId, open: v === "open" })),
    blockedTunnels: blocked,
    naturalVentilation: nat.filter((n) => n.pressure.trim() !== "").map((n) => ({ tunnelId: n.tunnelId, pressurePa: Number(n.pressure) })),
    gas: gasOn ? { releaseTunnelId: rel.tunnel, releaseM3s: Number(rel.rate), limitFraction: Number(rel.limit) / 100 } : null,
    reentry: gasOn && reOn ? { tunnelIds: re.tunnels, feedTunnelId: re.feed, startFraction: Number(re.start) / 100 } : null,
  });
  async function go(run: boolean) {
    setBusy(true);
    setError("");
    try {
      if (!run) setCheck(await post("ventilation/preflight", body()));
      else {
        const r = await post("ventilation/runs", body());
        setCheck(null);
        await onStarted(r);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const toggle = (list: string[], set: (v: string[]) => void, id: string, on: boolean) => set(on ? [...list, id] : list.filter((x) => x !== id));
  return (
    <section className="fs-panel fs-builder" aria-label="Ventilation scenario builder">
      <h3>Build a ventilation scenario</h3>
      <p className="fs-help">Resistances and fan duties come from the mine model (Mine → Table). A failed fan stops pushing air and its airway stays open. The result is compared with the model as it stands.</p>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <fieldset className="fs-group">
        <legend>Fans that fail</legend>
        {model.fans.length === 0 && <p className="fs-muted">The model has no fans.</p>}
        {model.fans.map((f) => (
          <label key={f.id} className="fs-3d-check">
            <input type="checkbox" checked={failed.includes(f.id)} onChange={(e) => toggle(failed, setFailed, f.id, e.target.checked)} /> {f.name} ({f.fixedDutyM3s === null ? "duty not entered" : `${f.fixedDutyM3s} m³/s`})
          </label>
        ))}
      </fieldset>
      <fieldset className="fs-group">
        <legend>Doors</legend>
        {model.doors.length === 0 && <p className="fs-muted">The model has no doors.</p>}
        {model.doors.map((d) => (
          <Field key={d.id} label={`${d.name} (now ${d.open ? "open" : "closed"})`}>
            <select value={doors[d.id] || ""} onChange={(e) => setDoors({ ...doors, [d.id]: e.target.value as "" | "open" | "closed" })}>
              <option value="">No change</option>
              <option value="open">Open it</option>
              <option value="closed">Close it</option>
            </select>
          </Field>
        ))}
      </fieldset>
      <details className="fs-advanced">
        <summary>Blocked airways ({blocked.length})</summary>
        {model.tunnels.map((t) => (
          <label key={t.id} className="fs-3d-check">
            <input type="checkbox" checked={blocked.includes(t.id)} onChange={(e) => toggle(blocked, setBlocked, t.id, e.target.checked)} /> {t.id} {t.name}
          </label>
        ))}
      </details>
      <details className="fs-advanced">
        <summary>Natural ventilation pressure ({nat.length})</summary>
        <p className="fs-help">A pressure you enter, in pascals, added to an airway (positive pushes air from its first junction to its second). It applies to the baseline and the scenario alike. It only moves air where it has a closed circuit to go round. The helper below uses your own readings; nothing is assumed.</p>
        {nat.map((n, i) => (
          <div key={i} className="fs-button-row">
            <select aria-label="Airway" value={n.tunnelId} onChange={(e) => setNat(nat.map((x, j) => (j === i ? { ...x, tunnelId: e.target.value } : x)))}>
              {model.tunnels.map((t) => <option key={t.id} value={t.id}>{t.id} {t.name}</option>)}
            </select>
            <input aria-label="Pressure (Pa)" inputMode="decimal" placeholder="Pa" value={n.pressure} onChange={(e) => setNat(nat.map((x, j) => (j === i ? { ...x, pressure: e.target.value } : x)))} />
            <button className="fs-button secondary" onClick={() => setNat(nat.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <button className="fs-button secondary" onClick={() => setNat([...nat, { tunnelId: model.tunnels[0]?.id || "", pressure: "" }])}>Add natural pressure</button>
        <p className="fs-help">Helper: pressure from a temperature difference over a height.</p>
        <Field label="Vertical height (m)"><input inputMode="decimal" value={helper.height} onChange={(e) => setHelper({ ...helper, height: e.target.value })} /></Field>
        <Field label="Cold column temperature (°C)"><input inputMode="decimal" value={helper.cold} onChange={(e) => setHelper({ ...helper, cold: e.target.value })} /></Field>
        <Field label="Warm column temperature (°C)"><input inputMode="decimal" value={helper.warm} onChange={(e) => setHelper({ ...helper, warm: e.target.value })} /></Field>
        <Field label="Surface air pressure (Pa)"><input inputMode="decimal" value={helper.pressure} onChange={(e) => setHelper({ ...helper, pressure: e.target.value })} /></Field>
        {[helper.height, helper.cold, helper.warm, helper.pressure].every((x) => x.trim() !== "" && Number.isFinite(Number(x))) && (
          <p role="status">≈ {naturalVentilationPressure({ heightM: Number(helper.height), coldC: Number(helper.cold), warmC: Number(helper.warm), surfacePressurePa: Number(helper.pressure) }).toFixed(1)} Pa. Type it into an airway above if it applies there.</p>
        )}
      </details>
      <fieldset className="fs-group">
        <legend>Gas release and re-entry (screening)</legend>
        <label className="fs-3d-check">
          <input type="checkbox" checked={gasOn} onChange={(e) => setGasOn(e.target.checked)} /> Estimate gas dilution
        </label>
        {gasOn && (
          <>
            <p className="fs-help">There are no defaults here: the release rate must come from fume-emission data and the limit from your site&apos;s rules.</p>
            <Field label="Release in tunnel">
              <select value={rel.tunnel} onChange={(e) => setRel({ ...rel, tunnel: e.target.value })}>
                {model.tunnels.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id} {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Release rate (m³/s of gas)">
              <input inputMode="decimal" value={rel.rate} onChange={(e) => setRel({ ...rel, rate: e.target.value })} />
            </Field>
            <Field label="Concentration limit (% by volume)">
              <input inputMode="decimal" value={rel.limit} onChange={(e) => setRel({ ...rel, limit: e.target.value })} />
            </Field>
            <label className="fs-3d-check">
              <input type="checkbox" checked={reOn} onChange={(e) => setReOn(e.target.checked)} /> Estimate re-entry time for a work area
            </label>
            {reOn && (
              <>
                <Field label="Starting concentration after the blast (% by volume)">
                  <input inputMode="decimal" value={re.start} onChange={(e) => setRe({ ...re, start: e.target.value })} />
                </Field>
                <Field label="Tunnel that feeds the area with air">
                  <select value={re.feed} onChange={(e) => setRe({ ...re, feed: e.target.value })}>
                    {model.tunnels.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.id} {t.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <details className="fs-advanced" open>
                  <summary>Tunnels in the work area ({re.tunnels.length})</summary>
                  {model.tunnels.map((t) => (
                    <label key={t.id} className="fs-3d-check">
                      <input type="checkbox" checked={re.tunnels.includes(t.id)} onChange={(e) => setRe({ ...re, tunnels: e.target.checked ? [...re.tunnels, t.id] : re.tunnels.filter((x) => x !== t.id) })} /> {t.id} {t.name}
                    </label>
                  ))}
                </details>
              </>
            )}
          </>
        )}
      </fieldset>
      {check && (
        <div className={"fs-note " + (check.ok ? "" : "fs-tone-red")} role="status">
          {check.ok ? "Preflight passed." : <>Preflight blocks this run:<ul>{check.problems.map((p) => <li key={p}>{p}</li>)}</ul></>}
          {check.warnings.map((w) => <p key={w}>{w}</p>)}
        </div>
      )}
      <ErrorText message={error} />
      <div className="fs-button-row">
        <button className="fs-button secondary" disabled={busy} onClick={() => void go(false)}>
          Check inputs
        </button>
        <button className="fs-button" disabled={busy} onClick={() => void go(true)}>
          Run ventilation scenario
        </button>
      </div>
    </section>
  );
}

function RunView({ run, model }: { run: Row; model: MineModel }) {
  const r = run.data.result as Result | null;
  const status = String(run.data.status);
  const colour = useMemo(() => zoneColour(model), [model]);
  const [view, setView] = useState<"baseline" | "scenario">(() => (r?.states.scenario ? "scenario" : "baseline"));
  if (status === "worker-unavailable")
    return (
      <section className="fs-panel">
        <h3>{String(run.data.name)}</h3>
        <p className="fs-tone-red">Not run: the simulation worker is not reachable. {String(run.data.error || "")}</p>
      </section>
    );
  if (!r)
    return (
      <section className="fs-panel" role="status">
        <h3>{String(run.data.name)}</h3>
        <p>{status === "failed" ? `Run failed: ${String(run.data.error)}` : "Calculating in the simulation worker…"}</p>
      </section>
    );
  const st = r.states[view] || r.states.baseline;
  const flows = Object.fromEntries(st.solution.airways.filter((a) => !a.id.startsWith("SURF-")).map((a) => [a.id, a.flowM3s]));
  const playback: Playback = { people: [], closed: new Set(), flows, clock: `${view === "scenario" ? "Scenario" : "Baseline"} · airflow (brighter = faster, arrows show direction)` };
  const cmp = new Map((r.comparison?.airways || []).map((a) => [a.id, a]));
  const name = (id: string) => model.tunnels.find((t) => t.id === id)?.name || (id.startsWith("SURF-") ? "Surface connection" : "");
  return (
    <>
      <section className="fs-panel">
        <div className="fs-section-heading">
          <div>
            <h3>{String(run.data.name)}</h3>
            <p>model revision {String(run.data.mineModelRevisionNumber)} · {r.engine}</p>
          </div>
          <Tag tone="amber">Planning calculation</Tag>
        </div>
        <div className="fs-note" role="note" aria-label="Verification status">
          <strong>Verification.</strong> The solver reproduces {r.verification.closedFormChecks.filter((c) => c.passed).length} of {r.verification.closedFormChecks.length} closed-form cases within {r.verification.closedFormChecks[0]?.tolerance} m³/s, and its answers satisfy continuity and the pressure law on every airway.{" "}
          <strong>It has not yet been checked against a published textbook worked example</strong>: {r.verification.textbook.note} A match with a textbook verifies the solver, not a real mine.
        </div>
        {r.states.scenario && (
          <div className="fs-seg" role="group" aria-label="State shown in 3D" style={{ margin: "10px 0" }}>
            <button aria-pressed={view === "baseline"} onClick={() => setView("baseline")}>Baseline</button>
            <button aria-pressed={view === "scenario"} onClick={() => setView("scenario")}>Scenario</button>
          </div>
        )}
        <Tunnels3D model={model} colour={colour} playback={playback} label="Airflow through the tunnel network" />
      </section>
      <section className="fs-panel fs-results" aria-label="Ventilation results">
        <h3>Results</h3>
        <p className="fs-accounting">
          {st.solution.converged ? "✓ converged" : "✗ NOT CONVERGED"}: {st.solution.loops} loop(s), {st.solution.iterations} iteration(s), tolerance {st.solution.tolerance} m³/s (limit {st.solution.maxIterations} iterations), largest last correction {st.solution.finalMaxCorrection.toExponential(1)} m³/s; continuity residual {st.solution.continuityResidualM3s.toExponential(1)} m³/s, pressure closure {st.solution.pressureClosureResidualPa.toExponential(1)} Pa.
        </p>
        {(st.solution.fanWarnings || []).map((w) => (
          <p key={w.id} className="fs-tone-red">Fan on {w.id}: {w.problem}. Treat this airway&apos;s result with caution.</p>
        ))}
        {st.solution.sections.filter((s) => s.status !== "solved").map((s, i) => (
          <p key={i} className={s.status === "infeasible" ? "fs-tone-red" : "fs-help"}>
            Section {s.nodes.slice(0, 4).join(", ")}{s.nodes.length > 4 ? "…" : ""}: {s.status}. {s.note}
          </p>
        ))}
        {r.comparison && (
          <p>
            <strong>{r.comparison.stopped.length}</strong> airway(s) lose all flow and <strong>{r.comparison.reversed.length}</strong> reverse against the baseline{r.comparison.reversed.length ? ` (${r.comparison.reversed.join(", ")})` : ""}.
          </p>
        )}
        <div className="fs-table-wrap">
          <table className="fs-register">
            <thead>
              <tr>
                <th scope="col">Airway</th>
                {r.comparison ? (
                  <>
                    <th scope="col">Baseline flow (m³/s)</th>
                    <th scope="col">Scenario flow (m³/s)</th>
                  </>
                ) : (
                  <th scope="col">Flow (m³/s)</th>
                )}
                <th scope="col">{r.comparison ? `Speed in ${view} (m/s)` : "Speed (m/s)"}</th>
                <th scope="col">{r.comparison ? `Pressure in ${view} (Pa)` : "Pressure drop (Pa)"}</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {st.solution.airways.filter((a) => !a.id.startsWith("SURF-")).map((a) => {
                const c = cmp.get(a.id);
                return (
                  <tr key={a.id}>
                    <td>{a.id} <small className="fs-block">{name(a.id)}</small></td>
                    {r.comparison ? (
                      <>
                        <td>{c ? q(c.baselineM3s) : "—"}</td>
                        <td>{c ? q(c.scenarioM3s) : "—"}</td>
                      </>
                    ) : (
                      <td>{q(a.flowM3s)}</td>
                    )}
                    <td>{a.velocityMs === undefined ? "size not entered" : a.velocityMs.toFixed(2)}</td>
                    <td>{a.fanCurve ? `fan curve rise ${a.fanCurve.pressureRisePa.toFixed(0)}` : a.fixed ? (a.fanPressureRisePa == null ? "—" : `fan rise ${a.fanPressureRisePa.toFixed(0)} · ${((a.fanPowerW || 0) / 1000).toFixed(1)} kW`) : (a.pressureDropPa ?? 0).toFixed(1)}</td>
                    <td>
                      {(a.fixed || a.fanCurve) && <Tag>fan</Tag>} {a.naturalPressurePa ? <Tag>natural pressure {a.naturalPressurePa} Pa</Tag> : null} {a.reversedFromDrawn && <Tag tone="amber">against drawn direction</Tag>} {c?.reversedVsBaseline && <Tag tone="red">reverses in the scenario</Tag>} {c?.stoppedVsBaseline && <Tag tone="red">stops in the scenario</Tag>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {st.gas && (
          <>
            <h4>Gas dilution (screening estimate)</h4>
            {st.gas.stagnant ? <p className="fs-tone-red">{st.gas.notes[0]}</p> : (
              <ul>
                {Object.entries(st.gas.concentration).map(([id, c]) => (
                  <li key={id}>
                    {id} {name(id)}: {pct(c)}
                  </li>
                ))}
              </ul>
            )}
            {st.gas.notes.filter((n) => !st.gas!.stagnant || n !== st.gas!.notes[0]).map((n) => <p key={n} className="fs-help">{n}</p>)}
          </>
        )}
        {(r.states.baseline.reentry || r.states.scenario?.reentry) && (
          <>
            <h4>Re-entry estimate (screening)</h4>
            <ul>
              <li>Baseline: {mins(r.states.baseline.reentry?.seconds ?? null)}{r.states.baseline.reentry ? ` (V ${r.states.baseline.reentry.volumeM3.toFixed(0)} m³, Q ${r.states.baseline.reentry.flowM3s.toFixed(2)} m³/s)` : ""}</li>
              {r.states.scenario?.reentry && <li>Scenario: {mins(r.states.scenario.reentry.seconds)} ({r.states.scenario.reentry.note})</li>}
            </ul>
            <p className="fs-help">{r.states.baseline.reentry?.formula}, assuming full mixing and a constant airflow through the work area. It needs fume-emission data and is not a clearance to re-enter.</p>
          </>
        )}
        <h4>Assumptions</h4>
        <ul>
          {r.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        {(run.data.warnings as string[]).map((w) => <p key={w} className="fs-help">⚠ {w}</p>)}
      </section>
    </>
  );
}
