/**
 * Vibe Kart — the procedural geometry kit the karts and drivers are built from.
 *
 * There is exactly one primitive in here that matters: `loft()`. A kart body is
 * not a box and it is not a capsule — it is a *section drawing*, a run of
 * cross-sections down the length of the car that pinch at the nose, swell over
 * the rear axle and taper into the tail. Give an artist those sections and they
 * will draw you a car; give a programmer a BoxGeometry and they will ship
 * programmer art. Everything with a silhouette worth looking at (chassis, side
 * pods, torso, arms, spoiler blade) is lofted.
 *
 * The cross-section is a superellipse rather than an arc-cornered rectangle:
 * one `sharp` parameter slides continuously from a circle (2) to a soft-cornered
 * slab (8), the point distribution naturally clusters where the curvature is,
 * and there is no corner-radius bookkeeping to get wrong when a section
 * narrows to nothing at the nose.
 *
 * Conventions
 * -----------
 * · Kart local space: -Z is forward, +X is right, +Y is up. Sections therefore
 *   run from a negative z (nose) to a positive z (tail).
 * · Loft UVs are (u = around the section, v = along the length). That is the
 *   space the livery textures are painted in, so u = 0.25 is the top deck and
 *   v = 0 is the nose. Do not change it without repainting `textures.ts`.
 * · Every builder returns a fresh BufferGeometry the caller owns and disposes.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { TAU, clamp01, lerp } from "./math";

// ---------------------------------------------------------------------------
// Cross-sections and lofting
// ---------------------------------------------------------------------------

export interface LoftSection {
  /** Position along the length. */
  z: number;
  /** Half width of the section. */
  halfW: number;
  /** Height above the section centre. */
  top: number;
  /** Depth below the section centre. Separate from `top` because car bodies
   *  are never symmetric about their waistline — the floor is flat, the deck
   *  is domed. */
  bottom: number;
  /** Section centre height. Sweeping this is how you get a rising beltline. */
  y?: number;
  /** 2 = ellipse, 4 = soft rectangle, 8 = slab with a chamfer. */
  sharp?: number;
  /** Rolls the section about Z — for a body that twists into its haunches. */
  roll?: number;
}

export interface LoftOptions {
  /** Points around the section. 24 is plenty at kart scale. */
  points?: number;
  capStart?: boolean;
  capEnd?: boolean;
  /** Tile the length UV, e.g. 3 to repeat a livery three times. */
  vRepeat?: number;
}

/**
 * Superellipse point. `sharp` is the exponent: |x/a|^n + |y/b|^n = 1 with
 * n = sharp. The `Math.sign` guards keep the four axis-crossing points exactly
 * on the axes, which is what stops the seam column from wobbling.
 */
function superPoint(a: number, sharp: number, out: { x: number; y: number }): void {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const e = 2 / sharp;
  out.x = Math.sign(c) * Math.pow(Math.abs(c), e);
  out.y = Math.sign(s) * Math.pow(Math.abs(s), e);
}

/**
 * Loft a run of sections into a closed tube with optional end caps.
 *
 * The seam column is duplicated (P + 1 columns for P points) so the U wrap is
 * clean, then its two normals are averaged back together after
 * `computeVertexNormals` — without that the seam shows as a hairline crease
 * down the flank of every kart, which is exactly the sort of thing that reads
 * as "3D demo" rather than "game".
 */
