"use client";
// Concerns: the evidence workflow, kept apart from the live headcount.
// Report in → supervisor checks the facts → concern raised → response owned.
import dynamic from "next/dynamic";
import { useState } from "react";
import {
  ArrowRight,
  ClipboardCheck,
  FileText,
  ShieldAlert,
  ShieldCheck,
  Waves,
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
import { AdvisoryAction, ConcernEvidence, PreEntryCard, RainCard, SensorRow } from "./rain-checks";
const Evidence = dynamic(() => import("./evidence").then((m) => m.Evidence), {
  loading: () => <p role="status">Loading reports…</p>,
});
const People = dynamic(() => import("./people").then((m) => m.People));
const IncidentRegister = dynamic(
  () => import("./records").then((m) => m.IncidentRegister),
  { loading: () => <p role="status">Loading responses…</p> },
);

export function concernCounts(data: ViewProps["data"], zone: string) {
  const current = rows(data, "assessment")[0]?.data as Assessment | undefined;
  return {
    reports: rows(data, "report", zone).filter(
      (r) => r.data.reviewStatus !== "accepted",
    ).length,
    concerns: (current?.concerns || []).filter(
      (c) => zone === "all" || c.zoneId === zone || c.zoneId === "all",
    ).length,
    responses: rows(data, "case", zone).filter(
      (c) => c.data.status !== "closed",
    ).length,
  };
}

export function Concerns(props: ViewProps & { initialTab?: string }) {
  const { data, zone } = props;
  const counts = concernCounts(data, zone);
  const [openCase, setOpenCase] = useState<Row | null>(null);
  const [tab, setTab] = useState(
    props.initialTab ||
      (counts.concerns ? "queue" : counts.reports ? "reports" : "queue"),
  );
  const steps = [
    {
      id: "reports",
      n: 1,
      label: "Reports and inspections",
      count: counts.reports,
      note: counts.reports === 1 ? "report to check" : "reports to check",
      Icon: FileText,
    },
    {
      id: "queue",
      n: 2,
      label: "Concerns",
      count: counts.concerns,
      note: counts.concerns === 1 ? "concern to review" : "concerns to review",
      Icon: ShieldCheck,
    },
    {
      id: "responses",
      n: 3,
      label: "Responses",
      count: counts.responses,
      note: counts.responses === 1 ? "response open" : "responses open",
      Icon: ShieldAlert,
    },
  ] as const;
  return (
    <>
      <div className="fs-page-heading">
        <div>
          <h1>Concerns</h1>
          <p>
            Someone reports a condition, a supervisor checks the facts,
            Foresight raises a concern, and every concern gets an owner.
          </p>
        </div>
        <button className="fs-button" onClick={() => setTab("reports")}>
          New report <ArrowRight size={16} />
        </button>
      </div>
      <div className="fs-steps" role="tablist" aria-label="Concern workflow">
        {steps.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={tab === s.id}
            aria-label={`${s.label}: ${s.count} ${s.note}`}
            className="fs-step"
            onClick={() => setTab(s.id)}
          >
            <span className="fs-step-n">{s.n}</span>
            <span className="fs-step-text">
              <strong>{s.label}</strong>
              <small>
                {s.count} {s.note}
              </small>
            </span>
            <s.Icon size={18} aria-hidden />
          </button>
        ))}
      </div>
      {tab === "reports" && <Evidence {...props} />}
      {tab === "queue" && <ConcernQueue {...props} openReports={() => setTab("reports")} openResponses={() => setTab("responses")} />}
      {tab === "responses" && (
        <>
          <p className="fs-help">
            Click a response to record actions, decisions and verification.
          </p>
          <IncidentRegister {...props} onOpen={setOpenCase} />
        </>
      )}
      {openCase && (
        <People
          key={openCase.id}
          {...props}
          mode="case"
          caseRow={openCase}
          onClose={() => setOpenCase(null)}
        />
      )}
    </>
  );
}

