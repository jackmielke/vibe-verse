import * as THREE from "three";
import type { GameModule, ModuleContext } from "../ModuleTypes";
import type { Collider } from "../entities/Player";
import type { Rng } from "../core/Assets";
import { canvasTexture, makeNoise2D } from "../core/Assets";

/**
 * Everything that grows on the Genesee shore: dry August tussocks on the
 * flats, Douglas fir and big-leaf maple up the bluff, salal and blackberry in
 * between, and bleached driftwood along the strand.
 *
 * Colour note — every vertex colour here is scene-linear reflectance, matching
 * the anchor in Sky.ts (0.18 diffuse in full sun reads as middle grey).
 * Conifer needles really are only 4-6% reflective, which is exactly why a
 * forested bluff reads as a dark mass against straw-coloured flats. Brightening
 * them to "look green" would flatten the whole frame.
 *
 * SHADOWS — this module projects its own. The renderer's shadow map is not
 * currently producing occlusion for the world scene (a 24 m test plane with
 * castShadow set throws nothing onto terrain with receiveShadow set, with the
 * terrain on a stock MeshStandardMaterial, so it is not a material problem).
 * A sunlit outdoor scene with no shadows reads as a decal collage, so every
 * woody thing here lays down a multiply-blended ground shadow along the actual
 * anti-solar azimuth, split into a short chain of discs so it follows
 * undulating ground instead of floating over it. castShadow is still set, so
 * when the shadow map is fixed the two agree rather than fight.
 */

const UP = new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------- mesh build ---

class Mesher {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly col: number[] = [];
  private readonly sway: number[] = [];
  private readonly wide: number[] = [];

  vert(p: THREE.Vector3, n: THREE.Vector3, c: THREE.Color, s: number, w?: THREE.Vector3): void {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.col.push(c.r, c.g, c.b);
    this.sway.push(s);
    if (w) this.wide.push(w.x, w.y, w.z);
    else this.wide.push(0, 0, 0);
  }

  get triangles(): number {
    return this.pos.length / 9;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("aSway", new THREE.Float32BufferAttribute(this.sway, 1));
    g.setAttribute("aWide", new THREE.Float32BufferAttribute(this.wide, 3));
    g.computeBoundingSphere();
    return g;
  }
}

const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _fn = new THREE.Vector3();

/** upBias rounds the shading normal toward vertical, which is what stops thin
 *  foliage cards from flickering between lit and unlit as they turn. */
function tri(
  m: Mesher,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  ca: THREE.Color,
  cb: THREE.Color,
  cc: THREE.Color,
  sa: number,
  sb: number,
  sc: number,
  upBias = 0,
  wa?: THREE.Vector3,
  wb?: THREE.Vector3,
  wc?: THREE.Vector3,
): void {
  _fn.copy(_ab.subVectors(b, a)).cross(_ac.subVectors(c, a));
  if (_fn.lengthSq() < 1e-12) return;
  _fn.normalize();
  if (upBias > 0) _fn.lerp(UP, upBias).normalize();
  m.vert(a, _fn, ca, sa, wa);
  m.vert(b, _fn, cb, sb, wb);
  m.vert(c, _fn, cc, sc, wc);
}

function quad(
  m: Mesher,
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  p2: THREE.Vector3,
  p3: THREE.Vector3,
  c0: THREE.Color,
  c1: THREE.Color,
  s0: number,
  s1: number,
  upBias = 0,
  w0?: THREE.Vector3,
  w1?: THREE.Vector3,
): void {
  const nw0 = w0 ? _w0.copy(w0) : undefined;
  const nw1 = w0 ? _w1.copy(w0).negate() : undefined;
  const nw2 = w1 ? _w2.copy(w1) : undefined;
  const nw3 = w1 ? _w3.copy(w1).negate() : undefined;
  tri(m, p0, p1, p2, c0, c0, c1, s0, s0, s1, upBias, nw0, nw1, nw2);
  tri(m, p2, p1, p3, c1, c0, c1, s1, s0, s1, upBias, nw2, nw1, nw3);
}

const _w0 = new THREE.Vector3();
const _w1 = new THREE.Vector3();
const _w2 = new THREE.Vector3();
const _w3 = new THREE.Vector3();

const _lp = new THREE.Vector3();
const _ln = new THREE.Vector3();
const _wp = new THREE.Vector3();
const _wn = new THREE.Vector3();
const _nm = new THREE.Matrix3();

function appendGeo(
  m: Mesher,
  src: THREE.BufferGeometry,
  mat: THREE.Matrix4,
  color: (worldPos: THREE.Vector3, localNormal: THREE.Vector3) => THREE.Color,
  sway: (worldPos: THREE.Vector3) => number,
): void {
  const p = src.attributes.position as THREE.BufferAttribute;
  const n = src.attributes.normal as THREE.BufferAttribute;
  _nm.getNormalMatrix(mat);
  for (let i = 0; i < p.count; i++) {
    _lp.fromBufferAttribute(p, i);
    _ln.fromBufferAttribute(n, i);
    _wp.copy(_lp).applyMatrix4(mat);
    _wn.copy(_ln).applyMatrix3(_nm).normalize();
    m.vert(_wp, _wn, color(_wp, _ln), sway(_wp));
  }
}

/** Cheap 3D value noise; used to make crown silhouettes ragged. */
function vnoise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const h = (a: number, b: number, c: number) => {
    let n = a * 374761393 + b * 668265263 + c * 2147483647;
    n = (n ^ (n >> 13)) * 1274126177;
    return ((n ^ (n >> 16)) >>> 0) / 4294967295;
  };
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c00 = lerp(h(xi, yi, zi), h(xi + 1, yi, zi), u);
  const c10 = lerp(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u);
  const c01 = lerp(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u);
  const c11 = lerp(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u);
  return lerp(lerp(c00, c10, v), lerp(c01, c11, v), w);
}

/**
 * Leaf-mass blob. A smooth radius function of direction gives a convex lump,
 * and convex lumps always read as blobs; three octaves of value noise on the
 * world direction push the rim in and out so the silhouette is ragged the way
 * a crown of leaves is.
 */
function makeBlob(seed: number, detail: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const o = seed * 7.13;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const r =
      1 +
      0.20 * (vnoise3(v.x * 1.9 + o, v.y * 1.9 + o, v.z * 1.9 + o) - 0.5) * 2 +
      0.13 * (vnoise3(v.x * 4.3 + o * 2, v.y * 4.3 + o * 2, v.z * 4.3 + o * 2) - 0.5) * 2 +
      0.07 * (vnoise3(v.x * 9.1 + o * 3, v.y * 9.1 + o * 3, v.z * 9.1 + o * 3) - 0.5) * 2;
    pos.setXYZ(i, v.x * r, v.y * r, v.z * r);
    // Shade off the undisplaced direction, not the displaced face. Per-face
    // normals on a noisy blob is what makes a canopy read as crumpled paper;
    // a leaf mass wants a ragged edge and smooth interior shading.
    nrm.setXYZ(i, v.x, v.y, v.z);
  }
  return geo;
}