export function loft(sections: LoftSection[], opts: LoftOptions = {}): THREE.BufferGeometry {
  const P = Math.max(6, opts.points ?? 24);
  const cols = P + 1;
  const rows = sections.length;
  const capStart = opts.capStart !== false;
  const capEnd = opts.capEnd !== false;
  const vRepeat = opts.vRepeat ?? 1;

  const ringCount = rows * cols;
  const capVerts = (capStart ? cols + 1 : 0) + (capEnd ? cols + 1 : 0);
  const total = ringCount + capVerts;

  const position = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const index: number[] = [];

  // Arc-length along the loft, so V is uniform even when sections bunch up.
  const vs = new Float32Array(rows);
  let span = 0;
  for (let i = 1; i < rows; i++) {
    span += Math.abs(sections[i].z - sections[i - 1].z);
    vs[i] = span;
  }
  for (let i = 0; i < rows; i++) vs[i] = (span > 0 ? vs[i] / span : i / Math.max(1, rows - 1)) * vRepeat;

  const p = { x: 0, y: 0 };
  for (let r = 0; r < rows; r++) {
    const s = sections[r];
    const cy = s.y ?? 0;
    const sharp = s.sharp ?? 4;
    const roll = s.roll ?? 0;
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    for (let c = 0; c < cols; c++) {
      const a = (c % P) * (TAU / P);
      superPoint(a, sharp, p);
      const x0 = p.x * s.halfW;
      const y0 = p.y * (p.y >= 0 ? s.top : s.bottom);
      const o = (r * cols + c) * 3;
      position[o] = x0 * cr - y0 * sr;
      position[o + 1] = cy + x0 * sr + y0 * cr;
      position[o + 2] = s.z;
      const t = (r * cols + c) * 2;
      uv[t] = c / P;
      uv[t + 1] = vs[r];
    }
  }

  // Winding: `a→b` walks the section anticlockwise and `a→d` walks +Z, so
  // (b-a) × (d-a) points out of the surface. Get this backwards and every kart
  // in the game is rendered from the inside — which looks, deceptively, like a
  // lighting bug rather than a topology one.
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < P; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      index.push(a, b, d, b, e, d);
    }
  }

  let cursor = ringCount;
  const addCap = (row: number, flip: boolean) => {
    const s = sections[row];
    const centre = cursor;
    position[centre * 3] = 0;
    position[centre * 3 + 1] = s.y ?? 0;
    position[centre * 3 + 2] = s.z;
    uv[centre * 2] = 0.5;
    uv[centre * 2 + 1] = flip ? 0 : vRepeat;
    cursor++;
    const ring = cursor;
    for (let c = 0; c < cols; c++) {
      const src = (row * cols + c) * 3;
      const dst = (ring + c) * 3;
      position[dst] = position[src];
      position[dst + 1] = position[src + 1];
      position[dst + 2] = position[src + 2];
      uv[(ring + c) * 2] = uv[(row * cols + c) * 2];
      uv[(ring + c) * 2 + 1] = flip ? 0 : vRepeat;
    }
    cursor += cols;
    for (let c = 0; c < P; c++) {
      // The start cap faces -Z and the end cap +Z; the fan winding follows.
      if (flip) index.push(centre, ring + c + 1, ring + c);
      else index.push(centre, ring + c, ring + c + 1);
    }
  };
  if (capStart) addCap(0, true);
  if (capEnd) addCap(rows - 1, false);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();

  // Weld the seam normals: columns 0 and P are the same point in space.
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  for (let r = 0; r < rows; r++) {
    const a = r * cols;
    const b = a + P;
    const nx = nrm.getX(a) + nrm.getX(b);
    const ny = nrm.getY(a) + nrm.getY(b);
    const nz = nrm.getZ(a) + nrm.getZ(b);
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm.setXYZ(a, nx / l, ny / l, nz / l);
    nrm.setXYZ(b, nx / l, ny / l, nz / l);
  }
  nrm.needsUpdate = true;
  return geo;
}

/**
 * Chunky rounded box.
 *
 * Built by inflating a sphere out to the box's inner corner box — the classic
 * "capsule box" — then *boxifying* the shading normal with a power curve so the
 * faces read flat and only the chamfer catches a rolling highlight. That last
 * step is the difference between a moulded plastic part and a beach ball.
 */
