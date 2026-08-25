/**
 * ai/characters.ts — every human being in San Francisco, in one draw call.
 *
 * There are no skeletons, no skinned meshes and no animation clips here, and
 * that is a deliberate engineering choice rather than a shortcut. A crowd of
 * three hundred skinned characters means three hundred bone-matrix uploads and
 * three hundred draw calls, which is the entire frame budget of a browser game
 * spent on background pedestrians. Instead:
 *
 *   - ONE geometry contains every part any character might need: body, hair,
 *     police cap, combat helmet, plate carrier, rifle, holstered sidearm,
 *     backpack, long coat. Each vertex carries the id of the *joint* it belongs
 *     to and the id of the *optional slot* it belongs to.
 *
 *   - The vertex shader poses the body by walking a hardcoded, unrolled joint
 *     chain — foot → shin → thigh → pelvis, four rotations deep at worst — and
 *     collapses any optional part whose bit is clear in the instance's mask to
 *     a degenerate triangle. A civilian and a SWAT operator are the same mesh
 *     with different mask bits.
 *
 *   - The gait is *synthesised*, not sampled. Walk, run, idle, aim, cower, sit
 *     and death all come out of half a dozen sines driven by a per-instance
 *     phase and speed. The result is a crowd where nobody is in lockstep with
 *     anybody, at the cost of one float per agent per frame.
 *
 * The material is a real `MeshStandardMaterial` — it takes the sun, the marine
 * layer, the shadow cascades and the tone mapping like everything else in the
 * city — with an injected fragment stage that gives each region its own
 * micro-surface: woven cloth on the shirt, twill on the denim, oiled skin, a
 * matte roughened polymer on the armour, and a dirt gradient rising from the
 * shoes. No untextured mannequins.
 *
 * Public API
 * ----------
 *   CHAR_SLOT_*                        optional-part bit constants
 *   buildCharacterGeometry(detail)     the shared geometry
 *   CharacterBatch                     instanced renderer + attribute writer
 *   CHARACTER_PALETTES                 seeded wardrobe
 *   archetypeMask / archetypeTint
 */
import * as THREE from "three";
import type { Rng } from "../math/rng";
import { ANIM_IDLE, type AnimClip, type CharacterArchetype } from "./types";

/* ================================================================== *
 * Skeleton
 * ================================================================== *
 * Metric, feet on y = 0, facing +X. Facing +X rather than the more usual −Z
 * because every heading in this game comes out of `atan2(dz, dx)` against the
 * road graph, and one convention beats two conversions.
 */

export const J_ROOT = 0;
export const J_PELVIS = 1;
export const J_TORSO = 2;
export const J_HEAD = 3;
export const J_UARM_L = 4;
export const J_FARM_L = 5;
export const J_UARM_R = 6;
export const J_FARM_R = 7;
export const J_THIGH_L = 8;
export const J_SHIN_L = 9;
export const J_THIGH_R = 10;
export const J_SHIN_R = 11;
export const J_FOOT_L = 12;
export const J_FOOT_R = 13;

/**
 * Joint pivots in the rest pose. Left is +Z, forward is +X.
 *
 * The vertex shader hardcodes these numbers rather than reading a uniform
 * array, because dynamic indexing into uniforms is the one GLSL feature whose
 * support you cannot assume across the tiers this ships to. This table is the
 * authority they mirror — change one and change both — and it is exported so
 * that anything wanting to attach a prop to a hand or a muzzle flash to a
 * rifle has the same skeleton the shader is using.
 */
export const CHARACTER_PIVOTS: Record<number, [number, number, number]> = {
  [J_PELVIS]: [0, 0.96, 0],
  [J_TORSO]: [0, 1.0, 0],
  [J_HEAD]: [0, 1.5, 0],
  [J_UARM_L]: [0, 1.44, 0.185],
  [J_FARM_L]: [0, 1.16, 0.2],
  [J_UARM_R]: [0, 1.44, -0.185],
  [J_FARM_R]: [0, 1.16, -0.2],
  [J_THIGH_L]: [0, 0.93, 0.095],
  [J_SHIN_L]: [0, 0.49, 0.1],
  [J_THIGH_R]: [0, 0.93, -0.095],
  [J_SHIN_R]: [0, 0.49, -0.1],
  [J_FOOT_L]: [0, 0.085, 0.1],
  [J_FOOT_R]: [0, 0.085, -0.1],
};

/* ------------------------------------------------------------------ *
 * Optional parts
 * ------------------------------------------------------------------ *
 * Bit index, not bit value — the shader recovers the bit with a power of two.
 * Slot 0 means "always present".
 */
export const CHAR_SLOT_ALWAYS = 0;
export const CHAR_SLOT_HAIR = 1;
export const CHAR_SLOT_CAP = 2;
export const CHAR_SLOT_HELMET = 3;
export const CHAR_SLOT_VEST = 4;
export const CHAR_SLOT_RIFLE = 5;
export const CHAR_SLOT_SIDEARM = 6;
export const CHAR_SLOT_BACKPACK = 7;
export const CHAR_SLOT_COAT = 8;

export const CHAR_MASK_HAIR = 1 << (CHAR_SLOT_HAIR - 1);
export const CHAR_MASK_CAP = 1 << (CHAR_SLOT_CAP - 1);
export const CHAR_MASK_HELMET = 1 << (CHAR_SLOT_HELMET - 1);
export const CHAR_MASK_VEST = 1 << (CHAR_SLOT_VEST - 1);
export const CHAR_MASK_RIFLE = 1 << (CHAR_SLOT_RIFLE - 1);
export const CHAR_MASK_SIDEARM = 1 << (CHAR_SLOT_SIDEARM - 1);
export const CHAR_MASK_BACKPACK = 1 << (CHAR_SLOT_BACKPACK - 1);
export const CHAR_MASK_COAT = 1 << (CHAR_SLOT_COAT - 1);

/* ------------------------------------------------------------------ *
 * Surface regions — which instance colour and which micro-surface
 * ------------------------------------------------------------------ */
const R_SKIN = 0;
const R_TOP = 1;
const R_BOTTOM = 2;
const R_HAIR = 3;
const R_SHOE = 4;
const R_ACCENT = 5;
const R_GEAR = 6;

/* ================================================================== *
 * Geometry construction
 * ================================================================== */

class MeshBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  joint: number[] = [];
  region: number[] = [];
  slot: number[] = [];
  idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  vert(
    x: number,
    y: number,
    z: number,
    u: number,
    v: number,
    joint: number,
    region: number,
    slot: number,
  ): number {
    const i = this.vertexCount;
    this.pos.push(x, y, z);
    this.nrm.push(0, 0, 0);
    this.uv.push(u, v);
    this.joint.push(joint);
    this.region.push(region);
    this.slot.push(slot);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /** Accumulate face normals, then normalise. Smooth shading with hard edges
   *  only where the topology is actually split — a low-poly body with faceted
   *  normals reads as a paper model, which is not the look. */
  finish(): void {
    const p = this.pos;
    const n = this.nrm;
    for (let i = 0; i < this.idx.length; i += 3) {
      const a = this.idx[i] * 3;
      const b = this.idx[i + 1] * 3;
      const c = this.idx[i + 2] * 3;
      const ax = p[b] - p[a];
      const ay = p[b + 1] - p[a + 1];
      const az = p[b + 2] - p[a + 2];
      const bx = p[c] - p[a];
      const by = p[c + 1] - p[a + 1];
      const bz = p[c + 2] - p[a + 2];
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;
      n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
      n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
      n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
      n[i] /= l;
      n[i + 1] /= l;
      n[i + 2] /= l;
    }
  }
}

