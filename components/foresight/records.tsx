"use client";
import dynamic from "next/dynamic";
import { useState } from "react";
import {
  ClipboardList,
  Download,
  FileText,
  LogIn,
  MessageSquare,
  ShieldAlert,
  Users,
} from "lucide-react";
import { messageText, messageTone, statusText, statusTone } from "./underground";
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
  ["people", "People and musters", Users],
  ["checkins", "Check-ins", LogIn],
  ["messages", "Messages", MessageSquare],
  ["exports", "Exports and audit", ClipboardList],
] as const;
export function Records(props: ViewProps & { initialTab?: string }) {
  const [tab, setTab] = useState(props.initialTab || "people");
  return (
    <>
      <div className="fs-page-heading">
        <div>
          <h1>Records</h1>
          <p>
            The people register and the history of every check-in, muster and
            message, with exports for audits.
          </p>
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
      {tab === "people" && (
        <>
          <PeopleRegister {...props} />
          <People {...props} mode="records" />
        </>
      )}
      {tab === "checkins" && <CheckInLog {...props} />}
      {tab === "messages" && <MessageLog {...props} />}
      {tab === "exports" && <Exports {...props} />}
    </>
  );
}
export function IncidentRegister({ data, zone, post, refresh, notify, onOpen }: ViewProps & { onOpen?: (row: Row) => void }) {
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
          <h2>Responses and incidents</h2>
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
                    {onOpen ? (
                      <button className="fs-inline-link fs-case-open" onClick={() => onOpen(c)}>
                        {String(c.data.title)}
                      </button>
                    ) : (
                      <strong>{String(c.data.title)}</strong>
                    )}
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
                    {supervisor && (
                      <a className="fs-inline-link fs-block" href={`/api/workspace/incidents/${c.id}/pdf`}>
                        Incident PDF
                      </a>
                    )}
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
      <h3 className="fs-subhead">CSV records</h3>
      <div className="fs-button-row">
        {[
          ["check-in", "Check-ins"],
          ["case", "Responses and incidents"],
          ["message", "Messages"],
          ["muster", "Musters"],
          ["person", "People"],
        ].map(([kind, label]) => (
          <a key={kind} className="fs-button secondary" href={`/api/workspace/export?format=csv&kind=${kind}`}>
            {label} (CSV)
          </a>
        ))}
      </div>
      <p className="fs-help">
        {data.entities.length} records in this workspace. Each incident has a
        PDF report (Concerns → Responses). Phone numbers in CSV are
        masked; viewers and reporters do not receive them.
      </p>
    </section>
  );
}