function ConcernQueue({
  data,
  zone,
  post,
  refresh,
  notify,
  openReports,
  openResponses,
}: ViewProps & { openReports: () => void; openResponses: () => void }) {
  // One click from a concern to a pre-filled flooding scenario (spec §10).
  const declaredIn = (zoneId: string) =>
    rows(data, "check-in").filter(
      (x) =>
        ["declared-underground", "return-overdue", "confirmed-missing"].includes(
          String(x.data.status),
        ) &&
        (x.data.declaredZoneId === zoneId ||
          (!x.data.declaredZoneId &&
            data.messaging?.config.shafts
              .find((s) => s.id === x.data.shaftId)
              ?.zoneIds[0] === zoneId)),
    ).length;
  const scenarioLink = (c: { id: string; zoneId: string; title: string; observationIds: string[]; shaftId?: string }) => {
    const asset = c.observationIds
      .map((id) => data.entities.find((e) => e.id === id)?.data.assetId)
      .find((a) => typeof a === "string" && a);
    const q = new URLSearchParams({ zone: c.zoneId, concern: c.id, name: `${c.title} (from concern)` });
    if ((c as Concern).shaftId) q.set("shaft", String((c as Concern).shaftId));
    if (asset) q.set("pump", String(asset));
    return "#scenarios?" + q.toString();
  };
  const assessment = rows(data, "assessment")[0],
    current = assessment?.data as Assessment | undefined,
    previous = rows(data, "assessment")[1];
  const concerns = (current?.concerns || []).filter(
      (c) => zone === "all" || c.zoneId === zone || c.zoneId === "all",
    ),
    workers = rows(data, "worker", zone).filter(
      (w) => w.data.status !== "checked-out",
    ),
    cases = rows(data, "case", zone),
    pendingReports = rows(data, "report", zone).filter(
      (r) => r.data.reviewStatus !== "accepted",
    ).length;
  const zoneName = (id: string) => (id === "all" ? "All zones" : data.site.zones.find((z) => z.id === id)?.name || id);
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
      notify("Response opened with linked evidence.");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="fs-command-grid">
        <section className="fs-panel">
          <div className="fs-section-heading">
            <div>
              <h2>Concerns to review</h2>
              <p>
                {assessment
                  ? `Based on ${current?.observationIds.length || 0} checked fact(s) · updated ${date(assessment.createdAt)}`
                  : "No checked facts yet"}
              </p>
            </div>
            <Tag>
              {zone === "all"
                ? "All zones"
                : data.site.zones.find((z) => z.id === zone)?.name}
            </Tag>
          </div>
          {pendingReports > 0 && (
            <div className="fs-inline-alert">
              <ClipboardCheck size={16} /> {pendingReports} report(s) still
              need their facts checked before they can raise a concern.
              <button className="fs-inline-link" onClick={openReports}>
                Check reports <ArrowRight size={14} />
              </button>
            </div>
          )}
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
                          : c.priority === "advisory"
                            ? "Advisory"
                            : "Review required"}
                      </Tag>
                      <small>{zoneName(c.zoneId)}</small>
                    </div>
                    <h3>{c.title}</h3>
                    <p>{c.reason}</p>
                    <div className="fs-concern-meta">
                      <span>{c.observationIds.length + (c.evidence?.length || 0)} source(s)</span>
                      <span>
                        {response
                          ? `Owner: ${response.data.owner}`
                          : "No owner yet"}
                      </span>
                      <span>{c.controlState}</span>
                      <span>
                        {declaredIn(c.zoneId)} declared underground in this
                        zone now
                      </span>
                    </div>
                  </div>
                  <div className="fs-concern-actions">
                    <button
                      className="fs-button secondary"
                      onClick={() => {
                        setSelected(c);
                        setExplanation(null);
                        setError("");
                      }}
                    >
                      {response ? "View" : "Assign owner"} <ArrowRight size={15} />
                    </button>
                    {c.priority !== "advisory" && (
                      <a className="fs-button" href={scenarioLink(c)}>
                        Run scenario
                      </a>
                    )}
                  </div>
                </article>
              );
            })
          ) : (
            <div className="fs-command-empty">
              <ShieldCheck size={36} />
              <h3>
                {assessment
                  ? "No concern raised by the checked facts"
                  : "No concerns yet"}
              </h3>
              <p>
                {assessment
                  ? "This does not mean a zone is clear. Missing and old information still needs checking."
                  : "Concerns appear here after a report or inspection is submitted and its facts are checked by a supervisor."}
              </p>
              <button className="fs-inline-link" onClick={openReports}>
                Submit a report <ArrowRight size={16} />
              </button>
            </div>
          )}
        </section>
        <aside className="fs-panel fs-source-status">
          <div className="fs-section-heading">
            <h2>What Foresight can see</h2>
          </div>
          <Status
            label="Checked written facts"
            value={`${rows(data, "observation", zone).length} accepted`}
            status="recorded"
          />
          <Status
            label="Live water measurements"
            value="No sensor connected"
            status="unavailable"
          />
          <Status
            label="Camera evidence"
            value={`${rows(data, "vision-event", zone).length} recorded events`}
            status={data.services.vision ? "configured" : "unavailable"}
          />
          <Status
            label="People's locations"
            value="Declared at check-in, not tracked"
            status="declared"
          />
          <SensorRow data={data} />
          {data.messaging && (
            <>
              <RainCard data={data} post={post} refresh={refresh} notify={notify} />
              <PreEntryCard data={data} post={post} refresh={refresh} notify={notify} />
            </>
          )}
          <div className="fs-note">
            <strong>Gaps stay visible</strong>
            <p>
              A written report cannot supply a measured water inflow. Treat
              anything marked unavailable as unknown, not as safe.
            </p>
          </div>
        </aside>
      </div>
      {selected && (
        <Dialog title={selected.title} onClose={() => setSelected(null)}>
          <Tag tone="amber">{selected.priority === "urgent-review" ? "Urgent review" : selected.priority === "advisory" ? "Advisory" : "Review required"}</Tag>
          <p>{selected.reason}</p>
          <dl className="fs-meta">
            <dt>Zone</dt>
            <dd>{zoneName(selected.zoneId)}</dd>
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
            <dt>Assigned people in zone</dt>
            <dd>
              {workers
                .filter((w) => w.zoneId === selected.zoneId)
                .map((w) => w.data.name)
                .join(", ") || "None recorded; location remains unknown"}
            </dd>
          </dl>
          <ConcernEvidence concern={selected} />
          {selected.observationIds.length > 0 && <h3>Supporting evidence</h3>}
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
          {data.messaging && (selected.rules?.includes("rain-forecast") || selected.rules?.some((r) => r.startsWith("pre-entry"))) && (
            <AdvisoryAction data={data} concern={selected} post={post} refresh={refresh} notify={notify} />
          )}
          <h3>Response</h3>
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
                <button
                  className="fs-inline-link"
                  onClick={() => {
                    setSelected(null);
                    openResponses();
                  }}
                >
                  Manage response
                </button>
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