/**
 * One ring of a swept limb: height, half-extent forward (X), half-extent
 * lateral (Z), and a forward/lateral offset so a chest can be pushed forward
 * of the pelvis and a calf can sit behind the knee.
 */
type Ring = [y: number, rx: number, rz: number, ox: number, oz: number];

/**
 * Sweep an elliptical profile. This is the whole modelling toolkit: torso,
 * head, every limb, the helmet and the backpack are all swept ellipses, which
 * is why the silhouette reads as *drawn* rather than as boxes glued together.
 */
function sweep(
  b: MeshBuilder,
  rings: Ring[],
  sides: number,
  joint: number,
  region: number,
  slot: number,
  capBottom = true,
  capTop = true,
): void {
  const start = b.vertexCount;
  const n = rings.length;
  for (let r = 0; r < n; r++) {
    const [y, rx, rz, ox, oz] = rings[r];
    const v = r / (n - 1);
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      // Slight squaring of the ellipse — pure circles look inflated on cloth.
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const k = 1 + 0.09 * Math.cos(4 * a);
      b.vert(ox + ca * rx * k, y, oz + sa * rz * k, s / sides, v, joint, region, slot);
    }
  }
  const stride = sides + 1;
  for (let r = 0; r < n - 1; r++) {
    for (let s = 0; s < sides; s++) {
      const a = start + r * stride + s;
      b.quad(a, a + 1, a + stride + 1, a + stride);
    }
  }
  if (capBottom) {
    const [y, , , ox, oz] = rings[0];
    const c = b.vert(ox, y, oz, 0.5, 0, joint, region, slot);
    for (let s = 0; s < sides; s++) {
      b.tri(c, start + s, start + s + 1);
    }
  }
  if (capTop) {
    const [y, , , ox, oz] = rings[n - 1];
    const base = start + (n - 1) * stride;
    const c = b.vert(ox, y, oz, 0.5, 1, joint, region, slot);
    for (let s = 0; s < sides; s++) {
      b.tri(c, base + s + 1, base + s);
    }
  }
}

/** A rounded box, used for feet, hands, magazines and the rifle body. */
function box(
  b: MeshBuilder,
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  joint: number,
  region: number,
  slot: number,
): void {
  const s = b.vertexCount;
  const hx = sx * 0.5;
  const hy = sy * 0.5;
  const hz = sz * 0.5;
  const corners: [number, number, number][] = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz],
    [-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  for (let i = 0; i < 8; i++) {
    const c = corners[i];
    b.vert(cx + c[0], cy + c[1], cz + c[2], (i & 1) as number, (i >> 2) as number, joint, region, slot);
  }
  b.quad(s + 0, s + 3, s + 2, s + 1); // bottom
  b.quad(s + 4, s + 5, s + 6, s + 7); // top
  b.quad(s + 0, s + 1, s + 5, s + 4);
  b.quad(s + 1, s + 2, s + 6, s + 5);
  b.quad(s + 2, s + 3, s + 7, s + 6);
  b.quad(s + 3, s + 0, s + 4, s + 7);
}

/**
 * Build the shared character geometry.
 *
 * `detail` 0 is the near mesh (8-sided limbs, ~900 triangles); 1 is the far
 * mesh (5-sided, fewer rings, ~330 triangles) used past 55 m, where the
 * difference is a couple of pixels and the saving is two thirds of the crowd's
 * vertex cost.
 */
