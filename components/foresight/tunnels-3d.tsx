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

type View = "perspective" | "top" | "section";
type Picked = { title: string; rows: [string, string][] } | null;

export default function Tunnels3D({
  model,
  colour,
  highlight,
  counts = {},
}: {
  model: MineModel;
  colour: (tunnelId: string) => string;
  highlight?: Set<string>;
  counts?: Record<string, number>;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<{ view: (v: View) => void }>({ view: () => {} });
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("perspective");
  const [exaggerate, setExaggerate] = useState(3);
  const [layers, setLayers] = useState({ surface: true, labels: true, rock: true });
  const [spin, setSpin] = useState(false);
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
    scene.background = new THREE.Color(0x0d1b27);
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.5, 50000);
    scene.add(new THREE.HemisphereLight(0xdfe9f3, 0x2a1d12, 1.6));
    const sun = new THREE.DirectionalLight(0xfff3e0, 2.2);
    sun.position.set(300, 600, 200);
    scene.add(sun);
    const lamp = new THREE.PointLight(0xffc27a, 1.2, 0, 0);
    scene.add(lamp);

    const ex = exaggerate;
    const byId = new Map(model.junctions.map((j) => [j.id, j]));
    // Plan x → three x, plan y → three -z, elevation (× exaggeration) → three y.
    const P = (x: number, y: number, z: number | null) => new THREE.Vector3(x, (z ?? 0) * ex, -y);
    const world = new THREE.Group();
    const pickable: THREE.Object3D[] = [];
    const disposables: { dispose: () => void }[] = [];
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

    // Tunnels: arched or box cross-section extruded along the centreline.
    const section = (w: number, h: number, arched: boolean) => {
      const s = new THREE.Shape();
      s.moveTo(-w / 2, 0);
      s.lineTo(w / 2, 0);
      if (arched) {
        const wall = Math.max(0.1, h - w / 2);
        s.lineTo(w / 2, wall);
        s.absarc(0, wall, w / 2, 0, Math.PI, false);
      } else {
        s.lineTo(w / 2, h);
        s.lineTo(-w / 2, h);
      }
      s.lineTo(-w / 2, 0);
      return s;
    };
    for (const t of model.tunnels) {
      const a = byId.get(t.from), b = byId.get(t.to);
      if (!a || !b) continue;
      const pa = P(a.x, a.y, a.z), pb = P(b.x, b.y, b.z);
      const length = pa.distanceTo(pb);
      if (!(length > 0)) continue;
      const known = t.width !== null && t.height !== null;
      // Cross-sections are scaled up so a few-metre drive stays visible on a
      // mine-scale view; the scale note in the legend says so.
      const vis = Math.max(1, Math.min(spanX, spanY) / 110);
      const w = (t.width ?? 3) * vis, h = (t.height ?? 3) * vis;
      const geometry = new THREE.ExtrudeGeometry(section(w, h, t.profile === "arched"), { depth: length, bevelEnabled: false, curveSegments: 10 });
      geometry.translate(0, -h / 2, 0);
      disposables.push(geometry);
      const flooded = highlight?.has(t.id);
      const base = new THREE.Color(flooded ? 0xd92d20 : colour(t.id));
      const mesh = new THREE.Mesh(
        geometry,
        mat({ color: base, emissive: base.clone().multiplyScalar(0.25), roughness: 0.55, metalness: 0.05, transparent: !known, opacity: known ? 1 : 0.35 }),
      );
      mesh.position.copy(pa);
      mesh.lookAt(pb);
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
    }
    // Junction nodes.
    const nodeGeo = new THREE.SphereGeometry(Math.max(1.2, Math.min(spanX, spanY) / 160), 16, 12);
    disposables.push(nodeGeo);
    const nodeMat = mat({ color: 0xe8edf2, roughness: 0.4 });
    for (const j of model.junctions) {
      const m = new THREE.Mesh(nodeGeo, nodeMat);
      m.position.copy(P(j.x, j.y, j.z));
      m.userData.pick = { title: `${j.id}${j.name ? " · " + j.name : ""}`, rows: [["Position", `x ${j.x} m, y ${j.y} m`], ["Elevation", j.z === null ? "Not entered" : `${j.z} m`]] } satisfies Picked;
      world.add(m);
      pickable.push(m);
      const featured = model.exits.some((e) => e.junction === j.id) || model.refuges.some((r) => r.junction === j.id) || model.sumps.some((x) => x.junction === j.id);
      if (j.name && !featured) label(j.name, m.position.clone().add(new THREE.Vector3(0, 6, 0)), "minor");
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
        const steel = mat({ color: 0x2d3e4e, metalness: 0.6, roughness: 0.35 });
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
      const pit = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 10, 28, 1, true), mat({ color: 0x5b6b78, side: THREE.DoubleSide, transparent: true, opacity: 0.6 }));
      disposables.push(pit.geometry);
      pit.position.copy(at).add(new THREE.Vector3(0, -7, 0));
      world.add(pit);
      const water = new THREE.Mesh(new THREE.CylinderGeometry(8.6, 8.6, 4, 28), mat({ color: 0x2f7fd0, emissive: new THREE.Color(0x0b2f55), transparent: true, opacity: 0.8 }));
      disposables.push(water.geometry);
      water.position.copy(at).add(new THREE.Vector3(0, -10, 0));
      water.userData.water = true;
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
      label(`${s.name}${pumps.length ? " · " + pumps.map((p) => p.id).join(", ") : ""}`, at.clone().add(new THREE.Vector3(0, -22, 0)), "water");
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
    const grid = new THREE.GridHelper(Math.max(spanX, spanY), Math.round(Math.max(spanX, spanY) / 50), 0xc9b48a, 0x6d5f45);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    grid.position.set(cx, 0.05, -cy);
    surface.add(grid);
    world.add(surface);
    // Rock: faint box down to below the deepest working, with depth ticks.
    const rock = new THREE.Group();
    const rockDepth = (Math.abs(deepest) + 20) * ex;
    const rockBox = new THREE.Mesh(new THREE.BoxGeometry(spanX, rockDepth, spanY), mat({ color: 0x6b5236, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.BackSide }));
    disposables.push(rockBox.geometry);
    rockBox.position.set(cx, -rockDepth / 2, -cy);
    rock.add(rockBox);
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
    surface.visible = layers.surface;
    rock.visible = layers.rock;
    world.traverse((o) => {
      if (o.userData.label) o.visible = layers.labels && (!tickLabels.includes(o as CSS2DObject) || layers.rock);
    });

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
    let tween: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;
    const go = (v: View, instant = false) => {
      const to =
        v === "top"
          ? center.clone().add(new THREE.Vector3(0, radius * 1.2, 0.01))
          : v === "section"
            ? center.clone().add(new THREE.Vector3(0, 0, radius * 1.1))
            : center.clone().add(new THREE.Vector3(radius * 0.55, radius * 0.5, radius * 0.8));
      orbit.target.copy(center);
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
      const hit = ray.intersectObjects(pickable, false)[0];
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
      world.traverse((o) => {
        if (o.userData.spin) o.rotation.z += dt * 2.5;
        if (o.userData.water) (o as THREE.Mesh).scale.y = 1 + Math.sin(time * 1.4) * 0.04;
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
  }, [model, highlight, countsKey, exaggerate, layers]);

  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === frame.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const pick = (v: View) => {
    setView(v);
    api.current.view(v);
  };
  if (error) return <p role="status">{error}</p>;
  return (
    <div className={"fs-3d-frame" + (full ? " full" : "")} ref={frame}>
      <div className="fs-3d-toolbar" role="toolbar" aria-label="3D view controls">
        <div className="fs-seg" role="group" aria-label="Camera">
          {(
            [
              ["perspective", "3D"],
              ["top", "From above"],
              ["section", "Side section"],
            ] as const
          ).map(([v, l]) => (
            <button key={v} aria-pressed={view === v} onClick={() => pick(v)}>
              {l}
            </button>
          ))}
        </div>
        <label className="fs-3d-select">
          Depth ×
          <select value={exaggerate} onChange={(e) => setExaggerate(Number(e.target.value))} aria-label="Vertical exaggeration">
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
            ["rock", "Rock and depth"],
            ["labels", "Labels"],
          ] as const
        ).map(([k, l]) => (
          <label key={k} className="fs-3d-check">
            <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} /> {l}
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
      <div
        ref={host}
        className="fs-3d"
        role="img"
        aria-label={`3D schematic of ${model.tunnels.length} tunnels with ${model.exits.length} exits. Drag to orbit, scroll to zoom, click an item for details. The table tab lists the same values.`}
      />
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
      <p className="fs-help">
        Drag to orbit, right-drag to pan, scroll to zoom, click a tunnel or feature for its entered values. Depth is
        exaggerated ×{exaggerate} and tunnel cross-sections are enlarged so they stay visible; the surface is a flat
        reference plane at 0 m (not surveyed terrain). Faded tunnels have no entered size.
      </p>
    </div>
  );
}
