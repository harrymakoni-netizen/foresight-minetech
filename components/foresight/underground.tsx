"use client";
// Underground now (spec §13.1): declared headcount by shaft, overdue first,
// alerts with per-message delivery status, gateway and scheduler health.
// Wording rule: "declared underground", never "is underground".
import { useEffect, useState } from "react";
import { PersonnelMonitor } from "./personnel-monitor";
import { AlertTriangle, MessageSquare, Radio, Siren, UserPlus, Users } from "lucide-react";
import { queue, queued, sync, type Queued } from "@/lib/client/queue";
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

export const statusText: Record<string, string> = {
  "declared-underground": "Declared underground",
  "return-overdue": "Return overdue",
  "accounted-for": "Accounted for",
  "confirmed-missing": "Confirmed missing",
};
export const statusTone: Record<string, string> = {
  "declared-underground": "teal",
  "return-overdue": "red",
  "confirmed-missing": "red",
  "accounted-for": "muted",
};
export const messageTone: Record<string, string> = {
  delivered: "teal",
  accepted: "amber",
  queued: "amber",
  unconfirmed: "amber",
  failed: "red",
  blocked: "red",
  "dry-run": "muted",
  received: "muted",
};
export const messageText: Record<string, string> = {
  queued: "Queued",
  accepted: "Accepted, not yet delivered",
  delivered: "Delivered",
  failed: "Failed",
  unconfirmed: "Unconfirmed: no delivery receipt",
  blocked: "Blocked: not sent",
  "dry-run": "Dry run: not sent",
  received: "Received",
};
const stepText: Record<string, string> = {
  reminder: "Reminder to the miner",
  overdue: "Overdue: buddy alerted",
  supervisor: "Supervisor alerted, muster opened",
};
const time = (iso: unknown) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Harare", hourCycle: "h23" }).format(new Date(String(iso)))
    : "—";
const active = (s: unknown) => s === "declared-underground" || s === "return-overdue" || s === "confirmed-missing";
const rank: Record<string, number> = { "confirmed-missing": 0, "return-overdue": 1, "declared-underground": 2 };