export function buildCharacterGeometry(detail: 0 | 1 = 0): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const hi = detail === 0;
  const limbSides = hi ? 7 : 5;
  const bodySides = hi ? 9 : 5;

  /* ---- torso: pelvis block + ribcage, waisted, chest pushed forward ---- */
  sweep(
    b,
    hi
      ? ([
          [0.86, 0.115, 0.155, 0, 0],
          [1.0, 0.108, 0.152, 0.004, 0],
          [1.14, 0.098, 0.142, 0.008, 0],
          [1.28, 0.112, 0.165, 0.012, 0],
          [1.4, 0.12, 0.185, 0.01, 0],
          [1.47, 0.1, 0.168, 0, 0],
        ] as Ring[])
      : ([
          [0.86, 0.115, 0.155, 0, 0],
          [1.14, 0.098, 0.145, 0.008, 0],
          [1.4, 0.12, 0.185, 0.01, 0],
          [1.47, 0.1, 0.168, 0, 0],
        ] as Ring[]),
    bodySides,
    J_TORSO,
    R_TOP,
    CHAR_SLOT_ALWAYS,
  );

  /* ---- neck + head ---- */
  sweep(
    b,
    [
      [1.45, 0.055, 0.06, 0.005, 0],
      [1.56, 0.05, 0.055, 0.008, 0],
    ] as Ring[],
    limbSides,
    J_HEAD,
    R_SKIN,
    CHAR_SLOT_ALWAYS,
    false,
    false,
  );
  sweep(
    b,
    hi
      ? ([
          [1.56, 0.062, 0.068, 0.006, 0],
          [1.62, 0.085, 0.086, 0.012, 0],
          [1.68, 0.092, 0.09, 0.014, 0],
          [1.74, 0.086, 0.084, 0.008, 0],
          [1.79, 0.055, 0.055, 0, 0],
        ] as Ring[])
      : ([
          [1.56, 0.062, 0.068, 0.006, 0],
          [1.68, 0.092, 0.09, 0.013, 0],
          [1.79, 0.055, 0.055, 0, 0],
        ] as Ring[]),
    bodySides,
    J_HEAD,
    R_SKIN,
    CHAR_SLOT_ALWAYS,
  );
  // Nose + brow: two tiny wedges. They cost eight triangles and they are the
  // difference between a head and a potato at conversational distance.
  if (hi) {
    box(b, 0.098, 1.665, 0, 0.03, 0.028, 0.022, J_HEAD, R_SKIN, CHAR_SLOT_ALWAYS);
    box(b, 0.086, 1.702, 0, 0.022, 0.014, 0.12, J_HEAD, R_SKIN, CHAR_SLOT_ALWAYS);
  }

  /* ---- hair: a cap that hugs the skull, slot-gated ---- */
  sweep(
    b,
    hi
      ? ([
          [1.655, 0.098, 0.096, 0.008, 0],
          [1.715, 0.1, 0.097, 0.006, 0],
          [1.765, 0.093, 0.09, 0.002, 0],
          [1.802, 0.05, 0.05, 0, 0],
        ] as Ring[])
      : ([
          [1.655, 0.098, 0.096, 0.008, 0],
          [1.77, 0.09, 0.088, 0.002, 0],
          [1.802, 0.05, 0.05, 0, 0],
        ] as Ring[]),
    bodySides,
    J_HEAD,
    R_HAIR,
    CHAR_SLOT_HAIR,
    false,
  );

  /* ---- police cap: crown + peak ---- */
  sweep(
    b,
    [
      [1.735, 0.1, 0.098, 0.004, 0],
      [1.79, 0.104, 0.1, 0.004, 0],
      [1.815, 0.09, 0.088, 0.002, 0],
    ] as Ring[],
    bodySides,
    J_HEAD,
    R_ACCENT,
    CHAR_SLOT_CAP,
  );
  box(b, 0.15, 1.742, 0, 0.09, 0.016, 0.15, J_HEAD, R_ACCENT, CHAR_SLOT_CAP);

  /* ---- combat helmet: deeper shell, ear cups ---- */
  sweep(
    b,
    hi
      ? ([
          [1.63, 0.108, 0.106, 0.006, 0],
          [1.7, 0.114, 0.112, 0.006, 0],
          [1.76, 0.108, 0.106, 0.004, 0],
          [1.81, 0.062, 0.06, 0, 0],
        ] as Ring[])
      : ([
          [1.63, 0.108, 0.106, 0.006, 0],
          [1.76, 0.11, 0.108, 0.005, 0],
          [1.81, 0.062, 0.06, 0, 0],
        ] as Ring[]),
    bodySides,
    J_HEAD,
    R_GEAR,
    CHAR_SLOT_HELMET,
    false,
  );
  box(b, -0.02, 1.63, 0.108, 0.11, 0.075, 0.03, J_HEAD, R_GEAR, CHAR_SLOT_HELMET);
  box(b, -0.02, 1.63, -0.108, 0.11, 0.075, 0.03, J_HEAD, R_GEAR, CHAR_SLOT_HELMET);

  /* ---- plate carrier over the chest ---- */
  sweep(
    b,
    hi
      ? ([
          [1.06, 0.124, 0.166, 0.006, 0],
          [1.2, 0.118, 0.162, 0.01, 0],
          [1.33, 0.132, 0.184, 0.014, 0],
          [1.42, 0.134, 0.196, 0.01, 0],
        ] as Ring[])
      : ([
          [1.06, 0.124, 0.166, 0.006, 0],
          [1.42, 0.134, 0.19, 0.012, 0],
        ] as Ring[]),
    bodySides,
    J_TORSO,
    R_ACCENT,
    CHAR_SLOT_VEST,
    false,
    false,
  );
  // Magazine pouches across the front — the silhouette cue that says "armed".
  box(b, 0.132, 1.16, 0.06, 0.05, 0.11, 0.07, J_TORSO, R_GEAR, CHAR_SLOT_VEST);
  box(b, 0.132, 1.16, -0.02, 0.05, 0.11, 0.07, J_TORSO, R_GEAR, CHAR_SLOT_VEST);
  box(b, 0.132, 1.16, -0.1, 0.05, 0.11, 0.07, J_TORSO, R_GEAR, CHAR_SLOT_VEST);

  /* ---- backpack ---- */
  sweep(
    b,
    [
      [1.02, 0.07, 0.12, -0.15, 0],
      [1.18, 0.08, 0.135, -0.16, 0],
      [1.34, 0.07, 0.12, -0.15, 0],
    ] as Ring[],
    limbSides,
    J_TORSO,
    R_GEAR,
    CHAR_SLOT_BACKPACK,
  );

  /* ---- long coat: a flared skirt hanging from the waist ---- */
  sweep(
    b,
    [
      [1.02, 0.13, 0.175, 0, 0],
      [0.84, 0.15, 0.2, -0.005, 0],
      [0.66, 0.165, 0.215, -0.012, 0],
    ] as Ring[],
    bodySides,
    J_PELVIS,
    R_TOP,
    CHAR_SLOT_COAT,
    false,
    false,
  );

  /* ---- arms ---- */
  for (const side of [1, -1] as const) {
    const zs = side * 1;
    const ju = side > 0 ? J_UARM_L : J_UARM_R;
    const jf = side > 0 ? J_FARM_L : J_FARM_R;
    sweep(
      b,
      hi
        ? ([
            [1.45, 0.058, 0.058, 0, 0.19 * zs],
            [1.3, 0.05, 0.05, 0, 0.196 * zs],
            [1.16, 0.044, 0.044, 0, 0.2 * zs],
          ] as Ring[])
        : ([
            [1.45, 0.058, 0.058, 0, 0.19 * zs],
            [1.16, 0.045, 0.045, 0, 0.2 * zs],
          ] as Ring[]),
      limbSides,
      ju,
      R_TOP,
      CHAR_SLOT_ALWAYS,
    );
    sweep(
      b,
      hi
        ? ([
            [1.16, 0.044, 0.044, 0, 0.2 * zs],
            [1.02, 0.038, 0.038, 0, 0.205 * zs],
            [0.9, 0.032, 0.032, 0, 0.208 * zs],
          ] as Ring[])
        : ([
            [1.16, 0.044, 0.044, 0, 0.2 * zs],
            [0.9, 0.033, 0.033, 0, 0.207 * zs],
          ] as Ring[]),
      limbSides,
      jf,
      R_SKIN,
      CHAR_SLOT_ALWAYS,
    );
    box(b, 0.01, 0.855, 0.208 * zs, 0.07, 0.09, 0.05, jf, R_SKIN, CHAR_SLOT_ALWAYS);
  }

  /* ---- legs ---- */
  for (const side of [1, -1] as const) {
    const zs = side * 1;
    const jt = side > 0 ? J_THIGH_L : J_THIGH_R;
    const js = side > 0 ? J_SHIN_L : J_SHIN_R;
    const jf = side > 0 ? J_FOOT_L : J_FOOT_R;
    sweep(
      b,
      hi
        ? ([
            [0.95, 0.085, 0.088, 0, 0.095 * zs],
            [0.76, 0.078, 0.081, 0.004, 0.098 * zs],
            [0.6, 0.068, 0.07, 0.004, 0.1 * zs],
            [0.49, 0.06, 0.062, 0, 0.1 * zs],
          ] as Ring[])
        : ([
            [0.95, 0.085, 0.088, 0, 0.095 * zs],
            [0.49, 0.062, 0.064, 0.002, 0.1 * zs],
          ] as Ring[]),
      limbSides,
      jt,
      R_BOTTOM,
      CHAR_SLOT_ALWAYS,
    );
    sweep(
      b,
      hi
        ? ([
            [0.49, 0.06, 0.062, 0, 0.1 * zs],
            [0.36, 0.058, 0.06, -0.006, 0.1 * zs],
            [0.2, 0.045, 0.047, -0.004, 0.1 * zs],
            [0.09, 0.038, 0.04, 0, 0.1 * zs],
          ] as Ring[])
        : ([
            [0.49, 0.06, 0.062, 0, 0.1 * zs],
            [0.09, 0.04, 0.042, -0.003, 0.1 * zs],
          ] as Ring[]),
      limbSides,
      js,
      R_BOTTOM,
      CHAR_SLOT_ALWAYS,
    );
    box(b, 0.04, 0.042, 0.1 * zs, 0.245, 0.084, 0.092, jf, R_SHOE, CHAR_SLOT_ALWAYS);
  }

  /* ---- rifle, carried low-ready in the right hand ---- */
  box(b, 0.3, 0.98, -0.19, 0.62, 0.055, 0.05, J_FARM_R, R_GEAR, CHAR_SLOT_RIFLE);
  box(b, 0.16, 0.94, -0.19, 0.09, 0.13, 0.04, J_FARM_R, R_GEAR, CHAR_SLOT_RIFLE);
  box(b, -0.02, 0.985, -0.19, 0.22, 0.075, 0.045, J_FARM_R, R_GEAR, CHAR_SLOT_RIFLE);
  box(b, 0.2, 1.03, -0.19, 0.2, 0.028, 0.03, J_FARM_R, R_GEAR, CHAR_SLOT_RIFLE);

  /* ---- holstered sidearm on the right hip ---- */
  box(b, 0.0, 0.82, -0.15, 0.1, 0.16, 0.06, J_PELVIS, R_GEAR, CHAR_SLOT_SIDEARM);

  b.finish();

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(b.nrm, 3));
  // Named `aUv`, not `uv`: three only declares the built-in `uv` attribute when
  // a material actually samples a map, and this one never does — the surface is
  // synthesised. Borrowing the built-in name compiles on some tiers and fails
  // on others, which is the worst possible failure mode.
  g.setAttribute("aUv", new THREE.Float32BufferAttribute(b.uv, 2));
  g.setAttribute("aJoint", new THREE.Float32BufferAttribute(b.joint, 1));
  g.setAttribute("aRegion", new THREE.Float32BufferAttribute(b.region, 1));
  g.setAttribute("aSlot", new THREE.Float32BufferAttribute(b.slot, 1));
  g.setIndex(b.idx);
  return g;
}

