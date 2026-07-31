/**
 * Vibe Kart — scenery toolkit.
 *
 * Trackside dressing is a *lot* of small objects, and the only way that ships
 * at 60 fps is to never let "one prop" mean "one draw call". Two ideas run
 * through the whole directory and they both live here:
 *
 *  1. **Merge, then instance.** A grandstand bay, a tree canopy, a marshal hut
 *     — each is authored as a pile of primitives, baked into one indexed
 *     geometry with vertex colours carrying the paint job, and then drawn as an
 *     `InstancedMesh` across the whole circuit. Colour variety costs nothing
 *     because it lives in the vertices and in `instanceColor`, not in extra
 *     materials.
 *
 *  2. **No per-instance attributes.** Everything a shader needs to decorrelate
 *     one instance from the next (wind phase, crowd shirt, which sponsor logo)
 *     is hashed from `instanceMatrix[3].xyz` in the vertex shader. That is what
 *     lets a single shared geometry back a dozen sectorised `InstancedMesh`es
 *     for culling — custom attributes live on the *geometry*, and would have
 *     forced a geometry clone per sector.
 *
 * Everything allocated here is registered with a `Resources` pool, because the
 * engine tears the world down by calling `dispose()` and anything we forget is
 * a leaked GPU buffer on every soft restart.
 */
import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Maths
// ---------------------------------------------------------------------------

export type Rng = () => number;

/**
 * xorshift32 off a string or numeric seed. Named streams matter: every builder
 * takes its own so adding a tree species cannot reshuffle the crowd.
 */
export function makeRng(seed: string | number): Rng {
  let s: number;
  if (typeof seed === "number") {
    s = seed >>> 0;
  } else {
    s = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
      s ^= seed.charCodeAt(i);
      s = Math.imul(s, 0x01000193) >>> 0;
    }
  }
  if (s === 0) s = 0x2f6e2b1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

export function rand(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

export function pick<T>(rng: Rng, list: readonly T[]): T {
  return list[Math.min(list.length - 1, (rng() * list.length) | 0)];
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Cheap deterministic 2D value hash — used for terrain and scatter jitter. */
export function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Two octaves of smooth value noise. Enough shape for hills seen through fog. */
export function fbm2(x: number, y: number): number {
  let sum = 0;
  let amp = 0.5;
  let fx = x;
  let fy = y;
  for (let o = 0; o < 3; o++) {
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const ux = tx * tx * (3 - 2 * tx);
    const uy = ty * ty * (3 - 2 * ty);
    const a = hash2(ix, iy);
    const b = hash2(ix + 1, iy);
    const c = hash2(ix, iy + 1);
    const d = hash2(ix + 1, iy + 1);
    sum += amp * (lerp(lerp(a, b, ux), lerp(c, d, ux), uy) * 2 - 1);
    amp *= 0.5;
    fx *= 2.03;
    fy *= 1.97;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Resource ownership
// ---------------------------------------------------------------------------

/**
 * Everything this module allocates on the GPU. `dispose()` is not optional —
 * the engine removes our root from the scene before its own graph sweep runs,
 * so if it is not in here it never gets freed.
 */
export class Resources {
  private geometries = new Set<THREE.BufferGeometry>();
  private materials = new Set<THREE.Material>();
  private textures = new Set<THREE.Texture>();

  geo<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.add(g);
    return g;
  }

  mat<T extends THREE.Material>(m: T): T {
    this.materials.add(m);
    return m;
  }

  tex<T extends THREE.Texture>(t: T): T {
    this.textures.add(t);
    return t;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.textures.clear();
  }
}

// ---------------------------------------------------------------------------
// Geometry kit
// ---------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);
const M4 = new THREE.Matrix4();
const EUL = new THREE.Euler();
const QUAT = new THREE.Quaternion();
const VEC = new THREE.Vector3();
const SCL = new THREE.Vector3();

/**
 * Place a primitive. Rotation order is YXZ — yaw, then pitch, then roll — which
 * is the order a person says it in ("turn it round, then tip it over").
 */
export function at(
  geo: THREE.BufferGeometry,
  x = 0,
  y = 0,
  z = 0,
  yaw = 0,
  pitch = 0,
  roll = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): THREE.BufferGeometry {
  EUL.set(pitch, yaw, roll, "YXZ");
  QUAT.setFromEuler(EUL);
  VEC.set(x, y, z);
  SCL.set(sx, sy, sz);
  geo.applyMatrix4(M4.compose(VEC, QUAT, SCL));
  return geo;
}

/**
 * Map a unit-length primitive onto the segment A→B with a given cross-section.
 * Written out because the obvious `compose` + `premultiply(rotation)` spelling
 * rotates *inside* the scale and shears every diagonal brace into a
 * parallelogram — which looks plausible right up until you notice the gantry.
 */
export function strut(
  geo: THREE.BufferGeometry,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  w: number,
  d = w,
): THREE.BufferGeometry {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz) || 1e-5;
  // Unit-Y primitives (boxes and cylinders alike) rotate onto the segment.
  QUAT.setFromUnitVectors(UP, VEC.set(dx / len, dy / len, dz / len));
  SCL.set(w, len, d);
  VEC.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
  geo.applyMatrix4(M4.compose(VEC, QUAT, SCL));
  return geo;
}

export function gBox(w = 1, h = 1, d = 1): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

export function gCyl(rTop: number, rBot: number, h: number, seg = 8, open = false): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
}

export function gCone(r: number, h: number, seg = 8): THREE.BufferGeometry {
  return new THREE.ConeGeometry(r, h, seg);
}

export function gSphere(r: number, w = 8, h = 6): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, w, h);
}

