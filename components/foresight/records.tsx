"use client";
import dynamic from "next/dynamic";
import { useState } from "react";
import {
  ClipboardList,
  Download,
  FileText,
  ShieldAlert,
  Users,
} from "lucide-react";
import {
  date,
  Dialog,
  Empty,
  ErrorText,
  Field,
  fromLocal,
  localInput,
  rows,
  Tag,
  type Row,
  type ViewProps,
} from "./shared";
const Evidence = dynamic(() => import("./evidence").then((m) => m.Evidence), {
  loading: () => <p role="status">Loading evidence…</p>,
});
const People = dynamic(() => import("./people").then((m) => m.People), {
  loading: () => <p role="status">Loading people and muster…</p>,
});
export const categoryLabel: Record<string, string> = {
  "near-miss": "Near miss",
  injury: "Injury",
  "equipment-failure": "Equipment failure",
  "overdue-miner": "Overdue miner",
  collapse: "Collapse",
  flooding: "Flooding",
  drill: "Drill",
  planning: "Planning",
};
export const sourceLabel: Record<string, string> = {
  "real-event": "Real event",
  "overdue-escalation": "Overdue escalation",
  "declared-emergency": "Declared emergency",
  report: "Report",
  concern: "Concern",
  "planning-scenario": "Scenario (planning)",
  "escalated-scenario": "Escalated scenario",
  "legacy-mineshield": "MineShield (migrated)",
};
const statusLabel: Record<string, string> = {
  open: "Open",
  acknowledged: "Acknowledged",
  "action-in-progress": "In progress",
  "awaiting-verification": "Awaiting verification",
  closed: "Closed",
  reopened: "Reopened",
};
const tabs = [
  ["evidence", "Evidence and inspections", FileText],
  ["incidents", "Incidents and responses", ShieldAlert],
  ["people", "People and musters", Users],
  ["exports", "Exports and audit", ClipboardList],
] as const;
export function Records(props: ViewProps & { initialTab?: string }) {
  const [tab, setTab] = useState(props.initialTab || "evidence");
  return (
    <>
      <div className="fs-page-heading">
        <div>
          <div className="fs-eyebrow">RECORDS / TRACEABILITY</div>
          <h1>Records</h1>
          <p>What was reported, decided and done, with the full audit trail.</p>
        </div>
      </div>
      <div className="fs-tabs" role="tablist" aria-label="Record type">
        {tabs.map(([id, label, Icon]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            <Icon size={17} />
            {label}
          </button>
        ))}
      </div>
      {tab === "evidence" && <Evidence {...props} />}
      {tab === "incidents" && <IncidentRegister {...props} />}
      {tab === "people" && <People {...props} />}
      {tab === "exports" && <Exports {...props} />}
    </>
  );
}
function IncidentRegister({ data, zone, post, refresh, notify }: ViewProps) {
  const [creating, setCreating] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [filter, setFilter] = useState("all");
  const zoneName = (id: string | null) =>
    data.site.zones.find((z) => z.id === id)?.name || id || "No zone";
  const cases = rows(data, "case", zone)
    .filter((c) => filter === "all" || c.data.category === filter)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const supervisor = ["supervisor", "administrator"].includes(
    data.workspace.role,
  );
  const [form, setForm] = useState({
    title: "",
    zoneId: zone === "all" ? data.site.zones[0]?.id || "" : zone,
    category: "near-miss",
    source: "real-event",
    description: "",
    people: "",
    owner: "",
    dueAt: localInput(new Date(Date.now() + 24 * 3600e3).toISOString()),
  });
  async function save() {
    setBusy(true);
    setError("");
    try {
      await post("incidents", {
        title: form.title,
        zoneId: form.zoneId,
        category: form.category,
        source: form.source,
        description: form.description,
        peopleAffected: form.people
          .split(/[\n,]/)
          .map((n) => n.trim())
          .filter(Boolean)
          .map((name) => ({ name, personId: null })),
        owner: form.owner,
        dueAt: fromLocal(form.dueAt),
        occurredAt: null,
      });
      setCreating(false);
      notify("Incident recorded in the register.");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="fs-panel">
      <div className="fs-section-heading">
        <div>
          <h2>Incidents and responses</h2>
          <p>
            One register for real incidents, overdue escalations, declared
            emergencies, concerns and planning responses. Planning responses
            never send messages.
          </p>
        </div>
        <div className="fs-button-row">
          <label className="fs-inline-select">
            Category{" "}
            <select
              aria-label="Filter incidents by category"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">All</option>
              {Object.entries(categoryLabel).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {supervisor && (
            <button className="fs-button" onClick={() => setCreating(true)}>
              Record incident
            </button>
          )}
        </div>
      </div>
      {cases.length === 0 ? (
        <Empty title="No incidents or responses recorded">
          Incidents appear here when recorded, escalated from an overdue
          check-in, declared as an emergency or opened from a concern.
        </Empty>
      ) : (
        <div className="fs-table-wrap">
          <table className="fs-register">
            <caption className="fs-sr-only">Incidents and responses register</caption>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Zone</th>
                <th scope="col">Category</th>
                <th scope="col">Source</th>
                <th scope="col">Owner · due</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c: Row) => (
                <tr key={c.id}>
                  <td>
                    <strong>{String(c.data.title)}</strong>
                    {c.data.planning ? (
                      <>
                        {" "}
                        <Tag tone="amber">Planning</Tag>
                      </>
                    ) : null}
                    {Array.isArray(c.data.peopleAffected) &&
                    c.data.peopleAffected.length ? (
                      <small className="fs-block">
                        People affected:{" "}
                        {c.data.peopleAffected
                          .map((p: { name: string }) => p.name)
                          .join(", ")}
                      </small>
                    ) : null}
                  </td>
                  <td>{zoneName(c.zoneId)}</td>
                  <td>
                    {c.data.category
                      ? categoryLabel[String(c.data.category)] || String(c.data.category)
                      : "Not classified"}
                  </td>
                  <td>
                    {c.data.source
                      ? sourceLabel[String(c.data.source)] || String(c.data.source)
                      : "Not recorded"}
                  </td>
                  <td>
                    {String(c.data.owner || "No owner")}
                    <small className="fs-block">
                      {c.data.dueAt ? "Due " + date(String(c.data.dueAt)) : "No due date"}
                    </small>
                  </td>
                  <td>
                    <Tag tone={c.data.status === "closed" ? "teal" : "amber"}>
                      {statusLabel[String(c.data.status)] || String(c.data.status)}
                    </Tag>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="fs-help">
        Actions, verification and closure are managed from the case detail in
        People and musters. Every change is in the audit trail.
      </p>
      {creating && (
        <Dialog title="Record incident" onClose={() => setCreating(false)}>
          <Field label="Title">
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </Field>
          <Field label="Zone">
            <select
              value={form.zoneId}
              onChange={(e) => setForm({ ...form, zoneId: e.target.value })}
            >
              {data.site.zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category">
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            >
              {Object.entries(categoryLabel)
                .filter(([id]) => id !== "planning")
                .map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Source">
            <select
              value={form.source}
              onChange={(e) => setForm({ ...form, source: e.target.value })}
            >
              <option value="real-event">Real event</option>
              <option value="report">Report</option>
            </select>
          </Field>
          <Field label="What happened">
            <textarea
              rows={4}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </Field>
          <Field label="People affected" help="Names separated by commas or new lines.">
            <textarea
              rows={2}
              value={form.people}
              onChange={(e) => setForm({ ...form, people: e.target.value })}
            />
          </Field>
          <Field label="Owner">
            <input
              value={form.owner}
              onChange={(e) => setForm({ ...form, owner: e.target.value })}
            />
          </Field>
          <Field label="Due (CAT)">
            <input
              type="datetime-local"
              value={form.dueAt}
              onChange={(e) => setForm({ ...form, dueAt: e.target.value })}
            />
          </Field>
          <ErrorText message={error} />
          <button className="fs-button" disabled={busy} onClick={() => void save()}>
            Save incident
          </button>
        </Dialog>
      )}
    </section>
  );
}
function Exports({ data }: ViewProps) {
  return (
    <section className="fs-panel">
      <div className="fs-section-heading">
        <div>
          <h2>Exports and audit</h2>
          <p>
            Every acceptance, edit, alert and closure is recorded with who and
            when. Exports are scoped to this workspace.
          </p>
        </div>
      </div>
      <div className="fs-button-row">
        <a className="fs-button" href="/api/workspace/export">
          <Download size={16} /> Evidence and audit bundle (JSON)
        </a>
        <a className="fs-button secondary" href="/api/workspace/export?format=text">
          Readable timeline
        </a>
      </div>
      <p className="fs-help">
        {data.entities.length} records in this workspace. Incident PDF and CSV
        exports are added with the emergency workflow.
      </p>
    </section>
  );
}