/* ================================================================== *
 * Shader
 * ================================================================== */

/** Emit `piv + Rz(a) * (p − piv)` — the swing axis for every limb. */

/**
 * Declarations shared by the lit and depth vertex stages. Both stages run the
 * *identical* pose code — a shadow that does not match the body is the single
 * most obvious tell that a crowd is faked in the vertex shader.
 */
const GLSL_HELPERS = /* glsl */ `
attribute float aJoint;
attribute float aRegion;
attribute float aSlot;
attribute vec2  aUv;

attribute vec3  iPos;
attribute vec4  iAnim;     // phase, speed m/s, clip id, clip blend
attribute vec4  iBody;     // yaw, height scale, girth scale, optional-part mask
attribute vec3  iSkin;
attribute vec3  iTop;
attribute vec3  iBottom;
attribute vec3  iHair;
attribute vec3  iAccent;
attribute vec2  iExtra;    // seed, wound soak 0..1

varying vec3 vBaseColor;
varying float vRegion;
varying float vSeed;
varying float vSoak;
varying vec2 vSurfUv;

vec3 sfRotZ(vec3 p, vec3 piv, float a) {
  vec3 d = p - piv;
  float c = cos(a), s = sin(a);
  return piv + vec3(d.x * c - d.y * s, d.x * s + d.y * c, d.z);
}
vec3 sfRotY(vec3 p, vec3 piv, float a) {
  vec3 d = p - piv;
  float c = cos(a), s = sin(a);
  return piv + vec3(d.x * c + d.z * s, d.y, -d.x * s + d.z * c);
}
vec3 sfRotX(vec3 p, vec3 piv, float a) {
  vec3 d = p - piv;
  float c = cos(a), s = sin(a);
  return piv + vec3(d.x, d.y * c - d.z * s, d.y * s + d.z * c);
}
`;

/**
 * The pose solver.
 *
 * Emitted at `beginnormal_vertex`, which three includes before `begin_vertex`,
 * so both the normal and the position stages can read its scalars without the
 * trig being computed twice.
 */