export function roundedBox(
  w: number,
  h: number,
  d: number,
  radius: number,
  segments = 8,
  flatten = 3,
): THREE.BufferGeometry {
  const r = Math.max(1e-3, Math.min(radius, w / 2, h / 2, d / 2));
  const geo = new THREE.SphereGeometry(r, Math.max(8, segments * 2), Math.max(6, segments));
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  const ax = Math.max(0, w / 2 - r);
  const ay = Math.max(0, h / 2 - r);
  const az = Math.max(0, d / 2 - r);
  for (let i = 0; i < pos.count; i++) {
    const nx = nrm.getX(i);
    const ny = nrm.getY(i);
    const nz = nrm.getZ(i);
    pos.setXYZ(i, pos.getX(i) + Math.sign(nx) * ax, pos.getY(i) + Math.sign(ny) * ay, pos.getZ(i) + Math.sign(nz) * az);
    const bx = Math.sign(nx) * Math.pow(Math.abs(nx), flatten);
    const by = Math.sign(ny) * Math.pow(Math.abs(ny), flatten);
    const bz = Math.sign(nz) * Math.pow(Math.abs(nz), flatten);
    const l = Math.hypot(bx, by, bz) || 1;
    nrm.setXYZ(i, bx / l, by / l, bz / l);
  }
  pos.needsUpdate = true;
  nrm.needsUpdate = true;
  return geo;
}

/** A swept tube through a smooth curve — roll bars, bumpers, exhaust pipes. */
export function tube(
  points: Array<[number, number, number]>,
  radius: number,
  tubular = 20,
  radial = 8,
  closed = false,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(
    points.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    closed,
    "catmullrom",
    0.5,
  );
  return new THREE.TubeGeometry(curve, tubular, radius, radial, closed);
}

// ---------------------------------------------------------------------------
// Wheels
// ---------------------------------------------------------------------------

export interface TyreOptions {
  radius: number;
  width: number;
  /** Radius the rim meets the rubber at. */
  rimRadius: number;
  /** How far the sidewall bulges past the tread width, 0..1. */
  bulge?: number;
  /** Number of tread blocks around the circumference. */
  blocks?: number;
  radial?: number;
}

/**
 * A real tyre: bead, bulging sidewall, a shoulder that rolls into the tread,
 * and a moulded block pattern cut into the crown.
 *
 * The tread is *geometry*, not a normal map, because a kart wheel is a metre of
 * screen at the start line and the silhouette against the tarmac is what sells
 * it. It costs about 700 triangles and one draw call for the whole field, since
 * every wheel on every kart is one instance of this mesh.
 */
