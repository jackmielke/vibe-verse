/**
 * vibeyNpc — Vibey lives in Vibe City now.
 *
 * The same hovering robot from the village map (public/models/vibey.glb,
 * ~450KB) drifts in a lazy orbit around the spawn plaza with a bob and
 * a slow yaw, plus a soft glow ring so you can spot them after dark.
 * Walk up close and the City UI offers "Talk to Vibey" — the actual
 * conversation goes through the unit7-chat edge function.
 *
 * `excite()` gives a little hop+spin burst when Vibey replies.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export interface VibeyNpc {
  group: THREE.Group;
  update(dt: number, now: number): void;
  /** World position, for the "close enough to talk" check. */
  position: THREE.Vector3;
  /** Celebration burst when a reply lands. */
  excite(): void;
}

const ORBIT_RADIUS = 14;
const ORBIT_SPEED = 0.05; // rad/s — ~0.7 m/s drift, easy to walk up to
const HOVER_BASE = 2.2;

export function createVibeyNpc(): VibeyNpc {
  const group = new THREE.Group();
  let excitement = 0;

  // Glow ring under Vibey so the meet-spot reads at night.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.0, 1.45, 32),
    new THREE.MeshBasicMaterial({
      color: "#2dd4a8",
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);

  const holder = new THREE.Group();
  group.add(holder);

  const loader = new GLTFLoader();
  loader.load("/models/vibey.glb", (gltf) => {
    const model = gltf.scene;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const fit = 2.0 / Math.max(size.x, size.y, size.z, 0.0001);
    model.scale.setScalar(fit);
    model.updateMatrixWorld(true);
    const scaled = new THREE.Box3().setFromObject(model);
    model.position.y = -scaled.min.y;
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const std = mesh.material as THREE.MeshStandardMaterial;
      if (std && "metalness" in std) {
        std.metalness = Math.min(std.metalness, 0.4);
        std.roughness = Math.max(std.roughness, 0.4);
      }
    });
    holder.add(model);
  });

  return {
    group,
    position: group.position,
    update(dt, now) {
      // Lazy plaza orbit, offset from the spawn point so Vibey greets
      // arrivals instead of hovering on top of them.
      const a = now * 0.001 * ORBIT_SPEED;
      group.position.set(Math.cos(a) * ORBIT_RADIUS, 0, Math.sin(a) * ORBIT_RADIUS - 4);
      excitement = Math.max(0, excitement - dt * 1.4);
      holder.position.y =
        HOVER_BASE + Math.sin(now * 0.0017) * 0.35 + excitement * 1.2;
      holder.rotation.y = now * 0.0004 + excitement * Math.sin(now * 0.02) * 0.5;
      (ring.material as THREE.MeshBasicMaterial).opacity =
        0.4 + Math.sin(now * 0.003) * 0.2 + excitement * 0.3;
    },
    excite() {
      excitement = 1;
    },
  };
}
