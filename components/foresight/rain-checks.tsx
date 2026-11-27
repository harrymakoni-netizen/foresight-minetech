"use client";
// Phase 6 panels on the Concerns page: rain forecast, pre-entry checks, the
// do-not-enter advisory and external readings. Everything shown comes from
// stored records: no forecast is shown until one has really been retrieved.
import { useState } from "react";
import { CloudRain, ClipboardCheck, Send } from "lucide-react";
import { date, Dialog, ErrorText, Field, rows, Tag, type ViewProps } from "./shared";
import type { Concern } from "@/lib/domain/contracts";
import { advisoryDraft } from "@/lib/domain/advisory-text";

const supervisorRoles = ["supervisor", "administrator"];

export function RainCard({ data, post, refresh, notify }: Pick<ViewProps, "data" | "post" | "refresh" | "notify">) {
  const m = data.messaging!;
  const weather = m.config.weather;
  const latest = rows(data, "forecast")[0];
  const supervisor = supervisorRoles.includes(data.workspace.role);
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const summary = latest?.data.summary as { maxMmPerHour: number | null; totalMm24h: number | null; peakAt: string | null; missingHours: number } | undefined;
  async function refreshNow() {
    setBusy(true);
    setError("");
    try {
      const r = await post("forecast/refresh");
      notify(r.outcome === "stored" ? "Forecast retrieved." : `Forecast: ${r.detail}`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="fs-card-block" aria-label="Rain forecast">
      <div className="fs-section-heading">
        <h3>
          <CloudRain size={16} aria-hidden /> Rain forecast
        </h3>
        {supervisor && (
          <button className="fs-inline-link" onClick={() => setEdit(true)}>
            {weather ? "Settings" : "Set location"}
          </button>
        )}
      </div>
      {!weather ? (
        <p className="fs-muted">No mine location is set, so no forecast is retrieved and rain is not part of any concern.</p>
      ) : !latest || !summary ? (
        <p className="fs-muted">Location set. No forecast has been retrieved yet; the messaging service fetches one every few hours.</p>
      ) : (
        <>
          <dl className="fs-mini">
            <div>
              <dt>Peak hour</dt>
              <dd>{summary.maxMmPerHour === null ? "unknown" : `${summary.maxMmPerHour} mm/h`}</dd>
            </div>
            <div>
              <dt>Next 24 h</dt>
              <dd>{summary.totalMm24h === null ? "unknown" : `${summary.totalMm24h} mm`}</dd>
            </div>
            <div>
              <dt>Threshold</dt>
              <dd>
                {weather.heavyRainMmPerHour} mm/h or {weather.heavyRainMm24h} mm
              </dd>
            </div>
          </dl>
          <p>
            {latest.data.heavy ? <Tag tone="amber">Heavy rain forecast</Tag> : <Tag tone="teal">Below heavy-rain threshold</Tag>}
          </p>
          <small className="fs-block">
            Source: {String(latest.data.source)}. Retrieved {date(String(latest.data.retrievedAt))}.
            {summary.missingHours ? ` ${summary.missingHours} hour(s) had no value and are not counted.` : ""}
          </small>
        </>
      )}
      {m.weatherError && weather && <p className="fs-tone-red">Last forecast attempt failed ({date(m.weatherError.at)}): {m.weatherError.detail}</p>}
      {supervisor && weather && (
        <button className="fs-button secondary" disabled={busy} onClick={() => void refreshNow()}>
          Get forecast now
        </button>
      )}
      <ErrorText message={error} />
      {edit && <RainSettings data={data} post={post} refresh={refresh} notify={notify} onClose={() => setEdit(false)} />}
    </section>
  );
}

function RainSettings({ data, post, refresh, notify, onClose }: Pick<ViewProps, "data" | "post" | "refresh" | "notify"> & { onClose: () => void }) {
  const cfg = data.messaging!.config;
  const w = cfg.weather;
  const [f, setF] = useState({
    latitude: w ? String(w.latitude) : "",
    longitude: w ? String(w.longitude) : "",
    perHour: String(w?.heavyRainMmPerHour ?? 10),
    perDay: String(w?.heavyRainMm24h ?? 50),
  });
  const [error, setError] = useState("");
  async function save(clear: boolean) {
    setError("");
    try {
      const { liveEnabled: _l, ...saved } = cfg as typeof cfg & { liveEnabled?: unknown };
      void _l;
      await post("messaging/config", {
        ...saved,
        weather: clear
          ? null
          : { latitude: Number(f.latitude), longitude: Number(f.longitude), heavyRainMmPerHour: Number(f.perHour), heavyRainMm24h: Number(f.perDay) },
      });
      notify(clear ? "Forecast location removed." : "Forecast location saved. The next forecast is retrieved by the messaging service.");
      await refresh();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Dialog title="Rain forecast settings" onClose={onClose}>
      <p className="fs-help">
        Forecasts come from Open-Meteo (free tier, non-commercial use; a paid deployment needs a commercial licence). Enter the mine&apos;s own location. The
        thresholds below are development defaults, not validated site values: set them with your mine&apos;s engineer.
      </p>
      <div className="fs-form">
        <Field label="Latitude (decimal degrees, south is negative)">
          <input inputMode="decimal" value={f.latitude} onChange={(e) => setF({ ...f, latitude: e.target.value })} />
        </Field>
        <Field label="Longitude (decimal degrees)">
          <input inputMode="decimal" value={f.longitude} onChange={(e) => setF({ ...f, longitude: e.target.value })} />
        </Field>
        <Field label="Heavy rain: hourly (mm/h)">
          <input inputMode="decimal" value={f.perHour} onChange={(e) => setF({ ...f, perHour: e.target.value })} />
        </Field>
        <Field label="Heavy rain: next 24 hours (mm)">
          <input inputMode="decimal" value={f.perDay} onChange={(e) => setF({ ...f, perDay: e.target.value })} />
        </Field>
        <ErrorText message={error} />
        <div className="fs-button-row">
          <button className="fs-button" onClick={() => void save(false)}>
            Save
          </button>
          {w && (
            <button className="fs-button secondary" onClick={() => void save(true)}>
              Remove location
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export function PreEntryCard({ data, post, refresh, notify }: Pick<ViewProps, "data" | "post" | "refresh" | "notify">) {
  const m = data.messaging!;
  const checks = rows(data, "pre-entry-check");
  const [open, setOpen] = useState(false);
  const supervisor = supervisorRoles.includes(data.workspace.role);
  return (
    <section className="fs-card-block" aria-label="Pre-entry checks">
      <div className="fs-section-heading">
        <h3>
          <ClipboardCheck size={16} aria-hidden /> Pre-entry checks
        </h3>
        {supervisor && (
          <button className="fs-inline-link" onClick={() => setOpen(true)}>
            Record a check
          </button>
        )}
      </div>
      <p className="fs-help">
        A shift boss sends <code>CHECK 2</code> (shaft number) by WhatsApp or SMS and answers {m.config.preEntry?.questions.length ?? 5} yes/no questions. A &ldquo;no&rdquo; raises a concern for that shaft.
      </p>
      {m.config.shafts.map((s) => {
        const last = checks.find((c) => c.data.shaftId === s.id);
        const no = last ? (last.data.answers as { answer: string }[]).filter((a) => a.answer === "no").length : 0;
        return (
          <div className="fs-source-row" key={s.id}>
            <strong>
              {s.name}
              {last ? <Tag tone={no ? "amber" : "teal"}>{no ? `${no} no` : "all yes"}</Tag> : <Tag>none yet</Tag>}
            </strong>
            <small>{last ? `${date(String(last.data.at))} by ${String(last.data.by)}` : "No check recorded"}</small>
          </div>
        );
      })}
      {open && <RecordCheck data={data} post={post} refresh={refresh} notify={notify} onClose={() => setOpen(false)} />}
    </section>
  );
}

function RecordCheck({ data, post, refresh, notify, onClose }: Pick<ViewProps, "data" | "post" | "refresh" | "notify"> & { onClose: () => void }) {
  const m = data.messaging!;
  const questions = m.config.preEntry?.questions || [];
  const [shaft, setShaft] = useState(m.config.shafts[0]?.id || "");
  const [ans, setAns] = useState<Record<string, "yes" | "no" | "">>({});
  const [error, setError] = useState("");
  const complete = questions.every((q) => ans[q.key]);
  async function save() {
    setError("");
    try {
      await post("pre-entry", { shaftId: shaft, answers: questions.map((q) => ({ key: q.key, text: q.text, answer: ans[q.key] })) });
      notify("Pre-entry check recorded as evidence.");
      await refresh();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Dialog title="Record a pre-entry check" onClose={onClose}>
      <p className="fs-help">Use this when a check was done in person or on paper. Each answer is stored with your name and the time.</p>
      <Field label="Shaft">
        <select value={shaft} onChange={(e) => setShaft(e.target.value)}>
          {m.config.shafts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      {questions.map((q) => (
        <fieldset className="fs-group" key={q.key}>
          <legend>{q.text}</legend>
          {(["yes", "no"] as const).map((v) => (
            <label key={v} className="fs-3d-check">
              <input type="radio" name={q.key} checked={ans[q.key] === v} onChange={() => setAns({ ...ans, [q.key]: v })} /> {v === "yes" ? "Yes" : "No"}
            </label>
          ))}
        </fieldset>
      ))}
      <ErrorText message={error} />
      <button className="fs-button" disabled={!complete} onClick={() => void save()}>
        Record check
      </button>
    </Dialog>
  );
}

/** Rules that fired, labelled for people. */
export const ruleLabel: Record<string, string> = {
  "supervisor-accepted-observation": "A supervisor accepted this observation",
  "physical-condition+unverified-control": "Physical condition plus an unverified control",
  "rain-forecast": "Heavy rain forecast",
  "overdue-support-or-shaft-inspection": "Support or shaft inspection overdue",
  "pre-entry-no": "Pre-entry check answered no",
  "pre-entry-repeated-no": "Same pre-entry check answered no more than once this week",
  "subsidence-mark": "New subsidence mark",
  "people-at-risk": "People declared underground in the zone",
};

export function ConcernEvidence({ concern }: { concern: Concern }) {
  return (
    <>
      {concern.rules && concern.rules.length > 0 && (
        <>
          <h3>Rule that fired</h3>
          <ul>
            {concern.rules.map((r) => (
              <li key={r}>{ruleLabel[r] || r}</li>
            ))}
          </ul>
        </>
      )}
      {typeof concern.peopleAtRisk === "number" && (
        <p>
          <strong>{concern.peopleAtRisk}</strong> declared underground in {concern.zoneId === "all" ? "the mine" : "this zone"} right now (from check-ins, not live locations).
        </p>
      )}
      {concern.evidence && concern.evidence.length > 0 && (
        <>
          <h3>Other evidence</h3>
          {concern.evidence.map((e) => (
            <blockquote key={e.id}>
              {e.summary}
              <footer>
                {e.kind} · {e.id}
              </footer>
            </blockquote>
          ))}
        </>
      )}
    </>
  );
}

export function AdvisoryAction({ data, concern, post, refresh, notify }: Pick<ViewProps, "data" | "post" | "refresh" | "notify"> & { concern: Concern }) {
  const m = data.messaging!;
  const supervisor = supervisorRoles.includes(data.workspace.role);
  const active = rows(data, "advisory").filter((a) => a.data.status === "active" && a.data.concernId === concern.id && Date.parse(String(a.data.expiresAt)) > Date.now());
  const forecast = rows(data, "forecast")[0]?.data.summary as { maxMmPerHour: number | null; totalMm24h: number | null } | undefined;
  const preselected = concern.shaftId ? [concern.shaftId] : m.config.shafts.filter((s) => concern.zoneId === "all" || s.zoneIds.includes(concern.zoneId)).map((s) => s.id);
  const [open, setOpen] = useState(false);
  const [shafts, setShafts] = useState<string[]>(preselected);
  const [text, setText] = useState(
    advisoryDraft(forecast ? `peak ${forecast.maxMmPerHour ?? "unknown"} mm/h, ${forecast.totalMm24h ?? "unknown"} mm over 24 h` : "see the concern"),
  );
  const [hours, setHours] = useState(12);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  if (!supervisor) return null;
  const declared = rows(data, "check-in").filter((c) => ["declared-underground", "return-overdue", "confirmed-missing"].includes(String(c.data.status)) && shafts.includes(String(c.data.shaftId))).length;
  async function send() {
    setError("");
    try {
      await post("concerns/advisory", { concernId: concern.id, shaftIds: shafts, text, hours, confirm: true });
      notify(m.mode === "dry-run" ? "Advisory recorded. Messaging is in dry run, so nothing was sent." : "Advisory recorded.");
      setOpen(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function withdraw(id: string) {
    try {
      await post(`concerns/advisory/${id}/withdraw`, { reason: "Withdrawn by supervisor" });
      notify("Advisory withdrawn.");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="fs-advisory">
      <h3>Do-not-enter advisory</h3>
      {active.map((a) => (
        <div className="fs-list-row" key={a.id}>
          <div>
            <strong>Active until {date(String(a.data.expiresAt))}</strong>
            <small>
              {(a.data.shaftIds as string[]).join(", ")} · sent by {String(a.data.issuedBy)} · {String(a.data.notified)} notified
            </small>
          </div>
          <button className="fs-inline-link" onClick={() => void withdraw(a.id)}>
            Withdraw
          </button>
        </div>
      ))}
      {!open ? (
        <button className="fs-button secondary" onClick={() => setOpen(true)}>
          <Send size={15} /> Prepare an advisory
        </button>
      ) : (
        <div className="fs-form">
          <p className="fs-help">Never sent automatically. It is shown to anyone who checks in at the chosen shafts, and sent to people already declared there.</p>
          <fieldset className="fs-group">
            <legend>Shafts</legend>
            {m.config.shafts.map((s) => (
              <label key={s.id} className="fs-3d-check">
                <input type="checkbox" checked={shafts.includes(s.id)} onChange={(e) => setShafts(e.target.checked ? [...shafts, s.id] : shafts.filter((x) => x !== s.id))} /> {s.name}
              </label>
            ))}
          </fieldset>
          <Field label="Message (you can edit it)">
            <textarea rows={3} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <Field label="Stays in force for (hours)">
            <input type="number" min={1} max={48} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
          </Field>
          <p>
            {declared} person(s) declared at these shafts would be messaged now. Mode: <Tag tone={m.mode === "live" ? "teal" : "amber"}>{m.mode === "dry-run" ? "dry run: nothing is sent" : m.mode}</Tag>
          </p>
          <label className="fs-confirm">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I am authorised to send this advisory
          </label>
          <ErrorText message={error} />
          <button className="fs-button" disabled={!confirm || !shafts.length || text.trim().length < 10} onClick={() => void send()}>
            Send advisory
          </button>
        </div>
      )}
    </div>
  );
}

export function SensorRow({ data }: { data: ViewProps["data"] }) {
  const readings = rows(data, "sensor-reading");
  const latest = readings[0];
  return (
    <div className="fs-source-row">
      <strong>
        External sensor readings
        <Tag>{readings.length ? "supplied" : "unavailable"}</Tag>
      </strong>
      <small>
        {latest
          ? `${readings.length} recorded; latest ${String(latest.data.quantity)} ${String(latest.data.value)} ${String(latest.data.unit)} from ${String(latest.data.source)} at ${date(String(latest.data.readAt))}. Recorded as evidence only; no alarm thresholds are applied.`
          : "No sensor feed is connected. An administrator can record readings supplied by another system."}
      </small>
    </div>
  );
}