export function tyre(o: TyreOptions): THREE.BufferGeometry {
  const R = o.radius;
  const hw = o.width / 2;
  const bulge = o.bulge ?? 0.16;
  const blocks = o.blocks ?? 9;
  const radial = o.radial ?? 28;

  // (x across the wheel, r out from the axle, treaded?)
  //
  // The bead sits at the *outer* edge of the wheel, not tucked inboard: a kart
  // tyre is a fat band with the rim face nearly flush in its opening, and
  // modelling it that way is what stops the rim from poking out through the
  // sidewall at every steering angle.
  const w = (t: number) => hw * t;
  const s = (t: number) => o.rimRadius + (R - o.rimRadius) * t;
  const half: Array<[number, number, number]> = [
    [w(-1.0), o.rimRadius, 0],
    [w(-1.0 - bulge * 0.1), s(0.34), 0],
    [w(-0.99 - bulge * 0.12), s(0.66), 0],
    [w(-0.93), s(0.88), 0],
    [w(-0.82), R * 0.985, 0],
    [w(-0.7), R, 1],
    [w(-0.36), R * 1.004, 1],
    [0, R * 1.006, 1],
    [w(0.36), R * 1.004, 1],
    [w(0.7), R, 1],
    [w(0.82), R * 0.985, 0],
    [w(0.93), s(0.88), 0],
    [w(0.99 + bulge * 0.12), s(0.66), 0],
    [w(1.0 + bulge * 0.1), s(0.34), 0],
    [w(1.0), o.rimRadius, 0],
  ];

  const rows = half.length;
  const cols = radial + 1;
  const position = new Float32Array(rows * cols * 3);
  const uv = new Float32Array(rows * cols * 2);
  const index: number[] = [];

  const groove = 0.045 * R;
  // Blocks must land on whole segments or the pattern beats against the
  // tessellation and the tread turns to fur. One groove segment per block.
  const per = Math.max(2, Math.round(radial / Math.max(1, blocks)));
  for (let r = 0; r < rows; r++) {
    const [x, rad, treaded] = half[r];
    // Neighbouring bands are offset half a block: a straight-across tread reads
    // as a stack of rings, a staggered one reads as a moulded pattern.
    const offset = (r % 2) * Math.floor(per / 2);
    for (let c = 0; c < cols; c++) {
      const j = c % radial;
      let rr = rad;
      if (treaded) {
        // Lateral groove between blocks, plus a permanent circumferential
        // channel down the crown so the tyre has a centre line.
        const lateral = (j + offset) % per === 0 ? 1 : 0;
        const centre = Math.abs(x) < hw * 0.1 ? 0.75 : 0;
        rr -= groove * Math.max(lateral, centre);
      }
      const a = (j / radial) * TAU;
      const o3 = (r * cols + c) * 3;
      position[o3] = x;
      position[o3 + 1] = Math.sin(a) * rr;
      position[o3 + 2] = Math.cos(a) * rr;
      // Tiled hard: the rubber material's pebble grain is authored for a
      // half-metre panel, and at that scale on a wheel this close to the camera
      // it reads as fur. Ten wraps around puts the grain under a pixel and
      // leaves the moulded tread blocks to carry the shape.
      const o2 = (r * cols + c) * 2;
      uv[o2] = (c / radial) * 10;
      uv[o2 + 1] = (r / (rows - 1)) * 2.5;
    }
  }
  // Here the row direction is +X across the wheel and the column direction runs
  // *clockwise* seen from +X, so the outward face is (d-a) × (b-a) — the
  // opposite hand to `loft`.
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < radial; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      index.push(a, d, b, b, d, e);
    }
  }
  // No end caps: the bead opening is filled by the rim barrel, and a capping
  // disc here would just z-fight with it.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

export interface RimOptions {
  radius: number;
  width: number;
  spokes?: number;
  /** Spoke twist, radians — a little makes the wheel look designed. */
  twist?: number;
}

/**
 * Rim: barrel, dished centre and spokes, painted in the accent colour.
 *
 * Symmetric about the wheel's midplane on purpose. All four wheels are
 * instances of one mesh, so there is no inboard and outboard face to author —
 * the spoke star sits in the middle of the barrel and reads correctly from
 * either side, which is worth far more than a "correct" one-sided design that
 * shows its back to half the field.
 */
export function rimFace(o: RimOptions): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const R = o.radius;
  const spokes = o.spokes ?? 5;

  // Barrel, filling the tyre's bead opening.
  const barrel = new THREE.CylinderGeometry(R, R, o.width * 0.98, 24, 1, true);
  barrel.rotateZ(Math.PI / 2);
  parts.push(barrel);

  // Dished hub.
  const dish = new THREE.CylinderGeometry(R * 0.4, R * 0.4, o.width * 0.52, 20, 1, false);
  dish.rotateZ(Math.PI / 2);
  parts.push(dish);

  for (let i = 0; i < spokes; i++) {
    const spoke = roundedBox(o.width * 0.5, R * 0.92, R * 0.26, R * 0.07, 5);
    // Twist about the spoke's own long axis: a flat plank reads as a
    // placeholder, a turbine-angled one reads as a wheel someone designed.
    spoke.rotateY(o.twist ?? 0.35);
    spoke.translate(0, R * 0.48, 0);
    spoke.rotateX((i / spokes) * TAU);
    parts.push(spoke);
  }

  return mergeAll(parts);
}

