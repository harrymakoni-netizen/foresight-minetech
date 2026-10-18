"use client";
import { useState } from "react";
import { Users, ShieldCheck, ClipboardList } from "lucide-react";
import { queue, sync } from "@/lib/client/queue";
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
export function People({ data, zone, post, refresh, notify }: ViewProps) {
  const [tab, setTab] = useState("crew"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<Row | null>(null),
    [name, setName] = useState(""),
    [target, setTarget] = useState(zone === "all" ? "zone-b" : zone),
    [starts, setStarts] = useState(localInput()),
    [ends, setEnds] = useState(
      localInput(new Date(Date.now() + 8 * 3600e3).toISOString()),
    ),
    [action, setAction] = useState(""),
    [reason, setReason] = useState(""),
    [verification, setVerification] = useState(""),
    [caseId, setCaseId] = useState("");
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
  const workers = rows(data, "worker", zone),
    cases = rows(data, "case", zone),
    musters = rows(data, "muster", zone);
  const current = selected
    ? data.entities.find((e) => e.id === selected.id) || selected
    : null;
  return (
    <>
      <div className="fs-page-heading">
        <div>
          <div className="fs-eyebrow">WORKERSAFE / DOCUMENTED RESPONSE</div>
          <h1>People and Response</h1>
          <p>
            Assignments, response ownership and human confirmations in one
            timeline.
          </p>
        </div>
        <a
          className="fs-button secondary"
          href="/api/workspace/export?format=text"
        >
          Export response timeline
        </a>
      </div>
      <div
        className="fs-tabs"
        role="tablist"
        aria-label="People and response views"
      >
        {[
          ["crew", "Crew and shifts", Users],
          ["cases", "Cases and actions", ClipboardList],
          ["muster", "Human muster", ShieldCheck],
        ].map(([id, label, Icon]) => {
          const I = Icon as typeof Users;
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
      {tab === "crew" && (
        <div className="fs-evidence-grid">
          <section className="fs-panel">
            <h2>Register a fictional assignment</h2>
            <form
              className="fs-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await queue(data.workspace.id, "workers", {
                    name,
                    zoneId: target,
                    role: "Fictional crew",
                    startsAt: fromLocal(starts),
                    endsAt: fromLocal(ends),
                    status: "assigned",
                  });
                  try {
                    await sync(data.workspace.id);
                  } catch {
                    notify(
                      "Assignment saved to device; pending server validation.",
                    );
                  }
                  setName("");
                  await refresh();
                });
              }}
            >
              <Field label="Fictional worker name">
                <input
                  required
                  minLength={2}
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="Assigned zone">
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
              <Field label="Assignment start · Africa/Harare">
                <input
                  type="datetime-local"
                  required
                  value={starts}
                  onChange={(e) => setStarts(e.target.value)}
                />
              </Field>
              <Field label="Assignment end · Africa/Harare">
                <input
                  type="datetime-local"
                  required
                  value={ends}
                  onChange={(e) => setEnds(e.target.value)}
                />
              </Field>
              <button className="fs-button" disabled={busy}>
                Register assignment
              </button>
            </form>
            <p className="fs-note">
              An assignment is an administrative record. Check-in does not
              provide continuous underground location.
            </p>
          </section>
          <section className="fs-panel">
            <div className="fs-section-heading">
              <h2>Crew register</h2>
              <Tag>{workers.length} records</Tag>
            </div>
            {workers.map((w) => (
              <div className="fs-history-item" key={w.id}>
                <h3>{w.data.name}</h3>
                <Tag tone={w.data.status === "checked-out" ? "muted" : "teal"}>
                  {w.data.status}
                </Tag>
                <p>
                  {data.site.zones.find((z) => z.id === w.zoneId)?.name}
                  <br />
                  <small>
                    {date(w.data.startsAt)} → {date(w.data.endsAt)}
                  </small>
                </p>
                <div className="fs-button-row">
                  {["checked-in", "checked-out"]
                    .filter((s) => s !== w.data.status)
                    .map((status) => (
                      <button
                        key={status}
                        disabled={busy}
                        className="fs-button secondary"
                        onClick={() =>
                          void run(async () => {
                            await queue(data.workspace.id, "worker-status", {
                              id: w.id,
                              expectedRevision: w.revision,
                              status,
                              reason:
                                "Fictional supervisor recorded this status.",
                            });
                            try {
                              await sync(data.workspace.id);
                            } catch {
                              notify(
                                "Check-in/status saved on this device; pending server validation.",
                              );
                            }
                            await refresh();
                          })
                        }
                      >
                        {status === "checked-in"
                          ? "Record check-in"
                          : "Check out"}
                      </button>
                    ))}
                </div>
              </div>
            ))}
            {!workers.length && (
              <Empty title="No assignments in this zone">
                Register a fictional assignment with its validity interval.
              </Empty>
            )}
          </section>
        </div>
      )}
      {tab === "cases" && (
        <section className="fs-panel">
          <div className="fs-section-heading">
            <h2>Response register</h2>
            <a className="fs-inline-link" href="#overview">
              Open a case from a concern
            </a>
          </div>
          {cases.map((c) => (
            <button
              className="fs-case-row"
              key={c.id}
              onClick={() => {
                setSelected(c);
                setError("");
                setReason("");
                setAction("");
              }}
            >
              <div>
                <Tag tone={c.data.status === "closed" ? "teal" : "amber"}>
                  {c.data.status}
                </Tag>
                <h3>{c.data.title}</h3>
                <small>
                  {data.site.zones.find((z) => z.id === c.zoneId)?.name} ·
                  Owner: {c.data.owner}
                </small>
              </div>
              <div>
                <span>Due {date(c.data.dueAt)}</span>
                <small>
                  {c.data.actions?.length || 0} action(s) · revision{" "}
                  {c.revision}
                </small>
              </div>
            </button>
          ))}
          {!cases.length && (
            <Empty title="No response cases">
              Review a concern in Command Centre and assign an owner. A
              completed action still needs verification before case closure.
            </Empty>
          )}
        </section>
      )}
      {tab === "muster" && (
        <>
          <section className="fs-panel">
            <div className="fs-section-heading">
              <div>
                <h2>Freeze a roster for confirmation</h2>
                <p>
                  Only currently valid assignments are included. Estimated lab
                  arrivals never confirm attendance.
                </p>
              </div>
              <Tag>Human record</Tag>
            </div>
            <form
              className="fs-form fs-form-columns"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await post("muster", {
                    zoneId: target,
                    caseId: caseId || null,
                  });
                  notify(
                    "Time-specific roster snapshot created. Confirm each person explicitly.",
                  );
                  await refresh();
                });
              }}
            >
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
              <Field label="Linked case (optional)">
                <select
                  value={caseId}
                  onChange={(e) => setCaseId(e.target.value)}
                >
                  <option value="">No linked case</option>
                  {cases
                    .filter((c) => c.zoneId === target)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.data.title}
                      </option>
                    ))}
                </select>
              </Field>
              <button className="fs-button" disabled={busy}>
                Start human muster
              </button>
            </form>
          </section>
          {musters.map((m) => (
            <section className="fs-panel" key={m.id}>
              <div className="fs-section-heading">
                <div>
                  <h2>
                    {data.site.zones.find((z) => z.id === m.zoneId)?.name}{" "}
                    muster
                  </h2>
                  <p>Roster frozen {date(m.data.rosterAt)}</p>
                </div>
                <Tag
                  tone={m.data.status === "accounted-for" ? "teal" : "amber"}
                >
                  {m.data.status}
                </Tag>
              </div>
              {m.data.members.map((member: any) => (
                <div className="fs-list-row" key={member.workerId}>
                  <div>
                    <strong>{member.name}</strong>
                    <small>
                      {member.confirmed
                        ? `Confirmed by ${member.actor} · ${date(member.confirmedAt)}`
                        : `Awaiting human confirmation · assignment revision ${member.assignmentRevision}`}
                    </small>
                  </div>
                  <button
                    disabled={busy}
                    className="fs-button secondary"
                    onClick={() =>
                      void run(async () => {
                        await post(`muster/${m.id}/confirm`, {
                          expectedRevision: m.revision,
                          workerId: member.workerId,
                          confirmed: !member.confirmed,
                          reason: member.confirmed
                            ? "Correction recorded during fictional drill."
                            : "Human confirmation recorded during fictional drill.",
                        });
                        await refresh();
                      })
                    }
                  >
                    {member.confirmed
                      ? "Correct confirmation"
                      : "Confirm present"}
                  </button>
                </div>
              ))}
              {!m.data.members.length && (
                <Empty title="Empty roster">
                  No active assignments were present at the roster cutoff.
                </Empty>
              )}
            </section>
          ))}
          {!musters.length && (
            <Empty title="No muster snapshots">
              Create a time-specific roster above.
            </Empty>
          )}
        </>
      )}
      {current && (
        <Dialog title={current.data.title} onClose={() => setSelected(null)}>
          <Tag tone="amber">{current.data.status}</Tag>
          <dl className="fs-meta">
            <dt>Owner</dt>
            <dd>{current.data.owner}</dd>
            <dt>Due</dt>
            <dd>{date(current.data.dueAt)}</dd>
            <dt>Assessment</dt>
            <dd>{current.data.assessmentId}</dd>
            <dt>Case revision</dt>
            <dd>{current.revision}</dd>
          </dl>
          {current.data.sourceRunId && (
            <p>
              Laboratory source run: <code>{current.data.sourceRunId}</code>.
              This response records a human decision; calculated arrival is not
              muster confirmation.
            </p>
          )}
          {current.data.sourceEventId && (
            <p>
              Confirmed source event: <code>{current.data.sourceEventId}</code>.
            </p>
          )}
          {current.data.assumptions && (
            <details>
              <summary>Preserved run assumptions and results</summary>
              <pre>
                {JSON.stringify(
                  {
                    runId: current.data.sourceRunId,
                    assumptions: current.data.assumptions,
                    result: current.data.sourceResult,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          )}
          <ErrorText message={error} />
          <h3>Actions</h3>
          {current.data.actions.map((a: any) => (
            <div className="fs-history-item" key={a.id}>
              <strong>{a.title}</strong>
              <Tag>{a.completed ? "Completed" : "Recorded"}</Tag>
              <small>
                {a.actor} · {date(a.at)} · due {date(a.dueAt)}
              </small>
            </div>
          ))}
          {current.data.status !== "closed" && (
            <form
              className="fs-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await post(`cases/${current.id}/actions`, {
                    expectedRevision: current.revision,
                    title: action,
                    dueAt: fromLocal(ends),
                    completed: true,
                    evidenceIds: verification ? [verification] : [],
                  });
                  setAction("");
                  await refresh();
                });
              }}
            >
              <Field label="Completed corrective action">
                <input
                  required
                  minLength={3}
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                />
              </Field>
              <Field label="Action due · Africa/Harare">
                <input
                  type="datetime-local"
                  required
                  value={ends}
                  onChange={(e) => setEnds(e.target.value)}
                />
              </Field>
              <button className="fs-button secondary" disabled={busy}>
                Record completed action
              </button>
            </form>
          )}
          <h3>Response history</h3>
          <ol className="fs-timeline">
            {current.data.history.map((h: any, i: number) => (
              <li key={i}>
                <strong>{h.status}</strong>
                <p>{h.reason}</p>
                <small>
                  {h.actor} · {date(h.at)}
                </small>
              </li>
            ))}
          </ol>
          <h3>Record next decision</h3>
          <Field label="Verification evidence in this zone">
            <select
              value={verification}
              onChange={(e) => setVerification(e.target.value)}
            >
              <option value="">No verification selected</option>
              {data.entities
                .filter(
                  (e) =>
                    e.zoneId === current.zoneId &&
                    ["observation", "inspection", "vision-event"].includes(
                      e.kind,
                    ),
                )
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {String(e.data.title || e.data.condition || e.kind).slice(
                      0,
                      80,
                    )}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Decision / reopening / correction reason">
            <textarea
              rows={3}
              minLength={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div className="fs-button-row">
            {(
              {
                open: ["acknowledged"],
                acknowledged: ["action-in-progress", "awaiting-verification"],
                "action-in-progress": ["awaiting-verification"],
                "awaiting-verification": ["action-in-progress", "closed"],
                closed: ["open"],
              } as Record<string, string[]>
            )[current.data.status]?.map((status) => (
              <button
                className="fs-button secondary"
                key={status}
                disabled={busy || reason.trim().length < 3}
                onClick={() =>
                  void run(async () => {
                    await post(`cases/${current.id}/transition`, {
                      expectedRevision: current.revision,
                      status,
                      reason,
                      verificationIds: verification ? [verification] : [],
                    });
                    notify(
                      "Decision recorded. Historical concern and evidence remain unchanged.",
                    );
                    await refresh();
                  })
                }
              >
                {status === "open" ? "Reopen with reason" : status}
              </button>
            ))}
          </div>
          <p className="fs-muted">
            Closing this record is a reviewed workflow decision. It does not
            certify the zone as safe.
          </p>
        </Dialog>
      )}
    </>
  );
}