export function gIco(r: number, detail = 0): THREE.BufferGeometry {
  // Polyhedra come out of three non-indexed, and `mergeGeometries` refuses to
  // mix indexed and non-indexed sources. Welding is not an optimisation here,
  // it is the price of admission — and it halves the crowd's vertex count.
  const g = new THREE.IcosahedronGeometry(r, detail);
  const welded = mergeVertices(g, 1e-5);
  if (welded !== g) g.dispose();
  return welded;
}

export function gPlane(w: number, h: number, ws = 1, hs = 1): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(w, h, ws, hs);
}

export function gTorus(r: number, tube: number, rad = 6, tub = 10): THREE.BufferGeometry {
  return new THREE.TorusGeometry(r, tube, rad, tub);
}

export interface Part {
  geo: THREE.BufferGeometry;
  /** Vertex colour painted onto this part before the merge. */
  color?: number;
}

const COL = new THREE.Color();

/** Paint a geometry's vertices, creating the attribute if it is missing. */
export function paint(geo: THREE.BufferGeometry, color: number, jitter = 0): THREE.BufferGeometry {
  const n = geo.getAttribute("position").count;
  let attr = geo.getAttribute("color") as THREE.BufferAttribute | undefined;
  if (!attr || attr.count !== n) {
    attr = new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3);
    geo.setAttribute("color", attr);
  }
  COL.setHex(color, THREE.SRGBColorSpace);
  const arr = attr.array as Float32Array;
  for (let i = 0; i < n; i++) {
    // A whisper of per-vertex value jitter keeps big flat panels from reading
    // as a solid fill of one hex code, which is the tell of programmer art.
    const j = jitter === 0 ? 1 : 1 + (hash2(i * 0.731, i * 1.117) - 0.5) * jitter;
    arr[i * 3] = COL.r * j;
    arr[i * 3 + 1] = COL.g * j;
    arr[i * 3 + 2] = COL.b * j;
  }
  attr.needsUpdate = true;
  return geo;
}

/**
 * Fill a constant vector attribute across a whole geometry.
 *
 * Merging demands that every source carries the same attribute set, so the
 * parts of a figure that are *not* an arm still need `aArm` — they just carry
 * zeroes. This is how the spectator's shader knows an elbow from a knee.
 */
export function setConst(geo: THREE.BufferGeometry, name: string, values: number[]): THREE.BufferGeometry {
  const n = geo.getAttribute("position").count;
  const k = values.length;
  const arr = new Float32Array(n * k);
  for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) arr[i * k + c] = values[c];
  geo.setAttribute(name, new THREE.Float32BufferAttribute(arr, k));
  return geo;
}

/**
 * Bake a pile of parts into one indexed geometry. Sources are disposed — they
 * are scaffolding, and leaving them alive is how a build leaks 400 buffers.
 */