const GLSL_POSE = /* glsl */ `
  float sfClip  = iAnim.z;
  float sfBlend = iAnim.w;
  float sfSpd   = iAnim.y;
  float sfPh    = iAnim.x;
  float sfSeed  = iExtra.x;

  float sfMoving = smoothstep(0.06, 0.85, sfSpd);
  float sfRun    = smoothstep(2.9, 6.2, sfSpd);
  float sfW      = sfPh * 6.28318530718;
  float sfS1 = sin(sfW);
  float sfC1 = cos(sfW);
  float sfS2 = sin(2.0 * sfW);

  // Clip weights. Locomotion is always the base; aim layers on top of it, the
  // rest override it. Blending is done by the sim ramping sfBlend, so a
  // pedestrian dropping into a cower folds over a quarter second instead of
  // snapping.
  float wAim   = step(2.5, sfClip) * step(sfClip, 3.5) * sfBlend;
  float wCower = step(3.5, sfClip) * step(sfClip, 4.5) * sfBlend;
  float wDead  = step(4.5, sfClip) * step(sfClip, 5.5) * sfBlend;
  float wSit   = step(5.5, sfClip) * step(sfClip, 6.5) * sfBlend;
  float wOver  = clamp(wCower + wDead + wSit, 0.0, 1.0);

  // ---- locomotion ----
  float legAmp = mix(0.42, 1.02, sfRun) * sfMoving;
  float thighL = sfS1 * legAmp;
  float thighR = -sfS1 * legAmp;
  // Knees fold backwards only; a hyperextending knee is instantly, unmissably
  // wrong even on a background pedestrian.
  float kneeL = max(0.0, -sin(sfW + 0.55)) * mix(0.85, 1.85, sfRun) * sfMoving;
  float kneeR = max(0.0, -sin(sfW + 0.55 + 3.14159265)) * mix(0.85, 1.85, sfRun) * sfMoving;
  float footL = -kneeL * 0.35 + sfS1 * 0.12 * sfMoving;
  float footR = -kneeR * 0.35 - sfS1 * 0.12 * sfMoving;

  float armAmp = mix(0.3, 0.78, sfRun) * sfMoving;
  float armL = -sfS1 * armAmp;
  float armR = sfS1 * armAmp;
  float elbowBase = mix(0.18, 0.62, sfRun) * sfMoving + 0.1;
  float elbowL = elbowBase + max(0.0, sfS1) * 0.3 * sfMoving;
  float elbowR = elbowBase + max(0.0, -sfS1) * 0.3 * sfMoving;

  float breathe = sin(sfSeed * 12.9 + sfPh * 1.7) * 0.018 * (1.0 - sfMoving);
  float torsoPitch = mix(0.02, 0.24, sfRun) * sfMoving + breathe;
  float torsoRoll = sfC1 * 0.055 * sfMoving;
  float torsoYaw = -sfS1 * 0.09 * sfMoving;
  float headYaw = sfS1 * 0.06 * sfMoving + sin(sfSeed * 31.7 + sfPh * 0.7) * 0.12 * (1.0 - sfMoving);
  float headPitch = -torsoPitch * 0.55;
  float bob = (-abs(sfS2) * 0.035 - 0.02) * sfMoving * mix(0.6, 1.6, sfRun);

  // ---- aim: weapon up, torso squared to the target, elbows tucked ----
  armL = mix(armL, -1.45, wAim);
  armR = mix(armR, -1.35, wAim);
  elbowL = mix(elbowL, 1.15, wAim);
  elbowR = mix(elbowR, 0.95, wAim);
  torsoPitch = mix(torsoPitch, 0.12, wAim);
  torsoYaw = mix(torsoYaw, -0.28, wAim);

  // ---- cower: folded down, arms over the head ----
  torsoPitch = mix(torsoPitch, 0.95, wCower);
  thighL = mix(thighL, 0.9, wCower);
  thighR = mix(thighR, 0.9, wCower);
  kneeL = mix(kneeL, 1.5, wCower);
  kneeR = mix(kneeR, 1.5, wCower);
  armL = mix(armL, -2.5, wCower);
  armR = mix(armR, -2.5, wCower);
  elbowL = mix(elbowL, 1.9, wCower);
  elbowR = mix(elbowR, 1.9, wCower);
  headPitch = mix(headPitch, 0.6, wCower);

  // ---- sit (bus stops, park benches, café tables) ----
  thighL = mix(thighL, 1.5, wSit);
  thighR = mix(thighR, 1.5, wSit);
  kneeL = mix(kneeL, 1.5, wSit);
  kneeR = mix(kneeR, 1.5, wSit);
  torsoPitch = mix(torsoPitch, -0.05, wSit);

  // ---- death: limbs go limp; the lay-over happens after scaling ----
  armL = mix(armL, 0.35, wDead);
  armR = mix(armR, -0.3, wDead);
  elbowL = mix(elbowL, 0.5, wDead);
  elbowR = mix(elbowR, 0.4, wDead);
  thighL = mix(thighL, 0.25, wDead);
  thighR = mix(thighR, -0.15, wDead);
  kneeL = mix(kneeL, 0.55, wDead);
  kneeR = mix(kneeR, 0.3, wDead);
  torsoPitch = mix(torsoPitch, -0.1, wDead);
  bob = mix(bob, 0.0, wOver);

  // ---- optional parts: collapse the unmasked ones to a point ----
  vec3 sfPose = position;
  if (aSlot > 0.5) {
    float bit = floor(mod(floor(iBody.w / exp2(aSlot - 1.0)), 2.0) + 0.5);
    if (bit < 0.5) sfPose = vec3(0.0, 1.2, 0.0);
  }

  // ---- the joint chain, unrolled deepest-first ----
  // Parents always have a lower id than their children, so a single descending
  // pass visits every joint on the chain exactly once with no loop and no
  // dynamic indexing.
  float sfJ = aJoint;
  if (sfJ > 12.5) { sfPose = sfRotZ(sfPose, vec3(0.0, 0.085, -0.1), footR); sfJ = 11.0; }
  if (sfJ > 11.5 && sfJ < 12.5) { sfPose = sfRotZ(sfPose, vec3(0.0, 0.085, 0.1), footL); sfJ = 9.0; }
  if (sfJ > 10.5 && sfJ < 11.5) { sfPose = sfRotZ(sfPose, vec3(0.0, 0.49, -0.1), kneeR); sfJ = 10.0; }
  if (sfJ > 9.5 && sfJ < 10.5) { sfPose = sfRotZ(sfPose, vec3(0.0, 0.93, -0.095), thighR); sfJ = 1.0; }
  if (sfJ > 8.5 && sfJ < 9.5) { sfPose = sfRotZ(sfPose, vec3(0.0, 0.49, 0.1), kneeL); sfJ = 8.0; }
  if (sfJ > 7.5 && sfJ < 8.5) { sfPose = sfRotZ(sfPose, vec3(0.0, 0.93, 0.095), thighL); sfJ = 1.0; }
  if (sfJ > 6.5 && sfJ < 7.5) { sfPose = sfRotZ(sfPose, vec3(0.0, 1.16, -0.2), elbowR); sfJ = 6.0; }
  if (sfJ > 5.5 && sfJ < 6.5) { sfPose = sfRotZ(sfPose, vec3(0.0, 1.44, -0.185), armR); sfJ = 2.0; }
  if (sfJ > 4.5 && sfJ < 5.5) { sfPose = sfRotZ(sfPose, vec3(0.0, 1.16, 0.2), elbowL); sfJ = 4.0; }
  if (sfJ > 3.5 && sfJ < 4.5) { sfPose = sfRotZ(sfPose, vec3(0.0, 1.44, 0.185), armL); sfJ = 2.0; }
  if (sfJ > 2.5 && sfJ < 3.5) {
    sfPose = sfRotY(sfPose, vec3(0.0, 1.5, 0.0), headYaw);
    sfPose = sfRotZ(sfPose, vec3(0.0, 1.5, 0.0), headPitch);
    sfJ = 2.0;
  }
  if (sfJ > 1.5 && sfJ < 2.5) {
    sfPose = sfRotZ(sfPose, vec3(0.0, 1.0, 0.0), torsoPitch);
    sfPose = sfRotY(sfPose, vec3(0.0, 1.0, 0.0), torsoYaw);
    sfPose = sfRotX(sfPose, vec3(0.0, 1.0, 0.0), torsoRoll);
    sfJ = 1.0;
  }
  if (sfJ > 0.5 && sfJ < 1.5) {
    sfPose = sfRotX(sfPose, vec3(0.0, 0.96, 0.0), -torsoRoll * 0.5);
  }

  // Proportions: height along Y, girth in the transverse plane. Two floats buy
  // an entire population of body types.
  sfPose.y *= iBody.y;
  sfPose.x *= iBody.z;
  sfPose.z *= iBody.z;
  sfPose.y += bob * iBody.y;

  // Death lays the body over on its side about the hips.
  if (wDead > 0.001) {
    vec3 hip = vec3(0.0, 0.85 * iBody.y, 0.0);
    sfPose = sfRotX(sfPose, hip, 1.57079633 * wDead);
    sfPose.y -= 0.62 * iBody.y * wDead;
  }

  float sfCy = cos(iBody.x);
  float sfSy = sin(iBody.x);
  vec3 sfWorld = vec3(sfPose.x * sfCy - sfPose.z * sfSy, sfPose.y, sfPose.x * sfSy + sfPose.z * sfCy);
  sfWorld += iPos;
`;

/**
 * Normals follow the torso rotation and the world yaw rather than the full
 * chain. Re-running thirteen joint rotations on the normal doubles the vertex
 * cost to fix shading on limbs that are 40 px tall; the torso term is what the
 * eye actually reads, and it is exact there.
 */
const GLSL_NORMAL = /* glsl */ `
  vec3 sfN = objectNormal;
  sfN = sfRotZ(sfN, vec3(0.0), torsoPitch * 0.4);
  if (wDead > 0.001) sfN = sfRotX(sfN, vec3(0.0), 1.57079633 * wDead);
  objectNormal = vec3(sfN.x * sfCy - sfN.z * sfSy, sfN.y, sfN.x * sfSy + sfN.z * sfCy);
`;

const GLSL_VARYINGS = /* glsl */ `
  vRegion = aRegion;
  vSeed = sfSeed;
  vSoak = iExtra.y;
  vSurfUv = aUv;
  vec3 sfBase = iTop;
  if (aRegion < 0.5) sfBase = iSkin;
  else if (aRegion < 1.5) sfBase = iTop;
  else if (aRegion < 2.5) sfBase = iBottom;
  else if (aRegion < 3.5) sfBase = iHair;
  else if (aRegion < 4.5) sfBase = iBottom * 0.28 + vec3(0.02);
  else if (aRegion < 5.5) sfBase = iAccent;
  else sfBase = iAccent * 0.34 + vec3(0.028, 0.03, 0.032);
  vBaseColor = sfBase;
`;