// ------------------------------------------------------------------ grass ---

/**
 * A tussock of arching blades. The blade is a quadratic arc whose control
 * point leans over half way out and whose tip falls back below three quarters
 * of the blade height: straight ribbons splaying from a point are a rosette,
 * not grass, and the eye knows the difference instantly.
 */
function buildGrassClump(rand: Rng, blades: number): THREE.BufferGeometry {
  const m = new Mesher();
  const dry = new THREE.Color(0.152, 0.120, 0.044);
  const bleached = new THREE.Color(0.256, 0.208, 0.082);
  const green = new THREE.Color(0.058, 0.092, 0.026);

  const base = new THREE.Vector3();
  const wdir = new THREE.Vector3();
  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const pC = new THREE.Vector3();
  const q = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const wide = new THREE.Vector3();

  for (let i = 0; i < blades; i++) {
    const yaw = rand() * Math.PI * 2;
    const dx = Math.cos(yaw);
    const dz = Math.sin(yaw);
    const off = 0.02 + rand() * 0.085;
    const h = 0.42 + rand() * rand() * 0.55;
    const lean = (0.42 + rand() * 0.55) * h;
    // 8-16 mm: a real blade of dry ryegrass. Twice this and it is a leaf.
    const w = 0.008 + rand() * 0.008;

    const tint = rand();
    const tipCol = dry.clone().lerp(bleached, Math.min(1, tint * 1.5));
    // Sheaths at the base of a tuft are shaded by the tuft itself; that is the
    // contact darkening, and it is what stops the clump looking pasted on.
    const baseCol = dry.clone().lerp(green, 0.5 + rand() * 0.35).multiplyScalar(0.66);
    const midCol = tipCol.clone().lerp(baseCol, 0.4);

    base.set(dx * off, 0, dz * off);
    // Quadratic Bezier: P0 at the crown, P1 up and half way out, P2 arched over.
    const c1x = lean * 0.55;
    const c1y = h * 0.80;
    const c2x = lean;
    const c2y = h * (0.42 + rand() * 0.28);
    const bez = (t: number, out: THREE.Vector3) => {
      const it = 1 - t;
      const ex = 2 * it * t * c1x + t * t * c2x;
      const ey = 2 * it * t * c1y + t * t * c2y;
      return out.set(base.x + dx * ex, ey, base.z + dz * ex);
    };

    bez(0, pA);
    bez(0.45, pB);
    bez(0.78, pC);
    const tip = bez(1, new THREE.Vector3());

    wdir.set(-dz, 0, dx);
    wide.copy(wdir);

    const widths = [w, w * 0.82, w * 0.55];
    const pts = [pA, pB, pC];
    for (let k = 0; k < 2; k++) {
      const w0 = widths[k];
      const w1 = widths[k + 1];
      q[0].copy(pts[k]).addScaledVector(wdir, w0);
      q[1].copy(pts[k]).addScaledVector(wdir, -w0);
      q[2].copy(pts[k + 1]).addScaledVector(wdir, w1);
      q[3].copy(pts[k + 1]).addScaledVector(wdir, -w1);
      const t0 = k === 0 ? 0 : 0.45;
      const t1 = k === 0 ? 0.45 : 0.78;
      quad(
        m,
        q[0], q[1], q[2], q[3],
        k === 0 ? baseCol : midCol,
        k === 0 ? midCol : tipCol,
        t0 * t0, t1 * t1, 0.80,
        wide.clone().multiplyScalar(w0),
        wide.clone().multiplyScalar(w1),
      );
    }
    const wt = wide.clone().multiplyScalar(widths[2]);
    tri(
      m, q[2], q[3], tip, tipCol, tipCol, tipCol, 0.61, 0.61, 1, 0.80,
      wt, wt.clone().negate(), new THREE.Vector3(),
    );
  }
  return m.build();
}

// ------------------------------------------------------------------- trees ---

/**
 * Douglas fir, built as unit-height so instances can just scale it. The
 * silhouette comes from whorls of drooping branch sprays that shorten toward
 * the leader, each rolled about its own axis so the crown is never planar.
 */
function buildFir(rand: Rng, whorlCount: number, branchCount: number): THREE.BufferGeometry {
  const m = new Mesher();
  const needle = new THREE.Color(0.028, 0.043, 0.028);
  const sunNeedle = new THREE.Color(0.050, 0.068, 0.033);
  const bark = new THREE.Color(0.048, 0.038, 0.030);

  const trunkR = 0.020 + rand() * 0.008;
  const trunk = new THREE.CylinderGeometry(trunkR * 0.18, trunkR, 1.0, 6, 1, true).toNonIndexed();
  appendGeo(
    m,
    trunk,
    new THREE.Matrix4().makeTranslation(0, 0.5, 0),
    (wp) => bark.clone().multiplyScalar(0.7 + 0.5 * wp.y),
    (wp) => wp.y * 0.35,
  );
  trunk.dispose();

  const crownR = 0.26 + rand() * 0.11;
  const whorls = whorlCount + Math.floor(rand() * 3);
  const dir = new THREE.Vector3();
  const wdir = new THREE.Vector3();
  const perp = new THREE.Vector3();
  const a0 = new THREE.Vector3();
  const a1 = new THREE.Vector3();
  const a2 = new THREE.Vector3();
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  for (let i = 0; i < whorls; i++) {
    const t = 0.14 + (i / (whorls - 1)) * 0.82;
    const y = t;
    // Real crowns are ragged: the ±35% on branch length is what keeps the
    // silhouette from resolving into a cone.
    const L = crownR * Math.pow(1.02 - t, 0.72) * (0.66 + rand() * 0.7);
    const branches = branchCount + Math.floor(rand() * 3);
    const yaw0 = rand() * Math.PI * 2;
    const swayBase = 0.25 + 0.75 * t;

    for (let b = 0; b < branches; b++) {
      const yaw = yaw0 + ((b + (rand() - 0.5) * 0.55) / branches) * Math.PI * 2;
      dir.set(Math.cos(yaw), 0, Math.sin(yaw));
      perp.set(-dir.z, 0, dir.x);
      const roll = (rand() - 0.5) * 1.7;
      wdir.copy(perp).multiplyScalar(Math.cos(roll)).addScaledVector(UP, Math.sin(roll));

      const droop = (0.22 + rand() * 0.3) * L;
      const lift = 0.09 * L;
      a0.set(0, y, 0);
      a1.copy(dir).multiplyScalar(L * 0.46).setY(y + lift * 0.6);
      a2.copy(dir).multiplyScalar(L).setY(y - droop);

      const shade = 0.78 + rand() * 0.5;
      const cIn = needle.clone().multiplyScalar(shade);
      const cMid = needle.clone().lerp(sunNeedle, 0.35).multiplyScalar(shade);
      const cOut = needle.clone().lerp(sunNeedle, 0.75).multiplyScalar(shade);

      const w0 = L * 0.22;
      const w1 = L * 0.30;
      p[0].copy(a0).addScaledVector(wdir, w0);
      p[1].copy(a0).addScaledVector(wdir, -w0);
      p[2].copy(a1).addScaledVector(wdir, w1);
      p[3].copy(a1).addScaledVector(wdir, -w1);
      quad(m, p[0], p[1], p[2], p[3], cIn, cMid, swayBase * 0.4, swayBase * 0.7, 0.4);
      tri(m, p[2], p[3], a2, cMid, cMid, cOut, swayBase * 0.7, swayBase * 0.7, swayBase, 0.4);
    }
  }

  // Leader: firs come to a narrow spire, and the eye reads that instantly.
  const spire = new THREE.ConeGeometry(crownR * 0.20, 0.20, 5, 1, true).toNonIndexed();
  appendGeo(
    m,
    spire,
    new THREE.Matrix4().makeTranslation(0, 1.0, 0),
    () => sunNeedle,
    () => 1,
  );
  spire.dispose();

  return m.build();
}

