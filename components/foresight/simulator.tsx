"use client";
import { ResponseCase } from "./response-case";
import { useEffect, useState } from "react";
import {
  Play,
  Square,
  GitCompareArrows,
  Save,
  Download,
  ArrowRight,
} from "lucide-react";
import {
  scenarioSchema,
  pumpFailureDemonstration,
  type Scenario,
  type SimulationResult,
} from "@/lib/domain/scenario";
import {
  date,
  Empty,
  ErrorText,
  Field,
  Tag,
  download,
  rows,
  type ViewProps,
  type Row,
} from "./shared";
export function Simulator({ data, post, refresh, notify }: ViewProps) {
  const [scenario, setScenario] = useState<Scenario | null>(null),
    [name, setName] = useState("Backup pump comparison"),
    [accepted, setAccepted] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [active, setActive] = useState<Row | null>(null),
    [index, setIndex] = useState(0),
    [baselineId, setBaselineId] = useState(""),
    [advanced, setAdvanced] = useState(""),
    [dirty, setDirty] = useState(false),
    [backupDelay, setBackupDelay] = useState(1),
    [demonstration, setDemonstration] = useState(false),
    [playing, setPlaying] = useState(false);
  const [evaluation, setEvaluation] = useState<any>(null);
  const [ranges, setRanges] = useState({
    inflowLow: 16,
    inflowHigh: 20,
    pumpLow: 10,
    pumpHigh: 14,
    delayLow: 0.5,
    delayHigh: 2,
    samples: 100,
  });
  const sensitivity =
    active?.data.result?.modelId === "bounded-sensitivity-v1"
      ? active.data.result
      : null;
  const runs = rows(data, "run"),
    completed = runs.filter(
      (r) => r.data.status === "completed" && !r.data.sensitivity,
    ),
    result = (sensitivity ? undefined : active?.data.result) as
      SimulationResult | undefined,
    baseline = completed.find((r) => r.id === baselineId)?.data.result as
      SimulationResult | undefined;
  async function task(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!active || !["queued", "running"].includes(active.data.status)) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const response = await fetch("/api/workspace/runs/" + active.id, {
            headers: { "X-Workspace-Id": data.workspace.id },
          }),
          run = await response.json();
        if (!response.ok) throw new Error(run.message);
        if (!stopped) {
          setActive(run);
          if (!["queued", "running"].includes(run.data.status)) {
            await refresh();
            setIndex(0);
          }
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active?.id, active?.data.status, data.workspace.id, refresh]);
  useEffect(() => {
    if (!playing || !result) return;
    const timer = setInterval(
      () =>
        setIndex((i) => {
          if (i >= result.series.length - 1) {
            setPlaying(false);
            return i;
          }
          return i + 1;
        }),
      180,
    );
    return () => clearInterval(timer);
  }, [playing, result]);
  function edit(fn: (s: Scenario) => void) {
    if (!scenario) return;
    const next = structuredClone(scenario);
    fn(next);
    setScenario(next);
    setAdvanced(JSON.stringify(next, null, 2));
    setDirty(true);
    setDemonstration(false);
    setPlaying(false);
  }
  async function clone() {
    const response = await post("snapshots");
    setDemonstration(false);
    setScenario(response.scenarioTemplate);
    setAdvanced(JSON.stringify(response.scenarioTemplate, null, 2));
    setDirty(true);
    setAccepted(false);
    notify(
      "Workspace snapshot frozen. Physical parameters are fictional assumptions until measured values are configured.",
    );
    await refresh();
  }
  async function execute(withBackup: boolean) {
    if (!scenario) throw new Error("Clone a snapshot first.");
    if (!accepted)
      throw new Error("Review and accept the laboratory assumptions.");
    const input = structuredClone(scenario);
    if (demonstration) {
      const demo = pumpFailureDemonstration(input, withBackup ? 1 : 4);
      Object.assign(input, demo);
      setScenario(demo);
      setBackupDelay(withBackup ? 1 : 4);
      setAdvanced(JSON.stringify(demo, null, 2));
    }
    if (!withBackup && !demonstration)
      input.events = input.events.filter(
        (e) => !(e.type === "pump_availability" && e.pumpId === "P2"),
      );
    const parsed = scenarioSchema.parse(input);
    const saved = await post("scenarios", {
      name: demonstration
        ? `Primary failure · backup at ${withBackup ? "one hour" : "four hours"}`
        : name + (withBackup ? " · backup" : " · baseline"),
      baselineSnapshotId: parsed.baselineSnapshotId,
      scenario: parsed,
      assumptionsAccepted: true,
    });
    const run = await post(`scenarios/${saved.id}/runs`);
    if (active?.data.status === "completed") setBaselineId(active.id);
    setActive(run);
    setDirty(false);
    setIndex(0);
    await refresh();
  }
  async function sensitivityRun() {
    if (!scenario || !accepted)
      throw new Error("Review the scenario and assumptions first.");
    const saved = await post("scenarios", {
      name: name + " · sensitivity",
      baselineSnapshotId: scenario.baselineSnapshotId,
      scenario,
      assumptionsAccepted: true,
    });
    const run = await post(`scenarios/${saved.id}/sensitivity`, {
      samples: ranges.samples,
      seed: scenario.seed,
      inflowM3s: [ranges.inflowLow / 3600, ranges.inflowHigh / 3600],
      pumpCapacityM3s: [ranges.pumpLow / 3600, ranges.pumpHigh / 3600],
      backupDelaySeconds: [ranges.delayLow * 3600, ranges.delayHigh * 3600],
    });
    setActive(run);
    setDirty(false);
    await refresh();
  }
  function setRun(run: Row) {
    setActive(run);
    setIndex(0);
    setPlaying(false);
    const input = run.data.scenario as Scenario;
    setScenario(input);
    setAdvanced(JSON.stringify(input, null, 2));
    setDirty(false);
    setAccepted(true);
    setDemonstration(false);
    if (baselineId === run.id) setBaselineId("");
    const start = input.events.find(
      (e) => e.type === "pump_availability" && e.pumpId === "P2" && e.available,
    );
    setBackupDelay(start ? start.atSeconds / 3600 : 0);
    setName(
      String(
        data.entities.find((e) => e.id === run.data.scenarioId)?.data.name ||
          "Saved run",
      ),
    );
  }
  const point = result?.series[Math.min(index, result.series.length - 1)],
    nodeId =
      active?.data.scenario?.nodes[0]?.id || scenario?.nodes[0].id || "S1";
  return (
    <>
      <div className="fs-page-heading">
        <div>
          <div className="fs-eyebrow">LABORATORY / WATER AND MOVEMENT</div>
          <h1>Simulator Lab</h1>
          <p>
            Change assumptions. Calculate outcomes. Compare the consequences
            over time.
          </p>
        </div>
        <button
          className="fs-button secondary"
          disabled={busy}
          onClick={() => void task(clone)}
        >
          Clone current workspace <ArrowRight size={16} />
        </button>
      </div>
      <div className="fs-lab-notice">
        <FlaskIcon />
        <div>
          <strong>Fictional laboratory · results require human review</strong>
          <p>
            Water accumulation, effective pumping and assumed movement only. No
            field calibration or automatic control.
          </p>
        </div>
        <Tag>lumped-water-v1</Tag>
      </div>
      <ErrorText message={error} />
      {result?.status === "completed" && (
        <section className="fs-panel" aria-label="Main calculated outcome">
          <h2>{String(active?.data.name || "Calculated water outcome")}</h2>
          <p>
            Final storage{" "}
            <strong>{result.summary.finalStorageM3.toFixed(2)} m³</strong> ·
            peak level{" "}
            <strong>
              {peakLevel(
                active?.data.scenario,
                nodeId,
                result.summary.peakVolumeM3[nodeId],
              ).toFixed(2)}{" "}
              m
            </strong>
            .
          </p>
          <p>
            {result.thresholds
              .map(
                (t) =>
                  `${t.label}: ${t.firstCrossingSeconds === null ? "not crossed in this run" : `crossed at ${formatElapsed(t.firstCrossingSeconds)}`}`,
              )
              .join(". ")}
            .
          </p>
          {baseline && (
            <p role="status">
              Under these fictional assumptions, the selected run ends with{" "}
              {result.summary.finalStorageM3.toFixed(2)} m³ of water, compared
              with {baseline.summary.finalStorageM3.toFixed(2)} m³ in the
              comparison run (
              {Math.abs(
                baseline.summary.finalStorageM3 - result.summary.finalStorageM3,
              ).toFixed(2)}{" "}
              m³{" "}
              {baseline.summary.finalStorageM3 >= result.summary.finalStorageM3
                ? "less"
                : "more"}
              ). Compare the saved assumptions as well as the outcome.
            </p>
          )}
        </section>
      )}
      <details className="fs-panel">
        <summary>Verification and independent evaluation status</summary>
        <button
          className="fs-button secondary"
          onClick={() =>
            void task(async () => {
              const response = await fetch("/api/workspace/evaluation");
              if (!response.ok)
                throw new Error("Evaluation evidence unavailable.");
              setEvaluation(await response.json());
            })
          }
        >
          Load recorded evaluation evidence
        </button>
        {evaluation && (
          <>
            <p>
              Constructed numerical cases: {evaluation.numerical.passed} passed,{" "}
              {evaluation.numerical.failed} failed. Independent review: pending.
            </p>
            <p>
              Text: {evaluation.text.candidates} provisional candidates,{" "}
              {evaluation.text.independentlyReviewed} independently reviewed.
              Provider quality evaluation has not run.
            </p>
            <p>
              Vision: {evaluation.vision.sourceClips} licensed/consented clips
              supplied. PPE accuracy and live alert latency are unverified.
            </p>
            <ul>
              {evaluation.numerical.limitations.map((x: string) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <pre>
              {JSON.stringify(
                evaluation.numerical.performance24h3nodes6pumps,
                null,
                2,
              )}
            </pre>
          </>
        )}
      </details>
      {!scenario ? (
        <section className="fs-panel">
          <Empty title="Start with a frozen snapshot">
            Clone current workspace conditions. The builder identifies
            unavailable physical measurements and offers clearly labelled
            fictional assumptions.
          </Empty>
          {completed.length > 0 && (
            <SavedRuns runs={completed} onSelect={setRun} />
          )}
        </section>
      ) : (
        <div className="fs-simulator-grid">
          <aside className="fs-panel fs-scenario-builder">
            <div className="fs-section-heading">
              <h2>Scenario builder</h2>
              <Tag tone="teal">SI engine</Tag>
            </div>
            <small className="fs-break">
              Baseline {scenario.baselineSnapshotId}
              <br />
              {date(scenario.timeOrigin)}
            </small>
            <div className="fs-note">
              <strong>Input quality: assumed</strong>
              <p>
                Storage geometry, inflow, pump capacity and starting positions
                are fictional. No measured physical baseline is configured.
              </p>
            </div>
            <details>
              <summary>Fictional pump-failure exercise</summary>
              <p>
                Assume 30 m³ initially, 18 m³/h inflow, 30 m² storage area, 150
                m³ capacity, primary pumping 12 m³/h failing at 1 h, and backup
                pumping 24 m³/h. Compare activation at 4 h and 1 h over 6 h. The
                reviewed fictional 2 m limit restricts the direct route at 2 h
                20 min in the delayed run. Assumed movement departs at 2 h 18
                min, so the direct traversal overlaps that restriction. All
                values and the crew location are assumptions.
              </p>
              <button
                type="button"
                className="fs-button secondary"
                onClick={() => {
                  const demo = pumpFailureDemonstration(scenario, 4);
                  setScenario(demo);
                  setAdvanced(JSON.stringify(demo, null, 2));
                  setName("Primary failure exercise");
                  setBackupDelay(4);
                  setDemonstration(true);
                  setAccepted(false);
                  setDirty(true);
                }}
              >
                Load fictional pump-failure exercise
              </button>
            </details>
            {demonstration && (
              <p role="status">
                Exercise loaded. Review the assumptions, run delayed backup
                first, then earlier backup. Editing an input leaves exercise
                mode so your changes are preserved.
              </p>
            )}
            <form
              className="fs-form"
              onSubmit={(e) => {
                e.preventDefault();
                void task(() => execute(true));
              }}
            >
              <Field label="Scenario name">
                <input
                  required
                  minLength={3}
                  maxLength={100}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setDemonstration(false);
                    setDirty(true);
                  }}
                />
              </Field>
              <div className="fs-form-columns">
                <Field label="Horizon (hours)">
                  <input
                    type="number"
                    min={1}
                    max={24}
                    step={1}
                    value={scenario.horizonSeconds / 3600}
                    onChange={(e) =>
                      edit((s) => {
                        s.horizonSeconds = Number(e.target.value) * 3600;
                        s.events = s.events.filter(
                          (e) => e.atSeconds <= s.horizonSeconds,
                        );
                      })
                    }
                  />
                </Field>
                <Field label="Output interval (seconds)">
                  <input
                    type="number"
                    min={10}
                    max={3600}
                    step={10}
                    value={scenario.outputIntervalSeconds}
                    onChange={(e) =>
                      edit((s) => {
                        s.outputIntervalSeconds = Number(e.target.value);
                      })
                    }
                  />
                </Field>
              </div>
              <h3>Water storage · {scenario.nodes[0].zoneId}</h3>
              <Field
                label="External inflow (m³/hour)"
                help="Explicit assumption, not inferred from qualitative reports."
              >
                <input
                  type="number"
                  min={0}
                  max={360000}
                  step="any"
                  value={round(scenario.nodes[0].inflowM3s * 3600)}
                  onChange={(e) =>
                    edit((s) => {
                      s.nodes[0].inflowM3s = Number(e.target.value) / 3600;
                    })
                  }
                />
              </Field>
              <Field label="Initial stored volume (m³)">
                <input
                  type="number"
                  min={0}
                  max={scenario.nodes[0].geometry.at(-1)?.volumeM3}
                  step="any"
                  value={scenario.nodes[0].initialVolumeM3}
                  onChange={(e) =>
                    edit((s) => {
                      s.nodes[0].initialVolumeM3 = Number(e.target.value);
                    })
                  }
                />
              </Field>
              <Field label="Constant storage area (m²)">
                <input
                  type="number"
                  min={1}
                  max={100000}
                  step="any"
                  value={round(
                    scenario.nodes[0].geometry.at(-1)!.volumeM3 /
                      (scenario.nodes[0].geometry.at(-1)!.levelM -
                        scenario.nodes[0].geometry[0].levelM),
                  )}
                  onChange={(e) =>
                    edit((s) => {
                      const last = s.nodes[0].geometry.at(-1)!;
                      s.nodes[0].geometry = [
                        s.nodes[0].geometry[0],
                        {
                          ...last,
                          volumeM3:
                            Number(e.target.value) *
                            (last.levelM - s.nodes[0].geometry[0].levelM),
                        },
                      ];
                    })
                  }
                />
              </Field>
              <h3>Effective pumps</h3>
              {scenario.pumps.map((p, i) => (
                <div className="fs-pump-input" key={p.id}>
                  <Field label={`${p.id} capacity (m³/hour)`}>
                    <input
                      type="number"
                      min={0}
                      max={360000}
                      step="any"
                      value={round(p.capacityM3s * 3600)}
                      onChange={(e) =>
                        edit((s) => {
                          s.pumps[i].capacityM3s =
                            Number(e.target.value) / 3600;
                        })
                      }
                    />
                  </Field>
                  <label className="fs-checkbox">
                    <input
                      type="checkbox"
                      checked={p.available}
                      onChange={(e) =>
                        edit((s) => {
                          s.pumps[i].available = e.target.checked;
                        })
                      }
                    />
                    Available at start
                  </label>
                </div>
              ))}
              <Field label="Primary P1 failure time (hours; blank means no scheduled failure)">
                <input
                  type="number"
                  min={0}
                  max={scenario.horizonSeconds / 3600}
                  step="any"
                  value={
                    scenario.events.find(
                      (e) =>
                        e.type === "pump_availability" &&
                        e.pumpId === "P1" &&
                        !e.available,
                    )?.atSeconds === undefined
                      ? ""
                      : scenario.events.find(
                          (e) =>
                            e.type === "pump_availability" &&
                            e.pumpId === "P1" &&
                            !e.available,
                        )!.atSeconds / 3600
                  }
                  onChange={(e) =>
                    edit((s) => {
                      s.events = s.events.filter(
                        (x) =>
                          !(
                            x.type === "pump_availability" &&
                            x.pumpId === "P1" &&
                            !x.available
                          ),
                      );
                      if (e.target.value !== "")
                        s.events.push({
                          type: "pump_availability",
                          atSeconds: Number(e.target.value) * 3600,
                          pumpId: "P1",
                          available: false,
                        });
                    })
                  }
                />
              </Field>
              <Field label="Backup P2 start delay (hours)">
                <input
                  type="number"
                  min={0}
                  max={scenario.horizonSeconds / 3600}
                  step={0.25}
                  value={backupDelay}
                  onChange={(e) => {
                    setBackupDelay(Number(e.target.value));
                    edit((s) => {
                      s.events = s.events.filter(
                        (e) =>
                          !(
                            e.type === "pump_availability" && e.pumpId === "P2"
                          ),
                      );
                      s.events.push({
                        type: "pump_availability",
                        atSeconds: Number(e.target.value) * 3600,
                        pumpId: "P2",
                        available: true,
                      });
                    });
                  }}
                />
              </Field>
              <Field label="Response delay (minutes)">
                <input
                  type="number"
                  min={0}
                  max={120}
                  value={scenario.movements[0].responseDelaySeconds / 60}
                  onChange={(e) =>
                    edit((s) => {
                      s.movements[0].responseDelaySeconds =
                        Number(e.target.value) * 60;
                    })
                  }
                />
              </Field>
              <label className="fs-checkbox">
                <input
                  type="checkbox"
                  checked={
                    scenario.routeGraph.edges[0].availability === "blocked"
                  }
                  onChange={(e) =>
                    edit((s) => {
                      s.routeGraph.edges[0].availability = e.target.checked
                        ? "blocked"
                        : "available";
                    })
                  }
                />
                Manually restrict direct east route
              </label>
              <label className="fs-checkbox">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                I reviewed these fictional assumptions and the planning
                limitations.
              </label>
              <div className="fs-button-row">
                <button className="fs-button" disabled={busy || !accepted}>
                  <Play size={15} />
                  {busy
                    ? "Submitting…"
                    : demonstration
                      ? "Run earlier backup (1 h)"
                      : "Run with backup"}
                </button>
                <button
                  type="button"
                  className="fs-button secondary"
                  disabled={busy || !accepted}
                  onClick={() => void task(() => execute(false))}
                >
                  {demonstration ? "Run delayed backup (4 h)" : "Run baseline"}
                </button>
              </div>
            </form>
            <details>
              <summary>Advanced scenario and scheduled events</summary>
              <p>
                Versioned SI contract supports three nodes, six pumps, directed
                transfers, outages, piecewise geometry and route changes.
              </p>
              <Field label="Scenario JSON">
                <textarea
                  rows={14}
                  value={advanced}
                  onChange={(e) => setAdvanced(e.target.value)}
                />
              </Field>
              <button
                className="fs-button secondary"
                onClick={() =>
                  void task(async () => {
                    const parsed = scenarioSchema.parse(JSON.parse(advanced));
                    setScenario(parsed);
                    setDemonstration(false);
                    setDirty(true);
                  })
                }
              >
                Apply edited contract
              </button>
            </details>
            <details>
              <summary>Bounded sensitivity run</summary>
              <p>
                Seeded uniform samples of stated ranges. This produces an
                assumption envelope, not calibrated probabilities.
              </p>
              <div className="fs-form-columns">
                {[
                  ["inflowLow", "Inflow minimum (m³/h)"],
                  ["inflowHigh", "Inflow maximum (m³/h)"],
                  ["pumpLow", "P1 minimum (m³/h)"],
                  ["pumpHigh", "P1 maximum (m³/h)"],
                  ["delayLow", "Backup earliest (h)"],
                  ["delayHigh", "Backup latest (h)"],
                  ["samples", "Samples (1–100)"],
                ].map(([key, label]) => (
                  <Field key={key} label={label}>
                    <input
                      type="number"
                      min={0}
                      max={key === "samples" ? 100 : 360000}
                      step="any"
                      value={ranges[key as keyof typeof ranges]}
                      onChange={(e) =>
                        setRanges({ ...ranges, [key]: Number(e.target.value) })
                      }
                    />
                  </Field>
                ))}
              </div>
              <button
                className="fs-button secondary"
                disabled={busy || !accepted}
                onClick={() => void task(sensitivityRun)}
              >
                Run assumption envelope
              </button>
            </details>
            <SavedRuns runs={runs} onSelect={setRun} />
          </aside>
          <section className="fs-lab-results">
            {dirty && active && (
              <div className="fs-alert" role="status">
                Inputs changed. The displayed result belongs to the saved run
                and is outdated for these edits. Run again to calculate new
                outcomes.
              </div>
            )}
            {active && ["queued", "running"].includes(active.data.status) && (
              <div className="fs-panel" role="status">
                <h2>Calculating scenario</h2>
                <progress max={1} value={active.data.progress || 0} />
                <p>
                  {active.data.status} ·{" "}
                  {Math.round((active.data.progress || 0) * 100)}%
                </p>
                <button
                  className="fs-button secondary"
                  onClick={() =>
                    void task(async () => {
                      await post(`runs/${active.id}/cancel`);
                      notify("Cancellation requested.");
                    })
                  }
                >
                  <Square size={14} />
                  Cancel run
                </button>
              </div>
            )}
            {active?.data.status === "dispatch-pending" && (
              <div className="fs-panel">
                <h2>Worker unavailable · run saved</h2>
                <ErrorText
                  message={
                    active.data.error ||
                    "Start the Python worker, then retry this saved run."
                  }
                />
                <button
                  className="fs-button secondary"
                  onClick={() =>
                    void task(async () => {
                      setActive(await post(`runs/${active.id}/retry`));
                      await refresh();
                    })
                  }
                >
                  Retry saved run
                </button>
              </div>
            )}
            {active?.data.status === "failed" && (
              <div className="fs-panel">
                <h2>Run failed</h2>
                <ErrorText
                  message={
                    active.data.error ||
                    "Invalid inputs or conservation check failed."
                  }
                />
              </div>
            )}
            {active?.data.status === "cancelled" && (
              <div className="fs-panel">
                <h2>Run cancelled</h2>
                <p>
                  Partial results are not presented as a completed calculation.
                </p>
              </div>
            )}
            {sensitivity && (
              <section className="fs-panel">
                <h2>Sensitivity envelope</h2>
                <p>{sensitivity.warning}</p>
                <p>
                  {sensitivity.sampleResults.length} samples · seed{" "}
                  {sensitivity.assumptions.seed}
                </p>
                {sensitivity.crossingCounts.map((c: any) => (
                  <p key={c.thresholdId}>
                    {c.thresholdId}: {c.crossed} crossing(s), {c.censored}{" "}
                    censored outcome(s).
                  </p>
                ))}
                <div className="fs-table-scroll">
                  <table>
                    <caption>Volume range from stated assumptions</caption>
                    <thead>
                      <tr>
                        <th>Elapsed h</th>
                        <th>Minimum m³</th>
                        <th>Maximum m³</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sensitivity.envelope.map((p: any) => (
                        <tr key={p.atSeconds}>
                          <td>{(p.atSeconds / 3600).toFixed(3)}</td>
                          <td>{p.minimumVolumeM3.toFixed(3)}</td>
                          <td>{p.maximumVolumeM3.toFixed(3)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button
                  className="fs-button secondary"
                  onClick={() => download("foresight-envelope.json", active)}
                >
                  Export envelope
                </button>
              </section>
            )}
            {result?.status === "completed" ? (
              <>
                <section className="fs-panel">
                  <div className="fs-section-heading">
                    <div>
                      <h2>Calculated water outcomes</h2>
                      <p>
                        {String(active?.data.name || "Saved water run")} ·{" "}
                        {date(active?.createdAt)} · simulated
                      </p>
                    </div>
                    <button
                      className="fs-icon-button"
                      aria-label="Export run"
                      onClick={() =>
                        download("foresight-run.json", {
                          run: active,
                          scenario: active?.data.scenario,
                        })
                      }
                    >
                      <Download size={18} />
                    </button>
                  </div>
                  <div className="fs-lab-metrics">
                    <div>
                      <small>Final storage</small>
                      <strong>
                        {result.summary.finalStorageM3.toFixed(2)} <em>m³</em>
                      </strong>
                    </div>
                    <div>
                      <small>Overflow retained</small>
                      <strong>
                        {result.summary.overflowM3.toFixed(2)} <em>m³</em>
                      </strong>
                    </div>
                    <div>
                      <small>Peak level</small>
                      <strong>
                        {peakLevel(
                          active?.data.scenario,
                          nodeId,
                          result.summary.peakVolumeM3[nodeId],
                        ).toFixed(2)}{" "}
                        <em>m</em>
                      </strong>
                    </div>
                  </div>
                  <Field label="Compare with completed run">
                    <select
                      value={baselineId}
                      onChange={(e) => setBaselineId(e.target.value)}
                    >
                      <option value="">Select baseline</option>
                      {completed
                        .filter((r) => r.id !== active?.id)
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {String(
                              data.entities.find(
                                (e) => e.id === r.data.scenarioId,
                              )?.data.name || r.id.slice(0, 8),
                            )}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <WaterChart
                    result={result}
                    baseline={baseline}
                    nodeId={nodeId}
                  />
                  <div className="fs-chart-legend">
                    <span>
                      <i />
                      Selected run
                    </span>
                    {baseline && (
                      <span>
                        <i className="baseline" />
                        Comparison run
                      </span>
                    )}
                    <small>
                      Matched axes · level in metres · elapsed hours
                    </small>
                  </div>
                  <label className="fs-field">
                    <span>
                      Playback:{" "}
                      {point ? (point.atSeconds / 3600).toFixed(2) : 0} hours
                    </span>
                    <input
                      aria-label="Calculated result playback time"
                      type="range"
                      min={0}
                      max={result.series.length - 1}
                      value={index}
                      onChange={(e) => {
                        setIndex(Number(e.target.value));
                        setPlaying(false);
                      }}
                    />
                  </label>
                  <div className="fs-button-row">
                    <button
                      className="fs-button secondary"
                      onClick={() => setPlaying(!playing)}
                    >
                      {playing ? "Pause playback" : "Play calculated series"}
                    </button>
                    <Tag>
                      {point?.nodes[nodeId]?.levelM.toFixed(3)} m at selected
                      time
                    </Tag>
                    <Tag>{point?.nodes[nodeId]?.volumeM3.toFixed(3)} m³</Tag>
                  </div>
                  <p className="fs-muted">
                    Playback reads the saved series. It does not rerun the model
                    or generate random outcomes.
                  </p>
                </section>
                <div className="fs-two-columns">
                  <section className="fs-panel">
                    <h2>Thresholds and routes</h2>
                    {result.thresholds.map((t) => (
                      <div className="fs-history-item" key={t.id}>
                        <strong>{t.label}</strong>
                        <p>
                          {t.censored
                            ? "Not crossed within the run (censored)"
                            : `First crossed at ${(t.firstCrossingSeconds! / 3600).toFixed(3)} hours`}
                        </p>
                      </div>
                    ))}
                    {result.routes.movements.map((m) => (
                      <div className="fs-history-item" key={m.id}>
                        <Tag
                          tone={m.allStartingNodesFeasible ? "teal" : "amber"}
                        >
                          {m.allStartingNodesFeasible
                            ? "Route found under assumptions"
                            : "No route for some starting assumptions"}
                        </Tag>
                        <p>{m.assumption}</p>
                        {m.alternatives.map((a) => (
                          <p key={a.startingNode}>
                            {a.startingNode}:{" "}
                            {a.status === "route-found"
                              ? `${a.travelSeconds?.toFixed(0)} seconds via ${a.edgeSequence?.join(" → ")}`
                              : "No route found under this model"}
                          </p>
                        ))}
                      </div>
                    ))}
                    <small>{result.routes.method}</small>
                  </section>
                  <details className="fs-panel">
                    <summary>
                      Mass balance, hashes and technical assumptions
                    </summary>
                    <p>
                      Run ID: {active?.id}. Conservation residual:{" "}
                      {result.diagnostics.conservationResidualM3.toExponential(
                        2,
                      )}{" "}
                      m³.
                    </p>
                    <dl className="fs-meta">
                      <dt>Initial volume</dt>
                      <dd>{result.summary.initialStorageM3.toFixed(3)} m³</dd>
                      <dt>Cumulative inflow</dt>
                      <dd>{result.summary.externalInflowM3.toFixed(3)} m³</dd>
                      <dt>External discharge</dt>
                      <dd>
                        {result.summary.externalDischargeM3.toFixed(3)} m³
                      </dd>
                      <dt>Overflow</dt>
                      <dd>{result.summary.overflowM3.toFixed(3)} m³</dd>
                      <dt>Internal steps</dt>
                      <dd>{result.diagnostics.internalSteps}</dd>
                      <dt>Runtime</dt>
                      <dd>{result.diagnostics.durationMs} ms</dd>
                      <dt>Input hash</dt>
                      <dd className="fs-break">{result.inputHash}</dd>
                    </dl>
                    <ul>
                      {result.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </details>
                </div>
                {active && (
                  <ResponseCase
                    key={active.id}
                    sourceId={active.id}
                    sourceKind="run"
                    post={post}
                    refresh={refresh}
                    notify={notify}
                  />
                )}
                <details className="fs-panel">
                  <summary>
                    Accessible numerical series and technical export
                  </summary>
                  <p>
                    Selected-time pump discharge:{" "}
                    {(
                      (point?.nodes[nodeId]?.pumpDischargeM3s || 0) * 3600
                    ).toFixed(3)}{" "}
                    m³/h. Internal step is {result.diagnostics.maxStepSeconds}{" "}
                    seconds.
                  </p>
                  <div className="fs-table-scroll">
                    <table>
                      <caption>
                        Calculated water series · every saved output
                      </caption>
                      <thead>
                        <tr>
                          <th>Elapsed h</th>
                          <th>Level m</th>
                          <th>Volume m³</th>
                          <th>Pump m³/h</th>
                          <th>Inflow m³</th>
                          <th>Discharge m³</th>
                          <th>Overflow m³</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.series.map((p) => (
                          <tr key={p.atSeconds}>
                            <td>{(p.atSeconds / 3600).toFixed(3)}</td>
                            <td>{p.nodes[nodeId]?.levelM.toFixed(4)}</td>
                            <td>{p.nodes[nodeId]?.volumeM3.toFixed(4)}</td>
                            <td>
                              {(
                                (p.nodes[nodeId]?.pumpDischargeM3s || 0) * 3600
                              ).toFixed(3)}
                            </td>
                            <td>{p.cumulativeInflowM3.toFixed(3)}</td>
                            <td>{p.cumulativeDischargeM3.toFixed(3)}</td>
                            <td>{p.cumulativeOverflowM3.toFixed(3)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            ) : (
              !active && (
                <section className="fs-panel fs-lab-empty">
                  <Empty title="A fresh calculation starts here">
                    Run a baseline with current configured pumping, then run a
                    scenario with backup activation. Save multiple runs to
                    compare them on the same axes.
                  </Empty>
                  <div className="fs-flow-diagram">
                    <span>Frozen inputs</span>
                    <ArrowRight />
                    <span>Water balance</span>
                    <ArrowRight />
                    <span>Route feasibility</span>
                  </div>
                </section>
              )
            )}
          </section>
        </div>
      )}
    </>
  );
}
function formatElapsed(seconds: number) {
  const minutes = Math.round(seconds / 60);
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
function peakLevel(scenario: Scenario | undefined, id: string, volume: number) {
  const curve = scenario?.nodes.find((n) => n.id === id)?.geometry;
  if (!curve || !Number.isFinite(volume)) return NaN;
  for (let i = 1; i < curve.length; i++)
    if (volume <= curve[i].volumeM3)
      return (
        curve[i - 1].levelM +
        ((volume - curve[i - 1].volumeM3) /
          (curve[i].volumeM3 - curve[i - 1].volumeM3)) *
          (curve[i].levelM - curve[i - 1].levelM)
      );
  return curve.at(-1)!.levelM;
}
function round(n: number) {
  return Math.round(n * 1e6) / 1e6;
}
function FlaskIcon() {
  return <GitCompareArrows size={22} />;
}
function SavedRuns({
  runs,
  onSelect,
}: {
  runs: Row[];
  onSelect: (r: Row) => void;
}) {
  return (
    <div className="fs-saved-runs">
      <h3>Saved runs</h3>
      {runs.slice(0, 12).map((r) => (
        <button className="fs-saved-run" key={r.id} onClick={() => onSelect(r)}>
          <span>
            {String(r.data.name || "Saved water calculation")} ·{" "}
            {date(r.createdAt)}
          </span>
          <Tag tone={r.data.status === "completed" ? "teal" : "muted"}>
            {r.data.status}
          </Tag>
        </button>
      ))}
      {!runs.length && <small>No runs saved yet.</small>}
    </div>
  );
}
function WaterChart({
  result,
  baseline,
  nodeId,
}: {
  result: SimulationResult;
  baseline?: SimulationResult;
  nodeId: string;
}) {
  const comparable = baseline?.series.every((p) => !!p.nodes[nodeId]);
  const comparison = comparable ? baseline : undefined;
  const all = [...result.series, ...(comparison?.series || [])];
  const xmax = Math.max(...all.map((p) => p.atSeconds), 1);
  const levels = all.map((p) => p.nodes[nodeId].levelM);
  const ymin = Math.min(...levels, 0),
    ymax = Math.max(...levels, 1);
  const range = (ymax - ymin) * 1.15;
  const points = (r: SimulationResult) =>
    r.series
      .map(
        (p) =>
          `${55 + (p.atSeconds / xmax) * 605},${250 - ((p.nodes[nodeId].levelM - ymin) / range) * 210}`,
      )
      .join(" ");
  return (
    <svg
      className="fs-water-chart"
      viewBox="0 0 700 300"
      role="img"
      aria-label={`Water level over elapsed time. Final selected volume ${result.summary.finalStorageM3.toFixed(2)} cubic metres. Full numerical table below.`}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <g key={i}>
          <line
            x1={55}
            x2={660}
            y1={250 - (i / 4) * 210}
            y2={250 - (i / 4) * 210}
            stroke="#e3e8ed"
          />
          <text x={45} y={254 - (i / 4) * 210} textAnchor="end">
            {(ymin + (i / 4) * range).toFixed(1)}
          </text>
          <text x={55 + (i / 4) * 605} y={277} textAnchor="middle">
            {(((i / 4) * xmax) / 3600).toFixed(1)}h
          </text>
        </g>
      ))}
      <text x={55} y={22}>
        Level (m)
      </text>
      {comparison && (
        <polyline
          fill="none"
          stroke="#7b8799"
          strokeWidth={2.5}
          strokeDasharray="7 5"
          points={points(comparison!)}
        />
      )}
      <polyline
        fill="none"
        stroke="#087f83"
        strokeWidth={3}
        points={points(result)}
      />
    </svg>
  );
}
