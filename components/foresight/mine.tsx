"use client";
// Mine (spec §8, §13.2): the tunnel network as a to-scale plan, a 3D schematic,
// an editor with provenance, a data table and preflight validation. Values are
// entered, not measured, unless their provenance says "measured".
import dynamic from "next/dynamic";
import { useMemo, useRef, useState, type MouseEvent } from "react";
import { preflight, tunnelLength, type MineModel, type Provenance, type Quality } from "@/lib/domain/mine-model";
import { activeBaseMap, planMarks } from "./surface-data";
import { imageMatrix } from "@/lib/domain/basemap-align";
import { Empty, ErrorText, Field, rows, Tag, type Row, type ViewProps } from "./shared";

const Surface = dynamic(() => import("./surface").then((m) => m.Surface), { loading: () => <p role="status">Loading surface view…</p> });
const ImportDxf = dynamic(() => import("./import-dxf").then((m) => m.ImportDxf), { loading: () => <p role="status">Loading import…</p> });
const Tunnels3D = dynamic(() => import("./tunnels-3d"), { ssr: false, loading: () => <p role="status">Loading 3D view…</p> });
const MineMapLegacy = dynamic(() => import("./mine-map").then((m) => m.MineMap), { loading: () => <p role="status">Loading…</p> });

const zonePalette = ["#0b7a75", "#b0661b", "#2b5ea7", "#7a4fa3", "#4f7a28", "#a33b5c"];
export function zoneColour(model: MineModel) {
  const map = new Map<string, string>();
  model.zones.forEach((z, i) => z.tunnelIds.forEach((t) => map.set(t, zonePalette[i % zonePalette.length])));
  return (tunnelId: string) => map.get(tunnelId) || "#8a99a3";
}
export type Dot = { id: string; x: number; y: number; tone: "walking" | "cut-off" | "safe" | "waiting"; label?: string };
export type Trail = { id: string; points: [number, number][]; tone: Dot["tone"] };
/** Georeferenced image drawn under the plan: plan-coordinate extent of the picture. */
/** west/south/east/north are offsets from the plan origin in the map grid (metres); rotationDegrees turns the plan grid against the map grid. */
export type PlanBaseMap = { href: string; west: number; south: number; east: number; north: number; opacity?: number; rotationDegrees?: number };
export type PlanMark = { id: string; x: number; y: number; label: string; tone: "near" | "far" | "pending" };
export function PlanView({
  model,
  counts = {},
  selected,
  onSelect,
  onPlanClick,
  closed,
  dots = [],
  trails = [],
  baseMap,
  marks = [],
  label,
  height = 460,
}: {
  model: MineModel;
  counts?: Record<string, number>;
  selected?: string | null;
  onSelect?: (id: string) => void;
  onPlanClick?: (x: number, y: number) => void;
  closed?: Set<string>;
  dots?: Dot[];
  trails?: Trail[];
  baseMap?: PlanBaseMap | null;
  marks?: PlanMark[];
  label: string;
  height?: number;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const b = useMemo(() => {
    const xs = model.junctions.map((j) => j.x), ys = model.junctions.map((j) => j.y);
    const pad = 40;
    return { minX: Math.min(...xs, 0) - pad, maxX: Math.max(...xs, 1) + pad * 3, minY: Math.min(...ys, 0) - pad, maxY: Math.max(...ys, 1) + pad };
  }, [model.junctions]);
  const W = b.maxX - b.minX, H = b.maxY - b.minY;
  const sx = (x: number) => x - b.minX, sy = (y: number) => b.maxY - y;
  const unit = Math.max(W, H) / 100;
  const colour = zoneColour(model);
  const j = (id: string) => model.junctions.find((x) => x.id === id);
  const click = (e: MouseEvent<SVGSVGElement>) => {
    if (!onPlanClick || !svg.current) return;
    const pt = svg.current.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.current.getScreenCTM()!.inverse());
    onPlanClick(p.x + b.minX, b.maxY - p.y);
  };
  const key = (fn?: () => void) => (e: React.KeyboardEvent) => {
    if (fn && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      fn();
    }
  };
  return (
    <svg ref={svg} className="fs-plan" viewBox={`0 0 ${W} ${H}`} style={{ height }} role="img" aria-label={label} onClick={click}>
      <defs>
        <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
          <path d="M 50 0 L 0 0 0 50" fill="none" stroke="#e3e9ec" strokeWidth={unit * 0.15} />
        </pattern>
      </defs>
      {baseMap && (
        // eslint-disable-next-line @next/next/no-img-element
        <image
          href={baseMap.href}
          x={0}
          y={0}
          width={baseMap.east - baseMap.west}
          height={baseMap.north - baseMap.south}
          preserveAspectRatio="none"
          opacity={baseMap.opacity ?? 0.75}
          transform={(() => {
            const m = imageMatrix({ planOriginEasting: 0, planOriginNorthing: 0, rotationDegrees: baseMap.rotationDegrees ?? 0 }, { west: baseMap.west, north: baseMap.north }, sx, sy);
            return `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`;
          })()}
        />
      )}
      <rect width={W} height={H} fill="url(#grid)" />
      {model.tunnels.map((t) => {
        const a = j(t.from), c = j(t.to);
        if (!a || !c) return null;
        const isClosed = closed?.has(t.id);
        return (
          <g key={t.id}>
            <line
              x1={sx(a.x)} y1={sy(a.y)} x2={sx(c.x)} y2={sy(c.y)}
              stroke={isClosed ? "#b42318" : colour(t.id)}
              strokeOpacity={t.walkable ? 0.9 : 0.4}
              strokeWidth={Math.max(t.width ?? 1, unit * 0.6)}
              strokeDasharray={t.width === null ? `${unit} ${unit}` : undefined}
              strokeLinecap="round"
            />
            {selected === t.id && <line x1={sx(a.x)} y1={sy(a.y)} x2={sx(c.x)} y2={sy(c.y)} stroke="#15999a" strokeWidth={unit * 0.4} strokeDasharray={`${unit} ${unit / 2}`} />}
            <line
              x1={sx(a.x)} y1={sy(a.y)} x2={sx(c.x)} y2={sy(c.y)}
              stroke="transparent" strokeWidth={unit * 3}
              tabIndex={onSelect ? 0 : -1}
              role={onSelect ? "button" : undefined}
              aria-label={onSelect ? `Tunnel ${t.id} ${t.name || ""}` : undefined}
              onClick={onSelect ? (e) => (e.stopPropagation(), onSelect(t.id)) : undefined}
              onKeyDown={key(onSelect && (() => onSelect(t.id)))}
              style={{ cursor: onSelect ? "pointer" : undefined }}
            />
            {isClosed && <text x={(sx(a.x) + sx(c.x)) / 2} y={(sy(a.y) + sy(c.y)) / 2 - unit * 1.5} fontSize={unit * 2.4} fill="#b42318" textAnchor="middle">closed</text>}
          </g>
        );
      })}
      {trails.map((t) => (
        <polyline key={t.id} points={t.points.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ")} fill="none" stroke={t.tone === "cut-off" ? "#b42318" : "#142a3c"} strokeOpacity={0.35} strokeWidth={unit * 0.35} />
      ))}
      {model.junctions.map((n) => (
        <circle
          key={n.id} cx={sx(n.x)} cy={sy(n.y)} r={unit * (selected === n.id ? 1.4 : 0.9)}
          fill={selected === n.id ? "#15999a" : "#fff"} stroke="#142a3c" strokeWidth={unit * 0.25}
          tabIndex={onSelect ? 0 : -1} role={onSelect ? "button" : undefined}
          aria-label={onSelect ? `Junction ${n.id}${n.name ? " " + n.name : ""}` : undefined}
          onClick={onSelect ? (e) => (e.stopPropagation(), onSelect(n.id)) : undefined}
          onKeyDown={key(onSelect && (() => onSelect(n.id)))}
          style={{ cursor: onSelect ? "pointer" : undefined }}
        />
      ))}
      {model.sumps.map((s) => {
        const n = j(s.junction);
        return n ? (
          <g key={s.id}>
            <circle cx={sx(n.x)} cy={sy(n.y)} r={unit * 2.6} fill="#2b5ea7" fillOpacity={0.25} stroke="#2b5ea7" strokeWidth={unit * 0.3} />
            <text x={sx(n.x) + unit * 3.2} y={sy(n.y) + unit * 1} fontSize={unit * 2.6} fill="#1d3f70">
              {s.name} · {model.pumps.filter((p) => p.sumpId === s.id).map((p) => p.id).join(", ")}
            </text>
          </g>
        ) : null;
      })}
      {model.refuges.map((r) => {
        const n = j(r.junction);
        return n ? (
          <g key={r.id}>
            <rect x={sx(n.x) - unit * 2} y={sy(n.y) - unit * 6} width={unit * 4} height={unit * 3.4} fill="#4f7a28" />
            <text x={sx(n.x)} y={sy(n.y) - unit * 7} fontSize={unit * 2.4} textAnchor="middle" fill="#2f4a17">{r.name}</text>
          </g>
        ) : null;
      })}
      {model.fans.map((f) => {
        const t = model.tunnels.find((x) => x.id === f.tunnelId), a = t && j(t.from), c = t && j(t.to);
        return a && c ? <text key={f.id} x={(sx(a.x) + sx(c.x)) / 2} y={(sy(a.y) + sy(c.y)) / 2 + unit * 4} fontSize={unit * 2.4} textAnchor="middle" fill="#142a3c">⊛ {f.name}</text> : null;
      })}
      {model.doors.map((d) => {
        const t = model.tunnels.find((x) => x.id === d.tunnelId), a = t && j(t.from), c = t && j(t.to);
        return a && c ? <text key={d.id} x={(sx(a.x) + sx(c.x)) / 2} y={(sy(a.y) + sy(c.y)) / 2 - unit * 2} fontSize={unit * 2.4} textAnchor="middle" fill="#596c79">▮ {d.name} ({d.open ? "open" : "closed"})</text> : null;
      })}
      {model.exits.map((e) => {
        const n = j(e.junction);
        if (!n) return null;
        const count = e.shaftId ? counts[e.shaftId] : undefined;
        return (
          <g key={e.id}>
            {e.kind === "shaft" ? (
              <rect x={sx(n.x) - unit * 2.2} y={sy(n.y) - unit * 2.2} width={unit * 4.4} height={unit * 4.4} fill="#142a3c" />
            ) : (
              <polygon points={`${sx(n.x)},${sy(n.y) - unit * 2.8} ${sx(n.x) - unit * 2.6},${sy(n.y) + unit * 2} ${sx(n.x) + unit * 2.6},${sy(n.y) + unit * 2}`} fill="#142a3c" />
            )}
            <text x={sx(n.x) + unit * 3.4} y={sy(n.y) - unit * 1} fontSize={unit * 2.8} fontWeight={700} fill="#142a3c">
              {e.name}
            </text>
            {count !== undefined && (
              <text x={sx(n.x) + unit * 3.4} y={sy(n.y) + unit * 2.4} fontSize={unit * 2.5} fill="#0b5f5b">
                {count} declared underground
              </text>
            )}
          </g>
        );
      })}
      {dots.map((d) => (
        <circle key={d.id} cx={sx(d.x)} cy={sy(d.y)} r={unit * 1.1} fill={d.tone === "cut-off" ? "#b42318" : d.tone === "safe" ? "#246752" : d.tone === "waiting" ? "#b0661b" : "#142a3c"} stroke="#fff" strokeWidth={unit * 0.25}>
          {d.label && <title>{d.label}</title>}
        </circle>
      ))}
      {marks.map((m) => (
        <g key={m.id} transform={`translate(${sx(m.x)},${sy(m.y)})`}>
          <path d={`M 0 ${-unit * 2.2} L ${unit * 1.6} 0 L 0 ${unit * 2.2} L ${-unit * 1.6} 0 Z`} fill={m.tone === "near" ? "#b42318" : m.tone === "pending" ? "#a76a2b" : "#7a8794"} stroke="#fff" strokeWidth={unit * 0.3} />
          <title>{m.label}</title>
        </g>
      ))}
      <g transform={`translate(${unit * 3},${H - unit * 4})`}>
        <line x1={0} y1={0} x2={50} y2={0} stroke="#142a3c" strokeWidth={unit * 0.4} />
        <text x={0} y={-unit} fontSize={unit * 2.4} fill="#142a3c">50 m</text>
      </g>
    </svg>
  );
}

const qualityText: Record<Quality, string> = { measured: "Measured", "survey-plan": "Survey plan", assumed: "Assumed", default: "Default" };
export function Mine(props: ViewProps) {
  const { data, post, refresh, notify } = props;
  const revisions = rows(data, "mine-model-revision").sort((a, b) => Number(b.data.number) - Number(a.data.number));
  const published = revisions.find((r) => r.data.status === "published");
  const draft = revisions.find((r) => r.data.status === "draft");
  const [tab, setTab] = useState("plan");
  const supervisor = ["supervisor", "administrator"].includes(data.workspace.role);
  const counts: Record<string, number> = Object.fromEntries((data.messaging?.config.shafts || []).map((s) => [s.id, 0]));
  for (const c of rows(data, "check-in"))
    if (["declared-underground", "return-overdue", "confirmed-missing"].includes(String(c.data.status)))
      counts[String(c.data.shaftId)] = (counts[String(c.data.shaftId)] || 0) + 1;
  if (!published)
    return <Empty title="No published mine model">Start a draft from the training template in the Edit tab.</Empty>;
  const model = published.data.model as MineModel;
  return (
    <>
      <div className="fs-page-heading">
        <div>
          <h1>Mine</h1>
          <p>
            {model.meta.name}: {model.junctions.length} junctions, {model.tunnels.length} tunnels, {model.exits.length} exits. A schematic of entered values; provenance is recorded for every value.
          </p>
        </div>
      </div>
      <div className="fs-tabs" role="tablist" aria-label="Mine view">
        {[
          ["plan", "Plan"],
          ["3d", "3D"],
          ["surface", "Surface"],
          ["edit", "Edit"],
          ...(supervisor ? [["import", "Import"]] : []),
          ["table", "Table"],
          ["pictures", "Zone pictures"],
        ].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "plan" && (
        <section className="fs-panel">
          <PlanView model={model} counts={counts} baseMap={activeBaseMap(data)} marks={planMarks(data)} label={`Plan of ${model.meta.name}: tunnels coloured by zone, exits with declared headcount. The Table tab lists the same data.`} />
          <Legend model={model} />
        </section>
      )}
      {tab === "3d" && (
        <section className="fs-panel">
          <Tunnels3D model={model} colour={zoneColour(model)} counts={counts} baseMap={activeBaseMap(data)} marks={planMarks(data).map((m) => ({ id: m.id, x: m.x, y: m.y, label: m.label, near: m.tone === "near" }))} />
        </section>
      )}
      {tab === "surface" && <Surface data={data} model={model} post={post} refresh={refresh} notify={notify} />}
      {tab === "import" && supervisor && <ImportDxf data={data} post={post} refresh={refresh} notify={notify} onDraft={() => setTab("edit")} />}
      {tab === "table" && <ModelTable model={model} />}
      {tab === "pictures" && <MineMapLegacy {...props} />}
      {tab === "edit" &&
        (supervisor ? (
          draft ? (
            <Editor key={draft.id + ":" + draft.revision} draft={draft} post={post} refresh={refresh} notify={notify} counts={counts} />
          ) : (
            <section className="fs-panel">
              <p>Published revisions never change, so any run that used them can be reproduced. Start a draft to edit.</p>
              <div className="fs-button-row">
                <button className="fs-button" onClick={() => void post("mine-model", { from: "published" }).then(refresh)}>
                  New draft from revision {String(published.data.number)}
                </button>
                <button className="fs-button secondary" onClick={() => void post("mine-model", { from: "template" }).then(refresh)}>
                  New draft from the training template
                </button>
                <button className="fs-button secondary" onClick={() => void post("mine-model/reset-training", {}).then(async (r) => (notify(`Training mine restored as revision ${r.revision}. No records were deleted.`), await refresh()))}>
                  Demo reset: restore training mine
                </button>
              </div>
            </section>
          )
        ) : (
          <p>Only supervisors and administrators edit the mine model.</p>
        ))}
    </>
  );
}
function Legend({ model }: { model: MineModel }) {
  return (
    <ul className="fs-legend" aria-label="Legend">
      {model.zones.map((z) => (
        <li key={z.id}>
          <span style={{ background: zoneColour(model)(z.tunnelIds[0]) }} /> {z.name}
        </li>
      ))}
      <li>■ Shaft · ▲ Adit/incline · green block: refuge · blue circle: sump with pumps · ⊛ fan · ▮ door · dashed: width not entered</li>
    </ul>
  );
}
function ModelTable({ model }: { model: MineModel }) {
  const prov = (k: string) => {
    const p = model.provenance[k];
    return p ? `${qualityText[p.quality]}${p.note ? ": " + p.note : ""}` : "No provenance (default)";
  };
  const v = (x: number | null, unit: string) => (x === null ? "Not entered" : `${x} ${unit}`);
  return (
    <section className="fs-panel">
      <h2>Tunnels</h2>
      <div className="fs-table-wrap">
        <table className="fs-register">
          <caption className="fs-sr-only">Tunnels with dimensions and provenance</caption>
          <thead>
            <tr>
              <th scope="col">Tunnel</th>
              <th scope="col">From → to</th>
              <th scope="col">Length</th>
              <th scope="col">Width</th>
              <th scope="col">Height</th>
              <th scope="col">Walkable</th>
              <th scope="col">Zone</th>
            </tr>
          </thead>
          <tbody>
            {model.tunnels.map((t) => (
              <tr key={t.id}>
                <td>{t.id} {t.name}</td>
                <td>{t.from} → {t.to}</td>
                <td>{tunnelLength(model, t)?.toFixed(1)} m<small className="fs-block">{t.length === null ? "computed from geometry" : prov(`${t.id}.length`)}</small></td>
                <td>{v(t.width, "m")}<small className="fs-block">{prov(`${t.id}.width`)}</small></td>
                <td>{v(t.height, "m")}<small className="fs-block">{prov(`${t.id}.height`)}</small></td>
                <td>{t.walkable ? "Yes" : "No"}</td>
                <td>{model.zones.find((z) => z.tunnelIds.includes(t.id))?.name || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Equipment, exits and refuges</h2>
      <ul className="fs-equipment">
        {model.exits.map((e) => (
          <li key={e.id}>{e.name} ({e.kind}) at {e.junction}: {e.usableForEscape ? "usable for escape" : "not usable for escape"}{e.hoist ? `; cage ${e.hoist.cageCapacity ?? "?"} people` : ""}{e.ladderClimbSeconds ? `; ladder climb ${e.ladderClimbSeconds} s (${prov(`${e.id}.ladderClimbSeconds`)})` : ""}</li>
        ))}
        {model.refuges.map((r) => (
          <li key={r.id}>{r.name} at {r.junction}: capacity {v(r.capacity, "people")}, air supply {v(r.airSupplyM3, "m³")} ({prov(`${r.id}.capacity`)})</li>
        ))}
        {model.sumps.map((s) => (
          <li key={s.id}>{s.name} at {s.junction}: danger level {v(s.dangerLevelM, "m")} ({prov(`${s.id}.dangerLevelM`)}); inflow {v(s.inflowM3h, "m³/h")}; closes {s.closesTunnelIds.join(", ") || "no tunnels"} at danger level</li>
        ))}
        {model.pumps.map((p) => (
          <li key={p.id}>{p.name} ({p.role}) on {p.sumpId}: {v(p.capacityM3h, "m³/h")} effective ({prov(`${p.id}.capacityM3h`)})</li>
        ))}
        {model.fans.map((f) => (
          <li key={f.id}>{f.name} on {f.tunnelId}: duty {v(f.fixedDutyM3s, "m³/s")}{f.curve ? `; curve of ${f.curve.length} points` : ""}</li>
        ))}
        {model.doors.map((d) => (
          <li key={d.id}>{d.name} on {d.tunnelId}: {d.open ? "open" : "closed"}</li>
        ))}
      </ul>
    </section>
  );
}

type Mode = "select" | "junction" | "tunnel" | "delete";
function Editor({ draft, post, refresh, notify, counts }: { draft: Row; post: ViewProps["post"]; refresh: ViewProps["refresh"]; notify: ViewProps["notify"]; counts: Record<string, number> }) {
  const [model, setModel] = useState<MineModel>(draft.data.model as MineModel);
  const [past, setPast] = useState<MineModel[]>([]), [future, setFuture] = useState<MineModel[]>([]);
  const [mode, setMode] = useState<Mode>("select"), [snap, setSnap] = useState(5);
  const [selected, setSelected] = useState<string | null>(null), [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const issues = useMemo(() => preflight(model), [model]);
  const errors = issues.filter((i) => i.severity === "error");
  const author = "Supervisor (editor)";
  const change = (fn: (m: MineModel) => void) => {
    const next: MineModel = JSON.parse(JSON.stringify(model));
    fn(next);
    next.meta.source = next.meta.source === "template" ? "editor" : next.meta.source;
    setPast([...past.slice(-49), model]);
    setFuture([]);
    setModel(next);
  };
  const stamp = (m: MineModel, path: string, q: Quality = "assumed", note = "Entered in editor") => {
    m.provenance[path] = { quality: q, note, author, at: new Date().toISOString() };
  };
  const nextId = (prefix: string, list: { id: string }[]) => {
    let i = list.length + 1;
    while (list.some((x) => x.id === prefix + i)) i++;
    return prefix + i;
  };
  const planClick = (x: number, y: number) => {
    if (mode !== "junction") return;
    const s = (v: number) => (snap ? Math.round(v / snap) * snap : Math.round(v * 10) / 10);
    change((m) => {
      const id = nextId("N", m.junctions);
      m.junctions.push({ id, x: s(x), y: s(y), z: null });
      stamp(m, `${id}.x`, "assumed", "Placed in editor");
      stamp(m, `${id}.y`, "assumed", "Placed in editor");
      setSelected(id);
    });
  };
  const select = (id: string) => {
    if (mode === "delete") {
      change((m) => {
        m.tunnels = m.tunnels.filter((t) => t.id !== id && t.from !== id && t.to !== id);
        m.junctions = m.junctions.filter((j) => j.id !== id);
        m.zones.forEach((z) => (z.tunnelIds = z.tunnelIds.filter((t) => t !== id)));
      });
      setSelected(null);
      return;
    }
    if (mode === "tunnel" && model.junctions.some((j) => j.id === id)) {
      if (!pending) return setPending(id);
      if (pending !== id)
        change((m) => {
          const tid = nextId("T", m.tunnels);
          m.tunnels.push({ id: tid, from: pending, to: id, length: null, width: null, height: null, profile: "box", walkable: true, resistance: null });
          setSelected(tid);
        });
      setPending(null);
      return;
    }
    setSelected(id);
  };
  const save = async (publishAfter: boolean) => {
    setBusy(true);
    setError("");
    try {
      const saved = await post(`mine-model/${draft.id}`, { expectedRevision: draft.revision, model });
      if (publishAfter) {
        await post(`mine-model/${draft.id}/publish`, { expectedRevision: saved.revision });
        notify("Revision published. Scenarios now use it; earlier runs keep their own revision.");
      } else notify("Draft saved.");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const tunnel = model.tunnels.find((t) => t.id === selected);
  const junction = model.junctions.find((j) => j.id === selected);
  const numField = (label: string, path: string, value: number | null, set: (m: MineModel, v: number | null) => void, unit: string) => (
    <ProvField
      key={path}
      label={`${label} (${unit})`}
      value={value}
      provenance={model.provenance[path]}
      onChange={(v, q, note) =>
        change((m) => {
          set(m, v);
          if (v === null) delete m.provenance[path];
          else stamp(m, path, q, note);
        })
      }
    />
  );
  return (
    <section className="fs-editor">
      <div className="fs-editor-tools" role="toolbar" aria-label="Editor tools">
        {(["select", "junction", "tunnel", "delete"] as Mode[]).map((m) => (
          <button key={m} className={"fs-button " + (mode === m ? "" : "secondary")} aria-pressed={mode === m} onClick={() => (setMode(m), setPending(null))}>
            {m === "select" ? "Select" : m === "junction" ? "Add junction" : m === "tunnel" ? "Connect tunnel" : "Delete"}
          </button>
        ))}
        <button className="fs-button secondary" disabled={!past.length} onClick={() => (setFuture([model, ...future]), setModel(past.at(-1)!), setPast(past.slice(0, -1)))}>
          Undo
        </button>
        <button className="fs-button secondary" disabled={!future.length} onClick={() => (setPast([...past, model]), setModel(future[0]), setFuture(future.slice(1)))}>
          Redo
        </button>
        <label className="fs-inline-select">
          Snap
          <select value={snap} onChange={(e) => setSnap(Number(e.target.value))}>
            <option value={0}>Off</option>
            <option value={1}>1 m</option>
            <option value={5}>5 m</option>
            <option value={10}>10 m</option>
          </select>
        </label>
      </div>
      <p className="fs-help">
        {mode === "junction" ? "Click the plan to place a junction." : mode === "tunnel" ? (pending ? `From ${pending}: click the second junction.` : "Click the first junction.") : mode === "delete" ? "Click a junction or tunnel to delete it." : "Click a junction or tunnel to edit its properties."}
      </p>
      <div className="fs-editor-grid">
        <div className="fs-panel">
          <PlanView model={model} counts={counts} selected={selected || pending} onSelect={select} onPlanClick={planClick} label={`Editable plan, draft revision ${String(draft.data.number)}`} />
        </div>
        <aside className="fs-panel fs-props" aria-label="Properties">
          {tunnel ? (
            <>
              <h3>Tunnel {tunnel.id}</h3>
              <Field label="Name">
                <input value={tunnel.name || ""} onChange={(e) => change((m) => (m.tunnels.find((t) => t.id === tunnel.id)!.name = e.target.value))} />
              </Field>
              {numField("Width", `${tunnel.id}.width`, tunnel.width, (m, v) => (m.tunnels.find((t) => t.id === tunnel.id)!.width = v), "m")}
              {numField("Height", `${tunnel.id}.height`, tunnel.height, (m, v) => (m.tunnels.find((t) => t.id === tunnel.id)!.height = v), "m")}
              {numField("Length (blank = from geometry)", `${tunnel.id}.length`, tunnel.length, (m, v) => (m.tunnels.find((t) => t.id === tunnel.id)!.length = v), "m")}
              {numField("Airway resistance R (N·s²/m⁸)", `${tunnel.id}.resistance`, tunnel.resistance, (m, v) => (m.tunnels.find((t) => t.id === tunnel.id)!.resistance = v), "ventilation")}
              {model.fans.filter((f) => f.tunnelId === tunnel.id).map((fan) => (
                <div key={fan.id} className="fs-group">
                  <h4>Fan {fan.name}</h4>
                  {numField("Fixed duty", `${fan.id}.fixedDutyM3s`, fan.fixedDutyM3s, (m, v) => (m.fans.find((f) => f.id === fan.id)!.fixedDutyM3s = v), "m³/s")}
                  <Field label="Pressure–quantity curve (one 'flow m³/s, pressure Pa' pair per line; blank = none)">
                    <textarea
                      rows={4}
                      defaultValue={(fan.curve || []).map((pt) => `${pt.q}, ${pt.p}`).join("\n")}
                      key={fan.id + JSON.stringify(fan.curve)}
                      onBlur={(e) => {
                        const lines = e.target.value.split("\n").map((l) => l.trim()).filter(Boolean);
                        const pts = lines.map((l) => l.split(/[ ,;\t]+/).map(Number));
                        const bad = pts.some((x) => x.length !== 2 || x.some((n) => !Number.isFinite(n)));
                        change((m) => {
                          const f = m.fans.find((x) => x.id === fan.id)!;
                          f.curve = !lines.length || bad ? null : pts.map(([q, p]) => ({ q: q!, p: p! }));
                          if (f.curve) stamp(m, `${fan.id}.curve`, "assumed", "Entered in editor");
                          else delete m.provenance[`${fan.id}.curve`];
                        });
                        if (bad) setError("Each curve line must be two numbers: flow then pressure.");
                      }}
                    />
                  </Field>
                  <p className="fs-help">Take the points from the fan maker&apos;s published curve. The curve is used instead of the fixed duty. Preflight blocks flows that do not increase.</p>
                </div>
              ))}
              {model.doors.filter((d) => d.tunnelId === tunnel.id).map((door) => numField(`Door ${door.name} resistance when closed`, `${door.id}.resistance`, door.resistance, (m, v) => (m.doors.find((d) => d.id === door.id)!.resistance = v), "N·s²/m⁸"))}
              <label className="fs-confirm">
                <input type="checkbox" checked={tunnel.walkable} onChange={(e) => change((m) => (m.tunnels.find((t) => t.id === tunnel.id)!.walkable = e.target.checked))} /> Walkable
              </label>
              <Field label="Zone">
                <select
                  value={model.zones.find((z) => z.tunnelIds.includes(tunnel.id))?.id || ""}
                  onChange={(e) =>
                    change((m) => {
                      m.zones.forEach((z) => (z.tunnelIds = z.tunnelIds.filter((t) => t !== tunnel.id)));
                      m.zones.find((z) => z.id === e.target.value)?.tunnelIds.push(tunnel.id);
                    })
                  }
                >
                  <option value="">No zone</option>
                  {model.zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="fs-help">Geometry length {tunnelLength(model, { ...tunnel, length: null })?.toFixed(1)} m.</p>
            </>
          ) : junction ? (
            <>
              <h3>Junction {junction.id}</h3>
              {numField("East (x)", `${junction.id}.x`, junction.x, (m, v) => (m.junctions.find((j) => j.id === junction.id)!.x = v ?? junction.x), "m")}
              {numField("North (y)", `${junction.id}.y`, junction.y, (m, v) => (m.junctions.find((j) => j.id === junction.id)!.y = v ?? junction.y), "m")}
              {numField("Elevation", `${junction.id}.z`, junction.z, (m, v) => (m.junctions.find((j) => j.id === junction.id)!.z = v), "m")}
            </>
          ) : (
            <p>Select a junction or tunnel.</p>
          )}
        </aside>
      </div>
      <section className="fs-panel" aria-labelledby="validation-heading">
        <h3 id="validation-heading">
          Validation: {errors.length} blocking, {issues.length - errors.length} warnings
        </h3>
        <ul className="fs-issues">
          {issues.map((i, k) => (
            <li key={k}>
              <Tag tone={i.severity === "error" ? "red" : "amber"}>{i.severity === "error" ? "Blocks" : "Warning"}</Tag> {i.message}
              {i.blocks.length ? <small> Blocks: {i.blocks.join(", ")}.</small> : null}
              {i.elementId && (
                <button className="fs-inline-link" onClick={() => setSelected(i.elementId!)}>
                  Show
                </button>
              )}
            </li>
          ))}
        </ul>
        <ErrorText message={error} />
        <div className="fs-button-row">
          <button className="fs-button secondary" disabled={busy} onClick={() => void save(false)}>
            Save draft
          </button>
          <button className="fs-button" disabled={busy || errors.length > 0} onClick={() => void save(true)}>
            Save and publish revision {String(draft.data.number)}
          </button>
        </div>
      </section>
    </section>
  );
}
function ProvField({ label, value, provenance, onChange }: { label: string; value: number | null; provenance?: Provenance; onChange: (v: number | null, q: Quality, note: string) => void }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const [q, setQ] = useState<Quality>(provenance?.quality || "assumed");
  const [note, setNote] = useState(provenance?.note || "");
  const commit = (t = text, qq = q, n = note) => {
    const v = t.trim() === "" ? null : Number(t);
    if (v !== null && !Number.isFinite(v)) return;
    onChange(v, qq, n || "Entered in editor");
  };
  return (
    <fieldset className="fs-prov">
      <legend>{label}</legend>
      <input inputMode="decimal" aria-label={label} value={text} placeholder="Not entered" onChange={(e) => setText(e.target.value)} onBlur={() => commit()} />
      <select aria-label={`${label} source`} value={q} onChange={(e) => (setQ(e.target.value as Quality), commit(text, e.target.value as Quality))}>
        {(Object.keys(qualityText) as Quality[]).map((k) => (
          <option key={k} value={k}>
            {qualityText[k]}
          </option>
        ))}
      </select>
      <input aria-label={`${label} source note`} value={note} placeholder="Source note" onChange={(e) => setNote(e.target.value)} onBlur={() => commit()} />
      {provenance && <small className="fs-block">{provenance.author} · {provenance.at.slice(0, 16).replace("T", " ")}</small>}
    </fieldset>
  );
}