/** Big-leaf maple: a short trunk that forks low into heavy limbs, carrying a
 *  broad rounded crown of overlapping leaf masses. */
function buildMaple(rand: Rng, blobs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = new Mesher();
  const leaf = new THREE.Color(0.062, 0.090, 0.028);
  const sunLeaf = new THREE.Color(0.118, 0.140, 0.048);
  const bark = new THREE.Color(0.062, 0.056, 0.046);

  const trunkH = 0.20 + rand() * 0.14;
  const trunkR = 0.028 + rand() * 0.016;
  const trunk = new THREE.CylinderGeometry(trunkR * 0.8, trunkR * 1.3, trunkH, 7, 1, true).toNonIndexed();
  appendGeo(
    m,
    trunk,
    new THREE.Matrix4().makeTranslation(0, trunkH * 0.5, 0),
    () => bark,
    () => 0,
  );
  trunk.dispose();

  const limbs = 3 + Math.floor(rand() * 3);
  const yaw0 = rand() * Math.PI * 2;
  const tip = new THREE.Vector3();
  const mat = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const hub = new THREE.Vector3(0, trunkH, 0);

  for (let i = 0; i < limbs; i++) {
    const yaw = yaw0 + ((i + (rand() - 0.5) * 0.5) / limbs) * Math.PI * 2;
    const reach = 0.18 + rand() * 0.22;
    const top = trunkH + 0.28 + rand() * 0.26;
    tip.set(Math.cos(yaw) * reach, top, Math.sin(yaw) * reach);

    const limbLen = tip.distanceTo(hub);
    const limb = new THREE.CylinderGeometry(trunkR * 0.26, trunkR * 0.8, limbLen, 5, 1, true).toNonIndexed();
    axis.copy(tip).sub(hub).normalize();
    q.setFromUnitVectors(UP, axis);
    mat.compose(
      new THREE.Vector3(tip.x * 0.5, trunkH + (tip.y - trunkH) * 0.5, tip.z * 0.5),
      q,
      new THREE.Vector3(1, 1, 1),
    );
    appendGeo(m, limb, mat, () => bark, (wp) => Math.max(0, (wp.y - trunkH) * 0.5));
    limb.dispose();

    // Two to three leaf masses per limb, offset outward and up.
    const masses = 4 + Math.floor(rand() * 2);
    for (let k = 0; k < masses; k++) {
      const blob = blobs[Math.floor(rand() * blobs.length)];
      const r = 0.10 + rand() * 0.10;
      const cx = tip.x * (0.80 + rand() * 0.6) + (rand() - 0.5) * 0.14;
      const cz = tip.z * (0.80 + rand() * 0.6) + (rand() - 0.5) * 0.14;
      const cy = top + rand() * 0.20 - 0.06;
      mat.compose(
        new THREE.Vector3(cx, cy, cz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3)),
        new THREE.Vector3(r * (0.80 + rand() * 0.5), r * (0.60 + rand() * 0.35), r * (0.80 + rand() * 0.5)),
      );
      const shade = 0.82 + rand() * 0.36;
      appendGeo(
        m,
        blob,
        mat,
        (_wp, ln) =>
          leaf
            .clone()
            .lerp(sunLeaf, THREE.MathUtils.smoothstep(ln.y, -0.3, 0.95))
            // Underside of a crown is in its own shadow; baking it in gives the
            // canopy form even before the sun shadow lands on it.
            .multiplyScalar(shade * THREE.MathUtils.lerp(0.38, 1.0, THREE.MathUtils.smoothstep(ln.y, -0.85, 0.6))),
        (wp) => THREE.MathUtils.clamp((wp.y - trunkH) * 1.1, 0, 1),
      );
    }
  }

  // A central mass ties the limb crowns into one canopy.
  mat.compose(
    new THREE.Vector3(0, trunkH + 0.38 + rand() * 0.1, 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rand() * 3, 0)),
    new THREE.Vector3(0.19 + rand() * 0.06, 0.13 + rand() * 0.05, 0.19 + rand() * 0.06),
  );
  appendGeo(
    m,
    blobs[Math.floor(rand() * blobs.length)],
    mat,
    (_wp, ln) =>
      leaf
        .clone()
        .lerp(sunLeaf, THREE.MathUtils.smoothstep(ln.y, -0.3, 0.95))
        .multiplyScalar(THREE.MathUtils.lerp(0.36, 0.95, THREE.MathUtils.smoothstep(ln.y, -0.85, 0.6))),
    (wp) => THREE.MathUtils.clamp((wp.y - trunkH) * 1.1, 0, 1),
  );

  return m.build();
}

