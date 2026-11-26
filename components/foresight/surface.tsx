"use client";
// Mine → Surface: a georeferenced base map under the plan and subsidence marks
// placed on it. Marks near a zone become evidence for a concern; the base map is
// a picture to read the plan against, never a source of tunnel geometry.
import { useEffect, useState } from "react";
import { MapPin, Upload } from "lucide-react";
import type { MineModel } from "@/lib/domain/mine-model";
import { PlanView } from "./mine";
import { activeBaseMap, planMarks } from "./surface-data";
import { date, Dialog, ErrorText, Field, rows, Tag, localInput, fromLocal, type Row, type ViewProps } from "./shared";

const toB64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("The file could not be read."));
    r.readAsDataURL(file);
  });

export function Surface({ data, model, post, refresh, notify }: Pick<ViewProps, "data" | "post" | "refresh" | "notify"> & { model: MineModel }) {
  const supervisor = ["supervisor", "administrator"].includes(data.workspace.role);
  const maps = rows(data, "base-map").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const marks = rows(data, "subsidence-mark").sort((a, b) => String(b.data.observedAt).localeCompare(String(a.data.observedAt)));
  const [live, setLive] = useState<Record<string, Row>>({});
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [aligning, setAligning] = useState<Row | null>(null);
  const [error, setError] = useState("");
  const [opacity, setOpacity] = useState(0.75);
  const base = activeBaseMap(data);
  // Poll maps that are still being processed.
  useEffect(() => {
    const pending = maps.filter((m) => (live[m.id] || m).data.status === "processing");
    if (!pending.length) return;
    const t = setInterval(async () => {
      for (const m of pending) {
        const res = await fetch(`/api/workspace/base-maps/${m.id}`, { cache: "no-store" });
        if (!res.ok) continue;
        const next = (await res.json()) as Row;
        setLive((l) => ({ ...l, [m.id]: next }));
        if (next.data.status !== "processing") void refresh();
      }
    }, 1200);
    return () => clearInterval(t);
  }, [maps, live, refresh]);
  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    try {
      if (file.size > 3_000_000) throw new Error("GeoTIFF files up to 3 MB can be uploaded here. Reduce the resolution first, for example gdal_translate -outsize 2000 0.");
      await post("base-maps", { name: file.name.replace(/\.[^.]+$/, "").slice(0, 120).padEnd(3, "_"), filename: file.name, b64: await toB64(file) });
      notify("Base map uploaded; the worker is reading it.");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <>
      <section className="fs-panel">
        <div className="fs-section-heading">
          <div>
            <h2>Surface plan</h2>
            <p>{base ? "Base map shown under the plan." : "No base map is shown. Upload a GeoTIFF and align it to the plan."} Click the plan to place a subsidence mark.</p>
          </div>
          {base && (
            <label className="fs-3d-check">
              Opacity <input type="range" min={0.2} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label="Base map opacity" />
            </label>
          )}
        </div>
        <PlanView model={model} baseMap={base ? { ...base, opacity } : null} marks={[...planMarks(data), ...(point ? [{ id: "pending", x: point.x, y: point.y, label: "New mark", tone: "pending" as const }] : [])]} onPlanClick={supervisor ? (x, y) => setPoint({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }) : undefined} label={`Surface plan of ${model.meta.name} with ${marks.filter((m) => m.data.status === "active").length} subsidence mark(s)${base ? " over a base map" : ""}`} />
        <p className="fs-help">
          Red diamonds are marks near a zone (they raise a concern for review); grey diamonds are further than 100 m from any zone's tunnels (a development default, not a validated distance). The base map is a picture only; it does not change any tunnel.
        </p>
        {point && supervisor && <MarkForm point={point} onClose={() => setPoint(null)} post={post} refresh={refresh} notify={notify} />}
      </section>
      <section className="fs-panel" aria-label="Base maps">
        <div className="fs-section-heading">
          <h3>Base maps</h3>
          {supervisor && (
            <label className="fs-button secondary">
              <Upload size={15} /> Upload GeoTIFF
              <input type="file" accept=".tif,.tiff,image/tiff" hidden onChange={(e) => void upload(e)} aria-label="Upload GeoTIFF base map" />
            </label>
          )}
        </div>
        <p className="fs-help">
          An orthophoto or elevation model from a surveyor or OpenDroneMap, in a metre-based projected system (for example UTM), north-up, up to 3 MB. It is read in the simulation worker and shown as a reduced picture; the original file is not kept here, so keep your copy.
        </p>
        <ErrorText message={error} />
        {maps.length === 0 && <p className="fs-muted">No base map uploaded.</p>}
        {maps.map((raw) => {
          const m = live[raw.id] || raw;
          const b = m.data.bounds as { west: number; south: number; east: number; north: number } | undefined;
          return (
            <div className="fs-list-row" key={m.id}>
              <div>
                <strong>{String(m.data.name)}</strong>{" "}
                <Tag tone={m.data.status === "ready" ? "teal" : m.data.status === "failed" || m.data.status === "worker-unavailable" ? "red" : "amber"}>{String(m.data.status)}</Tag>{" "}
                {m.data.active ? <Tag tone="teal">shown</Tag> : null}
                <small className="fs-block">
                  {m.data.status === "failed" || m.data.status === "worker-unavailable"
                    ? String(m.data.error)
                    : b
                      ? `${String(m.data.kind)} · ${String(m.data.crs)} · ${Number((m.data.pixelSizeM as number[])[0]).toFixed(2)} m pixels · covers E ${b.west}–${b.east}, N ${b.south}–${b.north}${m.data.range ? ` · values ${(m.data.range as { min: number }).min.toFixed(1)}–${(m.data.range as { max: number }).max.toFixed(1)} (${(m.data.range as { units: string }).units})` : ""}`
                      : "Reading the file…"}
                </small>
                {m.data.alignment ? (
                  <small className="fs-block">
                    Plan origin is E {(m.data.alignment as { planOriginEasting: number }).planOriginEasting}, N {(m.data.alignment as { planOriginNorthing: number }).planOriginNorthing}
                    {((m.data.alignment as { warnings: string[] }).warnings || []).map((w) => (
                      <span key={w} className="fs-tone-red"> · {w}</span>
                    ))}
                  </small>
                ) : null}
              </div>
              {supervisor && m.data.status === "ready" && (
                <div className="fs-button-row">
                  <button className="fs-inline-link" onClick={() => setAligning(m)}>
                    {m.data.alignment ? "Realign" : "Align to the plan"}
                  </button>
                  {m.data.alignment ? (
                    <button
                      className="fs-inline-link"
                      onClick={() => void post(`base-maps/${m.id}/active`, { active: !m.data.active }).then(refresh).catch((e) => setError(e.message))}
                    >
                      {m.data.active ? "Hide" : "Show"}
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </section>
      <section className="fs-panel" aria-label="Subsidence marks">
        <h3>
          <MapPin size={16} aria-hidden /> Subsidence marks
        </h3>
        {marks.length === 0 && <p className="fs-muted">No marks yet. Click the plan above to place one.</p>}
        {marks.map((m) => (
          <div className="fs-list-row" key={m.id}>
            <div>
              <strong>{String(m.data.description)}</strong>{" "}
              {m.data.status === "retracted" ? <Tag>retracted</Tag> : m.data.zoneId ? <Tag tone="amber">near {model.zones.find((z) => z.id === m.data.zoneId)?.name || String(m.data.zoneId)}</Tag> : <Tag>not near a zone</Tag>}
              <small className="fs-block">
                Observed {date(String(m.data.observedAt))} · recorded by {String(m.data.observer)} · plan x {String(m.data.x)} m, y {String(m.data.y)} m · {m.data.distanceM === null ? "" : `${String(m.data.distanceM)} m from tunnel ${String(m.data.nearTunnelId)}`}
                {m.data.status === "retracted" ? ` · retracted: ${String(m.data.retractedReason)}` : m.data.zoneId ? " · raised a concern for review" : " · recorded only, no concern raised"}
              </small>
              {m.data.photoFileId ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="fs-mark-photo" src={`/api/workspace/files/${String(m.data.photoFileId)}`} alt={`Photo of: ${String(m.data.description)}`} />
              ) : null}
            </div>
            {supervisor && m.data.status === "active" && (
              <button
                className="fs-inline-link"
                onClick={() => {
                  const reason = window.prompt("Why is this mark being retracted?");
                  if (reason && reason.length >= 3) void post(`subsidence-marks/${m.id}/retract`, { reason }).then(async () => (notify("Mark retracted."), await refresh())).catch((e) => setError(e.message));
                }}
              >
                Retract
              </button>
            )}
          </div>
        ))}
      </section>
      {aligning && <AlignDialog map={aligning} model={model} post={post} refresh={refresh} notify={notify} onClose={() => setAligning(null)} />}
    </>
  );
}

function MarkForm({ point, onClose, post, refresh, notify }: { point: { x: number; y: number }; onClose: () => void } & Pick<ViewProps, "post" | "refresh" | "notify">) {
  const [description, setDescription] = useState("");
  const [observed, setObserved] = useState(localInput(new Date().toISOString()));
  const [photo, setPhoto] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError("");
    try {
      if (photo && photo.size > 2_500_000) throw new Error("Photos up to 2.5 MB can be attached.");
      await post("subsidence-marks", {
        x: point.x,
        y: point.y,
        description,
        observedAt: fromLocal(observed),
        photo: photo ? { filename: photo.name, contentType: photo.type, b64: await toB64(photo) } : null,
      });
      notify("Subsidence mark recorded as evidence.");
      await refresh();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fs-form fs-mark-form" aria-label="New subsidence mark">
      <h3>New subsidence mark at x {point.x} m, y {point.y} m</h3>
      <Field label="What was seen">
        <textarea rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Observed at · Africa/Harare">
        <input type="datetime-local" value={observed} onChange={(e) => setObserved(e.target.value)} />
      </Field>
      <Field label="Photo (optional, PNG, JPEG or WebP, up to 2.5 MB)">
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setPhoto(e.target.files?.[0] || null)} />
      </Field>
      <ErrorText message={error} />
      <div className="fs-button-row">
        <button className="fs-button" disabled={busy || description.trim().length < 3} onClick={() => void save()}>
          Record mark
        </button>
        <button className="fs-button secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function AlignDialog({ map, model, post, refresh, notify, onClose }: { map: Row; model: MineModel; onClose: () => void } & Pick<ViewProps, "post" | "refresh" | "notify">) {
  const b = map.data.bounds as { west: number; south: number; east: number; north: number };
  const a = map.data.alignment as { planOriginEasting: number; planOriginNorthing: number } | null;
  const xs = model.junctions.map((j) => j.x), ys = model.junctions.map((j) => j.y);
  const [e, setE] = useState(a ? String(a.planOriginEasting) : "");
  const [n, setN] = useState(a ? String(a.planOriginNorthing) : "");
  const [ok, setOk] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setError("");
    try {
      await post(`base-maps/${map.id}/align`, { planOriginEasting: Number(e), planOriginNorthing: Number(n), confirmMetres: true });
      notify("Base map aligned and shown under the plan.");
      await refresh();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Dialog title="Align the base map to the plan" onClose={onClose}>
      <p className="fs-help">
        The mine plan uses its own origin (0, 0) in metres. Enter the map coordinates (easting and northing, in the file&apos;s coordinate system {String(map.data.crs)}) that the plan&apos;s origin corresponds to. The map covers E {b.west}–{b.east} and N {b.south}–{b.north}; the plan spans x {Math.min(...xs)}–{Math.max(...xs)} m and y {Math.min(...ys)}–{Math.max(...ys)} m. Rotation is not applied: the plan must be north-up on the same grid.
      </p>
      <Field label="Easting of the plan origin (m)">
        <input inputMode="decimal" value={e} onChange={(ev) => setE(ev.target.value)} />
      </Field>
      <Field label="Northing of the plan origin (m)">
        <input inputMode="decimal" value={n} onChange={(ev) => setN(ev.target.value)} />
      </Field>
      <label className="fs-confirm">
        <input type="checkbox" checked={ok} onChange={(ev) => setOk(ev.target.checked)} /> Both the plan and the map are in metres on the same grid
      </label>
      <ErrorText message={error} />
      <button className="fs-button" disabled={!ok || e === "" || n === "" || !Number.isFinite(Number(e)) || !Number.isFinite(Number(n))} onClick={() => void save()}>
        Align and show
      </button>
    </Dialog>
  );
}