export function UndergroundNow({ data, post, refresh, notify }: ViewProps) {
  const m = data.messaging;
  const checkIns = rows(data, "check-in");
  const current = checkIns.filter((c) => active(c.data.status));
  const overdue = current.filter((c) => c.data.status === "return-overdue");
  const missing = current.filter((c) => c.data.status === "confirmed-missing");
  const people = rows(data, "person");
  const messages = rows(data, "message");
  const supervisor = ["supervisor", "administrator"].includes(data.workspace.role);
  const [dialog, setDialog] = useState<null | "checkin" | "muster" | "emergency" | { row: Row; to: string }>(null);
  const emergencies = rows(data, "emergency").filter((e) => e.data.status === "active");
  // The top bar's Emergency shortcut links here with ?declare=1.
  useEffect(() => {
    const open = () => {
      if (supervisor && location.hash.includes("declare=1")) {
        setDialog("emergency");
        history.replaceState(null, "", "#underground");
      }
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, [supervisor]);
  const [pending, setPending] = useState<Queued[]>([]);
  useEffect(() => {
    void queued(data.workspace.id)
      .then((q) => setPending(q.filter((x) => x.operation === "checkins" && x.state !== "synced")))
      .catch(() => {});
  }, [data]);
  const shafts = m?.config.shafts || [];
  const gateway = m?.gateways[0];
  const gatewayOk = gateway?.status === "online" && !gateway.stale;
  return (
    <section aria-labelledby="underground-heading" className="fs-underground">
      <h2 id="underground-heading" className="fs-sr-only">
        Declared headcount
      </h2>
      <div className="fs-headcount" role="list">
        <div role="listitem" className="fs-count">
          <span>Declared underground</span>
          <strong>{current.length}</strong>
          <small>from check-ins, not live locations</small>
        </div>
        <div role="listitem" className="fs-count">
          <span>Shafts with people down</span>
          <strong>{shafts.filter((s) => current.some((c) => c.data.shaftId === s.id)).length}<small> of {shafts.length}</small></strong>
          <small>per-shaft roll below</small>
        </div>
        <div role="listitem" className={"fs-count " + (overdue.length ? "danger" : "")}>
          <span>Return overdue</span>
          <strong>{overdue.length}</strong>
          <small>{overdue.length ? "needs action now" : "none overdue"}</small>
        </div>
        {missing.length > 0 && (
          <div role="listitem" className="fs-count danger">
            <span>Confirmed missing</span>
            <strong>{missing.length}</strong>
            <small>incident open</small>
          </div>
        )}
      </div>
      <div className="fs-service-row" aria-label="Messaging services">
        <Tag tone={m?.mode === "live" ? "teal" : "amber"}>
          <MessageSquare size={13} />{" "}
          {m?.mode === "dry-run"
            ? "Messaging: dry run, nothing is sent"
            : m?.mode === "allow-list"
              ? `Messaging: test numbers only (${m.testNumberCount})`
              : m?.liveEnabled
                ? "Messaging: live"
                : "Messaging: live mode set but not enabled by an administrator"}
        </Tag>
        <Tag tone={gatewayOk ? "teal" : "red"}>
          <Radio size={13} />{" "}
          {!gateway || gateway.status === "not-configured"
            ? "SMS gateway: not configured"
            : gatewayOk
              ? `SMS gateway online${gateway.batteryPercent !== null ? ` · battery ${gateway.batteryPercent}%` : ""}`
              : `Gateway offline: ${gateway.reason}${gateway.stale ? " (no recent heartbeat)" : ""}`}
        </Tag>
        <Tag tone={m?.scheduler.running ? "teal" : "red"}>{m?.scheduler.message || "Scheduler status unknown"}</Tag>
      </div>
      {emergencies.map((e) => (
        <EmergencyPanel key={e.id} emergency={e} data={data} post={post} refresh={refresh} notify={notify} supervisor={supervisor} />
      ))}
      {supervisor && (
        <div className="fs-button-row fs-actions">
          <button className="fs-button danger" onClick={() => setDialog("emergency")}>
            <Siren size={16} /> Declare emergency
          </button>
          <button className="fs-button" onClick={() => setDialog("checkin")}>
            <UserPlus size={16} /> Manual check-in
          </button>
          <button className="fs-button secondary" onClick={() => setDialog("muster")}>
            <Users size={16} /> Start muster
          </button>
          <a className="fs-button secondary" href="#scenarios">
            Run scenario
          </a>
        </div>
      )}
      {pending.length > 0 && (
        <div className="fs-alert" role="status">
          <AlertTriangle size={16} /> {pending.length} check-in(s) saved on this device are{" "}
          <strong>not yet registered</strong>. They protect nobody until the server stores them.
          <button onClick={() => void sync(data.workspace.id).then(refresh)}>Sync now</button>
        </div>
      )}
      <PersonnelMonitor data={data} post={post} refresh={refresh} notify={notify} zone="" />
      <div className="fs-shafts">
        {shafts.map((s) => {
          const here = current
            .filter((c) => c.data.shaftId === s.id)
            .sort((a, b) => rank[String(a.data.status)] - rank[String(b.data.status)] || String(a.data.expectedReturn).localeCompare(String(b.data.expectedReturn)));
          return (
            <article key={s.id} className="fs-panel fs-shaft-card" aria-label={`${s.name}: ${here.length} declared underground`}>
              <div className="fs-section-heading">
                <h3>
                  {s.number}. {s.name}
                </h3>
                <span>{here.length} declared underground</span>
              </div>
              {here.length === 0 ? (
                <p className="fs-muted">Nobody declared underground here.</p>
              ) : (
                <ul className="fs-roll">
                  {here.map((c) => (
                    <li key={c.id} className={c.data.status === "declared-underground" ? "" : "overdue"}>
                      <div>
                        <strong>{String(c.data.personName)}</strong>{" "}
                        <Tag tone={statusTone[String(c.data.status)]}>{statusText[String(c.data.status)]}</Tag>
                        <small className="fs-block">
                          In {time(c.data.timeIn)} · back by {time(c.data.expectedReturn)} · buddy {String(c.data.buddyName || "none")} · Ref {String(c.data.reference)} ·{" "}
                          {c.data.method === "manual" ? "manual check-in" : `via ${c.data.method}`}
                        </small>
                      </div>
                      {supervisor && (
                        <div className="fs-roll-actions">
                          <button className="fs-button secondary" onClick={() => setDialog({ row: c, to: "accounted-for" })}>
                            Accounted for
                          </button>
                          {c.data.status !== "confirmed-missing" && (
                            <button className="fs-button danger" onClick={() => setDialog({ row: c, to: "confirmed-missing" })}>
                              Confirm missing
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}
      </div>
      <Alerts data={data} checkIns={checkIns} messages={messages} />
      {dialog === "checkin" && (
        <ManualCheckIn
          data={data}
          people={people}
          onClose={() => setDialog(null)}
          submit={async (body, offline) => {
            if (offline) {
              await queue(data.workspace.id, "checkins", body);
              notify("Saved on this device. Not yet registered: it protects nobody until synced.");
              setPending((await queued(data.workspace.id)).filter((x) => x.operation === "checkins" && x.state !== "synced"));
            } else {
              await post("checkins", body);
              notify("Check-in registered on the server.");
            }
            setDialog(null);
            await refresh();
          }}
          consent={async (personId, note) => {
            await post(`people/${personId}/consent`, { given: true, note });
            await refresh();
          }}
        />
      )}
      {dialog === "emergency" && (
        <DeclareEmergency
          shafts={shafts}
          counts={Object.fromEntries(shafts.map((s) => [s.id, current.filter((c) => c.data.shaftId === s.id).length]))}
          onClose={() => setDialog(null)}
          submit={async (body) => {
            await post("emergencies", body);
            notify("Emergency declared. The rescue roll is shown above.");
            setDialog(null);
            await refresh();
            window.scrollTo({ top: 0 });
          }}
        />
      )}
      {dialog === "muster" && (
        <Dialog title="Start muster" onClose={() => setDialog(null)}>
          <MusterForm
            shafts={shafts}
            submit={async (shaftId, reason) => {
              const r = await post("muster/shaft", { shaftId, reason });
              notify(`Muster: ${r.outcome}. Confirm each person in Records → People and musters.`);
              setDialog(null);
              await refresh();
            }}
          />
        </Dialog>
      )}
      {dialog && typeof dialog === "object" && (
        <StatusDialog
          row={dialog.row}
          to={dialog.to}
          onClose={() => setDialog(null)}
          submit={async (reason) => {
            await post(`checkins/${dialog.row.id}/status`, { expectedRevision: dialog.row.revision, status: dialog.to, reason });
            notify(dialog.to === "confirmed-missing" ? "Confirmed missing. An incident was opened in Records." : "Marked accounted for. Remaining escalation steps stopped.");
            setDialog(null);
            await refresh();
          }}
        />
      )}
    </section>
  );
}
function Alerts({ data, checkIns, messages }: { data: ViewProps["data"]; checkIns: Row[]; messages: Row[] }) {
  const steps = data.messaging?.steps || [];
  const alerted = checkIns.filter((c) => steps.some((s) => s.checkin_id === c.id && s.executed_at) && active(c.data.status));
  return (
    <section className="fs-panel" aria-labelledby="alerts-heading">
      <div className="fs-section-heading">
        <h3 id="alerts-heading">Active alerts</h3>
        <span>Escalation step and per-message delivery status</span>
      </div>
      {alerted.length === 0 ? (
        <Empty title="No active alerts">Alerts start when a declared return time passes without a check-out.</Empty>
      ) : (
        alerted.map((c) => (
          <div key={c.id} className="fs-alert-card">
            <strong>{String(c.data.personName)}</strong> · {String(c.data.shaftName)} · expected {time(c.data.expectedReturn)}
            <ol>
              {steps
                .filter((s) => s.checkin_id === c.id && s.executed_at)
                .map((s) => (
                  <li key={s.step}>
                    {stepText[s.step]} at {time(s.executed_at)}
                    <ul>
                      {messages
                        .filter((msg) => msg.data.checkInId === c.id && String(msg.data.idempotencyKey || "").startsWith(`${c.id}:${s.step}`))
                        .map((msg) => (
                          <li key={msg.id}>
                            {String(msg.data.channel).toUpperCase()} to {String(msg.data.recipientMasked || "recipient")}:{" "}
                            <Tag tone={messageTone[String(msg.data.status)]}>{messageText[String(msg.data.status)] || String(msg.data.status)}</Tag>
                          </li>
                        ))}
                    </ul>
                  </li>
                ))}
            </ol>
          </div>
        ))
      )}
    </section>
  );
}
function ManualCheckIn({
  data,
  people,
  onClose,
  submit,
  consent,
}: {
  data: ViewProps["data"];
  people: Row[];
  onClose: () => void;
  submit: (body: unknown, offline: boolean) => Promise<void>;
  consent: (personId: string, note: string) => Promise<void>;
}) {
  const shafts = data.messaging?.config.shafts || [];
  const eligible = people.filter((p) => p.data.role !== "buddy-contact");
  const [f, setF] = useState({
    personId: eligible[0]?.id || "",
    shaftId: shafts[0]?.id || "",
    zoneId: "",
    returnAt: localInput(new Date(Date.now() + 4 * 3600e3).toISOString()),
    buddyPersonId: "",
    reason: "Shift boss reported at the collar",
  });
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [note, setNote] = useState("");
  const person = eligible.find((p) => p.id === f.personId);
  const consented = (person?.data.consent as { status?: string })?.status === "given";
  const shaft = shafts.find((s) => s.id === f.shaftId);
  const go = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const body = () => ({
    personId: f.personId,
    shaftId: f.shaftId,
    zoneId: f.zoneId || null,
    expectedReturn: fromLocal(f.returnAt),
    buddyPersonId: f.buddyPersonId || null,
    reason: f.reason,
  });
  return (
    <Dialog title="Manual check-in" onClose={onClose}>
      <p className="fs-help">Recorded as a manual check-in by you. It is a declaration, not a location.</p>
      <Field label="Person">
        <select value={f.personId} onChange={(e) => setF({ ...f, personId: e.target.value })}>
          {eligible.map((p) => (
            <option key={p.id} value={p.id}>
              {String(p.data.name)}
            </option>
          ))}
        </select>
      </Field>
      {person && !consented && (
        <div className="fs-note">
          <strong>No consent recorded for {String(person.data.name)}.</strong> No check-in is accepted without consent.
          <Field label="Consent note (how it was given)">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Signed form at the lamp room" />
          </Field>
          <button className="fs-button secondary" disabled={busy || note.trim().length < 3} onClick={() => void go(() => consent(f.personId, note))}>
            Record consent given in person
          </button>
        </div>
      )}
      <Field label="Shaft">
        <select value={f.shaftId} onChange={(e) => setF({ ...f, shaftId: e.target.value, zoneId: "" })}>
          {shafts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.number}. {s.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Declared zone (optional)">
        <select value={f.zoneId} onChange={(e) => setF({ ...f, zoneId: e.target.value })}>
          <option value="">Not stated</option>
          {data.site.zones
            .filter((z) => shaft?.zoneIds.includes(z.id))
            .map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
        </select>
      </Field>
      <Field label="Expected back (CAT)">
        <input type="datetime-local" value={f.returnAt} onChange={(e) => setF({ ...f, returnAt: e.target.value })} />
      </Field>
      <Field label="Buddy">
        <select value={f.buddyPersonId} onChange={(e) => setF({ ...f, buddyPersonId: e.target.value })}>
          <option value="">None</option>
          {people
            .filter((p) => p.id !== f.personId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {String(p.data.name)}
              </option>
            ))}
        </select>
      </Field>
      <Field label="Reason">
        <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      </Field>
      <ErrorText message={error} />
      <div className="fs-button-row">
        <button className="fs-button" disabled={busy || !consented} onClick={() => void go(() => submit(body(), !navigator.onLine))}>
          Register check-in
        </button>
        <button className="fs-button secondary" disabled={busy || !consented} onClick={() => void go(() => submit(body(), true))}>
          Save on this device (offline)
        </button>
      </div>
    </Dialog>
  );
}
function MusterForm({ shafts, submit }: { shafts: { id: string; name: string }[]; submit: (shaftId: string, reason: string) => Promise<void> }) {
  const [shaftId, setShaftId] = useState(shafts[0]?.id || ""), [reason, setReason] = useState(""), [error, setError] = useState("");
  return (
    <>
      <p className="fs-help">Freezes everyone declared underground at the shaft. Only human confirmations mark people accounted for.</p>
      <Field label="Shaft">
        <select value={shaftId} onChange={(e) => setShaftId(e.target.value)}>
          {shafts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Reason">
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorText message={error} />
      <button className="fs-button" disabled={reason.trim().length < 3} onClick={() => void submit(shaftId, reason).catch((e) => setError(e.message))}>
        Start muster
      </button>
    </>
  );
}
function StatusDialog({ row, to, onClose, submit }: { row: Row; to: string; onClose: () => void; submit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState(""), [error, setError] = useState("");
  return (
    <Dialog title={`${statusText[to]}: ${String(row.data.personName)}`} onClose={onClose}>
      <p className="fs-help">
        {to === "confirmed-missing"
          ? "Confirm only after the person cannot be found. This opens an incident with the check-in, messages and timeline."
          : "Confirm that a person has seen this miner safe on surface, or that they checked out. This stops the escalation ladder."}
      </p>
      <Field label="Reason (who confirmed, where, when)">
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorText message={error} />
      <button className={"fs-button " + (to === "confirmed-missing" ? "danger" : "")} disabled={reason.trim().length < 3} onClick={() => void submit(reason).catch((e) => setError(e.message))}>
        {statusText[to]}
      </button>
      <p className="fs-help">Last change {date(String(row.updatedAt))}</p>
    </Dialog>
  );
}

const rollText: Record<string, string> = {
  unconfirmed: "Not yet confirmed",
  "accounted-for": "Accounted for",
  injured: "Found injured",
  "confirmed-missing": "Confirmed missing",
};
const rollTone: Record<string, string> = { unconfirmed: "amber", "accounted-for": "teal", injured: "amber", "confirmed-missing": "red" };
type RollRow = { checkInId: string; personId: string; name: string; shaftName: string; declaredZoneId: string | null; timeIn: string; expectedReturn: string; buddyName: string | null; phoneMasked: string | null; reference: string; phone?: string | null };
function EmergencyPanel({ emergency, data, post, refresh, notify, supervisor }: { emergency: Row; data: ViewProps["data"]; post: ViewProps["post"]; refresh: ViewProps["refresh"]; notify: ViewProps["notify"]; supervisor: boolean }) {
  const [phones, setPhones] = useState<Record<string, string | null>>({});
  const [marking, setMarking] = useState<null | { entry: Row; status: string }>(null);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!supervisor) return;
    void fetch(`/api/workspace/emergencies/${emergency.id}/roll`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) return;
        const map: Record<string, string | null> = {};
        for (const r of [...j.snapshot, ...j.others] as RollRow[]) map[r.checkInId] = r.phone || null;
        setPhones(map);
      })
      .catch(() => {});
  }, [emergency.id, supervisor]);
  const entries = rows(data, "roll-entry").filter((r) => r.data.emergencyId === emergency.id);
  const entryFor = (checkInId: string) => entries.find((x) => x.data.checkInId === checkInId);
  const snapshot = emergency.data.rollSnapshot as RollRow[];
  const others = emergency.data.otherShaftsSnapshot as RollRow[];
  const zoneName = (id: string | null) => data.site.zones.find((z) => z.id === id)?.name || "not stated";
  const unresolved = entries.filter((e) => e.data.atAffectedShaft && e.data.status === "unconfirmed").length;
  const table = (list: RollRow[], caption: string) => (
    <div className="fs-table-wrap">
      <table className="fs-register">
        <caption className="fs-sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Name · Ref</th>
            <th scope="col">Checked in · expected back</th>
            <th scope="col">Declared zone</th>
            <th scope="col">Buddy</th>
            <th scope="col">Phone</th>
            <th scope="col">Status now</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => {
            const entry = entryFor(r.checkInId);
            const status = String(entry?.data.status || "unconfirmed");
            const phone = phones[r.checkInId];
            return (
              <tr key={r.checkInId} className={status === "confirmed-missing" ? "overdue" : ""}>
                <td>
                  <strong>{r.name}</strong>
                  <small className="fs-block">Ref {r.reference} · {r.shaftName}</small>
                </td>
                <td>
                  {time(r.timeIn)}
                  <small className="fs-block">back by {time(r.expectedReturn)}</small>
                </td>
                <td>{zoneName(r.declaredZoneId)}</td>
                <td>{r.buddyName || "None"}</td>
                <td>{phone ? <a href={"tel:" + phone}>{phone}</a> : r.phoneMasked || "No phone"}</td>
                <td>
                  <Tag tone={rollTone[status]}>{rollText[status]}</Tag>
                  {supervisor && entry && (
                    <div className="fs-roll-actions">
                      {["accounted-for", "injured", "confirmed-missing"]
                        .filter((x) => x !== status)
                        .map((x) => (
                          <button key={x} className={"fs-button " + (x === "confirmed-missing" ? "danger" : "secondary")} onClick={() => setMarking({ entry, status: x })}>
                            {rollText[x]}
                          </button>
                        ))}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
  return (
    <section className="fs-panel fs-emergency" aria-labelledby={"emergency-" + emergency.id}>
      <div className="fs-section-heading">
        <div>
          <h3 id={"emergency-" + emergency.id}>
            <Siren size={18} /> Emergency: {String(emergency.data.type)} at {String(emergency.data.shaftName)}
          </h3>
          <p>
            Declared {date(String(emergency.data.declaredAt))} by {String(emergency.data.declaredBy)}. Rescue roll: {snapshot.length} declared underground at the shaft at declaration; {unresolved} not yet confirmed. Check-ins are declarations, not confirmed locations.
          </p>
        </div>
      </div>
      <h4>Rescue roll · {String(emergency.data.shaftName)}</h4>
      {snapshot.length ? table(snapshot, "Rescue roll at the affected shaft") : <p>Nobody was declared underground at this shaft at declaration.</p>}
      {others.length > 0 && (
        <>
          <h4>Declared at other shafts (confirm separately)</h4>
          {table(others, "People declared at other shafts")}
        </>
      )}
      <ErrorText message={error} />
      {supervisor && (
        <div className="fs-button-row">
          <button
            className="fs-button danger"
            onClick={() =>
              void post(`emergencies/${emergency.id}/alert`, {})
                .then(async (r) => {
                  notify(`${r.mode === "dry-run" ? "Dry run: written to the outbox, not sent." : "Alerts queued."} ${r.queued.length} recipient(s); ${r.skipped.length} without a phone. Mine-wide muster open.`);
                  await refresh();
                })
                .catch((e) => setError(e.message))
            }
          >
            {emergency.data.alertsSentAt ? "Alerts requested · open muster again" : "Alert buddies and next of kin · open mine-wide muster"}
          </button>
          <a className="fs-button secondary" href={`/api/workspace/incidents/${String(emergency.data.incidentId)}/pdf`}>
            Export incident PDF
          </a>
          <button className="fs-button secondary" onClick={() => setClosing(true)}>
            Close emergency
          </button>
        </div>
      )}
      {marking && (
        <StatusNote
          title={`${rollText[marking.status]}: ${String(marking.entry.data.name)}`}
          danger={marking.status === "confirmed-missing"}
          onClose={() => setMarking(null)}
          submit={async (note) => {
            await post(`roll/${marking.entry.id}`, { expectedRevision: marking.entry.revision, status: marking.status, note });
            setMarking(null);
            await refresh();
          }}
        />
      )}
      {closing && (
        <StatusNote
          title="Close emergency"
          onClose={() => setClosing(false)}
          submit={async (reason) => {
            await post(`emergencies/${emergency.id}/close`, { reason });
            setClosing(false);
            notify("Emergency closed. The incident stays open in Records until it is verified and closed.");
            await refresh();
          }}
        />
      )}
    </section>
  );
}
function StatusNote({ title, danger, onClose, submit }: { title: string; danger?: boolean; onClose: () => void; submit: (note: string) => Promise<void> }) {
  const [note, setNote] = useState(""), [error, setError] = useState("");
  return (
    <Dialog title={title} onClose={onClose}>
      <Field label="Note (who, where, when)">
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <ErrorText message={error} />
      <button className={"fs-button " + (danger ? "danger" : "")} disabled={note.trim().length < 3} onClick={() => void submit(note).catch((e) => setError(e.message))}>
        Save
      </button>
    </Dialog>
  );
}
function DeclareEmergency({ shafts, counts, onClose, submit }: { shafts: { id: string; name: string }[]; counts: Record<string, number>; onClose: () => void; submit: (body: unknown) => Promise<void> }) {
  const [f, setF] = useState({ shaftId: shafts[0]?.id || "", type: "collapse", note: "", confirmReal: false });
  const [error, setError] = useState("");
  return (
    <Dialog title="Declare emergency" onClose={onClose}>
      <p className="fs-help">This records a <strong>real incident</strong>. Use Scenarios for drills and planning. Messages follow the current messaging mode.</p>
      <Field label="Shaft">
        <select value={f.shaftId} onChange={(e) => setF({ ...f, shaftId: e.target.value })}>
          {shafts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({counts[s.id] || 0} declared underground)
            </option>
          ))}
        </select>
      </Field>
      <Field label="Type">
        <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          <option value="collapse">Collapse / fall of ground</option>
          <option value="flooding">Flooding</option>
          <option value="fire">Fire</option>
          <option value="unknown">Unknown</option>
        </select>
      </Field>
      <Field label="What is known (optional)">
        <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </Field>
      <label className="fs-confirm">
        <input type="checkbox" checked={f.confirmReal} onChange={(e) => setF({ ...f, confirmReal: e.target.checked })} /> This is a real emergency, not a drill or scenario.
      </label>
      <ErrorText message={error} />
      <button className="fs-button danger" disabled={!f.confirmReal} onClick={() => void submit(f).catch((e) => setError(e.message))}>
        Declare emergency and show rescue roll
      </button>
    </Dialog>
  );
}