function buildShrub(rand: Rng, blobs: THREE.BufferGeometry[], dry: boolean): THREE.BufferGeometry {
  const m = new Mesher();
  const col = dry
    ? new THREE.Color(0.104, 0.092, 0.044)
    : new THREE.Color(0.052, 0.078, 0.028);
  const hi = dry ? new THREE.Color(0.180, 0.156, 0.076) : new THREE.Color(0.098, 0.120, 0.042);
  const mat = new THREE.Matrix4();
  const n = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const r = 0.42 + rand() * 0.42;
    mat.compose(
      new THREE.Vector3((rand() - 0.5) * 0.7, r * 0.62 + rand() * 0.15, (rand() - 0.5) * 0.7),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3)),
      new THREE.Vector3(r, r * 0.72, r),
    );
    appendGeo(
      m,
      blobs[Math.floor(rand() * blobs.length)],
      mat,
      (_wp, ln) =>
        col
          .clone()
          .lerp(hi, THREE.MathUtils.smoothstep(ln.y, -0.2, 0.9))
          .multiplyScalar(THREE.MathUtils.lerp(0.42, 1.0, THREE.MathUtils.smoothstep(ln.y, -0.9, 0.5))),
      (wp) => THREE.MathUtils.clamp(wp.y * 0.7, 0, 1),
    );
  }
  return m.build();
}

/**
 * Sun-silvered log. Bleached cedar is a warm grey around 0.22/0.20/0.165 with
 * hard longitudinal grain and dark weather splits — a smooth neutral cylinder
 * reads as concrete, which is exactly what the last pass looked like.
 */
function buildDriftwood(rand: Rng, variant: number): THREE.BufferGeometry {
  const m = new Mesher();
  const pale = new THREE.Color(0.228, 0.208, 0.170);
  const grey = new THREE.Color(0.118, 0.108, 0.092);
  const dark = new THREE.Color(0.040, 0.034, 0.028);
  const sides = 9;
  const rings = 9;
  const len = 1.0;
  const bend = (rand() - 0.5) * 0.34;
  const rBase = 0.070 + rand() * 0.055;
  const broken = variant % 2 === 1;
  // Root flare on half the logs: a shore log is usually a whole blown-down
  // tree, and the flare is the thing that says "tree" rather than "pipe".
  const flare = variant % 3 === 0 ? 1.9 + rand() : 1.0;
  const grainSeed = rand() * 31.7;
  const splitPhase = rand() * 6.28;

  const pt = (ri: number, si: number, out: THREE.Vector3) => {
    const t = ri / (rings - 1);
    const taper = broken ? (t > 0.88 ? 0.55 : 1 - 0.4 * t) : 1 - 0.45 * t;
    const rootT = Math.max(0, 1 - t * 5);
    const knob = 0.93 + 0.11 * Math.sin(t * 5.5 + si * 1.1 + grainSeed);
    const r = rBase * taper * knob * (1 + (flare - 1) * rootT * rootT);
    const a = (si / sides) * Math.PI * 2;
    const cx = (t - 0.5) * len;
    const cz = bend * Math.sin(t * Math.PI);
    return out.set(cx, r * Math.sin(a) + rBase, cz + r * Math.cos(a));
  };

  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  const shade = (v: THREE.Vector3) => {
    // Longitudinal grain: a 1D band along the log axis, plus deep splits.
    const u = v.x + 0.5;
    const a = Math.atan2(v.z, v.y - rBase);
    const grain =
      0.5 +
      0.30 * Math.sin(u * 39 + a * 1.4 + grainSeed) +
      0.20 * Math.sin(u * 97 + a * 0.7 + grainSeed * 3);
    const split = Math.pow(Math.max(0, Math.sin(u * 9 + a * 2.2 + splitPhase)), 10);
    const up = THREE.MathUtils.smoothstep((v.y - rBase) / rBase, -0.9, 0.9);
    const c = grey.clone().lerp(pale, THREE.MathUtils.clamp(up * 0.55 + grain * 0.62, 0, 1));
    return c.lerp(dark, THREE.MathUtils.lerp(0.40, 0.04, up) * 0.5 + split * 0.45);
  };

  for (let ri = 0; ri < rings - 1; ri++) {
    for (let si = 0; si < sides; si++) {
      pt(ri, si, p0);
      pt(ri, (si + 1) % sides, p1);
      pt(ri + 1, si, p2);
      pt(ri + 1, (si + 1) % sides, p3);
      tri(m, p0, p2, p1, shade(p0), shade(p2), shade(p1), 0, 0, 0);
      tri(m, p1, p2, p3, shade(p1), shade(p2), shade(p3), 0, 0, 0);
    }
  }
  return m.build();
}

// ------------------------------------------------------------- materials ----

const FOLIAGE_COMMON = /* glsl */ `
varying vec3 vFolWorld;
varying vec3 vFolNormal;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform float uTransl;
`;

const FOLIAGE_VERT_PARS = /* glsl */ `
attribute float aSway;
attribute vec3 aWide;
uniform float uTime;
uniform vec2 uWind;
uniform float uWindAmp;
uniform vec3 uCamPos;
uniform vec2 uFade;
uniform float uPxWidth;
`;

const FOLIAGE_VERT = /* glsl */ `
  #ifdef USE_INSTANCING
    vec3 folAnchor = (modelMatrix * instanceMatrix[3]).xyz;
  #else
    vec3 folAnchor = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  #endif

  // Shrink to nothing rather than pop out: the clump sinks into the ground.
  float folFade = 1.0 - smoothstep(uFade.x, uFade.y, distance(folAnchor, uCamPos));
  transformed *= folFade;

  // Hold a blade at least ~1.5 px wide on screen. Sub-pixel geometry plus a
  // per-channel dither is what produces the red/blue crawl along blade edges.
  float folDist = distance(folAnchor, uCamPos);
  float wantHalf = uPxWidth * folDist;
  float haveHalf = length(aWide.xz);
  if (haveHalf > 1e-5) {
    transformed += normalize(aWide) * max(0.0, wantHalf - haveHalf);
  }

  float folPhase = dot(folAnchor.xz, vec2(0.21, 0.13));
  float gust = sin(uTime * 1.15 + folPhase) * 0.62 + sin(uTime * 2.7 + folPhase * 1.9) * 0.38;
  float folAmp = aSway * aSway * uWindAmp * folFade;
  transformed.x += gust * folAmp * uWind.x;
  transformed.z += gust * folAmp * uWind.y;
  transformed.y -= abs(gust) * folAmp * 0.22;
`;

const FOLIAGE_WORLD = /* glsl */ `
  vFolWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
  #ifdef USE_INSTANCING
    vFolNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
  #else
    vFolNormal = normalize(mat3(modelMatrix) * objectNormal);
  #endif
`;

/**
 * Leaves and needles are thin: a good part of what you see looking toward the
 * sun is light that went through them. Without it, backlit foliage reads as a
 * black cut-out and the whole bluff dies.
 */
const FOLIAGE_NORMAL = /* glsl */ `
  #include <normal_fragment_begin>
  // A blade of grass is not a solid: three flips the normal on back faces, so
  // the far side of every card points at the ground, picks up only the dark
  // hemisphere term and draws a black stroke down the silhouette. Foliage
  // wants the same up-biased normal from either side.
  normal = normalize((viewMatrix * vec4(normalize(vFolNormal), 0.0)).xyz);
  nonPerturbedNormal = normal;
`;