/** Rim hardware: a chrome centre cap on each face plus its bolt ring. */
export function rimHub(o: RimOptions): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const R = o.radius;
  for (const side of [-1, 1] as const) {
    const cap = new THREE.SphereGeometry(R * 0.26, 12, 8, 0, TAU, 0, Math.PI * 0.58);
    cap.rotateZ(side * -Math.PI / 2);
    cap.translate(side * o.width * 0.24, 0, 0);
    parts.push(cap);
    const ring = new THREE.TorusGeometry(R * 0.46, R * 0.05, 6, 20);
    ring.rotateY(Math.PI / 2);
    ring.translate(side * o.width * 0.2, 0, 0);
    parts.push(ring);
  }
  return mergeAll(parts);
}

// ---------------------------------------------------------------------------
// Ribbons — scarves, capes, tails
// ---------------------------------------------------------------------------

export interface Ribbon {
  geometry: THREE.BufferGeometry;
  segments: number;
  /** Rewrite the strip from a polyline plus an up vector per node. */
  update(points: THREE.Vector3[], up: THREE.Vector3, widthAt: (t: number) => number): void;
}

export function ribbon(segments: number): Ribbon {
  const count = (segments + 1) * 2;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const index: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    uv[i * 4] = 0;
    uv[i * 4 + 1] = t;
    uv[i * 4 + 2] = 1;
    uv[i * 4 + 3] = t;
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(index);
  // The sim moves it every frame and it never leaves the racer's neighbourhood;
  // an infinite sphere is cheaper than recomputing bounds 8 times a frame.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 8);

  const dir = new THREE.Vector3();
  const side = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  return {
    geometry,
    segments,
    update(points, up, widthAt) {
      const pos = geometry.attributes.position as THREE.BufferAttribute;
      const nAttr = geometry.attributes.normal as THREE.BufferAttribute;
      const n = Math.min(points.length - 1, segments);
      for (let i = 0; i <= n; i++) {
        const a = points[Math.max(0, i - 1)];
        const b = points[Math.min(n, i + 1)];
        dir.copy(b).sub(a);
        if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
        dir.normalize();
        side.crossVectors(dir, up);
        if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
        side.normalize();
        nrm.crossVectors(side, dir).normalize();
        const w = widthAt(i / n) * 0.5;
        const p = points[i];
        pos.setXYZ(i * 2, p.x - side.x * w, p.y - side.y * w, p.z - side.z * w);
        pos.setXYZ(i * 2 + 1, p.x + side.x * w, p.y + side.y * w, p.z + side.z * w);
        nAttr.setXYZ(i * 2, nrm.x, nrm.y, nrm.z);
        nAttr.setXYZ(i * 2 + 1, nrm.x, nrm.y, nrm.z);
      }
      pos.needsUpdate = true;
      nAttr.needsUpdate = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Assembly helpers
// ---------------------------------------------------------------------------

export interface Placement {
  position?: [number, number, number];
  /** Euler XYZ. */
  rotation?: [number, number, number];
  scale?: [number, number, number] | number;
}

/** Bake a transform into a geometry, in place. Returns the same geometry. */
export function place(geo: THREE.BufferGeometry, p: Placement): THREE.BufferGeometry {
  if (p.scale !== undefined) {
    const s = typeof p.scale === "number" ? [p.scale, p.scale, p.scale] : p.scale;
    geo.scale(s[0], s[1], s[2]);
  }
  if (p.rotation) {
    geo.rotateX(p.rotation[0]);
    geo.rotateY(p.rotation[1]);
    geo.rotateZ(p.rotation[2]);
  }
  if (p.position) geo.translate(p.position[0], p.position[1], p.position[2]);
  return geo;
}

/**
 * Mirror across X for the other side of the car. Winding is reversed so the
 * mirrored copy is not inside-out; normals are re-derived rather than negated
 * because half these parts came out of `roundedBox` with authored normals that
 * a naive negate would ruin.
 */
export function mirrorX(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = geo.clone();
  out.scale(-1, 1, 1);
  const idx = out.getIndex();
  if (idx) {
    const arr = idx.array as unknown as number[] | Uint16Array | Uint32Array;
    for (let i = 0; i < arr.length; i += 3) {
      const t = arr[i];
      arr[i] = arr[i + 2];
      arr[i + 2] = t;
    }
    idx.needsUpdate = true;
  }
  const nrm = out.attributes.normal as THREE.BufferAttribute | undefined;
  if (nrm) {
    for (let i = 0; i < nrm.count; i++) nrm.setX(i, -nrm.getX(i));
    nrm.needsUpdate = true;
  }
  return out;
}

/** Add a geometry and its mirror image. */
export function pair(geo: THREE.BufferGeometry): THREE.BufferGeometry[] {
  return [geo, mirrorX(geo)];
}

/**
 * Merge and dispose the inputs. Every part of a kart that shares a material is
 * funnelled through here: one merged geometry per material is what keeps eight
 * fully dressed karts inside a sane draw-call budget.
 */
export function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = parts.filter((g) => g.getAttribute("position"));
  for (const g of clean) {
    // mergeGeometries is unforgiving about mismatched attribute sets.
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    if (!g.getAttribute("uv")) {
      const n = g.getAttribute("position").count;
      g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    for (const key of Object.keys(g.attributes)) {
      if (key !== "position" && key !== "normal" && key !== "uv") g.deleteAttribute(key);
    }
    if (!g.getIndex()) {
      const n = g.getAttribute("position").count;
      const idx = new Uint32Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    g.clearGroups();
  }
  if (clean.length === 1) return clean[0];
  if (clean.length === 0) throw new Error("[kart/models] nothing to merge");
  const merged = mergeGeometries(clean, false);
  for (const g of clean) g.dispose();
  if (!merged) throw new Error("[kart/models] geometry merge failed");
  return withUv1(merged);
}

/**
 * Duplicate UV0 into UV1.
 *
 * three binds `aoMap` to the `uv1` attribute by default, and the shared library
 * materials all carry an aoMap. A geometry without uv1 therefore samples the
 * occlusion texture at a single texel and can tint an entire part dark for no
 * visible reason. Since we are not allowed to mutate the shared materials, the
 * geometry meets them halfway. It costs 8 bytes a vertex on a few thousand
 * vertices per kart.
 */
export function withUv1(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const uv = geo.getAttribute("uv");
  if (uv && !geo.getAttribute("uv1")) geo.setAttribute("uv1", uv.clone());
  return geo;
}

/** Triangle count, for the budget report in the debug overlay. */
export function triangleCount(geo: THREE.BufferGeometry): number {
  const idx = geo.getIndex();
  return (idx ? idx.count : geo.getAttribute("position").count) / 3;
}

// ---------------------------------------------------------------------------
// A tiny CPU skin — two-bone limbs without a SkinnedMesh
// ---------------------------------------------------------------------------

export interface LimbBone {
  /** Pivot in mesh-local space. */
  pivot: THREE.Vector3;
  rotation: THREE.Quaternion;
}

export interface Skin {
  /** 0..1 weight toward the *second* bone of the vertex's chain. */
  blend: Float32Array;
  /** Which two-bone chain each vertex belongs to. */
  chain: Uint8Array;
  rest: Float32Array;
  restNormal: Float32Array;
}

/**
 * Build the skin weights for a limb mesh from the limb's own polyline.
 *
 * A SkinnedMesh would mean a bone hierarchy, an inverse-bind matrix set and a
 * skinning shader; for two bones and 200 vertices per driver the CPU path is
 * both less code and less GPU state, and it is what lets both arms live in a
 * single draw call while still bending at the elbow.
 */
export function buildSkin(
  geo: THREE.BufferGeometry,
  chains: Array<{ shoulder: THREE.Vector3; elbow: THREE.Vector3; wrist: THREE.Vector3 }>,
  softness = 0.07,
): Skin {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  const n = pos.count;
  const blend = new Float32Array(n);
  const chain = new Uint8Array(n);
  const rest = new Float32Array(pos.array as Float32Array);
  const restNormal = new Float32Array(nrm.array as Float32Array);

  const v = new THREE.Vector3();
  const seg = new THREE.Vector3();
  const rel = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    // Nearest chain by shoulder distance — arms are far enough apart that this
    // never picks the wrong side.
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < chains.length; c++) {
      const d = v.distanceToSquared(chains[c].shoulder);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    chain[i] = best;
    const ch = chains[best];
    // Project onto the upper-arm segment; past the elbow the vertex belongs to
    // the forearm, and `softness` smears the transition so the joint creases
    // instead of shearing.
    seg.copy(ch.elbow).sub(ch.shoulder);
    rel.copy(v).sub(ch.shoulder);
    const t = seg.lengthSq() > 0 ? rel.dot(seg) / seg.lengthSq() : 0;
    const along = (t - 1) * seg.length();
    blend[i] = clamp01(0.5 + along / (softness * 2));
  }
  return { blend, chain, rest, restNormal };
}

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Apply the skin. `chains[i]` supplies the two bone rotations for chain i;
 * bone matrices are pivot-local rotations composed down the chain.
 */
export function applySkin(
  geo: THREE.BufferGeometry,
  skin: Skin,
  chains: Array<{ upper: LimbBone; fore: LimbBone }>,
): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  const upperM: THREE.Matrix4[] = [];
  const foreM: THREE.Matrix4[] = [];
  for (const c of chains) {
    const u = new THREE.Matrix4()
      .makeTranslation(c.upper.pivot.x, c.upper.pivot.y, c.upper.pivot.z)
      .multiply(_m.makeRotationFromQuaternion(c.upper.rotation))
      .multiply(_m2.makeTranslation(-c.upper.pivot.x, -c.upper.pivot.y, -c.upper.pivot.z));
    const f = new THREE.Matrix4()
      .copy(u)
      .multiply(_m.makeTranslation(c.fore.pivot.x, c.fore.pivot.y, c.fore.pivot.z))
      .multiply(_m2.makeRotationFromQuaternion(c.fore.rotation))
      .multiply(new THREE.Matrix4().makeTranslation(-c.fore.pivot.x, -c.fore.pivot.y, -c.fore.pivot.z));
    upperM.push(u);
    foreM.push(f);
  }

  const rest = skin.rest;
  const restN = skin.restNormal;
  for (let i = 0; i < pos.count; i++) {
    const c = skin.chain[i];
    const w = skin.blend[i];
    const o = i * 3;
    _v.set(rest[o], rest[o + 1], rest[o + 2]);
    _v2.copy(_v);
    _v.applyMatrix4(upperM[c]);
    _v2.applyMatrix4(foreM[c]);
    pos.setXYZ(i, lerp(_v.x, _v2.x, w), lerp(_v.y, _v2.y, w), lerp(_v.z, _v2.z, w));
    // One rotation for the normal rather than a blend: at 200 vertices a frame
    // the difference is invisible and the slerp is not free.
    const bone = w < 0.5 ? chains[c].upper.rotation : chains[c].fore.rotation;
    _q.copy(bone);
    if (w >= 0.5) _q.premultiply(chains[c].upper.rotation);
    _v.set(restN[o], restN[o + 1], restN[o + 2]).applyQuaternion(_q);
    nrm.setXYZ(i, _v.x, _v.y, _v.z);
  }
  pos.needsUpdate = true;
  nrm.needsUpdate = true;
}
