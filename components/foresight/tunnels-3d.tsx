"use client";
// Procedural 3D schematic (spec §8.5): each tunnel is a box extruded along its
// centreline from entered width, height and junction elevations. It is a
// schematic of entered values, not a reconstruction.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { MineModel } from "@/lib/domain/mine-model";

export default function Tunnels3D({ model, colour, highlight }: { model: MineModel; colour: (tunnelId: string) => string; highlight?: Set<string> }) {
  const host = useRef<HTMLDivElement>(null);
  const reset = useRef<() => void>(() => {});
  const [error, setError] = useState("");
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setError("3D view unavailable on this device (WebGL). The plan view and table show the same model.");
      return;
    }
    const width = el.clientWidth || 600, height = 420;
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4f7f8);
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.5, 20000);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 2.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(200, 400, 100);
    scene.add(sun);
    const group = new THREE.Group();
    const byId = new Map(model.junctions.map((j) => [j.id, j]));
    // Plan x → three x, plan y → three -z, elevation → three y.
    for (const t of model.tunnels) {
      const a = byId.get(t.from), b = byId.get(t.to);
      if (!a || !b) continue;
      const pa = new THREE.Vector3(a.x, a.z ?? 0, -a.y), pb = new THREE.Vector3(b.x, b.z ?? 0, -b.y);
      const length = pa.distanceTo(pb);
      if (!(length > 0)) continue;
      const w = t.width ?? 1, h = t.height ?? 1;
      const geometry = new THREE.BoxGeometry(w, h, length);
      const material = new THREE.MeshStandardMaterial({
        color: highlight?.has(t.id) ? 0xb42318 : new THREE.Color(colour(t.id)),
        transparent: t.width === null || t.height === null,
        opacity: t.width === null || t.height === null ? 0.35 : 1,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(pa.clone().add(pb).multiplyScalar(0.5));
      mesh.lookAt(pb);
      group.add(mesh);
    }
    for (const e of model.exits) {
      const j = byId.get(e.junction);
      if (!j) continue;
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, e.kind === "shaft" ? 60 : 6, 12), new THREE.MeshStandardMaterial({ color: 0x142a3c }));
      mesh.position.set(j.x, (j.z ?? 0) + (e.kind === "shaft" ? 30 : 3), -j.y);
      group.add(mesh);
    }
    scene.add(group);
    const box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length() || 100;
    const orbit = new OrbitControls(camera, renderer.domElement);
    reset.current = () => {
      camera.position.copy(center).add(new THREE.Vector3(size * 0.5, size * 0.55, size * 0.7));
      orbit.target.copy(center);
      orbit.update();
    };
    reset.current();
    let frame = 0;
    const loop = () => {
      frame = requestAnimationFrame(loop);
      orbit.update();
      renderer.render(scene, camera);
    };
    loop();
    return () => {
      cancelAnimationFrame(frame);
      orbit.dispose();
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [model, colour, highlight]);
  return (
    <div>
      {error ? (
        <p role="status">{error}</p>
      ) : (
        <>
          <div ref={host} className="fs-3d" role="img" aria-label={`3D schematic of ${model.tunnels.length} tunnels. Drag to orbit, scroll to zoom. The table tab lists the same values.`} />
          <button className="fs-button secondary" onClick={() => reset.current()}>
            Reset view
          </button>
          <p className="fs-help">Faded tunnels have no entered width or height; their size is not known.</p>
        </>
      )}
    </div>
  );
}