const FOLIAGE_TRANSLUCENCY = /* glsl */ `
  vec3 folView = normalize(vFolWorld - cameraPosition);
  float folBack = max(0.0, dot(-normalize(vFolNormal), uSunDir));
  float folThru = pow(max(0.0, dot(folView, uSunDir)), 2.0);
  outgoingLight += diffuseColor.rgb * uSunCol * uTransl * folBack * (0.28 + 0.72 * folThru);
`;

interface FoliageUniforms {
  uTime: { value: number };
  uWind: { value: THREE.Vector2 };
  uWindAmp: { value: number };
  uCamPos: { value: THREE.Vector3 };
  uFade: { value: THREE.Vector2 };
  uSunDir: { value: THREE.Vector3 };
  uSunCol: { value: THREE.Vector3 };
  uTransl: { value: number };
  uPxWidth: { value: number };
}

interface FoliageOpts {
  windAmp: number;
  fade: THREE.Vector2;
  transl: number;
  roughness: number;
  /** Half-width in world units per metre of distance, for the anti-crawl widen. */
  pxWidth?: number;
}

function foliageMaterial(
  uniforms: FoliageUniforms,
  opts: FoliageOpts,
): { mat: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial } {
  const local: FoliageUniforms = {
    ...uniforms,
    uWindAmp: { value: opts.windAmp },
    uFade: { value: opts.fade },
    uTransl: { value: opts.transl },
    uPxWidth: { value: opts.pxWidth ?? 0 },
  };

  const injectVertex = (shader: THREE.WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, local);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${FOLIAGE_VERT_PARS}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${FOLIAGE_VERT}`);
  };

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: opts.roughness,
    metalness: 0,
    side: THREE.DoubleSide,
  });

  mat.onBeforeCompile = (shader) => {
    injectVertex(shader);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vFolWorld;\nvarying vec3 vFolNormal;`)
      .replace("#include <project_vertex>", `${FOLIAGE_WORLD}\n#include <project_vertex>`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FOLIAGE_COMMON}`)
      .replace("#include <normal_fragment_begin>", FOLIAGE_NORMAL)
      .replace("#include <opaque_fragment>", `${FOLIAGE_TRANSLUCENCY}\n#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => `seafair-foliage-${opts.windAmp}-${opts.transl}`;

  // The same displacement has to run in the shadow-caster pass, or a swayed,
  // shrunk clump leaves a still, full-size shadow behind it.
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.side = THREE.DoubleSide;
  depth.onBeforeCompile = injectVertex;
  depth.customProgramCacheKey = () => `seafair-foliage-depth-${opts.windAmp}`;

  return { mat, depth };
}

// ------------------------------------------------------------------ module ---

interface ShadowSpot {
  x: number;
  z: number;
  /** Height of the caster, which sets the length of the throw. */
  h: number;
  /** Half-width of the caster. */
  r: number;
  /** Number of discs laid down the throw. Short casters only need one. */
  discs: number;
}

