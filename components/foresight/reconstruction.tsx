"use client";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ErrorText, type Row } from "./shared";
export default function Reconstruction({ asset }: { asset: Row }) {
  const host = useRef<HTMLDivElement>(null),
    controls = useRef<OrbitControls | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let alive = true,
      frame = 0,
      renderer: THREE.WebGLRenderer;
    setError("");
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setError(
        "3D rendering unavailable. Evidence and 2D layout remain usable.",
      );
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, 420);
    renderer.setClearColor("#e8eef0");
    container.appendChild(renderer.domElement);
    renderer.domElement.setAttribute(
      "aria-label",
      "Captured area walkthrough; use the labelled rotation and zoom buttons below.",
    );
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(
        50,
        container.clientWidth / 420,
        0.01,
        100000,
      );
    scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 3));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(5, 10, 5);
    scene.add(light);
    const orbit = new OrbitControls(camera, renderer.domElement);
    controls.current = orbit;
    orbit.enableDamping = false;
    const abort = new AbortController();
    fetch("/api/workspace/assets/" + asset.id, { signal: abort.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error("Asset unavailable.");
        const buffer = await r.arrayBuffer();
        new GLTFLoader().parse(
          buffer,
          "",
          (gltf) => {
            if (!alive) return;
            const object = gltf.scene;
            object.scale.setScalar(asset.data.metresPerUnit || 1);
            object.position.fromArray(asset.data.translation || [0, 0, 0]);
            object.rotation.fromArray([
              ...(asset.data.rotationRadians || [0, 0, 0]),
              "XYZ",
            ] as [number, number, number, THREE.EulerOrder]);
            scene.add(object);
            const box = new THREE.Box3().setFromObject(object),
              center = box.getCenter(new THREE.Vector3()),
              size = box.getSize(new THREE.Vector3()).length() || 10;
            camera.position
              .copy(center)
              .add(new THREE.Vector3(size, size * 0.6, size));
            camera.near = size / 1000;
            camera.far = size * 100;
            camera.updateProjectionMatrix();
            orbit.target.copy(center);
            orbit.update();
          },
          () => {
            if (alive) setError("The imported mesh could not be decoded.");
          },
        );
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    const render = () => {
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    render();
    const resize = new ResizeObserver(() => {
      renderer.setSize(container.clientWidth, 420);
      camera.aspect = container.clientWidth / 420;
      camera.updateProjectionMatrix();
    });
    resize.observe(container);
    return () => {
      alive = false;
      abort.abort();
      cancelAnimationFrame(frame);
      resize.disconnect();
      orbit.dispose();
      controls.current = null;
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const materials = Array.isArray(obj.material)
            ? obj.material
            : [obj.material];
          materials.forEach((m) => {
            for (const value of Object.values(m))
              if (value instanceof THREE.Texture) value.dispose();
            m.dispose();
          });
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [asset.id]);
  function rotate(direction: number) {
    const c = controls.current;
    if (!c) return;
    const offset = c.object.position.clone().sub(c.target);
    offset.applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      (direction * Math.PI) / 8,
    );
    c.object.position.copy(c.target).add(offset);
    c.update();
  }
  function zoom(scale: number) {
    const c = controls.current;
    if (!c) return;
    c.object.position.sub(c.target).multiplyScalar(scale).add(c.target);
    c.update();
  }
  return (
    <>
      <ErrorText message={error} />
      <div ref={host} className="fs-reconstruction" />
      <div
        className="fs-button-row"
        aria-label="Keyboard alternatives to dragging"
      >
        <button className="fs-button secondary" onClick={() => rotate(-1)}>
          Rotate left
        </button>
        <button className="fs-button secondary" onClick={() => rotate(1)}>
          Rotate right
        </button>
        <button className="fs-button secondary" onClick={() => zoom(0.8)}>
          Zoom in
        </button>
        <button className="fs-button secondary" onClick={() => zoom(1.25)}>
          Zoom out
        </button>
      </div>
    </>
  );
}
