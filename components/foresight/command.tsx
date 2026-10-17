"use client";
import { useState } from "react";
import {
  ArrowRight,
  CircleHelp,
  FileText,
  Waves,
  Users,
  Clock,
  ShieldCheck,
} from "lucide-react";
import {
  date,
  Dialog,
  ErrorText,
  Field,
  Tag,
  rows,
  localInput,
  fromLocal,
  type ViewProps,
  type Row,
} from "./shared";
import type { Concern, Assessment } from "@/lib/domain/contracts";
export function CommandCentre({
  data,
  zone,
  post,
  refresh,
  notify,
}: ViewProps) {
  const assessment = rows(data, "assessment")[0],
    current = assessment?.data as Assessment | undefined,
    previous = rows(data, "assessment")[1];
  const concerns = (current?.concerns || []).filter(
      (c) => zone === "all" || c.zoneId === zone,
    ),
    workers = rows(data, "worker", zone).filter(
      (w) => w.data.status !== "checked-out",
    ),
    cases = rows(data, "case", zone),
    reports = rows(data, "report", zone).filter(
      (r) => r.data.reviewStatus !== "accepted",
    );
  const [selected, setSelected] = useState<Concern | null>(null),
    [error, setError] = useState(""),
    [explanation, setExplanation] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [owner, setOwner] = useState("Fictional shift supervisor"),
    [due, setDue] = useState(
      localInput(new Date(Date.now() + 3600e3).toISOString()),
    );
  async function explain() {
    if (!assessment) return;
    setBusy(true);
    setError("");
    try {
      setExplanation(await post(`assessments/${assessment.id}/explain`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function createCase(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !assessment) return;
    setBusy(true);
    setError("");
    try {
      await post("cases", {
        concernId: selected.id,
        assessmentId: assessment.id,
        zoneId: selected.zoneId,
        title: selected.title,
        owner,
        dueAt: fromLocal(due),
      });
      notify("Response case opened with linked evidence.");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const runs = rows(data, "run").filter(
    (r) => r.data.status === "completed" && !r.data.sensitivity,
  );
  return (
    <>
      <div className="fs-page-heading">
        <div>
          <div className="fs-eyebrow">OPERATIONS / EVIDENCE WORKSPACE</div>
          <h1>Command Centre</h1>
          <p>
            Understand the concern. Review the evidence. Record the response.
          </p>
        </div>
        <a className="fs-button" href="#evidence">
          Submit evidence <ArrowRight size={16} />
        </a>
      </div>
      <div className="fs-metrics">
        <Metric
          icon={<ShieldCheck size={20} />}
          label="Concerns for review"
          value={String(concerns.length)}
          note={
            concerns.some((c) => c.priority === "urgent-review")
              ? "Includes a direct serious observation"
              : "Under development policy"
          }
        />
        <Metric
          icon={<FileText size={20} />}
          label="Pending evidence"
          value={String(reports.length)}
          note="Awaiting supervisor review"
        />
        <Metric
          icon={<Users size={20} />}
          label="Assigned people"
          value={String(workers.length)}
          note="Assignments are not live locations"
        />
        <Metric
          icon={<Clock size={20} />}
          label="Open response cases"
          value={String(cases.filter((c) => c.data.status !== "closed").length)}
          note="Closure needs verification"
        />
      </div>
      <div className="fs-command-grid">
        <section className="fs-panel">
          <div className="fs-section-heading">
            <div>
              <h2>Review queue</h2>
              <p>
                Current assessment ·{" "}
                {assessment
                  ? date(assessment.createdAt)
                  : "No accepted evidence yet"}
              </p>
            </div>
            <Tag>
              {zone === "all"
                ? "All zones"
                : data.site.zones.find((z) => z.id === zone)?.name}
            </Tag>
          </div>
          {concerns.length ? (
            concerns.map((c) => {
              const response = cases.find((r) => r.data.concernId === c.id);
              return (
                <article className="fs-concern" key={c.id}>
                  <div
                    className={
                      "fs-concern-symbol " +
                      (c.priority === "urgent-review" ? "urgent" : "")
                    }
                  >
                    <Waves size={22} />
                  </div>
                  <div className="fs-concern-body">
                    <div className="fs-concern-line">
                      <Tag
                        tone={
                          c.priority === "urgent-review" ? "amber" : "muted"
                        }
                      >
                        {c.priority === "urgent-review"
                          ? "Urgent review"
                          : "Review required"}
                      </Tag>
                      <small>
                        {data.site.zones.find((z) => z.id === c.zoneId)?.name}
                      </small>
                    </div>
                    <h3>{c.title}</h3>
                    <p>{c.reason}</p>
                    <div className="fs-concern-meta">
                      <span>{c.observationIds.length} source(s)</span>
                      <span>
                        {response
                          ? `Owner: ${response.data.owner}`
                          : "Owner unassigned"}
                      </span>
                      <span>{c.controlState}</span>
                    </div>
                  </div>
                  <button
                    className="fs-button secondary"
                    onClick={() => {
                      setSelected(c);
                      setExplanation(null);
                      setError("");
                    }}
                  >
                    Review <ArrowRight size={15} />
                  </button>
                </article>
              );
            })
          ) : (
            <div className="fs-command-empty">
              <ShieldCheck size={36} />
              <h3>
                {assessment
                  ? "No concern supported by this evidence set"
                  : "Start with the evidence"}
              </h3>
              <p>
                {assessment
                  ? "This is not a zone clearance. Missing and stale inputs still need review."
                  : "Submit a report or an inspection, review its facts, and create a traceable assessment."}
              </p>
              <a className="fs-inline-link" href="#evidence">
                Open Evidence <ArrowRight size={16} />
              </a>
            </div>
          )}
          <div className="fs-panel-foot">
            <span>
              Policy {current?.policyVersion || "development-controls-1"}
            </span>
            <span>
              {current?.observationIds.length || 0} accepted observation(s)
            </span>
          </div>
        </section>
        <aside className="fs-panel fs-source-status">
          <div className="fs-section-heading">
            <h2>What we know</h2>
            <CircleHelp size={18} />
          </div>
          <Status
            label="Written evidence"
            value={`${rows(data, "observation", zone).length} accepted observations`}
            status="recorded"
          />
          <Status
            label="Live water measurements"
            value="No connected measurement source"
            status="unavailable"
          />
          <Status
            label="Vision evidence"
            value={`${rows(data, "vision-event", zone).length} recorded events`}
            status={data.services.vision ? "configured" : "unavailable"}
          />
          <Status
            label="Spatial model"
            value="Conceptual layout · scale unverified"
            status="assumed"
          />
          <Status
            label="Crew location"
            value="Assignment records only"
            status="unknown"
          />
          <div className="fs-note">
            <strong>Unknowns remain visible</strong>
            <p>
              Current means latest recorded conditions. Qualitative reports
              cannot supply a numeric water inflow.
            </p>
          </div>
        </aside>
      </div>
      <div className="fs-two-columns">
        <section className="fs-panel">
          <div className="fs-section-heading">
            <h2>Latest laboratory runs</h2>
            <a href="#simulator" className="fs-inline-link">
              Open Lab <ArrowRight size={15} />
            </a>
          </div>
          {runs.length ? (
            runs.slice(0, 3).map((r) => (
              <div className="fs-list-row" key={r.id}>
                <div>
                  <strong>
                    {String(
                      data.entities.find((e) => e.id === r.data.scenarioId)
                        ?.data.name || "Laboratory run",
                    )}
                  </strong>
                  <small>{date(r.createdAt)} · simulated</small>
                </div>
                <Tag tone="teal">
                  {r.data.result?.summary?.overflowM3?.toFixed(2)} m³ overflow
                </Tag>
              </div>
            ))
          ) : (
            <p className="fs-muted">
              No completed runs. Clone the latest workspace snapshot in
              Simulator Lab.
            </p>
          )}
        </section>
        <section className="fs-panel">
          <div className="fs-section-heading">
            <h2>Pending decisions</h2>
          </div>
          <ul className="fs-plain-list">
            <li>
              Review {reports.length} submitted report(s) before using their
              facts.
            </li>
            <li>
              Verify physical input values and route assumptions before relying
              on a scenario.
            </li>
            <li>
              {
                cases.filter((c) => c.data.status === "awaiting-verification")
                  .length
              }{" "}
              response case(s) await verification.
            </li>
          </ul>
        </section>
      </div>
      {selected && (
        <Dialog title={selected.title} onClose={() => setSelected(null)}>
          <Tag tone="amber">{selected.priority}</Tag>
          <p>{selected.reason}</p>
          <dl className="fs-meta">
            <dt>Zone</dt>
            <dd>
              {data.site.zones.find((z) => z.id === selected.zoneId)?.name}
            </dd>
            <dt>Assessment</dt>
            <dd>
              {assessment?.id} · {date(assessment?.createdAt)}
            </dd>
            <dt>Previous version</dt>
            <dd>
              {previous
                ? `${previous.id} · ${date(previous.createdAt)}`
                : "No previous assessment"}
            </dd>
            <dt>Control</dt>
            <dd>{selected.controlState}</dd>
            <dt>Affected assignments</dt>
            <dd>
              {workers
                .filter((w) => w.zoneId === selected.zoneId)
                .map((w) => w.data.name)
                .join(", ") || "None recorded; location remains unknown"}
            </dd>
          </dl>
          <h3>Supporting evidence</h3>
          {selected.observationIds.map((id) => {
            const o = data.entities.find((e) => e.id === id);
            return (
              <blockquote key={id}>
                {o?.data.spans?.map((s: any) => s.quote).join(" / ") ||
                  o?.data.condition}
                <footer>
                  {id}
                  <br />
                  {date(o?.data.observedAt)} · submitted {date(o?.createdAt)}
                </footer>
              </blockquote>
            );
          })}
          <h3>Missing information</h3>
          <ul>
            {current?.unknowns.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
          <button
            className="fs-button secondary"
            disabled={busy}
            onClick={() => void explain()}
          >
            Explain this assessment
          </button>
          {explanation && (
            <section className="fs-explanation">
              {explanation.paragraphs.map((p: any, i: number) => (
                <p key={i}>
                  {p.text}
                  <small>Sources: {p.evidenceIds.join(", ")}</small>
                </p>
              ))}
              <p>{explanation.limitation}</p>
            </section>
          )}
          <ErrorText message={error} />
          <h3>Response history</h3>
          {cases
            .filter((c) => c.data.concernId === selected.id)
            .map((c) => (
              <div className="fs-list-row" key={c.id}>
                <div>
                  <strong>{c.data.owner}</strong>
                  <small>
                    {c.data.status} · due {date(c.data.dueAt)}
                  </small>
                </div>
                <a
                  href="#people"
                  className="fs-inline-link"
                  onClick={() => setSelected(null)}
                >
                  Manage case
                </a>
              </div>
            ))}
          {!cases.some((c) => c.data.concernId === selected.id) && (
            <form onSubmit={createCase} className="fs-form">
              <Field label="Response owner (fictional)">
                <input
                  required
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                />
              </Field>
              <Field label="Due time · Africa/Harare">
                <input
                  type="datetime-local"
                  required
                  value={due}
                  onChange={(e) => setDue(e.target.value)}
                />
              </Field>
              <button className="fs-button" disabled={busy}>
                Open linked response case
              </button>
            </form>
          )}
        </Dialog>
      )}
    </>
  );
}
function Metric({
  icon,
  label,
  value,
  note,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="fs-metric">
      <div>
        {label}
        {icon}
      </div>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}
function Status({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status: string;
}) {
  return (
    <div className="fs-source-row">
      <strong>
        {label}
        <Tag>{status}</Tag>
      </strong>
      <small>{value}</small>
    </div>
  );
}
