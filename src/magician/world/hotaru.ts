/**
 * Hotaru: fireflies over the river.
 *
 * In early summer Japanese rivers are known for them: a cloud of green-gold
 * lights hanging low over the water, each blinking in its own slow pulse.
 * The valley's own fireflies follow the player; these stay over the river by
 * the bridge, which is where anybody would go to see them.
 */
import * as THREE from "three";
import { riverCentre } from "./noise";

export interface Hotaru {
  points: THREE.Points;
  /** 0 hides them, 1 is the full swarm. */
  setLevel(v: number): void;
  update(dt: number, time: number, waterY: number): void;
  dispose(): void;
}

export function createHotaru(centreZ: number, count = 150): Hotaru {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const flies = Array.from({ length: count }, () => {
    const z = centreZ + (Math.random() - 0.5) * (Math.random() < 0.6 ? 20 : 50);
    return {
      z,
      side: (Math.random() - 0.5) * 11,
      h: 0.25 + Math.random() * 2.2,
      phase: Math.random() * 20,
      rate: 0.5 + Math.random() * 0.9,
      wx: Math.random() * 6, wz: Math.random() * 6,
    };
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const cv = document.createElement("canvas");
  cv.width = 32; cv.height = 32;
  const g = cv.getContext("2d")!;
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(0.3, "rgba(255,255,255,0.5)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(cv);
  const mat = new THREE.PointsMaterial({ size: 0.5, map: tex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.name = "hotaru";
  let level = 0;
  const glow = new THREE.Color("#c8ff6a");

  return {
    points,
    setLevel(v) { level = v; points.visible = v > 0.01; },
    update(dt, time, waterY) {
      if (!points.visible) return;
      for (let i = 0; i < count; i++) {
        const f = flies[i];
        f.wx += dt * 0.35; f.wz += dt * 0.28;
        const z = f.z + Math.sin(f.wz + i) * 1.5;
        const x = riverCentre(z) + f.side + Math.sin(f.wx * 1.3 + i * 0.7) * 1.2;
        const y = waterY + f.h + Math.sin(time * 0.6 + f.phase) * 0.25;
        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
        // A slow swell and a quick fade, like the real ones: bright a moment, then dark.
        const p = (time * f.rate + f.phase) % 2.6;
        const b = (p < 1.4 ? Math.pow(Math.sin((p / 1.4) * Math.PI), 0.7) : 0.06) * level;
        col[i * 3] = glow.r * b; col[i * 3 + 1] = glow.g * b; col[i * 3 + 2] = glow.b * b;
      }
      (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    },
    dispose() { geo.dispose(); mat.dispose(); tex.dispose(); },
  };
}