const hhmm = (iso: unknown) => (iso ? date(String(iso)) : "—");
function PeopleRegister({ data, post, refresh, notify }: ViewProps) {
  const people = rows(data, "person");
  const supervisor = ["supervisor", "administrator"].includes(data.workspace.role);
  const [adding, setAdding] = useState(false), [error, setError] = useState("");
  const [f, setF] = useState({ name: "", phone: "", role: "miner", zoneId: "", buddy: "", whatsapp: false, sms: true });
  return (
    <section className="fs-panel">
      <div className="fs-section-heading">
        <div>
          <h2>People register</h2>
          <p>Everyone who can check in, be a buddy or receive alerts. Phone numbers are stored sealed and shown masked to supervisors only.</p>
        </div>
        {supervisor && (
          <button className="fs-button" onClick={() => setAdding(true)}>
            Add person
          </button>
        )}
      </div>
      <div className="fs-table-wrap">
        <table className="fs-register">
          <caption className="fs-sr-only">People register</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Phone</th>
              <th scope="col">Channels</th>
              <th scope="col">Consent</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const consent = p.data.consent as { status: string; at?: string; channel?: string };
              const ch = p.data.channels as { whatsapp: boolean; sms: boolean };
              return (
                <tr key={p.id}>
                  <td>
                    {String(p.data.name)}
                    {p.data.fictional ? <small className="fs-block">Fictional training person</small> : null}
                  </td>
                  <td>{String(p.data.role)}</td>
                  <td>{p.data.phoneMasked ? String(p.data.phoneMasked) : supervisor ? "No phone" : "Hidden"}</td>
                  <td>{[ch.whatsapp && "WhatsApp", ch.sms && "SMS"].filter(Boolean).join(", ") || "None"}</td>
                  <td>
                    <Tag tone={consent.status === "given" ? "teal" : "amber"}>
                      {consent.status === "given" ? "Given" : consent.status === "withdrawn" ? "Withdrawn" : "Not recorded"}
                    </Tag>
                    {consent.at ? <small className="fs-block">{hhmm(consent.at)} · {consent.channel}</small> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {adding && (
        <Dialog title="Add person" onClose={() => setAdding(false)}>
          <p className="fs-help">Consent is recorded separately: on first message (reply YES) or in person.</p>
          <Field label="Name">
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Phone (international format)" help="Only add numbers of people who agreed to receive Foresight messages.">
            <input value={f.phone} inputMode="tel" placeholder="+263…" onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </Field>
          <Field label="Role">
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              <option value="miner">Miner</option>
              <option value="shift-boss">Shift boss</option>
              <option value="supervisor">Supervisor</option>
              <option value="administrator">Administrator</option>
            </select>
          </Field>
          <Field label="Usual zone">
            <select value={f.zoneId} onChange={(e) => setF({ ...f, zoneId: e.target.value })}>
              <option value="">Not stated</option>
              {data.site.zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Saved buddy">
            <select value={f.buddy} onChange={(e) => setF({ ...f, buddy: e.target.value })}>
              <option value="">None</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {String(p.data.name)}
                </option>
              ))}
            </select>
          </Field>
          <fieldset className="fs-checks">
            <legend>Channels</legend>
            <label>
              <input type="checkbox" checked={f.sms} onChange={(e) => setF({ ...f, sms: e.target.checked })} /> SMS
            </label>
            <label>
              <input type="checkbox" checked={f.whatsapp} onChange={(e) => setF({ ...f, whatsapp: e.target.checked })} /> WhatsApp
            </label>
          </fieldset>
          <ErrorText message={error} />
          <button
            className="fs-button"
            onClick={() =>
              void post("people", { name: f.name, phone: f.phone || null, role: f.role, zoneId: f.zoneId || null, defaultBuddyId: f.buddy || null, channels: { whatsapp: f.whatsapp, sms: f.sms } })
                .then(async () => {
                  setAdding(false);
                  notify("Person added. Record consent before their first check-in.");
                  await refresh();
                })
                .catch((e) => setError(e.message))
            }
          >
            Save person
          </button>
        </Dialog>
      )}
    </section>
  );
}
function CheckInLog({ data }: ViewProps) {
  const list = rows(data, "check-in").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const steps = data.messaging?.steps || [];
  return (
    <section className="fs-panel">
      <div className="fs-section-heading">
        <div>
          <h2>Check-ins</h2>
          <p>Declarations at the shaft collar, with their escalation steps. A check-in is never a confirmed location.</p>
        </div>
      </div>
      {list.length === 0 ? (
        <Empty title="No check-ins yet">Check-ins arrive by WhatsApp, SMS, shift-boss team message or manual entry.</Empty>
      ) : (
        <div className="fs-table-wrap">
          <table className="fs-register">
            <caption className="fs-sr-only">Check-ins</caption>
            <thead>
              <tr>
                <th scope="col">Person · Ref</th>
                <th scope="col">Shaft</th>
                <th scope="col">In · expected back · out</th>
                <th scope="col">Buddy · method</th>
                <th scope="col">Status</th>
                <th scope="col">Escalation</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} className={c.data.status === "return-overdue" || c.data.status === "confirmed-missing" ? "overdue" : ""}>
                  <td>
                    {String(c.data.personName)}
                    <small className="fs-block">Ref {String(c.data.reference)}</small>
                  </td>
                  <td>{String(c.data.shaftName)}</td>
                  <td>
                    {hhmm(c.data.timeIn)}
                    <small className="fs-block">Back by {hhmm(c.data.expectedReturn)}</small>
                    <small className="fs-block">Out {c.data.timeOut ? hhmm(c.data.timeOut) : "not checked out"}</small>
                  </td>
                  <td>
                    {String(c.data.buddyName || "None")}
                    <small className="fs-block">{c.data.method === "manual" ? "Manual check-in" : String(c.data.method)} · {String(c.data.declaredBy)}</small>
                  </td>
                  <td>
                    <Tag tone={statusTone[String(c.data.status)]}>{statusText[String(c.data.status)]}</Tag>
                  </td>
                  <td>
                    {steps
                      .filter((s) => s.checkin_id === c.id)
                      .map((s) => (
                        <small className="fs-block" key={s.step}>
                          {s.step}: {s.executed_at ? `ran ${hhmm(s.executed_at)}` : s.cancelled_at ? "stopped" : `due ${hhmm(s.due_at)}`}
                        </small>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
function MessageLog({ data }: ViewProps) {
  const list = rows(data, "message").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const mode = data.messaging?.mode;
  return (
    <section className="fs-panel">
      <div className="fs-section-heading">
        <div>
          <h2>Messages</h2>
          <p>
            Every message in and out, with its status history. Accepted by a provider is not delivered; only a delivery receipt counts.
            {mode === "dry-run" ? " Dry-run mode: nothing has been sent to anyone." : ""}
          </p>
        </div>
      </div>
      {list.length === 0 ? (
        <Empty title="No messages yet" />
      ) : (
        <ul className="fs-message-log">
          {list.map((m) => (
            <li key={m.id}>
              <div>
                <strong>{m.data.direction === "inbound" ? "In" : "Out"} · {String(m.data.channel).toUpperCase()}</strong>{" "}
                {m.data.direction === "inbound" ? `from ${String(m.data.senderMasked || "hidden")}` : `to ${String(m.data.recipientMasked || "hidden")}`}
                {m.data.templateKey ? <small> · {String(m.data.templateKey)}</small> : null}{" "}
                <Tag tone={messageTone[String(m.data.status)]}>{messageText[String(m.data.status)] || String(m.data.status)}</Tag>
              </div>
              <p>{String(m.data.text)}</p>
              <ol className="fs-history">
                {(m.data.statusHistory as { status: string; at: string; detail: string }[]).map((h, i) => (
                  <li key={i}>
                    {hhmm(h.at)} · {messageText[h.status] || h.status} · {h.detail}
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