const GLSL_FRAG_HEAD = /* glsl */ `
varying vec3 vBaseColor;
varying float vRegion;
varying float vSeed;
varying float vSoak;
varying vec2 vSurfUv;

float sfHash2(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float sfNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sfHash2(i), sfHash2(i + vec2(1.0, 0.0)), f.x),
             mix(sfHash2(i + vec2(0.0, 1.0)), sfHash2(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

/**
 * The surface stage. Every region gets its own micro-detail: nowhere on a
 * character is two square centimetres of flat colour, which is the whole
 * difference between "stylised" and "untextured".
 */
const GLSL_FRAG_BODY = /* glsl */ `
  {
    vec2 suv = vSurfUv;
    float reg = vRegion;
    vec3 tint = vBaseColor;
    float rough = 0.85;
    float metal = 0.0;

    float weave = (sin(suv.x * 340.0) * sin(suv.y * 260.0)) * 0.5 + 0.5;
    float folds = sfNoise2(suv * vec2(9.0, 5.0) + vSeed * 17.0);
    float grime = smoothstep(0.42, 0.0, suv.y);

    if (reg < 0.5) {
      float pore = sfNoise2(suv * 70.0 + vSeed * 3.0);
      tint *= 0.94 + pore * 0.12;
      tint = mix(tint, tint * vec3(1.06, 0.92, 0.88), folds * 0.25);
      rough = 0.52 + pore * 0.1;
    } else if (reg < 2.5) {
      tint *= 0.9 + weave * 0.14;
      tint *= 0.88 + folds * 0.24;
      tint *= 1.0 - grime * 0.18;
      rough = 0.86 - weave * 0.08;
    } else if (reg < 3.5) {
      float strand = sfNoise2(vec2(suv.x * 120.0, suv.y * 14.0) + vSeed);
      tint *= 0.72 + strand * 0.5;
      tint *= mix(0.7, 1.0, smoothstep(0.0, 0.6, suv.y));
      rough = 0.44 + strand * 0.2;
    } else if (reg < 4.5) {
      float scuff = sfNoise2(suv * 26.0 + vSeed * 5.0);
      tint *= 0.75 + scuff * 0.4;
      rough = 0.38 + scuff * 0.3;
    } else if (reg < 5.5) {
      float peel = sfNoise2(suv * 44.0 + vSeed * 7.0);
      tint *= 0.9 + peel * 0.16;
      rough = 0.42 + peel * 0.16;
      metal = 0.08;
    } else {
      float wear = sfNoise2(suv * 36.0 + vSeed * 11.0);
      tint *= 0.78 + wear * 0.34;
      rough = 0.36 + wear * 0.26;
      metal = 0.35;
    }

    // Wound soak — darkens and gloss-shifts as an agent takes rounds.
    tint = mix(tint, tint * vec3(0.42, 0.1, 0.09), vSoak * 0.7);
    rough = mix(rough, 0.28, vSoak * 0.5);

    diffuseColor.rgb *= tint;
    roughnessFactor = rough;
    metalnessFactor = metal;
  }
`;

/**
 * Ordered injection. `beginnormal_vertex` carries the pose (three includes it
 * first) and `begin_vertex` only consumes the result, so lit and depth passes
 * share one implementation and cannot drift apart.
 */
function injectCharacterVertex(shader: { vertexShader: string; fragmentShader: string }): void {
  shader.vertexShader = GLSL_HELPERS + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace(
    "#include <beginnormal_vertex>",
    `#include <beginnormal_vertex>\n${GLSL_POSE}\n${GLSL_NORMAL}`,
  );
  shader.vertexShader = shader.vertexShader.replace(
    "#include <begin_vertex>",
    `vec3 transformed = sfWorld;\n${GLSL_VARYINGS}`,
  );
}

/** The lit material — real PBR, so the crowd sits in the city's own light. */
export function makeCharacterMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0,
    dithering: true,
  });
  m.customProgramCacheKey = () => "sf-character-v1";
  m.onBeforeCompile = (shader) => {
    injectCharacterVertex(shader);
    shader.fragmentShader = GLSL_FRAG_HEAD + shader.fragmentShader;
    // After the metalness chunk: `roughnessFactor` and `metalnessFactor` are
    // both declared by then, and `diffuseColor` has already been established.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <metalnessmap_fragment>",
      `#include <metalnessmap_fragment>\n${GLSL_FRAG_BODY}`,
    );
  };
  return m;
}

/**
 * Depth material for the shadow pass — the same pose code, injected in a
 * different place.
 *
 * `depth_vert` wraps its `#include <beginnormal_vertex>` in
 * `#ifdef USE_DISPLACEMENTMAP`, which is not defined here — so injecting the
 * pose there (as the lit material does) puts it inside dead preprocessor
 * branches and leaves `sfWorld` undefined at `begin_vertex`. The depth pass
 * needs no normal, so the whole block goes at `begin_vertex` instead. Shadows
 * that silently fail to compile are a genuinely miserable afternoon.
 */
export function makeCharacterDepthMaterial(): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.customProgramCacheKey = () => "sf-character-depth-v1";
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = GLSL_HELPERS + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `${GLSL_POSE}\n  vec3 transformed = sfWorld;\n${GLSL_VARYINGS}`,
    );
  };
  return m;
}

/* ================================================================== *
 * Wardrobe
 * ================================================================== *
 * San Francisco does not dress in primary colours. Everything here is muted,
 * layered and slightly grey-shifted — fog city palette — with a small number of
 * saturated accents that read as a jacket rather than as programmer art.
 */

const SKIN_TONES = [
  0xf0c8a8, 0xe3b088, 0xd49a70, 0xb87c50, 0x8e5a38, 0x6b4227, 0x4a2d1c, 0xf5d5bb,
  0xc99668, 0xa06c44,
];

const TOP_COLOURS = [
  0x2b3440, 0x3d4a56, 0x59626b, 0x7d7466, 0x8e5f4a, 0x455c4a, 0x2f4858, 0x6a6f7a,
  0x9aa0a6, 0x4a3f52, 0x7a3f3a, 0x33383d, 0xb2a894, 0x5d6b7a, 0x86523f,
];

const BOTTOM_COLOURS = [
  0x2c3440, 0x3a4250, 0x1f2733, 0x4a4740, 0x5b5348, 0x33302e, 0x6c6a66, 0x272b31,
];

const HAIR_COLOURS = [
  0x1a1310, 0x2a1c14, 0x4a3220, 0x6b4a2c, 0x8a6a3c, 0x9a9a96, 0xd8d4cc, 0x120e0c,
  0x5c3a28, 0x3a2418,
];

/** Floats per instance colour block: skin, top, bottom, hair, accent. */
export const PALETTE_FLOATS = 15;

const _col = new THREE.Color();

function writeColour(out: Float32Array, offset: number, hex: number, jitter: number, rng: Rng): void {
  _col.setHex(hex, THREE.SRGBColorSpace);
  // Per-garment value jitter so two people in "navy" are not the same navy.
  const k = 1 + (rng.next() - 0.5) * jitter;
  out[offset] = Math.max(0, _col.r * k);
  out[offset + 1] = Math.max(0, _col.g * k);
  out[offset + 2] = Math.max(0, _col.b * k);
}

/**
 * A seeded wardrobe for one character. Returns 15 floats in the renderer's
 * working colour space: skin, top, bottom, hair, accent. Built once at spawn,
 * never per frame.
 */