export function merge(parts: Part[]): THREE.BufferGeometry {
  const prepped: THREE.BufferGeometry[] = [];
  for (const p of parts) {
    // Everything merged in this directory is indexed. A stray non-indexed
    // source silently fails the merge rather than erroring, so weld it here.
    const g = p.geo.index ? p.geo : mergeVertices(p.geo, 1e-5);
    paint(g, p.color ?? 0xffffff, 0.05);
    if (!g.getAttribute("uv")) {
      const n = g.getAttribute("position").count;
      g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
    }
    prepped.push(g);
  }
  const merged = prepped.length === 1 ? prepped[0] : mergeGeometries(prepped, false);
  if (!merged) {
    // Never throw during dressing: an unmergeable part costs one prop.
    console.error("[Vibe Kart/scenery] geometry merge failed; falling back to the first part");
    return prepped[0];
  }
  if (merged !== prepped[0]) for (const g of prepped) g.dispose();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Re-aim a card cluster's normals away from a centre point.
 *
 * Alpha-cut foliage is flat quads, and flat quads light like flat quads: one
 * face blows out, the other goes black, and the tree reads as cardboard. Bending
 * the normals into a sphere around the canopy centre makes the same triangles
 * shade like a volume of leaves. It is the single most important line in the
 * vegetation pipeline.
 */
export function sphericalNormals(
  geo: THREE.BufferGeometry,
  cx: number,
  cy: number,
  cz: number,
  blend = 0.85,
): THREE.BufferGeometry {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const nrm = geo.getAttribute("normal") as THREE.BufferAttribute;
  if (!pos || !nrm) return geo;
  const p = pos.array as Float32Array;
  const n = nrm.array as Float32Array;
  for (let i = 0; i < pos.count; i++) {
    const dx = p[i * 3] - cx;
    const dy = p[i * 3 + 1] - cy;
    const dz = p[i * 3 + 2] - cz;
    const l = Math.hypot(dx, dy, dz) || 1e-5;
    const nx = lerp(n[i * 3], dx / l, blend);
    const ny = lerp(n[i * 3 + 1], dy / l, blend);
    const nz = lerp(n[i * 3 + 2], dz / l, blend);
    const m = Math.hypot(nx, ny, nz) || 1e-5;
    n[i * 3] = nx / m;
    n[i * 3 + 1] = ny / m;
    n[i * 3 + 2] = nz / m;
  }
  nrm.needsUpdate = true;
  return geo;
}

/** Triangle count of a geometry, for the budget readout. */
export function triCount(geo: THREE.BufferGeometry): number {
  const idx = geo.getIndex();
  return (idx ? idx.count : geo.getAttribute("position").count) / 3;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * A transform builder for props that stand on the ground next to the track.
 * Yaw-only rotation is deliberate: it keeps the instance basis orthogonal with
 * Y up, which is what the wind shader's world→local conversion relies on.
 */
export function upright(
  out: THREE.Matrix4,
  x: number,
  y: number,
  z: number,
  yaw: number,
  scale: number,
  scaleY = scale,
): THREE.Matrix4 {
  EUL.set(0, yaw, 0, "YXZ");
  QUAT.setFromEuler(EUL);
  VEC.set(x, y, z);
  SCL.set(scale, scaleY, scale);
  return out.compose(VEC, QUAT, SCL);
}

/** Build a right-handed basis from a track frame: X along, Y up, Z outward. */
export function trackBasis(
  out: THREE.Matrix4,
  position: THREE.Vector3,
  forward: THREE.Vector3,
  outward: THREE.Vector3,
  scale = 1,
): THREE.Matrix4 {
  const x = TMP_A.copy(forward).normalize();
  const z = TMP_B.copy(outward).normalize();
  // Re-orthogonalise: track frames are banked, and a prop that leans with the
  // camber of a corner looks broken. Everything trackside stands up straight.
  x.y = 0;
  z.y = 0;
  if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
  else x.normalize();
  if (z.lengthSq() < 1e-6) z.set(0, 0, 1);
  else z.normalize();
  const y = TMP_C.crossVectors(z, x).normalize();
  out.makeBasis(x, y, z);
  out.scale(SCL.set(scale, scale, scale));
  out.setPosition(position);
  return out;
}

const TMP_A = new THREE.Vector3();
const TMP_B = new THREE.Vector3();
const TMP_C = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** Nudge a hex colour in HSL. Cheaper to read than three colour arithmetic. */
export function shade(hex: number, dLight: number, dSat = 0, dHue = 0): number {
  COL.setHex(hex, THREE.SRGBColorSpace);
  const hsl = { h: 0, s: 0, l: 0 };
  COL.getHSL(hsl);
  COL.setHSL(
    (hsl.h + dHue + 1) % 1,
    clamp01(hsl.s + dSat),
    clamp01(hsl.l + dLight),
    THREE.SRGBColorSpace,
  );
  return COL.getHex(THREE.SRGBColorSpace);
}
