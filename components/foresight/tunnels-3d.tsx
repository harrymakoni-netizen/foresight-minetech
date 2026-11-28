"use client";
// Procedural 3D schematic (spec §8.5): every shape comes from entered values
// (junction coordinates and elevations, tunnel width/height/profile, exits,
// refuges, sumps, pumps, fans, doors). It is a schematic, not a reconstruction:
// the surface is a flat reference plane at the datum (0 m), and tunnels with no
// entered size are drawn faded at a nominal size.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { Maximize2, Minimize2, RotateCcw } from "lucide-react";
import type { MineModel } from "@/lib/domain/mine-model";

type View = "perspective" | "top" | "section" | "cutaway";
/** Scenario state at one moment, applied without rebuilding the scene. */
export type Playback = {
  /** `shaft` places a person in a shaft column instead of in a tunnel: fraction 0 = station, 1 = surface. */
  people: { id: string; x: number; y: number; tone: "walking" | "cut-off" | "safe" | "waiting"; label?: string; shaft?: { exitId: string; fraction: number } }[];
  /** Cage position in a shaft (0 = station, 1 = surface) with the number aboard. */
  cage?: { exitId: string; fraction: number; aboard: number; failed: boolean };
  /** Several cages in one shaft (each rides beside the others). */
  cages?: { exitId: string; index: number; fraction: number; aboard: number; failed: boolean }[];
  /** Airflow by tunnel id (signed m3/s, positive from the tunnel's start to its end): colours tunnels by speed and animates arrows along the flow. */
  flows?: Record<string, number>;
  closed: Set<string>;
  sumps?: Record<string, { levelM: number; dangerLevelM: number | null }>;
  clock?: string;
};
// Open the camera-facing wall and roof so the floor and playback remain visible.
function cutawayGeometry(width: number, height: number, length: number, arched: boolean) {
  const half = width / 2;
  const roof = Math.min(half, height);
  const wall = arched ? height - roof : height;
  const profile = [new THREE.Vector2(half, 0), new THREE.Vector2(-half, 0)];
  if (wall > 0) profile.push(new THREE.Vector2(-half, wall));
  if (arched) {
    for (let step = 1; step <= 8; step++) {
      const angle = Math.PI - (step / 8) * Math.PI / 2;
      profile.push(new THREE.Vector2(Math.cos(angle) * half, wall + Math.sin(angle) * roof));
    }
  }
  const positions: number[] = [], uv: number[] = [], indices: number[] = [];
  let distance = 0;
  profile.forEach(({ x, y }, i) => {
    if (i > 0) distance += profile[i].distanceTo(profile[i - 1]);
    positions.push(x, y - height / 2, 0, x, y - height / 2, length);
    uv.push(distance, 0, distance, length);
    if (i > 0) {
      const offset = 2 * i;
      indices.push(offset - 2, offset, offset - 1, offset - 1, offset, offset + 1);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function rockTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const image = ctx.createImageData(size, size);
  let seed = 19;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const u = (x / size) * Math.PI * 2, v = (y / size) * Math.PI * 2;
      const tone = 177 + 14 * Math.sin(v * 4 + 1.7 * Math.sin(u * 3)) + 10 * Math.sin(u * 3 - v * 2) + (seed >>> 27);
      const i = (y * size + x) * 4;
      image.data.set([tone, tone, tone, 255], i);
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(0.4, 0.4);
  return texture;
}

type Picked = { title: string; rows: [string, string][] } | null;

export default function Tunnels3D({
  model,
  colour,
  highlight,
  counts = {},
  playback,
  baseMap,
  marks = [],
  label: ariaLabel,
  fallback,
}: {
  model: MineModel;
  colour: (tunnelId: string) => string;
  highlight?: Set<string>;
  counts?: Record<string, number>;
  playback?: Playback;
  /** Georeferenced picture laid on the surface plane (plan coordinates, metres). */
  baseMap?: { href: string; west: number; south: number; east: number; north: number; rotationDegrees?: number } | null;
  /** Subsidence marks, shown as pins on the surface. */
  marks?: { id: string; x: number; y: number; label: string; near: boolean }[];
  label?: string;
  fallback?: React.ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<{ view: (v: View) => void }>({ view: () => {} });
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("perspective");
  const cutaway = view === "cutaway";
  const [exaggerate, setExaggerate] = useState(3);
  const [layers, setLayers] = useState({ surface: true, labels: true, rock: true });
  const [spin, setSpin] = useState(false);
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const [picked, setPicked] = useState<Picked>(null);
  const [full, setFull] = useState(false);
  const spinRef = useRef(spin);
  spinRef.current = spin;
  // colour and counts are recreated on every parent render; rebuild the scene
  // only when their content changes.
  const colourRef = useRef(colour);
  colourRef.current = colour;
  const countsRef = useRef(counts);
  countsRef.current = counts;
  const countsKey = JSON.stringify(counts);
  const overlayKey = JSON.stringify([baseMap, marks]);
  const baseMapRef = useRef(baseMap);
  baseMapRef.current = baseMap;
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  const applyRef = useRef<(pb: Playback | undefined) => void>(() => {});
  useEffect(() => applyRef.current(playback), [playback]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const colour = colourRef.current, counts = countsRef.current;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setError("3D view unavailable on this device (WebGL). The plan view and table show the same model.");
      return;
    }
    const size = () => [el.clientWidth || 600, el.clientHeight || 520] as const;
    let [width, height] = size();
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(renderer.domElement);
    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(width, height);
    labelRenderer.domElement.className = "fs-3d-labels";
    el.appendChild(labelRenderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x10161b);
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.5, 50000);
    scene.add(new THREE.HemisphereLight(0xdfe9f3, 0x2a1d12, cutaway ? 1.0 : 0.95));
    const sun = new THREE.DirectionalLight(0xfff3e0, cutaway ? 1.35 : 1.7);
    sun.position.set(300, 600, 200);
    scene.add(sun);
    const lamp = new THREE.PointLight(0xffc27a, 1.2, 0, 0);
    scene.add(lamp);

    const ex = cutaway ? 1 : exaggerate;
    const byId = new Map(model.junctions.map((j) => [j.id, j]));
    const focusSump = model.sumps.find((s) => !!playbackRef.current?.sumps?.[s.id]) ?? model.sumps[0];
    const focusJunction = focusSump && byId.get(focusSump.junction);
    const focusLabels = new Map<string, { tag: CSS2DObject; name: string }>();
    // Plan x → three x, plan y → three -z, elevation (× exaggeration) → three y.
    const P = (x: number, y: number, z: number | null) => new THREE.Vector3(x, (z ?? 0) * ex, -y);
    const world = new THREE.Group();
    const pickable: THREE.Object3D[] = [];
    const tunnelMeshes = new Map<string, { mesh: THREE.Mesh; base: THREE.Color; pa: THREE.Vector3; pb: THREE.Vector3 }>();
    const arrowSets = new Map<string, { group: THREE.Group; q: number; f: number }>();
    const sumpWater = new Map<string, { mesh: THREE.Mesh; floor: number; depth: number; dangerLevel: number | null; initialLevel: number | null }>();
    const shaftColumns = new Map<string, { top: THREE.Vector3; bottom: THREE.Vector3 }>();
    const cages = new Map<string, { mesh: THREE.Mesh; tag: CSS2DObject }>(); // key: exitId or exitId#index
    const disposables: { dispose: () => void }[] = [];
    const stone = rockTexture();
    if (stone) disposables.push(stone);
    const mat = (o: THREE.MeshStandardMaterialParameters) => {
      const m = new THREE.MeshStandardMaterial(o);
      disposables.push(m);
      return m;
    };
    const label = (text: string, at: THREE.Vector3, tone = "") => {
      const div = document.createElement("div");
      div.className = "fs-3d-label " + tone;
      div.textContent = text;
      const obj = new CSS2DObject(div);
      obj.position.copy(at);
      obj.userData.label = true;
      world.add(obj);
      return obj;
    };

    // Extents of the entered geometry.
    const xs = model.junctions.map((j) => j.x), ys = model.junctions.map((j) => j.y);
    const zs = model.junctions.map((j) => j.z ?? 0);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const deepest = Math.min(0, ...zs);
    const pad = Math.max(40, (maxX - minX + maxY - minY) * 0.12);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const spanX = maxX - minX + pad * 2, spanY = maxY - minY + pad * 2;

    // Open drive sections reveal the floor and far wall in the overview.
    const lampHousing = new THREE.BoxGeometry(1.5, 0.4, 0.6);
    const lampLens = mat({ color: 0xffcf87, emissive: new THREE.Color(0xffb95f), emissiveIntensity: 1.5 });
    disposables.push(lampHousing);
    for (const t of model.tunnels) {
      const a = byId.get(t.from), b = byId.get(t.to);
      if (!a || !b) continue;
      const pa = P(a.x, a.y, a.z), pb = P(b.x, b.y, b.z);
      const length = pa.distanceTo(pb);
      if (!(length > 0)) continue;
      const known = t.width !== null && t.height !== null;
      // Cross-sections are scaled up so a few-metre drive stays visible on a
      // mine-scale view; the scale note in the legend says so.
      const vis = cutaway ? 1 : Math.max(1, Math.min(spanX, spanY) / 110);
      const w = (t.width ?? 3) * vis, h = (t.height ?? 3) * vis;
      const geometry = cutawayGeometry(w, h, length, t.profile === "arched");
      // In the default oblique camera, expose the wall facing the viewer.
      const direction = pb.clone().sub(pa);
      if (!cutaway && direction.z * 0.63 - direction.x * 0.7 < 0) geometry.scale(-1, 1, 1);
      disposables.push(geometry);
      const flooded = highlight?.has(t.id);
      const base = new THREE.Color(flooded ? 0xd92d20 : colour(t.id));
      if (!flooded) base.lerp(new THREE.Color(0x77736c), cutaway ? 0.75 : 0.78);
      const mesh = new THREE.Mesh(
        geometry,
        mat({ color: base, emissive: base.clone().multiplyScalar(0.25), map: stone, side: THREE.DoubleSide, roughness: 0.9, metalness: 0.05, transparent: !known, opacity: known ? 1 : 0.35 }),
      );
      mesh.position.copy(pa);
      mesh.lookAt(pb);
      if (!cutaway && known && length > 20) {
        const side = direction.z * 0.63 - direction.x * 0.7 < 0 ? 1 : -1;
        const spacing = Math.max(18, length / 5);
        for (let z = spacing / 2; z < length; z += spacing) {
          const fixture = new THREE.Mesh(lampHousing, lampLens);
          fixture.position.set(side * w * 0.43, h * 0.15, z);
          mesh.add(fixture);
        }
      }
      mesh.userData.pick = {
        title: `${t.id} · ${t.name || "Tunnel"}`,
        rows: [
          ["From → to", `${t.from} → ${t.to}`],
          ["Zone", model.zones.find((z) => z.tunnelIds.includes(t.id))?.name || "No zone"],
          ["Width × height", known ? `${t.width} m × ${t.height} m (${t.profile})` : "Not entered"],
          ["Plan length", `${Math.hypot(b.x - a.x, b.y - a.y).toFixed(0)} m`],
          ["Elevation", `${a.z ?? "?"} m → ${b.z ?? "?"} m`],
          ["Walkable", t.walkable ? "Yes" : "No"],
          ...(flooded ? ([["Scenario", "Closed by water"]] as [string, string][]) : []),
        ],
      } satisfies Picked;
      world.add(mesh);
      pickable.push(mesh);
      tunnelMeshes.set(t.id, { mesh, base, pa: pa.clone(), pb: pb.clone() });
      if (cutaway && focusSump?.closesTunnelIds.includes(t.id)) {
        const name = `${t.id} · ${t.name || "Tunnel"}`;
        const tag = label(name, pa.clone().lerp(pb, 0.5).add(new THREE.Vector3(0, h / 2 + 1, 0)), "minor");
        focusLabels.set(t.id, { tag, name });
      }
    }
    // Junction nodes.
    const nodeGeo = new THREE.SphereGeometry(cutaway ? 0.28 : Math.max(1.2, Math.min(spanX, spanY) / 160), 16, 12);
    disposables.push(nodeGeo);
    const nodeMat = mat({ color: 0xe8edf2, roughness: 0.4 });
    for (const j of model.junctions) {
      const m = new THREE.Mesh(nodeGeo, nodeMat);
      m.position.copy(P(j.x, j.y, j.z));
      m.userData.pick = { title: `${j.id}${j.name ? " · " + j.name : ""}`, rows: [["Position", `x ${j.x} m, y ${j.y} m`], ["Elevation", j.z === null ? "Not entered" : `${j.z} m`]] } satisfies Picked;
      world.add(m);
      pickable.push(m);
      const featured = model.exits.some((e) => e.junction === j.id) || model.refuges.some((r) => r.junction === j.id) || model.sumps.some((x) => x.junction === j.id);
      if (j.name && !featured && !cutaway) label(j.name, m.position.clone().add(new THREE.Vector3(0, 6, 0)), "minor");
    }

    // Exits: shaft with headframe, inclines/adits with a portal marker.
    for (const e of model.exits) {
      const j = byId.get(e.junction);
      if (!j) continue;
      const bottom = P(j.x, j.y, j.z);
      const count = e.shaftId ? counts[e.shaftId] : undefined;
      const text = `${e.name}${count !== undefined ? ` · ${count} declared underground` : ""}`;
      if (e.kind === "shaft") {
        const top = P(j.x, j.y, 0);
        const depth = Math.max(1, top.y - bottom.y);
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, depth, 20, 1, true), mat({ color: 0x8fa3b5, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
        disposables.push(shaft.geometry);
        shaft.position.set(top.x, (top.y + bottom.y) / 2, top.z);
        world.add(shaft);
        // Headframe: two legs and a sheave beam at the collar.
        const steel = mat({ color: 0x967044, metalness: 0.45, roughness: 0.48 });
        if (!cutaway && top.y > bottom.y) {
          const guideGeometry = new THREE.BoxGeometry(0.55, depth, 0.55);
          const frameGeometry = new THREE.TorusGeometry(4.15, 0.18, 5, 16);
          disposables.push(guideGeometry, frameGeometry);
          for (const dx of [-2.7, 2.7]) {
            for (const dz of [-2.7, 2.7]) {
              const guide = new THREE.Mesh(guideGeometry, steel);
              guide.position.copy(shaft.position).add(new THREE.Vector3(dx, 0, dz));
              world.add(guide);
            }
          }
          const spacing = Math.max(12, depth / 14);
          for (let y = bottom.y + spacing / 2; y < top.y; y += spacing) {
            const frame = new THREE.Mesh(frameGeometry, steel);
            frame.rotation.x = Math.PI / 2;
            frame.position.set(top.x, y, top.z);
            const fixture = new THREE.Mesh(lampHousing, lampLens);
            fixture.position.set(2.7, 0, 2.7);
            frame.add(fixture);
            world.add(frame);
          }
          const stationLight = new THREE.PointLight(0xffbc73, 1200, 34, 2);
          stationLight.position.copy(bottom).add(new THREE.Vector3(0, 7, 0));
          world.add(stationLight);
        }
        const hf = Math.max(22, spanX / 12);
        for (const dx of [-5, 5]) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(2, hf, 2), steel);
          disposables.push(leg.geometry);
          leg.position.set(top.x + dx, top.y + hf / 2, top.z);
          world.add(leg);
        }
        const beam = new THREE.Mesh(new THREE.BoxGeometry(12, 1.6, 2.5), steel);
        disposables.push(beam.geometry);
        beam.position.set(top.x, top.y + hf, top.z);
        world.add(beam);
        const sheave = new THREE.Mesh(new THREE.TorusGeometry(3, 0.5, 8, 24), mat({ color: 0xa76a2b, metalness: 0.5 }));
        disposables.push(sheave.geometry);
        sheave.position.set(top.x, top.y + hf + 3, top.z);
        sheave.userData.spin = true;
        world.add(sheave);
        label(text, new THREE.Vector3(top.x, top.y + hf + 10, top.z), "exit");
        shaftColumns.set(e.id, { top: top.clone(), bottom: bottom.clone() });
        if (e.hoist) {
          // Up to four cages can be drawn; only those in a playback state are shown, the first rests at the collar.
          for (let ci = 0; ci < 4; ci++) {
            const cageMesh = new THREE.Mesh(new THREE.BoxGeometry(4, 7, 4), mat({ color: 0xa76a2b, emissive: new THREE.Color(0x5a3611), metalness: 0.4, roughness: 0.4 }));
            disposables.push(cageMesh.geometry);
            cageMesh.position.copy(top).add(new THREE.Vector3(ci * 5.5 - 2.75, 0, 0));
            cageMesh.visible = ci === 0;
            const cageDiv = document.createElement("div");
            cageDiv.className = "fs-3d-label person cage";
            const cageTag = new CSS2DObject(cageDiv);
            cageTag.userData.label = true;
            cageTag.visible = false;
            cageMesh.add(cageTag);
            world.add(cageMesh);
            cages.set(ci === 0 ? e.id : `${e.id}#${ci}`, { mesh: cageMesh, tag: cageTag });
          }
        }
        shaft.userData.pick = {
          title: e.name,
          rows: [
            ["Type", "Shaft"],
            ["Station elevation", `${j.z ?? "?"} m (collar drawn at datum 0 m)`],
            ["Cage", e.hoist ? `${e.hoist.cageCapacity} people, ${e.hoist.loadingSeconds} s loading` : "No hoist entered"],
            ["Ladder climb", e.ladderClimbSeconds ? `${Math.round(e.ladderClimbSeconds / 60)} min` : "Not entered"],
            ["Declared underground", count === undefined ? "Not linked" : String(count)],
          ],
        } satisfies Picked;
        pickable.push(shaft);
      } else {
        const marker = new THREE.Mesh(new THREE.ConeGeometry(5, 12, 4), mat({ color: 0x1f6f4a, emissive: new THREE.Color(0x0b3a26) }));
        disposables.push(marker.geometry);
        marker.position.copy(bottom).add(new THREE.Vector3(0, 10, 0));
        marker.rotation.x = Math.PI;
        marker.userData.pick = {
          title: e.name,
          rows: [
            ["Type", e.kind === "incline" ? "Incline" : e.kind === "adit" ? "Adit" : "Portal"],
            ["Elevation", `${j.z ?? "?"} m`],
            ["Usable for escape", e.usableForEscape ? "Yes" : "No"],
            ["Declared underground", count === undefined ? "Not linked" : String(count)],
          ],
        } satisfies Picked;
        world.add(marker);
        pickable.push(marker);
        label(text, bottom.clone().add(new THREE.Vector3(0, 24, 0)), "exit");
      }
    }
    // Refuges, sumps with water, pumps, fans, doors.
    for (const r of model.refuges) {
      const j = byId.get(r.junction);
      if (!j) continue;
      const m = new THREE.Mesh(new THREE.BoxGeometry(10, 6, 10), mat({ color: 0x4f9a3a, emissive: new THREE.Color(0x1d3d14) }));
      disposables.push(m.geometry);
      m.position.copy(P(j.x, j.y, j.z)).add(new THREE.Vector3(0, 0, -12));
      m.userData.pick = { title: r.name, rows: [["Type", "Refuge bay"], ["Capacity", r.capacity === null ? "Not entered" : `${r.capacity} people`], ["Air supply", r.airSupplyM3 === null ? "Not entered" : `${r.airSupplyM3} m³`]] } satisfies Picked;
      world.add(m);
      pickable.push(m);
      label(r.name, m.position.clone().add(new THREE.Vector3(0, 9, 0)), "refuge");
    }
    for (const s of model.sumps) {
      const j = byId.get(s.junction);
      if (!j) continue;
      const at = P(j.x, j.y, j.z);
      const depth = cutaway && s.levelVolume.length > 0 ? s.levelVolume[s.levelVolume.length - 1].levelM || 10 : 10;
      const radius = cutaway ? 4 : 9;
      const floor = at.y - (cutaway ? depth + 1 : 12);
      const pit = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, depth, 32, 1, true), mat({ color: 0x535b60, side: THREE.DoubleSide, transparent: true, opacity: 0.46, depthWrite: false, roughness: 0.85 }));
      disposables.push(pit.geometry);
      pit.position.copy(at).setY(floor + depth / 2);
      world.add(pit);
      const water = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.95, radius * 0.95, 4, 32), mat({ color: 0x2586ad, emissive: new THREE.Color(0x0b2f55), transparent: true, opacity: 0.88, roughness: 0.23, metalness: 0.16 }));
      disposables.push(water.geometry);
      water.position.copy(at).add(new THREE.Vector3(0, -10, 0));
      water.userData.water = true;
      const upper = s.levelVolume.findIndex((point) => s.initialVolumeM3 !== null && point.volumeM3 >= s.initialVolumeM3);
      const low = s.levelVolume[upper - 1], high = s.levelVolume[upper];
      const initialLevel = low && high && s.initialVolumeM3 !== null && high.volumeM3 > low.volumeM3
        ? THREE.MathUtils.lerp(low.levelM, high.levelM, (s.initialVolumeM3 - low.volumeM3) / (high.volumeM3 - low.volumeM3))
        : (high?.volumeM3 === s.initialVolumeM3 ? high.levelM : null);
      sumpWater.set(s.id, { mesh: water, floor, depth, dangerLevel: s.dangerLevelM, initialLevel });
      const pumps = model.pumps.filter((p) => p.sumpId === s.id);
      water.userData.pick = {
        title: s.name,
        rows: [
          ["Type", "Sump"],
          ["Inflow", s.inflowM3h === null ? "Not entered" : `${s.inflowM3h} m³/h`],
          ["Danger level", s.dangerLevelM === null ? "Not entered" : `${s.dangerLevelM} m`],
          ["Pumps", pumps.map((p) => `${p.name} (${p.capacityM3h ?? "?"} m³/h)`).join(", ") || "None"],
          ["Closes when flooded", s.closesTunnelIds.join(", ") || "None entered"],
        ],
      } satisfies Picked;
      world.add(water);
      pickable.push(water);
      label(`${s.name}${pumps.length ? " · " + pumps.map((p) => p.id).join(", ") : ""}`, at.clone().add(new THREE.Vector3(0, cutaway ? 5 : -22, 0)), "water");
      if (cutaway && pumps.length) {
        const steel = mat({ color: 0x3e6877, roughness: 0.43, metalness: 0.54 });
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, depth, 12), steel);
        pipe.position.copy(pit.position).add(new THREE.Vector3(0, 0, -radius * 0.7));
        world.add(pipe);
        disposables.push(pipe.geometry);
        const motor = new THREE.CylinderGeometry(0.65, 0.65, 1.8, 16);
        const plinth = new THREE.BoxGeometry(2.0, 0.3, 1.6);
        const concrete = mat({ color: 0x565451, roughness: 0.95 });
        disposables.push(motor, plinth);
        for (const [i, pump] of pumps.entries()) {
          const body = new THREE.Mesh(motor, steel);
          body.rotation.z = Math.PI / 2;
          body.position.copy(at).add(new THREE.Vector3((i - (pumps.length - 1) / 2) * 2.1, 0.65, -radius * 0.7));
          body.userData.pick = { title: pump.name, rows: [["Capacity", pump.capacityM3h === null ? "Not entered" : `${pump.capacityM3h} m³/h`]] } satisfies Picked;
          const base = new THREE.Mesh(plinth, concrete);
          base.position.copy(body.position).add(new THREE.Vector3(0, -0.8, 0));
          world.add(body, base);
          pickable.push(body);
        }
      }
    }
    const along = (tunnelId: string, f = 0.5) => {
      const t = model.tunnels.find((x) => x.id === tunnelId);
      const a = t && byId.get(t.from), b = t && byId.get(t.to);
      return a && b ? P(a.x, a.y, a.z).lerp(P(b.x, b.y, b.z), f) : null;
    };
    for (const f of model.fans) {
      const at = along(f.tunnelId);
      if (!at) continue;
      const fan = new THREE.Group();
      for (let i = 0; i < 4; i++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.8, 7, 1.6), mat({ color: 0xd8dee4, metalness: 0.4 }));
        disposables.push(blade.geometry);
        blade.position.y = 3.5;
        const arm = new THREE.Group();
        arm.rotation.z = (i * Math.PI) / 2;
        arm.add(blade);
        fan.add(arm);
      }
      fan.position.copy(at).add(new THREE.Vector3(0, 9, 0));
      fan.userData.spin = true;
      world.add(fan);
      label(f.name, at.clone().add(new THREE.Vector3(0, 20, 0)), "minor");
    }
    for (const d of model.doors) {
      const at = along(d.tunnelId);
      if (!at) continue;
      const door = new THREE.Mesh(new THREE.BoxGeometry(8, 8, 1), mat({ color: d.open ? 0x8a99a3 : 0xb42318, transparent: d.open, opacity: d.open ? 0.5 : 1 }));
      disposables.push(door.geometry);
      door.position.copy(at);
      door.userData.pick = { title: d.name, rows: [["Type", "Ventilation door"], ["State", d.open ? "Open" : "Closed"]] } satisfies Picked;
      world.add(door);
      pickable.push(door);
      label(`${d.name} (${d.open ? "open" : "closed"})`, at.clone().add(new THREE.Vector3(0, 12, 0)), "minor");
    }
    // Zone names at the middle of each zone.
    for (const z of model.zones) {
      const pts = z.tunnelIds.map((id) => along(id)).filter((p): p is THREE.Vector3 => !!p);
      if (!pts.length) continue;
      const mid = pts.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / pts.length);
      if (cutaway) continue;
      const el2 = label(z.name, mid.add(new THREE.Vector3(0, 16, 0)), "zone");
      (el2.element as HTMLElement).style.borderColor = colour(z.tunnelIds[0]);
    }

    // Surface: translucent ground plane at datum 0 m with a grid.
    const surface = new THREE.Group();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(spanX, spanY), mat({ color: 0x8c7a5b, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
    disposables.push(ground.geometry);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(cx, 0, -cy);
    surface.add(ground);
    const bm = baseMapRef.current;
    // Fictional relief is a visual reference layer. The datum plane and all
    // surface markers retain their original coordinates.
    if (!cutaway && model.meta.fictional && !bm) {
      const terrain = new THREE.PlaneGeometry(spanX, spanY, 60, 42);
      terrain.rotateX(-Math.PI / 2);
      const vertices = terrain.attributes.position;
      const colors: number[] = [];
      const low = new THREE.Color(0x434d38), high = new THREE.Color(0x9a8365);
      for (let i = 0; i < vertices.count; i++) {
        const u = vertices.getX(i) / spanX, v = vertices.getZ(i) / spanY;
        const ridge = 0.52 + 0.24 * Math.sin(u * 13 + v * 7) * Math.cos(v * 10)
          + 0.14 * Math.sin(u * 24 - v * 14) + 0.07 * Math.cos(v * 35 + u * 12);
        vertices.setY(i, ridge * Math.min(spanX, spanY) * 0.055);
        const color = low.clone().lerp(high, ridge);
        colors.push(color.r, color.g, color.b);
      }
      terrain.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      terrain.computeVertexNormals();
      const relief = new THREE.Mesh(terrain, mat({ vertexColors: true, transparent: true, opacity: 0.3, depthWrite: false, roughness: 1 }));
      relief.position.set(cx, 0.2, -cy);
      surface.add(relief);
      disposables.push(terrain);
      ground.visible = false;
    }
    const grid = new THREE.GridHelper(Math.max(spanX, spanY), Math.round(Math.max(spanX, spanY) / 50), 0xc9b48a, 0x6d5f45);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    grid.position.set(cx, 0.05, -cy);
    surface.add(grid);
    // Base map: a picture laid on the surface plane at its real plan extent.
    if (bm) {
      const w = bm.east - bm.west, h = bm.north - bm.south;
      const bmMat = mat({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
      const bmPlane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), bmMat);
      disposables.push(bmPlane.geometry);
      bmPlane.rotation.x = -Math.PI / 2;
      // Placed in the map grid around the plan origin, then the whole picture is turned by the alignment rotation.
      bmPlane.position.set((bm.west + bm.east) / 2, 0.15, -(bm.south + bm.north) / 2);
      const pivot = new THREE.Group();
      pivot.rotation.y = -((bm.rotationDegrees ?? 0) * Math.PI) / 180;
      pivot.add(bmPlane);
      surface.add(pivot);
      new THREE.TextureLoader().load(bm.href, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        bmMat.map = tex;
        bmMat.needsUpdate = true;
        disposables.push(tex);
      });
    }
    // Subsidence marks: pins standing on the surface.
    for (const mk of marksRef.current) {
      const pin = new THREE.Mesh(new THREE.OctahedronGeometry(Math.max(2.5, spanX / 90), 0), mat({ color: mk.near ? 0xd92d20 : 0x7a8794, emissive: new THREE.Color(mk.near ? 0x701510 : 0x2a3138) }));
      disposables.push(pin.geometry);
      pin.position.set(mk.x, Math.max(2.5, spanX / 90) * 1.6, -mk.y);
      pin.userData.pick = { title: "Subsidence mark", rows: [["What was seen", mk.label], ["Near a zone", mk.near ? "Yes: raised a concern" : "No: recorded only"]] } satisfies Picked;
      surface.add(pin);
      pickable.push(pin);
    }
    world.add(surface);
    // Rock: faint box down to below the deepest working, with depth ticks.
    const rock = new THREE.Group();
    const rockDepth = (Math.abs(deepest) + 20) * ex;
    const rockBox = new THREE.Mesh(new THREE.BoxGeometry(spanX, rockDepth, spanY), mat({ color: 0x6b5236, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.BackSide }));
    disposables.push(rockBox.geometry);
    rockBox.position.set(cx, -rockDepth / 2, -cy);
    rock.add(rockBox);
    if (!cutaway && stone) {
      const strataTexture = stone.clone();
      strataTexture.repeat.set(5, 4);
      disposables.push(strataTexture);
      const thickness = rockDepth * 0.035;
      const geology = [0x413a33, 0x353637, 0x554739, 0x2d3032];
      geology.forEach((color, i) => {
        const geometry = new THREE.BoxGeometry(spanX, thickness, spanY);
        const layer = new THREE.Mesh(geometry, mat({ color, map: strataTexture, roughness: 1 }));
        layer.position.set(cx, -rockDepth - thickness * (i + 0.5), -cy);
        rock.add(layer);
        disposables.push(geometry);
      });
    }
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(rockBox.geometry), new THREE.LineBasicMaterial({ color: 0x8a6d47, transparent: true, opacity: 0.35 }));
    disposables.push(edges.geometry, edges.material as THREE.Material);
    edges.position.copy(rockBox.position);
    rock.add(edges);
    const step = Math.abs(deepest) > 300 ? 100 : Math.abs(deepest) > 100 ? 50 : 20;
    const tickLabels: CSS2DObject[] = [];
    for (let d = 0; d <= Math.abs(deepest) + 10; d += step) {
      const y = -d * ex;
      const tick = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(minX - pad, y, -(minY - pad)), new THREE.Vector3(minX - pad + 12, y, -(minY - pad))]),
        new THREE.LineBasicMaterial({ color: 0xc9b48a }),
      );
      disposables.push(tick.geometry, tick.material as THREE.Material);
      rock.add(tick);
      tickLabels.push(label(`${-d} m`, new THREE.Vector3(minX - pad - 10, y, -(minY - pad)), "tick"));
    }
    world.add(rock);
    scene.add(world);

    // Layer visibility.
    surface.visible = !cutaway && layers.surface;
    rock.visible = !cutaway && layers.rock;
    world.traverse((o) => {
      if (o.userData.label) o.visible = layers.labels && (!tickLabels.includes(o as CSS2DObject) || rock.visible);
    });

    // Scenario playback: people, closed tunnels and sump level.
    const people = new THREE.Group();
    world.add(people);
    const personGeo = new THREE.CapsuleGeometry(cutaway ? 0.24 : Math.max(1.4, Math.min(spanX, spanY) / 150), cutaway ? 1.2 : Math.max(2.4, Math.min(spanX, spanY) / 90), 4, 10);
    disposables.push(personGeo);
    const toneMat = {
      walking: mat({ color: 0xf5f8fb, emissive: new THREE.Color(0x6f8aa3) }),
      waiting: mat({ color: 0xf2a33a, emissive: new THREE.Color(0x7a4a0c) }),
      "cut-off": mat({ color: 0xff3b30, emissive: new THREE.Color(0x9a1208) }),
      safe: mat({ color: 0x3ccf7a, emissive: new THREE.Color(0x0f5a2c) }),
    };
    const segs = model.tunnels
      .map((t) => ({ t, a: byId.get(t.from), b: byId.get(t.to) }))
      .filter((x): x is { t: (typeof model.tunnels)[number]; a: (typeof model.junctions)[number]; b: (typeof model.junctions)[number] } => !!x.a && !!x.b);
    // Engines report plan positions; elevation comes from the nearest tunnel.
    const elevationAt = (x: number, y: number, floor = false) => {
      let best = Infinity, z = 0;
      for (const { t, a, b } of segs) {
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
        const k = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
        const d = Math.hypot(a.x + dx * k - x, a.y + dy * k - y);
        if (d < best) {
          best = d;
          z = (a.z ?? 0) + ((b.z ?? 0) - (a.z ?? 0)) * k;
          if (floor) z -= (t.height ?? 3) / 2;
        }
      }
      return z;
    };
    const personMeshes = new Map<string, { mesh: THREE.Mesh; tag: CSS2DObject }>();
    const groupDiv = document.createElement("div");
    groupDiv.className = "fs-3d-label person";
    const groupTag = new CSS2DObject(groupDiv);
    groupTag.visible = false;
    people.add(groupTag);
    const lift = cutaway ? 0.84 : Math.max(1, Math.min(spanX, spanY) / 110) * 1.6;
    applyRef.current = (pb) => {
      const closed = pb?.closed || highlight || new Set<string>();
      const flows = pb?.flows;
      const flowMax = flows ? Math.max(1e-9, ...Object.values(flows).map(Math.abs)) : 0;
      for (const [, set] of arrowSets) set.group.visible = false;
      for (const [id, { mesh, base, pa, pb: pend }] of tunnelMeshes) {
        const m = mesh.material as THREE.MeshStandardMaterial;
        if (flows) {
          const q = flows[id] ?? 0;
          const f = Math.min(1, Math.abs(q) / flowMax);
          const c = new THREE.Color(0x3a4a5a).lerp(new THREE.Color(0x39d0ff), Math.sqrt(f));
          m.color.copy(c);
          m.emissive.copy(c).multiplyScalar(0.35);
          if (Math.abs(q) > 1e-9) {
            let set = arrowSets.get(id);
            if (!set) {
              const group = new THREE.Group();
              const cone = new THREE.ConeGeometry(Math.max(1.4, spanX / 150), Math.max(4, spanX / 60), 8);
              disposables.push(cone);
              const cm = mat({ color: 0xffffff, emissive: new THREE.Color(0xbfefff) });
              for (let k = 0; k < 3; k++) group.add(new THREE.Mesh(cone, cm));
              world.add(group);
              set = { group, q, f };
              arrowSets.set(id, set);
            }
            set.q = q;
            set.f = f;
            set.group.visible = true;
            set.group.userData.ends = [pa, pend];
          }
          continue;
        }
        const blocked = closed.has(id);
        const c = blocked ? new THREE.Color(0xd92d20) : base;
        m.color.copy(c);
        m.emissive.copy(c).multiplyScalar(blocked ? 0.5 : 0.25);
        const route = focusLabels.get(id);
        if (route) route.tag.element.textContent = blocked ? `${route.name} · closed` : route.name;
      }
      for (const [id, { mesh, floor, depth, dangerLevel, initialLevel }] of sumpWater) {
        const sl = pb?.sumps?.[id];
        if (!sl && !cutaway) continue;
        const level = sl?.levelM ?? initialLevel;
        const threshold = sl?.dangerLevelM ?? dangerLevel;
        const danger = level !== null && threshold !== null && level >= threshold;
        const ratio = level !== null && threshold ? level / threshold : 0.4;
        const h = cutaway ? Math.min(depth, level ?? 0) : Math.max(0.3, Math.min(14, ratio * 8));
        mesh.visible = h > 0;
        mesh.scale.y = h / 4;
        mesh.position.y = floor + h / 2;
        const water = mesh.material as THREE.MeshStandardMaterial;
        water.color.set(cutaway ? 0x2586ad : danger ? 0xd9534f : 0x2f7fd0);
        water.emissive.set(cutaway && danger ? 0x2a605b : 0x0b2f55);
      }
      const list = pb?.cages ?? (pb?.cage ? [{ ...pb.cage, index: 0 }] : []);
      for (const [key, c] of cages) {
        const [id, idxText] = key.split("#");
        const idx = idxText === undefined ? 0 : Number(idxText);
        const col = shaftColumns.get(id);
        if (!col) continue;
        const state = list.find((x) => x.exitId === id && x.index === idx) || null;
        const count = list.filter((x) => x.exitId === id).length;
        c.mesh.visible = idx === 0 || Boolean(state);
        const side = new THREE.Vector3(idx * 5.5 - (Math.max(count, 1) - 1) * 2.75, 0, 0);
        c.mesh.position.lerpVectors(col.bottom, col.top, state ? state.fraction : 1).add(side);
        (c.mesh.material as THREE.MeshStandardMaterial).color.set(state?.failed ? 0xd92d20 : 0xa76a2b);
        c.tag.visible = Boolean(state) && layersRef.current.labels;
        (c.tag.element as HTMLElement).textContent = state ? `${count > 1 ? `Cage ${idx + 1}` : "Cage"} · ${state.aboard} aboard${state.failed ? " · hoist failed" : ""}` : "";
        c.tag.position.set(0, 7, 0);
      }
      const seen = new Set<string>();
      for (const p of pb?.people || []) {
        seen.add(p.id);
        let entry = personMeshes.get(p.id);
        if (!entry) {
          const mesh = new THREE.Mesh(personGeo, toneMat.walking);
          const div = document.createElement("div");
          div.className = "fs-3d-label person";
          const tag = new CSS2DObject(div);
          tag.userData.label = true;
          mesh.add(tag);
          people.add(mesh);
          entry = { mesh, tag };
          personMeshes.set(p.id, entry);
        }
        entry.mesh.material = toneMat[p.tone];
        entry.mesh.userData.tone = p.tone;
        const col = p.shaft ? shaftColumns.get(p.shaft.exitId) : undefined;
        if (col && p.shaft) {
          // In the shaft column, spread around the cage path so people do not overlap.
          const k = [...seen].length;
          const angle = k * 2.399963;
          const r = 6 + (k % 5) * 0.8;
          entry.mesh.position.lerpVectors(col.bottom, col.top, p.shaft.fraction).add(new THREE.Vector3(Math.cos(angle) * r, lift, Math.sin(angle) * r));
        } else entry.mesh.position.copy(P(p.x, p.y, elevationAt(p.x, p.y, cutaway))).add(new THREE.Vector3(0, lift, 0));
        // Name tags only for people cut off, and only while few enough to read;
        // otherwise one group tag is shown.
        const cutCount = (pb?.people || []).filter((q) => q.tone === "cut-off").length;
        const show = p.tone === "cut-off" && cutCount <= 2 && layersRef.current.labels;
        entry.tag.visible = show;
        (entry.tag.element as HTMLElement).textContent = show ? p.label || p.id : "";
        entry.tag.position.set(0, lift * 2.2, 0);
        entry.mesh.visible = true;
      }
      for (const [id, e] of personMeshes) if (!seen.has(id)) e.mesh.visible = false;
      const cut = (pb?.people || []).filter((q) => q.tone === "cut-off");
      if (cut.length > 2 && layersRef.current.labels) {
        const mid = cut
          .map((q) => P(q.x, q.y, elevationAt(q.x, q.y, cutaway)))
          .reduce((a, b) => a.add(b), new THREE.Vector3())
          .multiplyScalar(1 / cut.length);
        groupTag.position.copy(mid).add(new THREE.Vector3(0, lift * 4, 0));
        (groupTag.element as HTMLElement).textContent = `${cut.length} people cut off · names in results`;
        groupTag.visible = true;
      } else groupTag.visible = false;
      if (clockEl) clockEl.textContent = pb?.clock || "";
      clockEl?.classList.toggle("on", !!pb?.clock);
    };
    const clockEl = el.parentElement?.querySelector<HTMLElement>(".fs-3d-clock") || null;
    applyRef.current(playbackRef.current);

    // Camera and views.
    const box = new THREE.Box3();
    pickable.forEach((o) => box.expandByObject(o));
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() || 200;
    // The label layer sits on top of the canvas, so it receives the pointer.
    const orbit = new OrbitControls(camera, labelRenderer.domElement);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.08;
    orbit.maxDistance = radius * 4;
    const focusTunnel = model.tunnels
      .filter((t) => t.from === focusJunction?.id || t.to === focusJunction?.id)
      .map((t) => tunnelMeshes.get(t.id))
      .find((t) => t !== undefined) ?? tunnelMeshes.values().next().value;
    const focus = focusTunnel ? focusTunnel.pa.clone().lerp(focusTunnel.pb, 0.5)
      : focusJunction ? P(focusJunction.x, focusJunction.y, focusJunction.z) : center.clone();
    const side = new THREE.Vector3(1, 0, 0);
    if (focusTunnel) side.applyQuaternion(focusTunnel.mesh.quaternion).setY(0).normalize();
    const forward = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), side);
    if (cutaway && focusTunnel && stone) {
      // Illustrative section beneath the workings, kept below both the local
      // drive and the sump so the open view never hides the playback.
      const length = focusTunnel.pa.distanceTo(focusTunnel.pb);
      const span = THREE.MathUtils.clamp(length * 2, 50, 180);
      const sumpFloor = focusSump && sumpWater.get(focusSump.id)?.floor;
      const sectionTop = Math.min(focusTunnel.pa.y - 4, focusTunnel.pb.y - 4, sumpFloor ?? Infinity) - 1;
      const strataTexture = stone.clone();
      strataTexture.repeat.set(7, 3);
      disposables.push(strataTexture);
      const bed = new THREE.Group();
      bed.position.set(focus.x, sectionTop, focus.z);
      bed.rotation.y = Math.atan2(side.x, side.z);
      let belowTop = 0;
      for (const { thickness, color } of [
        { thickness: 2.2, color: 0x453d37 },
        { thickness: 3.6, color: 0x312e2d },
        { thickness: 1.4, color: 0x514239 },
        { thickness: 2.8, color: 0x282a2d },
      ]) {
        const geometry = new THREE.BoxGeometry(span, thickness, span * 0.75);
        const stratum = new THREE.Mesh(geometry, mat({ color, map: strataTexture, roughness: 1 }));
        stratum.position.y = -belowTop - thickness / 2;
        bed.add(stratum);
        disposables.push(geometry);
        belowTop += thickness;
      }
      bed.visible = layers.rock;
      world.add(bed);
    }
    const closePosition = () => {
      const length = focusTunnel ? focusTunnel.pa.distanceTo(focusTunnel.pb) : 0;
      const halfView = THREE.MathUtils.clamp(length * 0.65, 17, 60);
      const usableAspect = camera.aspect < 0.8 ? camera.aspect * 0.84 : Math.min(1, camera.aspect);
      const distance = halfView / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * usableAspect);
      return focus.clone().addScaledVector(side, distance * 0.78)
        .addScaledVector(forward, distance * 0.27).add(new THREE.Vector3(0, distance * 0.56, 0));
    };
    let tween: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;
    const go = (v: View, instant = false) => {
      const fitRadius = radius * Math.max(1, 1.15 / camera.aspect);
      const to =
        v === "cutaway" ? closePosition()
        : v === "top"
          ? center.clone().add(new THREE.Vector3(0, fitRadius * 1.2, 0.01))
          : v === "section"
            ? center.clone().add(new THREE.Vector3(0, 0, fitRadius * 1.1))
            : center.clone().add(new THREE.Vector3(fitRadius * 0.63, fitRadius * 0.47, fitRadius * 0.7));
      orbit.target.copy(v === "cutaway" ? focus : center);
      if (instant) {
        camera.position.copy(to);
        orbit.update();
      } else tween = { from: camera.position.clone(), to, t: 0 };
    };
    api.current.view = (v) => go(v);
    go(view, true);

    // Click to inspect.
    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down = { x: 0, y: 0 };
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const r = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(pointer, camera);
      const hit = ray.intersectObjects(pickable.filter((object) => object.visible), false)[0];
      setPicked(hit ? (hit.object.userData.pick as Picked) : null);
    };
    labelRenderer.domElement.addEventListener("pointerdown", onDown);
    labelRenderer.domElement.addEventListener("pointerup", onUp);

    const resize = () => {
      [width, height] = size();
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      labelRenderer.setSize(width, height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);

    const clock = new THREE.Clock();
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const dt = clock.getDelta(), time = clock.elapsedTime;
      if (tween) {
        tween.t = Math.min(1, tween.t + dt * 1.6);
        const k = 1 - Math.pow(1 - tween.t, 3);
        camera.position.lerpVectors(tween.from, tween.to, k);
        if (tween.t >= 1) tween = null;
      }
      orbit.autoRotate = spinRef.current && !tween;
      orbit.autoRotateSpeed = 0.8;
      for (const [, set] of arrowSets) {
        if (!set.group.visible) continue;
        const [a, b] = set.group.userData.ends as THREE.Vector3[];
        const dir = new THREE.Vector3().subVectors(set.q > 0 ? b : a, set.q > 0 ? a : b);
        const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
        set.group.children.forEach((child, k) => {
          const u = ((k / 3 + time * (0.15 + 0.6 * set.f)) % 1 + 1) % 1;
          child.position.copy(set.q > 0 ? a : b).addScaledVector(dir, u).add(new THREE.Vector3(0, 1.5, 0));
          child.quaternion.copy(quat);
        });
      }
      world.traverse((o) => {
        if (o.userData.spin) o.rotation.z += dt * 2.5;
        if (o.userData.tone === "cut-off") o.scale.setScalar(1 + Math.sin(time * 6) * 0.18);
      });
      lamp.position.copy(camera.position);
      orbit.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      labelRenderer.domElement.removeEventListener("pointerdown", onDown);
      labelRenderer.domElement.removeEventListener("pointerup", onUp);
      orbit.dispose();
      disposables.forEach((d) => d.dispose());
      (grid.geometry as THREE.BufferGeometry).dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labelRenderer.domElement.remove();
    };
    // view is applied through api.current.view without rebuilding the scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, countsKey, overlayKey, exaggerate, layers, cutaway]);

  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === frame.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const pick = (v: View) => {
    setView(v);
    if ((v === "cutaway") === cutaway) api.current.view(v);
  };
  if (error) return fallback ? <>{fallback}</> : <p role="status">{error}</p>;
  return (
    <div className={"fs-3d-frame" + (full ? " full" : "")} ref={frame}>
      <div className="fs-3d-toolbar" role="toolbar" aria-label="3D view controls">
        <div className="fs-seg" role="group" aria-label="Camera">
          {(
            [
              ["perspective", "3D"],
              ["top", "From above"],
              ["section", "Side section"],
              ["cutaway", "Underground cutaway"],
            ] as const
          ).map(([v, l]) => (
            <button key={v} aria-pressed={view === v} onClick={() => pick(v)}>
              {l}
            </button>
          ))}
        </div>
        <label className="fs-3d-select">
          Depth ×
          <select value={cutaway ? 1 : exaggerate} disabled={cutaway} onChange={(e) => setExaggerate(Number(e.target.value))} aria-label="Vertical exaggeration">
            {[1, 2, 3, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {(
          [
            ["surface", "Surface"],
            ["rock", cutaway ? "Rock section" : "Rock and depth"],
            ["labels", "Labels"],
          ] as const
        ).map(([k, l]) => (
          <label key={k} className="fs-3d-check">
            <input type="checkbox" checked={cutaway && k === "surface" ? false : layers[k]} disabled={cutaway && k === "surface"} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} /> {l}
          </label>
        ))}
        <label className="fs-3d-check">
          <input type="checkbox" checked={spin} onChange={(e) => setSpin(e.target.checked)} /> Rotate
        </label>
        <button className="fs-3d-icon" onClick={() => pick(view)} aria-label="Reset view" title="Reset view">
          <RotateCcw size={16} />
        </button>
        <button
          className="fs-3d-icon"
          aria-label={full ? "Exit full screen" : "Full screen"}
          title={full ? "Exit full screen" : "Full screen"}
          onClick={() => (document.fullscreenElement ? void document.exitFullscreen() : void frame.current?.requestFullscreen?.())}
        >
          {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
      <div className="fs-3d-stage">
      <div
        ref={host}
        className="fs-3d"
        role="img"
        aria-label={ariaLabel || `3D schematic of ${model.tunnels.length} tunnels with ${model.exits.length} exits. Drag to orbit, scroll to zoom, click an item for details. The table tab lists the same values.`}
      />
      <div className="fs-3d-clock" aria-hidden="true" />
      {picked && (
        <aside className="fs-3d-info" aria-live="polite">
          <button aria-label="Close details" onClick={() => setPicked(null)}>
            ×
          </button>
          <strong>{picked.title}</strong>
          <dl>
            {picked.rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </aside>
      )}
      </div>
      <p className="fs-help">
        Drag to orbit, right-drag to pan, scroll to zoom. Click a feature for its entered values.{" "}
        {cutaway
          ? "Cutaway uses entered tunnel sizes and elevations at ×1 depth. Rock and equipment are illustrative. Faded tunnels have no entered size."
          : `Depth is exaggerated ×${exaggerate} and tunnel cross-sections are enlarged. ${model.meta.fictional && !baseMap ? "Surface relief, rock layers, and fixtures are illustrative." : "The surface reference is the datum plane at 0 m. Rock layers and fixtures are illustrative."} Faded tunnels have no entered size.`}
      </p>
    </div>
  );
}