const mod: GameModule = {
  id: "vegetation",
  order: 60,

  build(ctx: ModuleContext) {
    const { scene, profile, rng, terrain } = ctx;
    const fd = profile.foliageDensity;
    const disposables: Array<{ dispose: () => void }> = [];
    const meshes: THREE.Object3D[] = [];

    const sunCol = new THREE.Vector3(
      ctx.sky.sun.color.r * ctx.sky.sun.intensity,
      ctx.sky.sun.color.g * ctx.sky.sun.intensity,
      ctx.sky.sun.color.b * ctx.sky.sun.intensity,
    );

    const shared: FoliageUniforms = {
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(0.62, 0.24) },
      uWindAmp: { value: 0 },
      uCamPos: { value: new THREE.Vector3() },
      uFade: { value: new THREE.Vector2(1e5, 2e5) },
      uSunDir: { value: ctx.sky.sunDirection.clone() },
      uSunCol: { value: sunCol },
      uTransl: { value: 0 },
      uPxWidth: { value: 0 },
    };

    const nrm = new THREE.Vector3();
    const dummy = new THREE.Object3D();
    const shadowSpots: ShadowSpot[] = [];
    const myColliders: Collider[] = [];

    /** The graded festival ground: nothing woody grows inside it. */
    const onApron = (x: number, z: number) => Math.abs(x) < 116 && Math.abs(z - 62) < 82;

    // ---------------------------------------------------------- grass ------
    // The tussock layer follows the camera: a fixed grid of chunks re-seeded
    // whenever the camera crosses into a new cell. Density is highest in the
    // ring the player is standing in and falls off hard outwards — park grass
    // is 4-plus clumps per square metre underfoot, and holding that areal
    // density out to fifty metres would be both wrong and unaffordable.
    const GRASS_CHUNK = 12;
    const GRASS_GRID = profile.tier === "low" ? 5 : profile.tier === "ultra" ? 9 : 7;
    const grassRadius = (GRASS_CHUNK * GRASS_GRID) / 2;
    const RING_FALLOFF = [1.0, 0.40, 0.13, 0.05, 0.03];
    const nearDensity = 4.5 * fd;
    const perChunkMax = Math.max(8, Math.round(GRASS_CHUNK * GRASS_CHUNK * nearDensity));

    const bladeCounts = profile.tier === "low" ? [4, 5, 6] : [7, 9, 11];
    const grassGeos = bladeCounts.map((b) => buildGrassClump(rng, b));
    const grass = foliageMaterial(shared, {
      windAmp: 0.20,
      fade: new THREE.Vector2(grassRadius * 0.78, grassRadius * 0.99),
      transl: 0.22,
      roughness: 0.92,
      // ~1.5 px at 1080p / 78 deg fov; slightly generous so SMAA has something
      // to work with rather than a dithered single-pixel line.
      pxWidth: 0.0010,
    });
    disposables.push(grass.mat, grass.depth, ...grassGeos);

    const grassChunks: Array<{ mesh: THREE.InstancedMesh; cx: number; cz: number }> = [];
    for (let i = 0; i < GRASS_GRID * GRASS_GRID; i++) {
      const inst = new THREE.InstancedMesh(grassGeos[i % grassGeos.length], grass.mat, perChunkMax);
      inst.castShadow = false;
      inst.receiveShadow = true;
      inst.frustumCulled = true;
      inst.count = 0;
      inst.name = `grass-${i}`;
      scene.add(inst);
      meshes.push(inst);
      disposables.push(inst);
      grassChunks.push({ mesh: inst, cx: 1e9, cz: 1e9 });
    }

    const fillGrassChunk = (
      chunk: (typeof grassChunks)[number],
      cx: number,
      cz: number,
      ring: number,
    ) => {
      chunk.cx = cx;
      chunk.cz = cz;
      const inst = chunk.mesh;
      const x0 = cx * GRASS_CHUNK;
      const z0 = cz * GRASS_CHUNK;
      const want = Math.min(
        perChunkMax,
        Math.round(perChunkMax * RING_FALLOFF[Math.min(ring, RING_FALLOFF.length - 1)]),
      );
      let n = 0;
      for (let guard = 0; guard < want * 3 && n < want; guard++) {
        const x = x0 + rng() * GRASS_CHUNK;
        const z = z0 + rng() * GRASS_CHUNK;
        const h = terrain.height(x, z);
        // Above the sand: nothing grows on the active strand.
        if (h < 1.95) continue;
        terrain.normal(x, z, nrm);
        if (nrm.y < 0.62) continue;
        // The apron is compacted; only stragglers come through it.
        if (onApron(x, z) && rng() > 0.14) continue;
        const s = 0.75 + rng() * rng() * 1.05;
        dummy.position.set(x, h - 0.04, z);
        dummy.rotation.set(0, rng() * Math.PI * 2, 0);
        dummy.scale.set(s * (0.85 + rng() * 0.5), s * (0.7 + rng() * 0.6), s * (0.85 + rng() * 0.5));
        dummy.updateMatrix();
        inst.setMatrixAt(n++, dummy.matrix);
      }
      inst.count = n;
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
    };

    let grassCentreX = 1e9;
    let grassCentreZ = 1e9;
    const half = (GRASS_GRID - 1) / 2;
    const recentreGrass = (px: number, pz: number) => {
      const cx = Math.floor(px / GRASS_CHUNK);
      const cz = Math.floor(pz / GRASS_CHUNK);
      if (cx === grassCentreX && cz === grassCentreZ) return;
      grassCentreX = cx;
      grassCentreZ = cz;
      // Toroidal addressing: stepping one cell only invalidates the row that
      // just wrapped from behind the camera to in front of it. The ring index
      // changes for every chunk though, so density is refreshed wholesale.
      for (let dz = -half; dz <= half; dz++) {
        for (let dx = -half; dx <= half; dx++) {
          const wx = cx + dx;
          const wz = cz + dz;
          const sx = ((wx % GRASS_GRID) + GRASS_GRID) % GRASS_GRID;
          const sz = ((wz % GRASS_GRID) + GRASS_GRID) % GRASS_GRID;
          fillGrassChunk(
            grassChunks[sz * GRASS_GRID + sx],
            wx,
            wz,
            Math.max(Math.abs(dx), Math.abs(dz)),
          );
        }
      }
    };
    recentreGrass(ctx.player.position.x, ctx.player.position.z);

    // ---------------------------------------------------------- woody ------
    const blobDetail = profile.tier === "low" ? 1 : profile.tier === "medium" ? 1 : 2;
    const blobs = [1.3, 2.7, 4.1, 5.9, 7.3].map((s) => makeBlob(s, blobDetail));
    const firWhorls = { low: 7, medium: 9, high: 11, ultra: 12 }[profile.tier];
    const firBranches = { low: 4, medium: 5, high: 6, ultra: 6 }[profile.tier];
    const firGeos = [0, 1, 2, 3, 4].map(() => buildFir(rng, firWhorls, firBranches));
    const mapleVariants = profile.tier === "low" ? 3 : 6;
    const mapleGeos = Array.from({ length: mapleVariants }, () => buildMaple(rng, blobs));
    const shrubGeos = [buildShrub(rng, blobs, false), buildShrub(rng, blobs, true), buildShrub(rng, blobs, false)];
    const driftGeos = [0, 1, 2, 3, 4].map((v) => buildDriftwood(rng, v));
    blobs.forEach((b) => b.dispose());
    disposables.push(...firGeos, ...mapleGeos, ...shrubGeos, ...driftGeos);

    const canopy = foliageMaterial(shared, {
      windAmp: 0.035,
      fade: new THREE.Vector2(1e5, 2e5),
      transl: 0.62,
      roughness: 0.85,
    });
    const shrubM = foliageMaterial(shared, {
      windAmp: 0.09,
      fade: new THREE.Vector2(1e5, 2e5),
      transl: 0.55,
      roughness: 0.88,
    });
    const woodM = foliageMaterial(shared, {
      windAmp: 0,
      fade: new THREE.Vector2(1e5, 2e5),
      transl: 0,
      roughness: 0.78,
    });
    disposables.push(canopy.mat, canopy.depth, shrubM.mat, shrubM.depth, woodM.mat, woodM.depth);

    const castShadows = profile.shadowMapSize > 0;
    const tintCol = new THREE.Color();

    /** Scatter with rejection sampling; returns the instances actually placed. */
    const scatter = (
      geos: THREE.BufferGeometry[],
      mats: { mat: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial },
      total: number,
      name: string,
      sample: () => { x: number; z: number } | null,
      accept: (x: number, z: number, h: number, ny: number) => boolean,
      pose: (x: number, z: number, h: number, i: number) => { collide: number; tint?: number },
    ) => {
      const per = Math.ceil(total / geos.length);
      const insts = geos.map((g, gi) => {
        const im = new THREE.InstancedMesh(g, mats.mat, per);
        im.castShadow = castShadows;
        im.receiveShadow = true;
        im.customDepthMaterial = mats.depth;
        im.name = `${name}-${gi}`;
        im.count = 0;
        return im;
      });
      const counts = new Array(geos.length).fill(0);

      for (let guard = 0, placed = 0; guard < total * 14 && placed < total; guard++) {
        const s = sample();
        if (!s) continue;
        const h = terrain.height(s.x, s.z);
        terrain.normal(s.x, s.z, nrm);
        if (!accept(s.x, s.z, h, nrm.y)) continue;
        const gi = placed % geos.length;
        if (counts[gi] >= per) continue;
        const r = pose(s.x, s.z, h, placed);
        dummy.updateMatrix();
        const k = counts[gi]++;
        insts[gi].setMatrixAt(k, dummy.matrix);
        if (r.tint !== undefined) {
          // Per-instance hue jitter: identical geometry repeated is obvious,
          // identical geometry in a different green much less so.
          const t = r.tint;
          tintCol.setRGB(1 + t * 0.28, 1 + t * 0.10, 1 - t * 0.22);
          insts[gi].setColorAt(k, tintCol);
        }
        // Only trees the player can actually reach earn a collider; the bluff
        // forest would otherwise put hundreds of boxes in the movement loop.
        if (r.collide > 0 && Math.abs(s.x) < 420 && s.z < 460) {
          const collider = {
            box: new THREE.Box3(
              new THREE.Vector3(s.x - r.collide, h - 1, s.z - r.collide),
              new THREE.Vector3(s.x + r.collide, h + 6, s.z + r.collide),
            ),
            solid: true,
            name,
          };
          ctx.colliders.push(collider);
          myColliders.push(collider);
        }
        placed++;
      }

      insts.forEach((im, i) => {
        im.count = counts[i];
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        if (counts[i] === 0) {
          im.dispose();
          return;
        }
        im.computeBoundingSphere();
        scene.add(im);
        meshes.push(im);
        disposables.push(im);
      });
    };

    // Trees do not fall uniformly: they hold in stands and leave meadows. This
    // field is what turns an even sprinkle into a forest with edges.
    const { fbm } = makeNoise2D(31337);
    const grove = (x: number, z: number) => fbm(x * 0.0032, z * 0.0032, 3) * 0.5 + 0.5;
    const standVigour = (x: number, z: number) => fbm(x * 0.0011 + 51, z * 0.0011 - 17, 2) * 0.5 + 0.5;

    // Douglas fir: the bluff is forest, thinning down onto the park flats.
    scatter(
      firGeos,
      canopy,
      Math.round(880 * (0.28 + 0.72 * fd)),
      "fir",
      () => ({
        x: (rng() * 2 - 1) * 1000,
        // Half near-biased for the park edge, half flat so the plateau behind
        // the crest keeps its canopy instead of thinning to bare ground.
        z: rng() < 0.5 ? 120 + rng() * rng() * 900 : 260 + rng() * 1150,
      }),
      (x, z, h, ny) => {
        if (h < 2.9 || ny < 0.55 || onApron(x, z)) return false;
        // Solid canopy up the bluff, scattered stragglers out on the flats.
        const cover = THREE.MathUtils.lerp(0.22, 1.0, THREE.MathUtils.smoothstep(z, 200, 460));
        return rng() < cover * THREE.MathUtils.smoothstep(grove(x, z), 0.24, 0.62);
      },
      (x, z, h) => {
        // Stand height tracks site quality, not chance: deep soil in the
        // gullies grows 40 m trees, the dry spurs grow 18 m ones. Uncorrelated
        // heights average out into a ruled horizontal treeline.
        const vig = standVigour(x, z) * 0.65 + grove(x, z) * 0.35;
        const s = (13 + vig * vig * 34) * (0.82 + rng() * 0.34);
        dummy.position.set(x, h - 0.4, z);
        dummy.rotation.set((rng() - 0.5) * 0.09, rng() * Math.PI * 2, (rng() - 0.5) * 0.09);
        dummy.scale.set(s * (0.80 + rng() * 0.34), s, s * (0.80 + rng() * 0.34));
        if (z < 700) shadowSpots.push({ x, z, h: s * 0.95, r: s * 0.30, discs: 3 });
        return { collide: s * 0.03, tint: (rng() - 0.5) * 0.5 };
      },
    );

    // Big-leaf maple: the park edge and the toe of the bluff, where it is wet.
    scatter(
      mapleGeos,
      canopy,
      Math.round(260 * (0.3 + 0.7 * fd)),
      "maple",
      () => ({ x: (rng() * 2 - 1) * 480, z: 10 + rng() * 480 }),
      (x, z, h, ny) => h > 2.6 && ny > 0.62 && !onApron(x, z) && rng() < 0.35 + 0.65 * grove(x, z),
      (x, z, h) => {
        const s = 10 + rng() * rng() * 18;
        dummy.position.set(x, h - 0.3, z);
        dummy.rotation.set(0, rng() * Math.PI * 2, 0);
        // Non-uniform X/Z: a crown that is round in plan is a ball, and a ball
        // pairs by eye with every other ball in the frame.
        dummy.scale.set(s * (0.78 + rng() * 0.5), s * (0.8 + rng() * 0.42), s * (0.78 + rng() * 0.5));
        shadowSpots.push({ x, z, h: s * 0.82, r: s * 0.40, discs: 3 });
        return { collide: s * 0.045, tint: (rng() - 0.5) * 0.6 };
      },
    );

    // Salal and blackberry: everywhere the mower does not reach.
    scatter(
      shrubGeos,
      shrubM,
      Math.round(1100 * (0.25 + 0.75 * fd)),
      "shrub",
      () => ({
        x: (rng() * 2 - 1) * (rng() * 0.6 + 0.4) * 620,
        z: -30 + rng() * rng() * 820,
      }),
      (x, z, h, ny) => h > 1.6 && ny > 0.5 && !onApron(x, z),
      (x, z, h) => {
        const s = 0.9 + rng() * rng() * 2.4;
        dummy.position.set(x, h - 0.16 * s, z);
        dummy.rotation.set(0, rng() * Math.PI * 2, 0);
        dummy.scale.set(s * (0.9 + rng() * 0.5), s * (0.7 + rng() * 0.5), s * (0.9 + rng() * 0.5));
        if (z < 260 && s > 1.2) shadowSpots.push({ x, z, h: s * 0.9, r: s * 0.75, discs: 1 });
        return { collide: 0, tint: (rng() - 0.5) * 0.4 };
      },
    );

    // Driftwood: stranded above the swash line, never floating.
    scatter(
      driftGeos,
      woodM,
      Math.round(110 * (0.3 + 0.7 * fd)),
      "driftwood",
      () => ({ x: (rng() * 2 - 1) * 480, z: -40 + rng() * 80 }),
      (_x, _z, h, ny) => h > 0.35 && h < 2.4 && ny > 0.72,
      (x, z, h) => {
        const s = 1.8 + rng() * rng() * 3.6;
        dummy.position.set(x, h - 0.035 * s, z);
        dummy.rotation.set((rng() - 0.5) * 0.25, rng() * Math.PI * 2, (rng() - 0.5) * 0.2);
        dummy.scale.setScalar(s);
        shadowSpots.push({ x, z, h: s * 0.16, r: s * 0.45, discs: 1 });
        return { collide: 0 };
      },
    );

    // ------------------------------------------------------ sun shadows ----
    // Each caster lays a chain of soft discs down the anti-solar azimuth, each
    // sitting on its own terrain height so the shadow follows the ground.
    if (shadowSpots.length > 0) {
      const sun = ctx.sky.sunDirection;
      const runPerMetre = 1 / Math.max(0.25, sun.y);
      const dirX = -sun.x * runPerMetre;
      const dirZ = -sun.z * runPerMetre;
      const runLen = Math.hypot(dirX, dirZ);
      const ux = dirX / runLen;
      const uz = dirZ / runLen;
      // Local +X of an XZ-plane maps to world (cos, -sin) under a Y rotation.
      const yaw = Math.atan2(-uz, ux);

      const shTex = canvasTexture(
        "veg-sunshadow",
        128,
        (c2d, s) => {
          const g = c2d.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
          // A cast shadow has a dark core with a real penumbra, not a wash.
          g.addColorStop(0, "#3c3c3c");
          g.addColorStop(0.38, "#4c4c4c");
          g.addColorStop(0.62, "#8a8a8a");
          g.addColorStop(0.84, "#d6d6d6");
          g.addColorStop(1, "#ffffff");
          c2d.fillStyle = g;
          c2d.fillRect(0, 0, s, s);
          // Canopy shadows are dappled; a solid ellipse reads as a sticker.
          c2d.globalCompositeOperation = "lighter";
          for (let i = 0; i < 26; i++) {
            const a = (i / 26) * Math.PI * 2 + i * 1.7;
            const rr = (0.12 + ((i * 37) % 100) / 260) * s * 0.5;
            const px = s / 2 + Math.cos(a) * rr;
            const py = s / 2 + Math.sin(a) * rr;
            const rad = s * (0.035 + ((i * 53) % 100) / 2600);
            const d = c2d.createRadialGradient(px, py, 0, px, py, rad);
            d.addColorStop(0, "rgba(255,255,255,0.32)");
            d.addColorStop(1, "rgba(255,255,255,0)");
            c2d.fillStyle = d;
            c2d.fillRect(px - rad, py - rad, rad * 2, rad * 2);
          }
        },
        { srgb: false },
      );

      const shGeo = new THREE.CircleGeometry(1, 14).rotateX(-Math.PI / 2);
      const shMat = new THREE.MeshBasicMaterial({
        map: shTex,
        transparent: true,
        blending: THREE.MultiplyBlending,
        depthWrite: false,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      });

      // Bucket by region so the transparent pass can frustum-cull them. One
      // world-spanning InstancedMesh is never culled and costs every frame.
      const REGION = 260;
      const buckets = new Map<string, THREE.Matrix4[]>();
      const q = new THREE.Quaternion();
      const qTilt = new THREE.Quaternion();
      const mtx = new THREE.Matrix4();
      const scl = new THREE.Vector3();
      const posv = new THREE.Vector3();

      const DISC_T = [[0.55], [0.22, 0.68], [0.16, 0.48, 0.82]];
      for (const sp of shadowSpots) {
        const run = sp.h * runLen;
        const ts = DISC_T[Math.min(sp.discs, 3) - 1];
        for (let d = 0; d < ts.length; d++) {
          const t = ts[d];
          const cx = sp.x + ux * run * t;
          const cz = sp.z + uz * run * t;
          const gy = terrain.height(cx, cz);
          if (gy < 0.1) continue;
          // The throw narrows and softens toward the tip of the shadow.
          const along = run * (0.34 / ts.length) + sp.r * 0.62;
          const across = sp.r * (1.05 - 0.35 * t);
          terrain.normal(cx, cz, nrm);
          qTilt.setFromUnitVectors(UP, nrm);
          q.setFromAxisAngle(UP, yaw);
          q.premultiply(qTilt);
          posv.set(cx, gy + 0.05 + across * 0.03, cz);
          scl.set(along, 1, across);
          mtx.compose(posv, q, scl);
          const key = `${Math.floor(cx / REGION)},${Math.floor(cz / REGION)}`;
          const list = buckets.get(key);
          if (list) list.push(mtx.clone());
          else buckets.set(key, [mtx.clone()]);
        }
      }

      let bi = 0;
      for (const list of buckets.values()) {
        const im = new THREE.InstancedMesh(shGeo, shMat, list.length);
        im.name = `veg-shadow-${bi++}`;
        im.renderOrder = 2;
        im.receiveShadow = false;
        im.castShadow = false;
        for (let i = 0; i < list.length; i++) im.setMatrixAt(i, list[i]);
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        scene.add(im);
        meshes.push(im);
        disposables.push(im);
      }
      disposables.push(shGeo, shMat);

      // ---------------------------------------------------- contact AO ----
      // Tight and dark, roughly the trunk flare. Contact occlusion is a small
      // thing; spread over a quarter of the tree's height it averages out to a
      // few percent and does nothing at all.
      const aoTex = canvasTexture(
        "veg-contact",
        64,
        (c2d, s) => {
          const g = c2d.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
          g.addColorStop(0, "#4a4a4a");
          g.addColorStop(0.35, "#525252");
          g.addColorStop(0.72, "#b4b4b4");
          g.addColorStop(1, "#ffffff");
          c2d.fillStyle = g;
          c2d.fillRect(0, 0, s, s);
        },
        { srgb: false },
      );
      const aoGeo = new THREE.CircleGeometry(1, 10).rotateX(-Math.PI / 2);
      const aoMat = new THREE.MeshBasicMaterial({
        map: aoTex,
        transparent: true,
        blending: THREE.MultiplyBlending,
        depthWrite: false,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -6,
      });
      const aoBuckets = new Map<string, THREE.Matrix4[]>();
      for (const sp of shadowSpots) {
        const gy = terrain.height(sp.x, sp.z);
        if (gy < 0.1) continue;
        terrain.normal(sp.x, sp.z, nrm);
        qTilt.setFromUnitVectors(UP, nrm);
        const r = Math.max(0.5, sp.r * 0.85);
        mtx.compose(new THREE.Vector3(sp.x, gy + 0.04, sp.z), qTilt, new THREE.Vector3(r, 1, r));
        const key = `${Math.floor(sp.x / REGION)},${Math.floor(sp.z / REGION)}`;
        const list = aoBuckets.get(key);
        if (list) list.push(mtx.clone());
        else aoBuckets.set(key, [mtx.clone()]);
      }
      let ai = 0;
      for (const list of aoBuckets.values()) {
        const im = new THREE.InstancedMesh(aoGeo, aoMat, list.length);
        im.name = `veg-contact-${ai++}`;
        im.renderOrder = 3;
        for (let i = 0; i < list.length; i++) im.setMatrixAt(i, list[i]);
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        scene.add(im);
        meshes.push(im);
        disposables.push(im);
      }
      disposables.push(aoGeo, aoMat);
    }

    return {
      update(_dt, elapsed) {
        shared.uTime.value = elapsed;
        shared.uCamPos.value.copy(ctx.camera.position);
        recentreGrass(ctx.camera.position.x, ctx.camera.position.z);
      },
      dispose() {
        meshes.forEach((m) => scene.remove(m));
        disposables.forEach((d) => d.dispose());
        for (const c of myColliders) {
          const i = ctx.colliders.indexOf(c);
          if (i >= 0) ctx.colliders.splice(i, 1);
        }
      },
    };
  },
};

export default mod;
