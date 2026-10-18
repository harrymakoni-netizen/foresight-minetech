"use client";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Map, Box, Layers, ArrowRight } from "lucide-react";
import {
  date,
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
const Reconstruction = dynamic(() => import("./reconstruction"), {
  ssr: false,
  loading: () => <p role="status">Loading 3D viewer…</p>,
});
export function MineMap({ data, zone, refresh, notify }: ViewProps) {
  const [selected, setSelected] = useState(zone === "all" ? "zone-b" : zone),
    [view, setView] = useState("2d"),
    [runId, setRunId] = useState(""),
    [time, setTime] = useState(0),
    [assetId, setAssetId] = useState(""),
    [error, setError] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [title, setTitle] = useState(""),
    [source, setSource] = useState(""),
    [capture, setCapture] = useState(localInput()),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false);
  const assets = rows(data, "spatial-asset", selected),
    asset = assets.find((a) => a.id === assetId) || assets[0],
    runs = rows(data, "run").filter(
      (r) => r.data.status === "completed" && !r.data.sensitivity,
    ),
    run = runs.find((r) => r.id === runId),
    series = run?.data.result?.series || [],
    point = series[Math.min(time, series.length - 1)],
    observations = rows(data, "observation", selected),
    cameras = rows(data, "camera", selected);
  const unavailable = (edge: string) =>
    !!run?.data.result?.routes?.blockedIntervals?.[edge]?.some(
      (i: any) =>
        (point?.atSeconds || 0) >= i.fromSeconds &&
        (point?.atSeconds || 0) <= i.toSeconds,
    );
  async function upload(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!file)
        throw new Error("Choose a self-contained reconstructed GLB mesh.");
      if (file.size > 20 * 1024 * 1024) throw new Error("GLB limit is 20 MB.");
      const metadata = {
        zoneId: selected,
        title,
        source,
        captureAt: fromLocal(capture),
        consent,
        scaleStatus: "unverified",
        metresPerUnit: 1,
        translation: [0, 0, 0],
        rotationRadians: [0, 0, 0],
        registrationResidualM: null,
        referenceNotes:
          "Unregistered walkthrough. Supply checked measured references before dimensional use.",
      };
      let response: Response;
      if (data.services.directUploads) {
        const { upload: uploadBlob } = await import("@vercel/blob/client");
        const pathname = `evidence/${data.workspace.id}/${crypto.randomUUID()}.glb`;
        await uploadBlob(pathname, file, {
          access: "private",
          handleUploadUrl: "/api/uploads",
          contentType: "model/gltf-binary",
          headers: { "X-Workspace-Id": data.workspace.id },
        });
        response = await fetch("/api/workspace/assets", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workspace-Id": data.workspace.id,
          },
          body: JSON.stringify({ pathname, metadata }),
        });
      } else {
        const form = new FormData();
        form.set("file", file);
        form.set("metadata", JSON.stringify(metadata));
        response = await fetch("/api/workspace/assets", {
          method: "POST",
          headers: { "X-Workspace-Id": data.workspace.id },
          body: form,
        });
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.message);
      notify("Reconstructed mesh imported as an unscaled walkthrough.");
      setAssetId(result.id);
      await refresh();
      setView("3d");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="fs-page-heading">
        <div>
          <div className="fs-eyebrow">
            SPATIAL CONTEXT / {data.site.layoutVersion}
          </div>
          <h1>Mine Map</h1>
          <p>
            Connect zones, evidence, equipment and laboratory route assumptions.
          </p>
        </div>
        <Tag>Conceptual layout · unverified scale</Tag>
      </div>
      <ErrorText message={error} />
      <div className="fs-map-toolbar">
        <div className="fs-tabs" role="tablist" aria-label="Map view">
          <button
            role="tab"
            aria-selected={view === "2d"}
            onClick={() => setView("2d")}
          >
            <Map size={17} />
            2D layout
          </button>
          <button
            role="tab"
            aria-selected={view === "3d"}
            onClick={() => setView("3d")}
          >
            <Box size={17} />
            Reconstructed area
          </button>
        </div>
        <Field label="Laboratory overlay">
          <select
            value={runId}
            onChange={(e) => {
              setRunId(e.target.value);
              setTime(0);
            }}
          >
            <option value="">Workspace evidence only</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                Lab {r.id.slice(0, 8)} · {date(r.createdAt)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="fs-map-grid">
        <section className="fs-panel fs-map-panel">
          {view === "2d" ? (
            <>
              <div className="fs-map-caption">
                <Tag>Fictional local coordinates · metres</Tag>
                <span>NOT A SURVEY</span>
              </div>
              <svg
                viewBox="0 0 640 390"
                className="fs-mine-svg"
                role="group"
                aria-label="Conceptual training mine: north junction, east sump, south alternative and surface muster. Routes are fictional and manually checked for the software fixture."
              >
                <defs>
                  <pattern
                    id="map-grid"
                    width="25"
                    height="25"
                    patternUnits="userSpaceOnUse"
                  >
                    <path
                      d="M 25 0 L 0 0 0 25"
                      fill="none"
                      stroke="#dbe4e7"
                      strokeWidth="0.6"
                    />
                  </pattern>
                </defs>
                <rect width="640" height="390" fill="url(#map-grid)" />
                {[
                  { id: "east-direct", d: "M430 190 L285 95 L140 95" },
                  { id: "east-south", d: "M430 190 L430 295 L220 295" },
                  { id: "south-junction", d: "M220 295 L140 215 L140 95" },
                  { id: "exit", d: "M140 95 L65 95 L65 195" },
                ].map((edge) => (
                  <g key={edge.id}>
                    <path
                      d={edge.d}
                      fill="none"
                      stroke={unavailable(edge.id) ? "#b77932" : "#b5c9cf"}
                      strokeWidth="15"
                      strokeLinejoin="round"
                    />
                    <path
                      d={edge.d}
                      fill="none"
                      stroke={unavailable(edge.id) ? "#fff0db" : "#edf4f3"}
                      strokeWidth="8"
                      strokeDasharray={unavailable(edge.id) ? "5 5" : undefined}
                    />
                  </g>
                ))}
                {data.site.zones.map((z, i) => (
                  <g
                    key={z.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Select ${z.name}`}
                    onClick={() => setSelected(z.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(z.id);
                      }
                    }}
                  >
                    <rect
                      x={z.x - 34}
                      y={z.y - 24}
                      width={68}
                      height={48}
                      rx={9}
                      fill={selected === z.id ? "#087f83" : "#fff"}
                      stroke={selected === z.id ? "#075c60" : "#8fa9b0"}
                      strokeWidth={2}
                    />
                    <text
                      x={z.x}
                      y={z.y + 6}
                      textAnchor="middle"
                      fill={selected === z.id ? "white" : "#233d4a"}
                      fontSize={17}
                      fontWeight={700}
                    >
                      {String.fromCharCode(65 + i)}
                    </text>
                    <text
                      x={z.x}
                      y={z.y + 45}
                      textAnchor="middle"
                      fill="#233d4a"
                      fontSize={12}
                    >
                      {z.name}
                    </text>
                    {rows(data, "observation", z.id).length > 0 && (
                      <g>
                        <circle
                          cx={z.x + 30}
                          cy={z.y - 23}
                          r={12}
                          fill="#b77932"
                        />
                        <text
                          x={z.x + 30}
                          y={z.y - 19}
                          textAnchor="middle"
                          fill="white"
                          fontSize={11}
                        >
                          {rows(data, "observation", z.id).length}
                        </text>
                      </g>
                    )}
                  </g>
                ))}
                <rect
                  x={45}
                  y={178}
                  width={40}
                  height={34}
                  fill="#e4f1ec"
                  stroke="#087f83"
                />
                <text x={65} y={233} textAnchor="middle" fontSize={12}>
                  Surface muster
                </text>
                <text x={462} y={184} fontSize={12}>
                  S1 · P1 · P2
                </text>
                <text x={468} y={204} fontSize={11}>
                  Camera B1
                </text>
                <text x={578} y={46} fontSize={16}>
                  N ↑
                </text>
                {point && (
                  <text x={320} y={365} textAnchor="middle" fontSize={12}>
                    LAB ONLY · level{" "}
                    {Object.values(point.nodes)
                      .map((n: any) => n.levelM.toFixed(2) + " m")
                      .join(", ")}{" "}
                    at {(point.atSeconds / 3600).toFixed(2)} hours
                  </text>
                )}
              </svg>
              <div className="fs-map-legend">
                <span>
                  <i className="route" />
                  Configured route
                </span>
                <span>
                  <i className="blocked" />
                  Lab restriction
                </span>
                <span>
                  <i className="evidence" />
                  Evidence count
                </span>
              </div>
              <p className="fs-muted">
                {data.site.datum}. The versioned route graph is independent of
                any reconstruction. Visible surfaces do not establish passage
                clearance.
              </p>
            </>
          ) : (
            <>
              <div className="fs-section-heading">
                <h2>Reconstructed area</h2>
                <Tag>
                  {asset
                    ? "Walkthrough · scale unverified"
                    : "Asset unavailable"}
                </Tag>
              </div>
              {asset ? (
                <>
                  <Field label="Imported area">
                    <select
                      value={asset.id}
                      onChange={(e) => setAssetId(e.target.value)}
                    >
                      {assets.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.data.title}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Reconstruction asset={asset} />
                  <p>
                    {asset.data.source} · captured {date(asset.data.captureAt)}
                  </p>
                  <p>
                    Registration: {asset.data.scaleStatus}. Dimensional
                    calculations disabled until measured references and
                    residuals are reviewed.
                  </p>
                </>
              ) : (
                <Empty title="No reconstruction imported">
                  Import an independently produced self-contained GLB mesh
                  below. No rendered tunnel is presented as a captured mine.
                  Offline capture and reconstruction commands are in
                  tools/reconstruction.
                </Empty>
              )}
            </>
          )}
          {run && (
            <div className="fs-playback">
              <label>
                Saved laboratory playback ·{" "}
                {((point?.atSeconds || 0) / 3600).toFixed(2)} h
                <input
                  aria-label="Map laboratory playback"
                  type="range"
                  min={0}
                  max={Math.max(0, series.length - 1)}
                  value={time}
                  onChange={(e) => setTime(Number(e.target.value))}
                />
              </label>
              <p>
                Overlay uses saved calculated levels and route intervals; it
                does not change workspace restrictions.
              </p>
            </div>
          )}
        </section>
        <aside className="fs-panel">
          <div className="fs-section-heading">
            <h2>Zone context</h2>
            <Layers size={18} />
          </div>
          <Field label="Selected zone">
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {data.site.zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </Field>
          <dl className="fs-meta">
            <dt>Geometry source</dt>
            <dd>Conceptual fixture · version {data.site.layoutVersion}</dd>
            <dt>Scale status</dt>
            <dd>Unverified; not surveyed</dd>
            <dt>Evidence</dt>
            <dd>{observations.length} observations</dd>
            <dt>Cameras</dt>
            <dd>
              {cameras.length} zone-mapped; global calibration unavailable
            </dd>
          </dl>
          <h3>Evidence markers</h3>
          {observations.slice(0, 8).map((o) => (
            <div className="fs-history-item" key={o.id}>
              <Tag>{o.data.category}</Tag>
              <p>{o.data.condition}</p>
              <small>
                {date(o.data.observedAt)}
                <br />
                {o.id.slice(0, 8)}
              </small>
            </div>
          ))}
          {!observations.length && (
            <p className="fs-muted">No accepted evidence in this zone.</p>
          )}
          <a href="#evidence" className="fs-inline-link">
            Review evidence <ArrowRight size={15} />
          </a>
          <h3>Routes at selected time</h3>
          {run ? (
            Object.entries(run.data.result.routes.blockedIntervals).map(
              ([id]) => (
                <p key={id}>
                  {id}:{" "}
                  <strong>
                    {unavailable(id)
                      ? "Unavailable under lab assumptions"
                      : "Available under lab assumptions"}
                  </strong>
                </p>
              ),
            )
          ) : (
            <p className="fs-muted">
              Select a laboratory run to inspect time-dependent restrictions.
              Workspace route status is unverified.
            </p>
          )}
        </aside>
      </div>
      <details className="fs-panel">
        <summary>Import a captured reconstruction</summary>
        <p>
          GLB 2.0 mesh viewer compatibility. Splatfacto PLY is a splat export;
          it is not converted to a mesh by renaming it. Capture permission,
          scale references and compute remain external dependencies.
        </p>
        <form className="fs-form fs-form-columns" onSubmit={upload}>
          <Field label="Area title">
            <input
              required
              minLength={3}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label="Capture/source provenance">
            <input
              required
              minLength={3}
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </Field>
          <Field label="Captured at · Africa/Harare">
            <input
              type="datetime-local"
              required
              value={capture}
              onChange={(e) => setCapture(e.target.value)}
            />
          </Field>
          <Field label="Self-contained GLB mesh (20 MB max)">
            <input
              type="file"
              accept=".glb,model/gltf-binary"
              required
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </Field>
          <label className="fs-checkbox">
            <input
              type="checkbox"
              required
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            I have permission to use this capture and record its provenance.
          </label>
          <button className="fs-button" disabled={busy}>
            {busy ? "Importing…" : "Import unscaled walkthrough"}
          </button>
        </form>
      </details>
    </>
  );
}
