"use client";
// Mine → Import: DXF centreline import review (spec 8.3). Choose layers, confirm
// units, review detected centrelines and near-miss connections, decide how
// elevations are handled, confirm both, and only then a draft revision is made.
// The draft still needs exits, zones and the rest before it can be published.
import { useEffect, useMemo, useState } from "react";
import { FileUp } from "lucide-react";
import type { MineModel } from "@/lib/domain/mine-model";
import { modelFromImport, type ImportProposal } from "@/lib/domain/mine-model-import";
import { PlanView } from "./mine";
import { ErrorText, Field, rows, Tag, type Row, type ViewProps } from "./shared";

type Layer = { name: string; counts: Record<string, number>; supported: number; unsupported: Record<string, number>; hasZ: boolean; zRange: [number, number] | null; bbox: number[] | null };
type Inspect = { entityTotal: number; insunits: { code: number; unit: string | null; note: string }; layers: Layer[] };
type Proposal = ImportProposal & { nearMisses: { id: string; distanceM: number; at: number[]; to: string; layerA: string }[]; components: string[][]; acceptedNearMiss: string[] };

export function ImportDxf({ data, post, refresh, notify, onDraft }: Pick<ViewProps, "data" | "post" | "refresh" | "notify"> & { onDraft: () => void }) {
  const imports = rows(data, "model-import").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const [id, setId] = useState<string | null>(imports[0]?.id || null);
  const [live, setLive] = useState<Record<string, Row>>({});
  // An import goes back and forth (inspected → building → proposed), so take whichever copy is newer.
  const stored = imports.find((i) => i.id === id) || null;
  const polled = id ? live[id] : undefined;
  const imp = polled && (!stored || polled.revision >= stored.revision) ? polled : stored;
  const [error, setError] = useState("");
  const status = String(imp?.data.status || "");
  useEffect(() => {
    if (!imp || !["inspecting", "building"].includes(status)) return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/workspace/mine-model/imports/${imp.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const next = (await res.json()) as Row;
      setLive((l) => ({ ...l, [imp.id]: next }));
      if (!["inspecting", "building"].includes(String(next.data.status))) void refresh();
    }, 1000);
    return () => clearInterval(t);
  }, [imp, status, refresh]);
  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    try {
      if (file.size > 4_000_000) throw new Error("DXF files up to 4 MB can be imported here. Export only the centreline layers, or split the drawing.");
      const started = await post("mine-model/import", { filename: file.name, text: await file.text() });
      setId(started.id);
      notify("DXF uploaded; the worker is reading it.");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <section className="fs-panel" aria-label="DXF import">
      <div className="fs-section-heading">
        <div>
          <h2>Import a DXF plan</h2>
          <p>Build a draft tunnel network from the centrelines in a surveyor&apos;s DXF. You confirm layers, units, connections and elevations before anything is created, and the draft still has to pass preflight before it can be published.</p>
        </div>
        <label className="fs-button">
          <FileUp size={15} /> Choose an ASCII DXF
          <input type="file" accept=".dxf" hidden onChange={(e) => void pick(e)} aria-label="Choose a DXF file" />
        </label>
      </div>
      <ErrorText message={error} />
      {imports.length > 1 && (
        <Field label="Import">
          <select value={id || ""} onChange={(e) => setId(e.target.value)}>
            {imports.map((i) => (
              <option key={i.id} value={i.id}>
                {String(i.data.filename)} · {String(i.data.status)}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!imp ? (
        <p className="fs-muted">No import yet. ASCII DXF only (not DWG or binary DXF); LINE, LWPOLYLINE and POLYLINE centrelines are read, other entities are listed and ignored.</p>
      ) : status === "worker-unavailable" ? (
        <p className="fs-tone-red">The simulation worker is not reachable, so the file could not be read. {String(imp.data.error || "")}</p>
      ) : status === "inspecting" ? (
        <p role="status">Reading {String(imp.data.filename)}…</p>
      ) : status === "failed" && !imp.data.inspect ? (
        <p className="fs-tone-red">{String(imp.data.error)}</p>
      ) : status === "accepted" ? (
        <div className="fs-note" role="status">
          A draft revision was created from this import. Add exits, zones, equipment and widths in the editor, then publish.
          <p>
            <button className="fs-button" onClick={onDraft}>
              Open the draft in the editor
            </button>
          </p>
        </div>
      ) : (
        <Review key={imp.id} imp={imp} post={post} refresh={refresh} notify={notify} onDraft={onDraft} busy={status === "building"} />
      )}
    </section>
  );
}

function Review({ imp, post, refresh, notify, onDraft, busy }: { imp: Row; busy: boolean; onDraft: () => void } & Pick<ViewProps, "post" | "refresh" | "notify">) {
  const inspect = imp.data.inspect as Inspect;
  const proposal = imp.data.proposal as Proposal | null;
  const sel = imp.data.selection as { layers: string[]; unit: string; snapMetres: number; nearMissMetres: number; elevation: { mode: string; constant: number | null }; acceptNearMiss: string[] } | null;
  const [layers, setLayers] = useState<string[]>(sel?.layers || inspect.layers.filter((l) => l.supported > 0).map((l) => l.name));
  const [unit, setUnit] = useState<string>(sel?.unit || "");
  const [snap, setSnap] = useState(String(sel?.snapMetres ?? 0.1));
  const [near, setNear] = useState(String(sel?.nearMissMetres ?? 3));
  const [elev, setElev] = useState<"dxf" | "constant" | "unknown">((sel?.elevation.mode as "dxf" | "constant" | "unknown") || "unknown");
  const [constant, setConstant] = useState(sel?.elevation.constant == null ? "" : String(sel.elevation.constant));
  const [accept, setAccept] = useState<string[]>(sel?.acceptNearMiss || []);
  const [unitsOk, setUnitsOk] = useState(false);
  const [elevOk, setElevOk] = useState(false);
  const [error, setError] = useState("");
  const anyZ = inspect.layers.some((l) => layers.includes(l.name) && l.hasZ);
  const body = (acceptIds: string[]) => ({
    layers,
    unit,
    snapMetres: Number(snap),
    nearMissMetres: Number(near),
    elevation: { mode: elev, constant: elev === "constant" ? Number(constant) : null },
    acceptNearMiss: acceptIds,
  });
  async function build(acceptIds = accept) {
    setError("");
    try {
      await post(`mine-model/imports/${imp.id}/build`, body(acceptIds));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function create() {
    setError("");
    try {
      await post(`mine-model/imports/${imp.id}/accept`, { unitsConfirmed: true, elevationsConfirmed: true });
      notify("Draft revision created from the DXF. It is not published.");
      await refresh();
      onDraft();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const preview: MineModel | null = useMemo(() => {
    if (!proposal) return null;
    try {
      return modelFromImport(proposal, String(imp.data.filename), "preview", new Date().toISOString());
    } catch {
      return null;
    }
  }, [proposal, imp.data.filename]);
  return (
    <>
      <h3>1. Layers and unit</h3>
      <p className="fs-help">
        {String(imp.data.filename)} · {inspect.entityTotal} entities. {inspect.insunits.unit ? `The file says its unit is ${inspect.insunits.unit}. ` : ""}
        {inspect.insunits.note}
      </p>
      <div className="fs-table-wrap">
        <table className="fs-register">
          <thead>
            <tr>
              <th scope="col">Use</th>
              <th scope="col">Layer</th>
              <th scope="col">Centrelines</th>
              <th scope="col">Not read</th>
              <th scope="col">Elevation</th>
            </tr>
          </thead>
          <tbody>
            {inspect.layers.map((l) => (
              <tr key={l.name}>
                <td>
                  <input type="checkbox" aria-label={`Use layer ${l.name}`} disabled={l.supported === 0} checked={layers.includes(l.name)} onChange={(e) => setLayers(e.target.checked ? [...layers, l.name] : layers.filter((x) => x !== l.name))} />
                </td>
                <td>{l.name}</td>
                <td>{l.supported}</td>
                <td>{Object.entries(l.unsupported).map(([k, v]) => `${v} ${k}`).join(", ") || "—"}</td>
                <td>{l.hasZ && l.zRange ? `${l.zRange[0]} to ${l.zRange[1]} (drawing units)` : "none in the file"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="fs-inline-fields">
        <Field label="Drawing unit" help="Chosen by you; the file's own declaration is only a hint.">
          <select value={unit} onChange={(e) => setUnit(e.target.value)}>
            <option value="">Choose the unit…</option>
            {["m", "mm", "cm", "ft", "in", "km", "yd"].map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Join line ends closer than (m)">
          <input inputMode="decimal" value={snap} onChange={(e) => setSnap(e.target.value)} />
        </Field>
        <Field label="Report near misses up to (m)">
          <input inputMode="decimal" value={near} onChange={(e) => setNear(e.target.value)} />
        </Field>
      </div>
      <fieldset className="fs-group">
        <legend>Elevations</legend>
        <label className="fs-3d-check">
          <input type="radio" name="elev" checked={elev === "unknown"} onChange={() => setElev("unknown")} /> Leave them not entered
        </label>
        <label className="fs-3d-check">
          <input type="radio" name="elev" checked={elev === "dxf"} disabled={!anyZ} onChange={() => setElev("dxf")} /> Use the elevations in the drawing {anyZ ? "" : "(the selected layers carry none)"}
        </label>
        <label className="fs-3d-check">
          <input type="radio" name="elev" checked={elev === "constant"} onChange={() => setElev("constant")} /> One constant elevation (m)
        </label>
        {elev === "constant" && <input aria-label="Constant elevation in metres" inputMode="decimal" value={constant} onChange={(e) => setConstant(e.target.value)} />}
        <p className="fs-help">A drawing with no Z values is never read as 0 m. A constant elevation is recorded as an assumption.</p>
      </fieldset>
      <ErrorText message={error} />
      <button className="fs-button" disabled={busy || !unit || layers.length === 0} onClick={() => void build(accept)}>
        {proposal ? "Rebuild the proposal" : "Detect centrelines"}
      </button>
      {busy && <p role="status">Detecting centrelines…</p>}
      {proposal && preview && !busy && (
        <>
          <h3>2. Review what was detected</h3>
          <p>
            <Tag tone="teal">{proposal.stats.junctions} junctions</Tag> <Tag tone="teal">{proposal.stats.tunnels} tunnels</Tag> <Tag>{proposal.stats.snappedEnds} ends joined</Tag> <Tag>{proposal.stats.tJunctions} T-junctions</Tag>
          </p>
          <PlanView model={preview} label={`Detected centrelines: ${proposal.stats.tunnels} tunnels and ${proposal.stats.junctions} junctions`} height={340} />
          {proposal.components.length > 1 && <p className="fs-tone-red">{proposal.components.length} separate parts are not connected to each other (isolated parts are not hidden).</p>}
          {proposal.warnings.map((w) => (
            <p key={w} className="fs-help">
              ⚠ {w}
            </p>
          ))}
          {proposal.nearMisses.length > 0 && (
            <>
              <h4>Near misses: line ends close to something but not joined</h4>
              <p className="fs-help">Nothing is joined unless you tick it. Tick the ones that are the same drive, then rebuild.</p>
              <ul className="fs-plain-list">
                {proposal.nearMisses.map((n) => (
                  <li key={n.id}>
                    <label className="fs-3d-check">
                      <input type="checkbox" checked={accept.includes(n.id)} onChange={(e) => setAccept(e.target.checked ? [...accept, n.id] : accept.filter((x) => x !== n.id))} />
                      {n.id}: a line end on layer {n.layerA} at ({n.at[0]}, {n.at[1]}) is {n.distanceM} m from {n.to}
                    </label>
                  </li>
                ))}
              </ul>
              <button className="fs-button secondary" onClick={() => void build(accept)}>
                Rebuild with these connections
              </button>
            </>
          )}
          <h3>3. Confirm and create a draft</h3>
          <label className="fs-confirm">
            <input type="checkbox" checked={unitsOk} onChange={(e) => setUnitsOk(e.target.checked)} /> The drawing is in {proposal.unit} and the converted coordinates are in metres
          </label>
          <label className="fs-confirm">
            <input type="checkbox" checked={elevOk} onChange={(e) => setElevOk(e.target.checked)} /> I have reviewed how elevations are handled ({proposal.elevation.mode === "unknown" ? "left not entered" : proposal.elevation.mode === "constant" ? `constant ${proposal.elevation.constant} m, recorded as an assumption` : "from the drawing"})
          </label>
          <p className="fs-help">The draft will have no exits, zones, sumps, pumps or tunnel sizes: those are not in a centreline drawing. Preflight blocks runs and publishing until they are entered.</p>
          <button className="fs-button" disabled={!unitsOk || !elevOk} onClick={() => void create()}>
            Create a draft revision
          </button>
        </>
      )}
    </>
  );
}