export function makePalette(rng: Rng, archetype: CharacterArchetype): Float32Array {
  const p = new Float32Array(PALETTE_FLOATS);
  writeColour(p, 0, rng.pick(SKIN_TONES), 0.1, rng);
  writeColour(p, 3, rng.pick(TOP_COLOURS), 0.22, rng);
  writeColour(p, 6, rng.pick(BOTTOM_COLOURS), 0.18, rng);
  writeColour(p, 9, rng.pick(HAIR_COLOURS), 0.16, rng);
  writeColour(p, 12, 0x2a2f36, 0.2, rng);

  switch (archetype) {
    case "cop":
      // SFPD navy over black, with the vest as the accent.
      writeColour(p, 3, 0x1d2530, 0.08, rng);
      writeColour(p, 6, 0x171b21, 0.08, rng);
      writeColour(p, 12, 0x11151b, 0.1, rng);
      break;
    case "swat":
      writeColour(p, 3, 0x14181d, 0.06, rng);
      writeColour(p, 6, 0x11151a, 0.06, rng);
      writeColour(p, 12, 0x0e1114, 0.08, rng);
      break;
    case "soldier":
      writeColour(p, 3, rng.pick([0x4a4d33, 0x3f4535, 0x53523c]), 0.12, rng);
      writeColour(p, 6, rng.pick([0x44472f, 0x3a3f2c]), 0.12, rng);
      writeColour(p, 12, 0x3a3c2c, 0.12, rng);
      break;
    case "officer":
      writeColour(p, 3, 0x2f3428, 0.08, rng);
      writeColour(p, 6, 0x2a2e24, 0.08, rng);
      writeColour(p, 12, 0x5a4a22, 0.1, rng);
      break;
    case "worker":
      // Hi-vis is the one legitimately saturated thing on a city street.
      writeColour(p, 12, rng.pick([0xd8e04a, 0xe8871f]), 0.1, rng);
      break;
    case "tourist":
      writeColour(p, 3, rng.pick([0x9fb8c4, 0xd6c6a8, 0xb26a5c, 0x86a08c]), 0.2, rng);
      break;
    case "techie":
      // Grey marl or navy under the gilet, and the gilet is the accent: the
      // colours a company orders a thousand of.
      writeColour(p, 3, rng.pick([0x6a7078, 0x2b3440, 0x4a4f58, 0x8d9299]), 0.12, rng);
      writeColour(p, 6, rng.pick([0x2c3440, 0x3a4250, 0x4a4740]), 0.14, rng);
      writeColour(p, 12, rng.pick([0x1f2a36, 0x33383d, 0x2f4858, 0x4a3f52]), 0.14, rng);
      break;
    case "cyclist":
      // One saturated garment so a bike is visible in the fog, and black below.
      writeColour(p, 3, rng.pick([0xd8e04a, 0xe8871f, 0x2fa8d8, 0xd94a4a]), 0.16, rng);
      writeColour(p, 6, 0x1c1f24, 0.1, rng);
      writeColour(p, 12, rng.pick([0xd8e04a, 0xe8871f]), 0.12, rng);
      break;
    case "street":
      // Everything sun-bleached and road-dirty. Deliberately still a real
      // wardrobe — layered coats and work trousers, the clothes somebody was
      // wearing before — rather than a costume that reads as a punchline.
      writeColour(p, 3, rng.pick([0x4a4638, 0x3d4340, 0x5b5348, 0x6b5f4c, 0x33383d]), 0.26, rng);
      writeColour(p, 6, rng.pick([0x3a362c, 0x2b2f33, 0x4a4740]), 0.24, rng);
      writeColour(p, 9, rng.pick([0x6b5a44, 0x9a9a96, 0x4a3220, 0x2a1c14]), 0.2, rng);
      writeColour(p, 12, rng.pick([0x5b5348, 0x3f4535, 0x6c6a66]), 0.22, rng);
      break;
    default:
      break;
  }
  return p;
}

/** Which optional parts an archetype wears. */
export function archetypeMask(archetype: CharacterArchetype, rng: Rng): number {
  let m = 0;
  if (rng.chance(0.86)) m |= CHAR_MASK_HAIR;
  switch (archetype) {
    case "cop":
      m |= CHAR_MASK_VEST | CHAR_MASK_SIDEARM;
      if (rng.chance(0.7)) m |= CHAR_MASK_CAP;
      break;
    case "swat":
      m = CHAR_MASK_HELMET | CHAR_MASK_VEST | CHAR_MASK_RIFLE | CHAR_MASK_SIDEARM;
      break;
    case "soldier":
      m = CHAR_MASK_HELMET | CHAR_MASK_VEST | CHAR_MASK_RIFLE;
      if (rng.chance(0.4)) m |= CHAR_MASK_BACKPACK;
      break;
    case "officer":
      m |= CHAR_MASK_CAP | CHAR_MASK_SIDEARM | CHAR_MASK_VEST;
      break;
    case "worker":
      m |= CHAR_MASK_VEST;
      if (rng.chance(0.35)) m |= CHAR_MASK_BACKPACK;
      break;
    case "tourist":
      if (rng.chance(0.75)) m |= CHAR_MASK_BACKPACK;
      if (rng.chance(0.25)) m |= CHAR_MASK_CAP;
      break;
    case "techie":
      // The vest slot was built for body armour and happens to be the exact
      // silhouette of the fleece gilet worn by half of Montgomery Street.
      // Same geometry, different colour, and it reads instantly.
      m |= CHAR_MASK_VEST | CHAR_MASK_BACKPACK;
      if (rng.chance(0.3)) m |= CHAR_MASK_CAP;
      break;
    case "cyclist":
      m |= CHAR_MASK_HELMET;
      if (rng.chance(0.8)) m |= CHAR_MASK_BACKPACK;
      if (rng.chance(0.45)) m |= CHAR_MASK_VEST;
      break;
    case "street":
      // Layers, and everything owned carried at once. The coat is nearly
      // always on, because it is nearly always cold here.
      m |= CHAR_MASK_COAT;
      if (rng.chance(0.72)) m |= CHAR_MASK_BACKPACK;
      if (rng.chance(0.42)) m |= CHAR_MASK_CAP;
      break;
    default:
      if (rng.chance(0.3)) m |= CHAR_MASK_BACKPACK;
      if (rng.chance(0.22)) m |= CHAR_MASK_COAT;
      break;
  }
  return m;
}

/** Height and girth scales for an archetype. Real populations are not uniform. */
export function archetypeBody(archetype: CharacterArchetype, rng: Rng): [number, number] {
  let h = 0.94 + rng.gauss() * 0.045;
  let g = 1 + rng.gauss() * 0.08;
  if (archetype === "civilian-heavy") g = 1.16 + rng.next() * 0.16;
  if (archetype === "civilian-slim") {
    g = 0.86 + rng.next() * 0.06;
    h += 0.02;
  }
  if (archetype === "swat" || archetype === "soldier") {
    h = 0.98 + rng.gauss() * 0.03;
    g = 1.05 + rng.next() * 0.08;
  }
  if (archetype === "cop" || archetype === "officer") {
    h = 0.97 + rng.gauss() * 0.035;
    g = 1.04 + rng.next() * 0.12;
  }
  if (archetype === "cyclist") {
    g = 0.9 + rng.next() * 0.08;
  }
  if (archetype === "street") {
    // Bulked out by the layers rather than by the body underneath, and the
    // spread is wider than the general population's in both directions.
    g = 1.02 + rng.gauss() * 0.14;
    h = 0.92 + rng.gauss() * 0.055;
  }
  return [Math.max(0.82, Math.min(1.1, h)), Math.max(0.8, Math.min(1.35, g))];
}

/* ================================================================== *
 * The batch
 * ================================================================== */

const FLOATS = {
  pos: 3,
  anim: 4,
  body: 4,
  skin: 3,
  top: 3,
  bottom: 3,
  hair: 3,
  accent: 3,
  extra: 2,
} as const;

interface Buffers {
  pos: Float32Array;
  anim: Float32Array;
  body: Float32Array;
  skin: Float32Array;
  top: Float32Array;
  bottom: Float32Array;
  hair: Float32Array;
  accent: Float32Array;
  extra: Float32Array;
  geometry: THREE.InstancedBufferGeometry;
  mesh: THREE.Mesh;
  count: number;
}

