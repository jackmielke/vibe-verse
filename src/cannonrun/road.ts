/**
 * The highway, as maths. `s` is metres along it, `lat` metres right of the
 * centre line (right of the direction of travel), `y` height. The road runs
 * toward -z; a model built facing +z needs only `rotation.y = heading(s)`.
 */
import * as THREE from "three";

/* ---------------------------------------------------------------- the road */

export const HALF = 7.4; // asphalt half width
export const LANE = 3.6;
export const LAT_MAX = 5.4;
export const G = 9.8;
export const MUZZLE = 46;
export const RELOAD = 0.85;

export const roadX = (s: number): number =>
  38 * Math.sin(s / 310) + 14 * Math.sin(s / 113 + 1.3) + 5 * Math.sin(s / 47 + 0.4);
export const roadDX = (s: number): number =>
  (38 / 310) * Math.cos(s / 310) + (14 / 113) * Math.cos(s / 113 + 1.3) + (5 / 47) * Math.cos(s / 47 + 0.4);
export const heading = (s: number): number => Math.atan2(roadDX(s), -1);

export const V = new THREE.Vector3();
export function toWorld(s: number, lat: number, y: number, out: THREE.Vector3 = V): THREE.Vector3 {
  const d = roadDX(s);
  const inv = 1 / Math.hypot(d, 1);
  // tangent (d, -1)*inv, right of it (1, d)*inv
  return out.set(roadX(s) + lat * inv, y, -s + lat * d * inv);
}
/** World (x, z) back to road (s, lat). Two Newton steps is plenty on these curves. */
export function toRoad(x: number, z: number): { s: number; lat: number } {
  let s = -z;
  let lat = 0;
  for (let k = 0; k < 3; k++) {
    const d = roadDX(s);
    const inv = 1 / Math.hypot(d, 1);
    const px = x - roadX(s);
    const pz = z + s;
    const along = (px * d - pz) * inv;
    lat = (px + pz * d) * inv;
    s += along;
  }
  return { s, lat };
}

export const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const hash = (n: number): number => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

