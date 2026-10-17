"use client";
import { useEffect, useState } from "react";
import {
  Plus,
  ArrowRight,
  FileText,
  ClipboardCheck,
  Video,
  CloudUpload,
} from "lucide-react";
import { queue, queued, sync, retry, type Queued } from "@/lib/client/queue";
import { type Fact } from "@/lib/domain/contracts";
import {
  date,
  Dialog,
  Empty,
  ErrorText,
  Field,
  Tag,
  rows,
  localInput,
  fromLocal,
  type ViewProps,
  type Row,
} from "./shared";
export function Evidence(props: ViewProps) {
  const { data, zone, post, refresh, notify } = props;
  const [tab, setTab] = useState("reports"),
    [text, setText] = useState(""),
    [target, setTarget] = useState(zone === "all" ? "zone-b" : zone),
    [observed, setObserved] = useState(""),
    [selected, setSelected] = useState<Row | null>(null),
    [facts, setFacts] = useState<Fact[]>([]),
    [reason, setReason] = useState("Reviewed against original report."),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [drafts, setDrafts] = useState<Queued[]>([]);
  const [inspection, setInspection] = useState({
    title: "",
    dueAt: localInput(),
    finding: "",
    outcome: "unverified",
  });
  useEffect(() => {
    if (!selected) return;
    const latest = data.entities.find((e) => e.id === selected.id);
    if (latest && latest.revision !== selected.revision) setSelected(latest);
  }, [data.entities, selected?.id, selected?.revision]);
  const [corrects, setCorrects] = useState("");
  const [region, setRegion] = useState({
    xMin: 0.2,
    yMin: 0.2,
    xMax: 0.8,
    yMax: 0.9,
  });
  const [recordedAt, setRecordedAt] = useState("");
  const [clipUrl, setClipUrl] = useState("");
  const [clip, setClip] = useState<File | null>(null),
    [camera, setCamera] = useState(rows(data, "camera")[0]?.id || "");
  useEffect(() => {
    void queued(data.workspace.id)
      .then(setDrafts)
      .catch(() =>
        setError("Device storage unavailable; drafts cannot be queued."),
      );
  }, [data.workspace.id, data.latestSyncedAt]);
  async function run(fn: () => Promise<void>) {
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
  async function enqueue(operation: "reports" | "inspections", body: unknown) {
    await queue(data.workspace.id, operation, body);
    notify(
      "Saved to this device. Pending submissions are not server-verified.",
    );
    try {
      await sync(data.workspace.id);
    } catch {
      notify("Saved locally; synchronization is pending.");
    }
    setDrafts(await queued(data.workspace.id));
    await refresh();
  }
  useEffect(() => {
    if (!clip) {
      setClipUrl("");
      return;
    }
    const url = URL.createObjectURL(clip);
    setClipUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [clip]);
  function manualFact(report: Row): Fact {
    return {
      category: "water",
      zoneId: report.data.zoneId || "zone-b",
      assetId: null,
      condition: "",
      polarity: "affirmed",
      action: "observed",
      quantity: null,
      unit: null,
      observedAt: report.data.observedAt || null,
      timeExpression: null,
      spans: [
        {
          start: 0,
          end: Math.min(4000, report.data.text.length),
          quote: report.data.text.slice(0, 4000),
        },
      ],
      interpretation: "explicit",
      serious: false,
    };
  }
  async function open(report: Row) {
    setSelected(report);
    setCorrects("");
    setFacts(
      report.data.acceptedFacts ||
        report.data.extraction?.facts || [manualFact(report)],
    );
    setError("");
  }
  function edit(index: number, values: Partial<Fact>) {
    setFacts(facts.map((f, i) => (i === index ? { ...f, ...values } : f)));
  }
  return (
    <>
      <div className="fs-page-heading">
        <div>
          <div className="fs-eyebrow">SOURCES / REVIEW / ASSESSMENT</div>
          <h1>Evidence</h1>
          <p>
            Keep the original account. Review the interpretation. Preserve what
            changed.
          </p>
        </div>
        <Tag>
          {
            rows(data, "report", zone).filter(
              (r) => r.data.reviewStatus === "pending",
            ).length
          }{" "}
          awaiting review
        </Tag>
      </div>
      <div className="fs-tabs" role="tablist" aria-label="Evidence type">
        {[
          ["reports", "Reports", FileText],
          ["inspections", "Inspections", ClipboardCheck],
          ["vision", "Vision", Video],
        ].map(([id, label, Icon]) => {
          const I = Icon as typeof FileText;
          return (
            <button
              key={id as string}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id as string)}
            >
              <I size={17} />
              {label as string}
            </button>
          );
        })}
      </div>
      <ErrorText message={error} />
      {tab === "reports" && (
        <div className="fs-evidence-grid">
          <section className="fs-panel">
            <div className="fs-section-heading">
              <h2>New written report</h2>
              <Tag tone="teal">Low data</Tag>
            </div>
            <form
              className="fs-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await enqueue("reports", {
                    text,
                    zoneId: target,
                    observedAt: fromLocal(observed),
                  });
                  setText("");
                });
              }}
            >
              <Field
                label="Original report"
                help="Fictional observations only. Do not enter worker identities, contact information, or credentials."
              >
                <textarea
                  required
                  rows={7}
                  minLength={5}
                  maxLength={12000}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Describe the condition, location, equipment and what was observed…"
                />
              </Field>
              <Field label="Reported zone">
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  {data.site.zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Observed at · Africa/Harare (optional)"
                help="Leave blank when unknown. Submission time is recorded separately."
              >
                <input
                  type="datetime-local"
                  value={observed}
                  onChange={(e) => setObserved(e.target.value)}
                />
              </Field>
              <button
                className="fs-button"
                disabled={busy || text.trim().length < 5}
              >
                <CloudUpload size={17} />
                {busy ? "Saving…" : "Save report and sync"}
              </button>
            </form>
            <p className="fs-muted">
              Original text persists before extraction. AI can propose facts; a
              supervisor accepts or corrects them.
            </p>
          </section>
          <section className="fs-panel">
            <div className="fs-section-heading">
              <h2>Submitted reports</h2>
              <span>{rows(data, "report", zone).length} records</span>
            </div>
            {rows(data, "report", zone).map((r) => (
              <button
                className="fs-report-item"
                key={r.id}
                onClick={() => void open(r)}
              >
                <div>
                  <Tag
                    tone={r.data.reviewStatus === "accepted" ? "teal" : "amber"}
                  >
                    {r.data.reviewStatus}
                  </Tag>
                  <small>{date(r.createdAt)}</small>
                </div>
                <p>{r.data.text}</p>
                <span>
                  {data.site.zones.find((z) => z.id === r.zoneId)?.name}
                  <ArrowRight size={16} />
                </span>
              </button>
            ))}
            {!rows(data, "report", zone).length && (
              <Empty title="No reports yet">
                The next submitted report will appear here for review.
              </Empty>
            )}
          </section>
        </div>
      )}
      {tab === "inspections" && (
        <div className="fs-evidence-grid">
          <section className="fs-panel">
            <h2>Record an inspection</h2>
            <form
              className="fs-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await enqueue("inspections", {
                    ...inspection,
                    zoneId: target,
                    dueAt: fromLocal(inspection.dueAt),
                    observedAt: fromLocal(observed),
                  });
                  setInspection({ ...inspection, title: "", finding: "" });
                });
              }}
            >
              <Field label="Inspection title">
                <input
                  required
                  minLength={3}
                  value={inspection.title}
                  onChange={(e) =>
                    setInspection({ ...inspection, title: e.target.value })
                  }
                />
              </Field>
              <Field label="Zone">
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  {data.site.zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Original due time · Africa/Harare">
                <input
                  type="datetime-local"
                  required
                  value={inspection.dueAt}
                  onChange={(e) =>
                    setInspection({ ...inspection, dueAt: e.target.value })
                  }
                />
              </Field>
              <Field label="Observed at · Africa/Harare (optional)">
                <input
                  type="datetime-local"
                  value={observed}
                  onChange={(e) => setObserved(e.target.value)}
                />
              </Field>
              <Field label="Control status">
                <select
                  value={inspection.outcome}
                  onChange={(e) =>
                    setInspection({ ...inspection, outcome: e.target.value })
                  }
                >
                  {[
                    "verified",
                    "reported-failed",
                    "unverified",
                    "deferred",
                  ].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </Field>
              <Field label="Findings / verification source">
                <textarea
                  required
                  minLength={3}
                  rows={4}
                  value={inspection.finding}
                  onChange={(e) =>
                    setInspection({ ...inspection, finding: e.target.value })
                  }
                />
              </Field>
              <button className="fs-button" disabled={busy}>
                Queue inspection and sync
              </button>
            </form>
          </section>
          <section className="fs-panel">
            <h2>Inspection history</h2>
            {rows(data, "inspection", zone).map((r) => (
              <article className="fs-history-item" key={r.id}>
                <h3>{r.data.title}</h3>
                <Tag>{r.data.outcome}</Tag>
                <p>{r.data.finding}</p>
                <small>
                  Original due: {date(r.data.dueAt)}
                  <br />
                  Observed: {date(r.data.observedAt)}
                  <br />
                  Submitted: {date(r.createdAt)}
                </small>
              </article>
            ))}
            {!rows(data, "inspection", zone).length && (
              <Empty title="No inspection records">
                Deferrals keep the original due date. Supervisor submissions
                create a fresh assessment.
              </Empty>
            )}
          </section>
        </div>
      )}
      {tab === "vision" && (
        <>
          <div className="fs-panel">
            <div className="fs-section-heading">
              <div>
                <h2>Visible equipment and entry review</h2>
                <p>
                  Person, helmet and vest inference runs in a separate Python
                  ONNX worker.
                </p>
              </div>
              <Tag tone={data.services.vision ? "teal" : "amber"}>
                {data.services.vision
                  ? "Worker configured"
                  : "Inference unavailable"}
              </Tag>
            </div>
            <p>
              Missing detections alone do not prove missing PPE. Occlusion,
              darkness and overlap must remain cannot assess. Tracks are local
              to a camera session and do not identify WorkerSafe members.
            </p>
            <form
              className="fs-form fs-form-columns"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  if (!clip) throw new Error("Choose a consented clip.");
                  const form = new FormData();
                  form.set("file", clip);
                  form.set("cameraId", camera);
                  form.set("recordedAt", fromLocal(recordedAt) || "");
                  const response = await fetch("/api/vision/jobs", {
                    method: "POST",
                    headers: { "X-Workspace-Id": data.workspace.id },
                    body: form,
                  });
                  const body = await response.json();
                  if (!response.ok) throw new Error(body.message);
                  notify("Vision job queued: " + body.id);
                  await refresh();
                });
              }}
            >
              <Field label="Mapped camera">
                <select
                  value={camera}
                  onChange={(e) => setCamera(e.target.value)}
                >
                  {rows(data, "camera").map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.data.name} · {c.zoneId}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Consented recorded clip (MP4, up to 50 MB)">
                <input
                  type="file"
                  accept="video/mp4"
                  onChange={(e) => setClip(e.target.files?.[0] || null)}
                />
              </Field>
              <Field
                label="Recording start time · Africa/Harare"
                help="Use actual capture metadata. Processing time is stored separately."
              >
                <input
                  type="datetime-local"
                  required
                  value={recordedAt}
                  onChange={(e) => setRecordedAt(e.target.value)}
                />
              </Field>
              <button
                className="fs-button"
                disabled={!data.services.vision || busy || !clip || !recordedAt}
              >
                Process actual frames
              </button>
            </form>
            {clipUrl && (
              <div className="fs-video-region">
                <video
                  src={clipUrl}
                  controls
                  aria-label="Local clip preview with restricted region overlay"
                />
                <div
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    pointerEvents: "none",
                    border: "2px solid #f7b744",
                    background: "#f7b74422",
                    left: region.xMin * 100 + "%",
                    top: region.yMin * 100 + "%",
                    width: (region.xMax - region.xMin) * 100 + "%",
                    height: (region.yMax - region.yMin) * 100 + "%",
                  }}
                />
              </div>
            )}
            <details>
              <summary>Camera region and restricted-entry policy</summary>
              <p>
                Footpoint entry is evaluated against a zone-mapped rectangle.
                These image coordinates are fractions of the source frame and
                are not global metres.
              </p>
              <div className="fs-form-columns">
                {Object.entries(region).map(([key, value]) => (
                  <Field key={key} label={key + " (0–1 of frame)"}>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      value={value}
                      onChange={(e) =>
                        setRegion({ ...region, [key]: Number(e.target.value) })
                      }
                    />
                  </Field>
                ))}
              </div>
              <button
                type="button"
                className="fs-button secondary"
                onClick={() =>
                  void run(async () => {
                    const record = rows(data, "camera").find(
                      (c) => c.id === camera,
                    );
                    if (!record) throw new Error("Select a camera.");
                    await post(`cameras/${camera}/policy`, {
                      expectedRevision: record.revision,
                      restrictedRegion: region,
                      reason:
                        "Fictional supervisor configured zone-mapped image region; no global position.",
                    });
                    notify("Camera policy version saved.");
                    await refresh();
                  })
                }
              >
                Save mapped restricted region
              </button>
            </details>
            <button
              className="fs-button secondary"
              disabled={busy || !data.services.vision}
              onClick={() =>
                void run(async () => {
                  const response = await fetch("/api/vision/feed", {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      "X-Workspace-Id": data.workspace.id,
                    },
                    body: JSON.stringify({ cameraId: camera }),
                  });
                  const body = await response.json();
                  if (!response.ok) throw new Error(body.message);
                  notify(
                    "Configured feed processing queued for a bounded 120-second session.",
                  );
                  await refresh();
                })
              }
            >
              Process administrator-configured feed
            </button>
            <small>
              Licensed model weights, configured class mapping and review clips
              are required. No saved boxes are presented as live inference.
            </small>
          </div>
          <section className="fs-panel">
            <h2>Processing jobs</h2>
            {rows(data, "vision-job", zone).map((job) => (
              <VisionJob
                key={job.id}
                job={job}
                refresh={refresh}
                workspaceId={data.workspace.id}
              />
            ))}
            <h2>Event review</h2>
            {rows(data, "vision-event", zone).map((r) => (
              <article className="fs-history-item" key={r.id}>
                <Tag tone="amber">{r.data.type}</Tag>
                <h3>
                  {r.data.state} · {r.data.visibility}
                </h3>
                <p>
                  {r.data.cameraId} / track {r.data.trackId} ·{" "}
                  {date(r.data.startsAt)}
                </p>
                <p>Frames: {r.data.frameIds?.join(", ")}</p>
                <div className="fs-vision-frames">
                  {r.data.frameIds?.slice(-3).map((fid: string) => (
                    <a
                      key={fid}
                      href={`/api/vision/frames/${r.data.jobId}/${fid}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img
                        src={`/api/vision/frames/${r.data.jobId}/${fid}`}
                        alt={`Blurred supporting frame ${fid}; inspect visible equipment before reviewing.`}
                      />
                    </a>
                  ))}
                </div>
                <div className="fs-button-row">
                  {["acknowledged", "dismissed", "resolved"].map((status) => (
                    <button
                      key={status}
                      className="fs-button secondary"
                      onClick={() =>
                        void run(async () => {
                          await post(`vision/${r.id}/review`, {
                            expectedRevision: r.revision,
                            status,
                            reason:
                              "Fictional supervisor reviewed the supporting event evidence.",
                          });
                          await refresh();
                        })
                      }
                    >
                      {status}
                    </button>
                  ))}
                </div>
              </article>
            ))}
            {!rows(data, "vision-event", zone).length && (
              <Empty title="No model events available">
                A configured worker must process frames before inference events
                can be reviewed. No compliant state is inferred from an absent
                feed.
              </Empty>
            )}
          </section>
        </>
      )}
      {drafts.some((d) => d.state !== "synced") && (
        <section className="fs-panel">
          <h2>Device submission queue</h2>
          <p>
            These records survive a browser restart on this device. Observation
            and queue times remain distinct.
          </p>
          {drafts
            .filter((d) => d.state !== "synced")
            .map((d) => (
              <details key={d.key} className="fs-history-item">
                <summary>
                  {d.operation} · {d.state} · queued {date(d.queuedAt)}
                </summary>
                <ErrorText message={d.message || ""} />
                <p>
                  Review preserved content before retrying rejected or
                  conflicting records.
                </p>
                <QueueEditor
                  draft={d}
                  onRetry={async (body) => {
                    await retry(d.key, data.workspace.id, body);
                    setDrafts(await queued(data.workspace.id));
                    notify("A reviewed replacement is pending sync.");
                  }}
                />
              </details>
            ))}
          <button
            className="fs-button secondary"
            onClick={() =>
              void run(async () => {
                await sync(data.workspace.id);
                setDrafts(await queued(data.workspace.id));
                await refresh();
              })
            }
          >
            Retry pending sync
          </button>
        </section>
      )}
      {selected && (
        <Dialog
          title="Report interpretation and review"
          onClose={() => setSelected(null)}
        >
          <Tag
            tone={selected.data.reviewStatus === "accepted" ? "teal" : "amber"}
          >
            {selected.data.reviewStatus}
          </Tag>
          <blockquote>
            {selected.data.text}
            <footer>
              Submitted {date(selected.createdAt)}
              <br />
              Observed {date(selected.data.observedAt)}
            </footer>
          </blockquote>
          <ErrorText message={error} />
          {selected.data.reviewStatus !== "accepted" && (
            <>
              <button
                className="fs-button secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    try {
                      const report = await post(
                        `reports/${selected.id}/extract`,
                      );
                      setSelected(report);
                      setFacts(report.data.extraction.facts);
                    } finally {
                      await refresh();
                    }
                  })
                }
              >
                Extract proposed facts with configured model
              </button>
              <p className="fs-muted">
                {selected.data.extractionState === "unavailable"
                  ? "Extraction unavailable. Review facts manually below."
                  : "Every accepted factual field must be supported by the cited excerpt. AI output remains a proposal."}
              </p>
            </>
          )}
          <form
            className="fs-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await post(`reports/${selected.id}/review`, {
                  expectedRevision: selected.revision,
                  facts,
                  reason,
                  supersedesObservationIds: corrects ? [corrects] : [],
                });
                notify(
                  "Accepted facts created new observations and an immutable assessment version.",
                );
                setSelected(null);
                await refresh();
              });
            }}
          >
            <fieldset
              disabled={selected.data.reviewStatus === "accepted" || busy}
            >
              <legend>Proposed / manually entered facts</legend>
              {facts.map((f, i) => (
                <div className="fs-fact-editor" key={i}>
                  <h3>Fact {i + 1}</h3>
                  <div className="fs-form-columns">
                    <Field label="Category">
                      <select
                        value={f.category}
                        onChange={(e) =>
                          edit(i, {
                            category: e.target.value as Fact["category"],
                          })
                        }
                      >
                        {[
                          "water",
                          "drainage",
                          "inspection",
                          "ppe",
                          "restricted-entry",
                          "injury",
                          "other",
                        ].map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Zone">
                      <select
                        value={f.zoneId || ""}
                        onChange={(e) =>
                          edit(i, {
                            zoneId: (e.target.value || null) as Fact["zoneId"],
                          })
                        }
                      >
                        <option value="">Unresolved zone</option>
                        {data.site.zones.map((z) => (
                          <option key={z.id} value={z.id}>
                            {z.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field
                    label="Source excerpt"
                    help="Must be an exact excerpt from the original. Keep enough text to support all fields."
                  >
                    <textarea
                      required
                      rows={3}
                      value={f.spans[0]?.quote || ""}
                      onChange={(e) => {
                        const quote = e.target.value,
                          start = selected.data.text.indexOf(quote);
                        edit(i, {
                          spans: [{ quote, start, end: start + quote.length }],
                        });
                      }}
                    />
                  </Field>
                  <Field label="Observed condition / interpretation">
                    <input
                      required
                      maxLength={500}
                      value={f.condition}
                      onChange={(e) => edit(i, { condition: e.target.value })}
                    />
                  </Field>
                  <div className="fs-form-columns">
                    <Field label="Equipment identifier (optional)">
                      <input
                        value={f.assetId || ""}
                        onChange={(e) =>
                          edit(i, { assetId: e.target.value || null })
                        }
                      />
                    </Field>
                    <Field label="Negation / uncertainty">
                      <select
                        value={f.polarity}
                        onChange={(e) =>
                          edit(i, {
                            polarity: e.target.value as Fact["polarity"],
                          })
                        }
                      >
                        {["affirmed", "negated", "uncertain"].map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Action status">
                      <select
                        value={f.action}
                        onChange={(e) =>
                          edit(i, { action: e.target.value as Fact["action"] })
                        }
                      >
                        {["observed", "proposed", "completed"].map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Statement basis">
                      <select
                        value={f.interpretation}
                        onChange={(e) =>
                          edit(i, {
                            interpretation: e.target
                              .value as Fact["interpretation"],
                          })
                        }
                      >
                        <option>explicit</option>
                        <option>inferred</option>
                      </select>
                    </Field>
                    <Field label="Quantity (only if stated)">
                      <input
                        type="number"
                        min={0}
                        max={1e7}
                        step="any"
                        value={f.quantity ?? ""}
                        onChange={(e) =>
                          edit(i, {
                            quantity:
                              e.target.value === ""
                                ? null
                                : Number(e.target.value),
                            unit: e.target.value === "" ? null : f.unit || "m",
                          })
                        }
                      />
                    </Field>
                    <Field label="Unit">
                      <select
                        value={f.unit || ""}
                        onChange={(e) =>
                          edit(i, {
                            unit: (e.target.value || null) as Fact["unit"],
                          })
                        }
                      >
                        <option value="">Not stated</option>
                        {["m", "m3", "m3/h", "m3/s"].map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Observed date/time · Africa/Harare">
                      <input
                        type="datetime-local"
                        value={f.observedAt ? localInput(f.observedAt) : ""}
                        onChange={(e) =>
                          edit(i, { observedAt: fromLocal(e.target.value) })
                        }
                      />
                    </Field>
                    <Field label="Original time expression">
                      <input
                        value={f.timeExpression || ""}
                        onChange={(e) =>
                          edit(i, { timeExpression: e.target.value || null })
                        }
                      />
                    </Field>
                  </div>
                  <label className="fs-checkbox">
                    <input
                      type="checkbox"
                      checked={f.serious}
                      onChange={(e) => edit(i, { serious: e.target.checked })}
                    />
                    Serious standalone condition requiring direct review
                    (development policy)
                  </label>
                  <button
                    type="button"
                    className="fs-inline-link"
                    onClick={() => setFacts(facts.filter((_, j) => j !== i))}
                  >
                    Remove proposed fact
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="fs-button secondary"
                onClick={() => setFacts([...facts, manualFact(selected)])}
              >
                <Plus size={16} />
                Add fact
              </button>
              <Field label="Corrects an earlier observation (optional)">
                <select
                  value={corrects}
                  onChange={(e) => setCorrects(e.target.value)}
                >
                  <option value="">Additional evidence; no correction</option>
                  {rows(data, "observation").map((o) => (
                    <option key={o.id} value={o.id}>
                      {String(o.data.condition).slice(0, 90)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Review / correction reason">
                <textarea
                  required
                  minLength={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              {selected.data.reviewStatus !== "accepted" && (
                <button className="fs-button" disabled={!facts.length || busy}>
                  {busy ? "Reviewing…" : "Accept reviewed facts and assess"}
                </button>
              )}
            </fieldset>
          </form>
          {selected.data.extraction?.provenance && (
            <details>
              <summary>Extraction provenance</summary>
              <pre>
                {JSON.stringify(selected.data.extraction.provenance, null, 2)}
              </pre>
            </details>
          )}
        </Dialog>
      )}
    </>
  );
}
function QueueEditor({
  draft,
  onRetry,
}: {
  draft: Queued;
  onRetry: (body: unknown) => Promise<void>;
}) {
  const [value, setValue] = useState(JSON.stringify(draft.body, null, 2)),
    [error, setError] = useState("");
  return (
    <>
      <Field label="Preserved submission content">
        <textarea
          rows={6}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      <ErrorText message={error} />
      <button
        className="fs-button secondary"
        onClick={async () => {
          try {
            await onRetry(JSON.parse(value));
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Confirm reviewed replacement
      </button>
    </>
  );
}

function VisionJob({
  job,
  refresh,
  workspaceId,
}: {
  job: Row;
  refresh: () => Promise<void>;
  workspaceId: string;
}) {
  const [error, setError] = useState("");
  async function poll() {
    try {
      const response = await fetch("/api/vision/jobs/" + job.id, {
          headers: { "X-Workspace-Id": workspaceId },
        }),
        body = await response.json();
      if (!response.ok) throw new Error(body.message);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (!["queued", "running"].includes(job.data.status)) return;
    const timer = setInterval(() => void poll(), 3000);
    return () => clearInterval(timer);
  }, [job.id, job.data.status]);
  return (
    <div className="fs-history-item">
      <Tag>{job.data.status}</Tag>
      <p>
        Job {job.id.slice(0, 8)} · {Math.round((job.data.progress || 0) * 100)}%
      </p>
      <ErrorText message={error || job.data.error || ""} />
      <button className="fs-button secondary" onClick={() => void poll()}>
        Refresh processing status
      </button>
      {job.data.result?.metrics && (
        <details>
          <summary>Measured processing metrics and limitations</summary>
          <pre>{JSON.stringify(job.data.result.metrics, null, 2)}</pre>
          <p>{job.data.result.limitations?.join(" ")}</p>
        </details>
      )}
    </div>
  );
}