/**
 * Two instanced meshes — a near one and a far one — sharing a material, a
 * depth material and one flat write API.
 *
 * Callers `begin()`, `push()` every visible agent, and `commit()`. The batch
 * decides which mesh each agent lands in from its distance to the camera, so
 * the LOD split costs one compare per agent and no state anywhere else.
 */
export class CharacterBatch {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  readonly depthMaterial: THREE.MeshDepthMaterial;
  private near: Buffers;
  private far: Buffers;
  /** Distance at which an agent drops to the low mesh, metres. */
  lodDistance = 55;
  private lod2 = 55 * 55;

  constructor(maxNear: number, maxFar: number) {
    this.material = makeCharacterMaterial();
    this.depthMaterial = makeCharacterDepthMaterial();
    this.near = this.makeBuffers(buildCharacterGeometry(0), maxNear, "sf-crowd-near");
    this.far = this.makeBuffers(buildCharacterGeometry(1), maxFar, "sf-crowd-far");
    this.group.add(this.near.mesh, this.far.mesh);
    this.group.name = "sf-characters";
  }

  setLodDistance(d: number): void {
    this.lodDistance = d;
    this.lod2 = d * d;
  }

  private makeBuffers(src: THREE.BufferGeometry, max: number, name: string): Buffers {
    const g = new THREE.InstancedBufferGeometry();
    g.index = src.index;
    for (const key of ["position", "normal", "aUv", "aJoint", "aRegion", "aSlot"]) {
      const attr = src.getAttribute(key);
      if (attr) g.setAttribute(key, attr);
    }
    const mk = (n: number) => new Float32Array(max * n);
    const b: Buffers = {
      pos: mk(FLOATS.pos),
      anim: mk(FLOATS.anim),
      body: mk(FLOATS.body),
      skin: mk(FLOATS.skin),
      top: mk(FLOATS.top),
      bottom: mk(FLOATS.bottom),
      hair: mk(FLOATS.hair),
      accent: mk(FLOATS.accent),
      extra: mk(FLOATS.extra),
      geometry: g,
      mesh: null as unknown as THREE.Mesh,
      count: 0,
    };
    g.setAttribute("iPos", new THREE.InstancedBufferAttribute(b.pos, 3));
    g.setAttribute("iAnim", new THREE.InstancedBufferAttribute(b.anim, 4));
    g.setAttribute("iBody", new THREE.InstancedBufferAttribute(b.body, 4));
    g.setAttribute("iSkin", new THREE.InstancedBufferAttribute(b.skin, 3));
    g.setAttribute("iTop", new THREE.InstancedBufferAttribute(b.top, 3));
    g.setAttribute("iBottom", new THREE.InstancedBufferAttribute(b.bottom, 3));
    g.setAttribute("iHair", new THREE.InstancedBufferAttribute(b.hair, 3));
    g.setAttribute("iAccent", new THREE.InstancedBufferAttribute(b.accent, 3));
    g.setAttribute("iExtra", new THREE.InstancedBufferAttribute(b.extra, 2));
    g.instanceCount = 0;
    // The instances are placed in world space by the shader, so three's own
    // bounds are meaningless. A large fixed sphere keeps the mesh out of the
    // frustum culler's hands without disabling culling for the whole scene.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    g.boundingBox = new THREE.Box3(
      new THREE.Vector3(-1e5, -1e4, -1e5),
      new THREE.Vector3(1e5, 1e4, 1e5),
    );

    const mesh = new THREE.Mesh(g, this.material);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = this.depthMaterial;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    b.mesh = mesh;
    // The source wrapper is deliberately *not* disposed: its index and vertex
    // attributes now belong to the instanced geometry, and `dispose()` would
    // release GPU buffers out from under it the moment the wrapper had ever
    // been rendered.
    return b;
  }

  /** Reset for a new frame. */
  begin(): void {
    this.near.count = 0;
    this.far.count = 0;
  }

  /**
   * Add one character. `palette` is the 15-float block from `makePalette`,
   * `paletteOffset` its start index (so a caller may pack many agents into one
   * array). `dist2` is the squared distance to the camera and picks the LOD.
   */
  push(
    x: number,
    y: number,
    z: number,
    yaw: number,
    phase: number,
    speed: number,
    clip: AnimClip | number,
    blend: number,
    heightScale: number,
    girth: number,
    mask: number,
    seed: number,
    soak: number,
    palette: Float32Array,
    paletteOffset: number,
    dist2: number,
  ): boolean {
    const b = dist2 > this.lod2 ? this.far : this.near;
    const i = b.count;
    if ((i + 1) * 3 > b.pos.length) return false;
    b.count++;

    const p3 = i * 3;
    const p4 = i * 4;
    const p2 = i * 2;
    b.pos[p3] = x;
    b.pos[p3 + 1] = y;
    b.pos[p3 + 2] = z;
    b.anim[p4] = phase;
    b.anim[p4 + 1] = speed;
    b.anim[p4 + 2] = clip;
    b.anim[p4 + 3] = blend;
    b.body[p4] = yaw;
    b.body[p4 + 1] = heightScale;
    b.body[p4 + 2] = girth;
    b.body[p4 + 3] = mask;
    b.skin[p3] = palette[paletteOffset];
    b.skin[p3 + 1] = palette[paletteOffset + 1];
    b.skin[p3 + 2] = palette[paletteOffset + 2];
    b.top[p3] = palette[paletteOffset + 3];
    b.top[p3 + 1] = palette[paletteOffset + 4];
    b.top[p3 + 2] = palette[paletteOffset + 5];
    b.bottom[p3] = palette[paletteOffset + 6];
    b.bottom[p3 + 1] = palette[paletteOffset + 7];
    b.bottom[p3 + 2] = palette[paletteOffset + 8];
    b.hair[p3] = palette[paletteOffset + 9];
    b.hair[p3 + 1] = palette[paletteOffset + 10];
    b.hair[p3 + 2] = palette[paletteOffset + 11];
    b.accent[p3] = palette[paletteOffset + 12];
    b.accent[p3 + 1] = palette[paletteOffset + 13];
    b.accent[p3 + 2] = palette[paletteOffset + 14];
    b.extra[p2] = seed;
    b.extra[p2 + 1] = soak;
    return true;
  }

  /** Upload only the range actually written this frame. */
  commit(): void {
    this.flush(this.near);
    this.flush(this.far);
  }

  private flush(b: Buffers): void {
    b.geometry.instanceCount = b.count;
    if (b.count === 0) return;
    const attrs = b.geometry.attributes as Record<string, THREE.InstancedBufferAttribute>;
    for (const key of ["iPos", "iAnim", "iBody", "iSkin", "iTop", "iBottom", "iHair", "iAccent", "iExtra"]) {
      const a = attrs[key];
      if (!a) continue;
      a.clearUpdateRanges();
      a.addUpdateRange(0, b.count * a.itemSize);
      a.needsUpdate = true;
    }
  }

  get nearCount(): number {
    return this.near.count;
  }
  get farCount(): number {
    return this.far.count;
  }

  dispose(): void {
    this.near.geometry.dispose();
    this.far.geometry.dispose();
    this.material.dispose();
    this.depthMaterial.dispose();
    this.group.clear();
  }
}
