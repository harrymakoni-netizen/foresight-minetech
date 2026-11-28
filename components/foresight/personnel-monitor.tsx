"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { MineModel } from "@/lib/domain/mine-model";
import { PlanView } from "./mine";
import { activeBaseMap } from "./surface-data";
import { date, Field, rows, type ViewProps } from "./shared";

const active = new Set(["declared-underground", "return-overdue", "confirmed-missing"]);
const isRecent = (value: unknown, now: number) => now - Date.parse(String(value)) < 90_000;

export function PersonnelMonitor({ data, post, refresh }: ViewProps) {
  const model = rows(data, "mine-model-revision").find((e) => e.data.status === "published")?.data.model as MineModel | undefined;
  const people = rows(data, "person");
  const devices = rows(data, "personnel-device");
  const roster = rows(data, "check-in").filter((e) => active.has(e.data.status));
  const alerts = rows(data, "personnel-alert").filter((e) => e.data.status === "open");
  const operator = ["administrator", "supervisor"].includes(data.workspace.role);
  const demo = data.features?.personnelDemo === true && model?.meta.fictional === true;
  const [source, setSource] = useState<"physical" | "demo">("physical");
  const [kind, setKind] = useState("receiver");
  const [selection, select] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(interval);
  }, []);
  if (!model || (!devices.length && !operator && !alerts.length)) return null;
  const origin = demo ? source : "physical";
  const visible = devices.filter((d) => d.data.source === origin);
  const activeAlerts = alerts.filter((alert) => alert.data.source === origin);
  const receivers = visible.filter((d) => d.data.kind === "receiver");
  const tags = visible.filter((d) => d.data.kind === "wearable");
  const selected = visible.find((d) => d.id === selection);
  const selectedAlert = activeAlerts.find((a) => a.id === selection);
  const focusZone = selectedAlert?.data.zoneId ?? (selected?.data.kind === "receiver" ? selected.zoneId : selected?.data.lastZoneId);
  const zone = (id: unknown) => model.zones.find((z) => z.id === id)?.name ?? "Unknown zone";
  const name = (id: unknown) => people.find((p) => p.id === id)?.data.name ?? "Unknown person";
  const tagFor = (personId: string) => tags.find((t) => t.data.personId === personId);
  const recent = roster.filter((r) => {
    const tag = tagFor(r.data.personId);
    return isRecent(tag?.data.observedAt, now) && Date.parse(String(tag?.data.observedAt)) >= Date.parse(String(r.data.timeIn)) && model.zones.some((z) => z.id === tag?.data.lastZoneId);
  }).length;

  async function action(run: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage("");
    try {
      await run();
      await refresh();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Operation failed.");
    } finally {
      setBusy(false);
    }
  }

  function provision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void action(() => post("personnel/devices", {
      source: origin, kind, code: form.get("code"),
      ...(kind === "receiver" ? { zoneId: form.get("assignment") } : { personId: form.get("assignment") }),
    }), "Device registered.");
  }

  function demoPacket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const timestamp = Date.now();
    void action(() => post("personnel/demo", {
      mineId: data.workspace.id, eventId: crypto.randomUUID(), observedAt: new Date(timestamp).toISOString(),
      type: form.get("type"), deviceId: form.get("wearable"), receiverId: form.get("receiver"), sequence: timestamp,
    }), "Demo event recorded.");
  }

  return (
    <section className="fs-panel" aria-labelledby="personnel-monitor-heading">
      <div className="fs-section-heading">
        <div>
          <h3 id="personnel-monitor-heading">Personnel observations</h3>
          <p>{origin === "demo" ? "Demo telemetry" : "Physical telemetry"} · {recent} recently detected · {roster.length - recent} unknown or stale · {receivers.filter((d) => isRecent(d.data.observedAt, now)).length}/{receivers.length} receivers heard recently</p>
        </div>
        {demo && <Field label="Observation source"><select value={source} onChange={(event) => setSource(event.target.value as typeof source)}><option value="physical">Physical</option><option value="demo">Demo</option></select></Field>}
      </div>
      {activeAlerts.length > 0 && (
        <section className="fs-panel" aria-labelledby="personnel-sos-heading">
          <h4 id="personnel-sos-heading" className="fs-tone-red">Open SOS alerts</h4>
          <ul>{activeAlerts.map((alert) => (
            <li key={alert.id}>
              <strong>SOS · {name(alert.data.personId)}</strong> · {date(alert.data.observedAt)} · {alert.data.acknowledgedAt ? "Acknowledged, still open" : "Needs acknowledgement"}
              {" · "}<button type="button" className="fs-inline-link" aria-pressed={selection === alert.id} onClick={() => select(alert.id)}>{zone(alert.data.zoneId)}</button>
              {operator && !alert.data.acknowledgedAt && (
                <button type="button" className="fs-button secondary" disabled={busy}
                  onClick={() => void action(() => post(`personnel/alerts/${alert.id}/acknowledge`), "Alert acknowledged and still open.")}>
                  Acknowledge SOS
                </button>
              )}
            </li>
          ))}</ul>
        </section>
      )}
      <PlanView model={model} height="clamp(230px, 42vw, 460px)" baseMap={activeBaseMap(data)} focusZone={focusZone} label="Personnel observation zones on the published mine plan" />
      <p className="fs-help">Selecting a device highlights its receiver zone. A zone is approximate. A stale observation does not change the declared roll.</p>
      <ul>
        {roster.map((checkIn) => {
          const tag = tagFor(checkIn.data.personId);
          const observedAt = tag?.data.observedAt;
          const status = !observedAt || zone(tag?.data.lastZoneId) === "Unknown zone" ? "Location unknown" : isRecent(observedAt, now) && Date.parse(observedAt) >= Date.parse(String(checkIn.data.timeIn)) ? "Recently detected" : "Stale last-known location";
          return <li key={checkIn.id}>
            <strong>{checkIn.data.personName}</strong> · {status}
            {tag && <> · <button type="button" className="fs-inline-link" onClick={() => select(tag.id)} aria-pressed={selection === tag.id}>{tag.data.code} · {zone(tag.data.lastZoneId)}</button></>}
            {observedAt && <> · {date(observedAt)}</>}
            {typeof tag?.data.batteryPercent === "number" && <> · {tag.data.batteryPercent}% battery</>}
          </li>;
        })}
      </ul>
      <details>
        <summary>Sensor network ({receivers.length} receivers)</summary>
        <ul>{receivers.map((r) => <li key={r.id}><button type="button" className="fs-inline-link" onClick={() => select(r.id)} aria-pressed={selection === r.id}>{r.data.code}</button> · {zone(r.zoneId)} · {isRecent(r.data.observedAt, now) ? "Heard recently" : "Unseen or stale"}</li>)}</ul>
        {operator && <form onSubmit={provision}>
          <Field label="Device type"><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="receiver">Receiver</option><option value="wearable">Wearable</option></select></Field>
          <Field label="Device ID"><input name="code" pattern="[a-zA-Z0-9_\\-]{1,64}" required /></Field>
          <Field label={kind === "receiver" ? "Receiver zone" : "Assigned person"}><select name="assignment" required>
            <option value="">Choose an assignment</option>
            {(kind === "receiver" ? model.zones.map((z) => ({ id: z.id, label: z.name })) : people.map((p) => ({ id: p.id, label: p.data.name }))).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select></Field>
          <button className="fs-button secondary" disabled={busy}>Register device</button>
        </form>}
      </details>
      {operator && origin === "demo" && <details><summary>Send a controlled demo event</summary>
        <form onSubmit={demoPacket}>
          <Field label="Demo receiver"><select name="receiver" required><option value="">Choose a receiver</option>{receivers.map((r) => <option key={r.id}>{r.data.code}</option>)}</select></Field>
          <Field label="Demo tag"><select name="wearable" required><option value="">Choose a tag</option>{tags.map((t) => <option key={t.id}>{t.data.code}</option>)}</select></Field>
          <Field label="Demo event"><select name="type"><option value="observation">Zone observation</option><option value="sos">SOS</option></select></Field>
          <button className="fs-button secondary" disabled={busy}>Record demo event</button>
        </form>
      </details>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
