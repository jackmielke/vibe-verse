/**
 * kit.ts — the landmark modelling toolkit.
 *
 * Every hero landmark in this directory is modelled in code. That is a very
 * different job from modelling in Blender: you do not get to push vertices, you
 * get to write a program that emits them, and the program has to stay readable
 * or nobody will ever fix the Transamerica's wings again. So the whole
 * directory is built on two ideas:
 *
 *  1. **A batch, not a scene graph.** Landmarks are made of hundreds of small
 *     pieces — balusters, rivet plates, coffers, mullions. One `THREE.Mesh` per
 *     piece would be a thousand draw calls for one building. `Batch` collects
 *     everything by material and merges it into exactly one mesh per material
 *     (or one `InstancedMesh` where the piece count is high enough that merging
 *     would waste memory). A finished landmark is three to six draw calls.
 *
 *  2. **Primitives that match the vocabulary of architecture**, not the
 *     vocabulary of three.js: tapered boxes, lofted rings, fluted shafts,
 *     catenaries, arched wall panels, stair flights. The builders read like a
 *     description of the building.
 *
 * UV policy: landmark materials are all world-space triplanar (see
 * `materials.ts`), so nothing here needs to author a sensible UV set. Every
 * geometry still carries a `uv` attribute because `mergeGeometries` refuses to
 * merge geometries with mismatched attribute sets.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/* ------------------------------------------------------------------ *
 * Batch
 * ------------------------------------------------------------------ */

/** Scratch matrix reused by the `*At` convenience helpers. */
const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const V = new THREE.Vector3();
const S = new THREE.Vector3();

/**
 * Build a transform without allocating. Rotation order is YXZ (yaw, then
 * pitch, then roll) which is how a person describes placing a building part.
 */
export function xform(
  x: number,
  y: number,
  z: number,
  yaw = 0,
  pitch = 0,
  roll = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): THREE.Matrix4 {
  E.set(pitch, yaw, roll, "YXZ");
  Q.setFromEuler(E);
  V.set(x, y, z);
  S.set(sx, sy, sz);
  return M.compose(V, Q, S);
}

/**
 * Transform that maps a **unit box centred on the origin** onto a bar running
 * from A to B, `w` wide and `h` deep.
 *
 * This exists because the obvious spelling — compose with a non-uniform scale
 * and then post-multiply a rotation — is wrong, and wrong in a way that looks
 * plausible for a while. `compose` builds T·R·S, so post-multiplying rotates
 * *inside* the scale and every diagonal truss member comes out sheared into a
 * parallelogram. Every strut, brace, hanger and diagonal in this directory goes
 * through here instead.
 */
export function strut(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  w = 1,
  h = w,
): THREE.Matrix4 {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  const yaw = Math.atan2(-dz, dx);
  const pitch = Math.atan2(dy, Math.hypot(dx, dz));
  // YZX order gives Ry(yaw)·Rz(pitch), which takes local +X onto the bar axis.
  E.set(0, yaw, pitch, "YZX");
  Q.setFromEuler(E);
  V.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  S.set(len, h, w);
  return M.compose(V, Q, S);
}

const KEEP = new Set(["position", "normal", "uv"]);

/**
 * Clone a geometry into the exact attribute layout the merger needs.
 *
 * Non-indexed sources (ExtrudeGeometry, our own strip builders) get a trivial
 * sequential index rather than being de-duplicated: `mergeVertices` is O(n log n)
 * with a hash per vertex and we are merging tens of thousands of triangles at
 * load time, where the win would be invisible and the cost would not.
 */
function prep(src: THREE.BufferGeometry, m?: THREE.Matrix4): THREE.BufferGeometry {
  const g = src.clone();
  for (const name of Object.keys(g.attributes)) {
    if (!KEEP.has(name)) g.deleteAttribute(name);
  }
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  const count = g.getAttribute("position").count;
  if (!g.getAttribute("uv")) {
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  if (!g.getIndex()) {
    const arr =
      count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    for (let i = 0; i < count; i++) arr[i] = i;
    g.setIndex(new THREE.BufferAttribute(arr, 1));
  }
  g.clearGroups();
  if (m) g.applyMatrix4(m);
  return g;
}

/** A high-count repeat that becomes one `InstancedMesh`. */
export class InstanceBucket {
  readonly matrices: THREE.Matrix4[] = [];
  readonly colors: THREE.Color[] = [];
  private tinted = false;

  constructor(
    readonly material: THREE.Material,
    readonly geometry: THREE.BufferGeometry,
  ) {}

  /** Place one instance. The matrix is copied, so `xform()`'s scratch is safe. */
  at(m: THREE.Matrix4, color?: THREE.ColorRepresentation): this {
    this.matrices.push(m.clone());
    if (color !== undefined) {
      this.tinted = true;
      this.colors.push(new THREE.Color(color));
    } else {
      this.colors.push(WHITE);
    }
    return this;
  }

  /** Place one instance from loose components. */
  atPos(
    x: number,
    y: number,
    z: number,
    yaw = 0,
    pitch = 0,
    roll = 0,
    sx = 1,
    sy = sx,
    sz = sx,
    color?: THREE.ColorRepresentation,
  ): this {
    return this.at(xform(x, y, z, yaw, pitch, roll, sx, sy, sz), color);
  }

  get hasColors(): boolean {
    return this.tinted;
  }
}

const WHITE = new THREE.Color(1, 1, 1);

export interface FlushOptions {
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Prefix for mesh names, so the debug inspector is navigable. */
  name?: string;
  /** Render order bump — used for coplanar decals like road markings. */
  renderOrder?: number;
}

/**
 * Accumulates geometry by material and resolves to the smallest number of
 * meshes that can represent it.
 */
export class Batch {
  private merged = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private instanced: InstanceBucket[] = [];
  private attached: THREE.Object3D[] = [];
  /** Cheap running estimate so the streamer can report a triangle budget. */
  triangles = 0;

  /** Add a transformed copy of `geo` to the merge bucket for `mat`. */
  add(mat: THREE.Material, geo: THREE.BufferGeometry, m?: THREE.Matrix4): this {
    const g = prep(geo, m);
    const idx = g.getIndex();
    this.triangles += (idx ? idx.count : g.getAttribute("position").count) / 3;
    let list = this.merged.get(mat);
    if (!list) {
      list = [];
      this.merged.set(mat, list);
    }
    list.push(g);
    return this;
  }

  /** Add a geometry placed by loose components. */
  addAt(
    mat: THREE.Material,
    geo: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    yaw = 0,
    pitch = 0,
    roll = 0,
    sx = 1,
    sy = sx,
    sz = sx,
  ): this {
    return this.add(mat, geo, xform(x, y, z, yaw, pitch, roll, sx, sy, sz));
  }

  /**
   * Attach a pre-built object that cannot be merged — the only legitimate use
   * is geometry that has to move independently, like the windmill's sails.
   * Everything static must go through `add` or `instances`, because every
   * attached object is a draw call the batch cannot fold away.
   */
  attach(obj: THREE.Object3D): this {
    this.attached.push(obj);
    return this;
  }

  /** Open (or reuse) an instanced bucket. The geometry is owned by the batch. */
  instances(mat: THREE.Material, geo: THREE.BufferGeometry): InstanceBucket {
    const b = new InstanceBucket(mat, prep(geo));
    this.instanced.push(b);
    return b;
  }

  /** Resolve everything into meshes parented to `parent`. Empties the batch. */
  flush(parent: THREE.Object3D, o: FlushOptions = {}): void {
    const cast = o.castShadow ?? true;
    const receive = o.receiveShadow ?? true;

    for (const [mat, geos] of this.merged) {
      if (geos.length === 0) continue;
      let geo: THREE.BufferGeometry | null = null;
      if (geos.length === 1) {
        geo = geos[0];
      } else {
        geo = mergeGeometries(geos, false);
        // mergeGeometries returns null on an attribute mismatch. `prep` makes
        // that impossible, but a silent null here would be an invisible
        // landmark, so fall back to one mesh per piece rather than vanish.
        if (geo) for (const g of geos) g.dispose();
      }
      if (!geo) {
        for (const g of geos) {
          const mesh = new THREE.Mesh(g, mat);
          mesh.castShadow = cast;
          mesh.receiveShadow = receive;
          parent.add(mesh);
        }
        continue;
      }
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `${o.name ?? "landmark"}/${mat.name || "part"}`;
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      if (o.renderOrder) mesh.renderOrder = o.renderOrder;
      parent.add(mesh);
    }
    this.merged.clear();

    for (const b of this.instanced) {
      const n = b.matrices.length;
      if (n === 0) {
        b.geometry.dispose();
        continue;
      }
      const im = new THREE.InstancedMesh(b.geometry, b.material, n);
      for (let i = 0; i < n; i++) im.setMatrixAt(i, b.matrices[i]);
      if (b.hasColors) {
        for (let i = 0; i < n; i++) im.setColorAt(i, b.colors[i]);
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
      im.instanceMatrix.needsUpdate = true;
      im.name = `${o.name ?? "landmark"}/${b.material.name || "part"}-x${n}`;
      im.castShadow = cast;
      im.receiveShadow = receive;
      if (o.renderOrder) im.renderOrder = o.renderOrder;
      im.computeBoundingSphere();
      const idx = b.geometry.getIndex();
      this.triangles += ((idx ? idx.count : 0) / 3) * (n - 1);
      parent.add(im);
    }
    this.instanced.length = 0;

    for (const o of this.attached) parent.add(o);
    this.attached.length = 0;
  }
}

/** Recursively dispose the geometry a landmark owns. Materials are shared. */
export function disposeLandmark(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
  });
  root.clear();
}

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

/** Axis-aligned box centred on the origin. */
export function box(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

/**
 * A box whose top face is a different size from its bottom — the single most
 * useful primitive in this directory, because almost every tower, pier, leg
 * and buttress in the real world tapers.
 *
 * Origin is at the centre of the bottom face.
 */
export function taperBox(
  w0: number,
  d0: number,
  w1: number,
  d1: number,
  h: number,
): THREE.BufferGeometry {
  return loft(
    [rectRing(w0, d0, 0), rectRing(w1, d1, h)],
    true,
    true,
  );
}

/** Rectangle as a closed 4-point ring at height `y` (xyz triplets). */
export function rectRing(w: number, d: number, y: number): Float32Array {
  const hw = w / 2;
  const hd = d / 2;
  return new Float32Array([-hw, y, -hd, hw, y, -hd, hw, y, hd, -hw, y, hd]);
}

/** N-gon ring of radius `r` at height `y`, optionally phase-shifted. */
export function circleRing(r: number, y: number, seg: number, phase = 0): Float32Array {
  const out = new Float32Array(seg * 3);
  for (let i = 0; i < seg; i++) {
    const a = phase + (i / seg) * Math.PI * 2;
    out[i * 3] = Math.cos(a) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(a) * r;
  }
  return out;
}

/** Ring whose radius varies with angle — stadium bowls, irregular plans. */
export function shapedRing(
  y: number,
  seg: number,
  radiusAt: (theta: number, i: number) => number,
): Float32Array {
  const out = new Float32Array(seg * 3);
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const r = radiusAt(a, i);
    out[i * 3] = Math.cos(a) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(a) * r;
  }
  return out;
}

/**
 * Rounded-rectangle ring — the plan of most modern towers, and of a stadium.
 * `r` is the corner radius; `seg` is the *total* point count.
 */
export function roundedRectRing(
  w: number,
  d: number,
  r: number,
  y: number,
  seg: number,
): Float32Array {
  const hw = Math.max(0.001, w / 2 - r);
  const hd = Math.max(0.001, d / 2 - r);
  const out = new Float32Array(seg * 3);
  // Walk the perimeter of the rounded rectangle at constant parameter, which
  // over-samples the corners slightly. That is the right bias: corners are
  // where a polygonal silhouette gives itself away.
  const per = 2 * (2 * hw + 2 * hd) + 2 * Math.PI * r;
  const step = per / seg;
  let t = 0;
  for (let i = 0; i < seg; i++, t += step) {
    let s = t;
    let x: number;
    let z: number;
    const arc = (Math.PI / 2) * r;
    if (s < 2 * hw) {
      x = -hw + s;
      z = -hd - r;
    } else if ((s -= 2 * hw) < arc) {
      const a = (s / arc) * (Math.PI / 2) - Math.PI / 2;
      x = hw + Math.cos(a) * r;
      z = -hd + Math.sin(a) * r;
    } else if ((s -= arc) < 2 * hd) {
      x = hw + r;
      z = -hd + s;
    } else if ((s -= 2 * hd) < arc) {
      const a = (s / arc) * (Math.PI / 2);
      x = hw + Math.cos(a) * r;
      z = hd + Math.sin(a) * r;
    } else if ((s -= arc) < 2 * hw) {
      x = hw - s;
      z = hd + r;
    } else if ((s -= 2 * hw) < arc) {
      const a = (s / arc) * (Math.PI / 2) + Math.PI / 2;
      x = -hw + Math.cos(a) * r;
      z = hd + Math.sin(a) * r;
    } else if ((s -= arc) < 2 * hd) {
      x = -hw - r;
      z = hd - s;
    } else {
      const a = (Math.min(s - 2 * hd, arc) / arc) * (Math.PI / 2) + Math.PI;
      x = -hw + Math.cos(a) * r;
      z = -hd + Math.sin(a) * r;
    }
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  return out;
}

/**
 * Loft a closed profile through a series of rings.
 *
 * Every ring must have the same vertex count. This one function builds tapered
 * towers, domes, stadium bowls, bridge pylons, pyramid shells and cliff skirts,
 * which is why it earns the extra care over normals and caps.
 */
export function loft(
  rings: Float32Array[],
  capStart = false,
  capEnd = false,
): THREE.BufferGeometry {
  const R = rings.length;
  const N = rings[0].length / 3;
  // Caps fan from an added centroid vertex rather than from vertex 0. Several
  // of the plans lofted here are strongly non-convex — 555 California's bay
  // windows, the Alcatraz cliff skirt, a stadium bowl — and a fan from a corner
  // throws triangles outside the outline. A fan from the centre is correct for
  // any star-shaped polygon, which all of them are.
  const vertCount = R * N + (capStart ? 1 : 0) + (capEnd ? 1 : 0);
  const pos = new Float32Array(vertCount * 3);
  const uv = new Float32Array(vertCount * 2);
  for (let r = 0; r < R; r++) {
    const src = rings[r];
    for (let i = 0; i < N; i++) {
      const o = (r * N + i) * 3;
      pos[o] = src[i * 3];
      pos[o + 1] = src[i * 3 + 1];
      pos[o + 2] = src[i * 3 + 2];
      uv[(r * N + i) * 2] = i / N;
      uv[(r * N + i) * 2 + 1] = r / Math.max(1, R - 1);
    }
  }
  const idx: number[] = [];
  idx.length = 0;
  for (let r = 0; r < R - 1; r++) {
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const a = r * N + i;
      const b = r * N + j;
      const c = (r + 1) * N + j;
      const d = (r + 1) * N + i;
      idx.push(a, b, c, a, c, d);
    }
  }
  let next = R * N;
  if (capStart) {
    centroid(pos, 0, N, next);
    fanCap(idx, 0, N, next, false);
    next++;
  }
  if (capEnd) {
    centroid(pos, (R - 1) * N, N, next);
    fanCap(idx, (R - 1) * N, N, next, true);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Write the average of a ring's vertices into slot `at`. */
function centroid(pos: Float32Array, base: number, n: number, at: number): void {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < n; i++) {
    x += pos[(base + i) * 3];
    y += pos[(base + i) * 3 + 1];
    z += pos[(base + i) * 3 + 2];
  }
  pos[at * 3] = x / n;
  pos[at * 3 + 1] = y / n;
  pos[at * 3 + 2] = z / n;
}

/** Triangle fan from a centroid vertex across a ring — a loft cap. */
function fanCap(idx: number[], base: number, n: number, hub: number, flip: boolean): void {
  for (let i = 0; i < n; i++) {
    const a = base + i;
    const b = base + ((i + 1) % n);
    if (flip) idx.push(hub, a, b);
    else idx.push(hub, b, a);
  }
}

/**
 * Vertical prism from an arbitrary XZ polygon.
 *
 * Winding is normalised internally, so callers can hand it a polygon in
 * whichever direction the source data happened to be traced (which matters —
 * the Alcatraz cliff skirt is traced straight out of `LANDMASSES`).
 */
export function prism(
  polyXZ: readonly number[],
  y0: number,
  y1: number,
  capTop = true,
  capBottom = false,
): THREE.BufferGeometry {
  const n = polyXZ.length / 2;
  // Signed area tells us the winding; loft() wants a consistent one.
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += polyXZ[i * 2] * polyXZ[j * 2 + 1] - polyXZ[j * 2] * polyXZ[i * 2 + 1];
  }
  const flip = area > 0;
  const lo = new Float32Array(n * 3);
  const hi = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const i = flip ? n - 1 - k : k;
    lo[k * 3] = polyXZ[i * 2];
    lo[k * 3 + 1] = y0;
    lo[k * 3 + 2] = polyXZ[i * 2 + 1];
    hi[k * 3] = polyXZ[i * 2];
    hi[k * 3 + 1] = y1;
    hi[k * 3 + 2] = polyXZ[i * 2 + 1];
  }
  return loft([lo, hi], capBottom, capTop);
}

/**
 * Cylinder with a fluted (channelled) surface — Coit Tower's shaft, the
 * Doric-ish columns of the Palace of Fine Arts, City Hall's drum.
 */
export function flutedCylinder(
  rBottom: number,
  rTop: number,
  h: number,
  flutes: number,
  depth: number,
  rows = 2,
  seg = flutes * 4,
): THREE.BufferGeometry {
  const rings: Float32Array[] = [];
  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    const rad = rBottom + (rTop - rBottom) * t;
    rings.push(
      shapedRing(t * h, seg, (a) => {
        // |sin| of the flute frequency gives a scalloped channel with a sharp
        // arris between flutes, which is what a real flute profile looks like.
        const s = Math.abs(Math.sin((a * flutes) / 2));
        return rad - depth * Math.pow(s, 0.65);
      }),
    );
  }
  return loft(rings, true, true);
}

/** Plain lathe from a `[r, y, r, y, ...]` profile. */
export function lathe(profile: readonly number[], seg = 24): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < profile.length; i += 2) pts.push(new THREE.Vector2(profile[i], profile[i + 1]));
  return new THREE.LatheGeometry(pts, seg);
}

/** Tube swept along a polyline — cables, ropes, handrails, pipework. */
export function tube(
  points: THREE.Vector3[],
  radius: number,
  radial = 6,
  segments = Math.max(8, points.length * 2),
  closed = false,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points, closed, "centripetal", 0.5);
  return new THREE.TubeGeometry(curve, segments, radius, radial, closed);
}

/**
 * A suspension-bridge main cable.
 *
 * A free cable under its own weight is a catenary; a cable carrying a uniform
 * *deck* load through vertical hangers is a parabola. Suspension bridge cables
 * are overwhelmingly the second case, and the difference is visible: a parabola
 * is flatter near the towers and tighter at midspan. So this really is a
 * parabola, despite the name everyone uses for it.
 */
export function cableCurve(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  sag: number,
  n = 48,
): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // 4t(1-t) peaks at 1 in the middle and is 0 at both ends.
    const droop = 4 * t * (1 - t) * sag;
    out.push(
      new THREE.Vector3(
        ax + (bx - ax) * t,
        ay + (by - ay) * t - droop,
        az + (bz - az) * t,
      ),
    );
  }
  return out;
}

/** Height of `cableCurve` at parameter t — for hanging suspender ropes off it. */
export function cableY(ay: number, by: number, sag: number, t: number): number {
  return ay + (by - ay) * t - 4 * t * (1 - t) * sag;
}

/**
 * A wall panel with an arched opening cut through it, extruded along Z.
 *
 * Arcades are everywhere in this city — the Ferry Building, the Palace, City
 * Hall's loggia, Oracle Park's outer wall, Alcatraz's cellhouse — and doing
 * them with a boolean-free extruded shape keeps them one cheap geometry.
 */
export function archedPanel(
  w: number,
  h: number,
  thickness: number,
  openW: number,
  openH: number,
  springLine = openH - openW / 2,
  arcSeg = 12,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(w / 2, h);
  shape.lineTo(-w / 2, h);
  shape.closePath();

  const hole = new THREE.Path();
  const ow = openW / 2;
  hole.moveTo(-ow, 0);
  hole.lineTo(-ow, springLine);
  const r = ow;
  for (let i = 1; i <= arcSeg; i++) {
    const a = Math.PI - (i / arcSeg) * Math.PI;
    hole.lineTo(Math.cos(a) * r, springLine + Math.sin(a) * r);
  }
  hole.lineTo(ow, 0);
  hole.closePath();
  shape.holes.push(hole);

  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
    curveSegments: 4,
  });
  g.translate(0, 0, -thickness / 2);
  return g;
}

/** A pointed (Gothic) arch opening in a wall panel. Grace Cathedral's grammar. */
export function lancetPanel(
  w: number,
  h: number,
  thickness: number,
  openW: number,
  openH: number,
  arcSeg = 8,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(w / 2, h);
  shape.lineTo(-w / 2, h);
  shape.closePath();

  const ow = openW / 2;
  // Equilateral arch: each half is a circular arc of radius `openW` struck from
  // the *opposite* springing point. That single rule generates every pointed
  // arch in a French Gothic elevation, and it is why they all look related.
  const spring = Math.max(0.1, openH - ow * Math.sqrt(3));
  const R = openW;
  const hole = new THREE.Path();
  hole.moveTo(-ow, 0);
  hole.lineTo(-ow, spring);
  for (let i = 1; i <= arcSeg; i++) {
    const a = Math.PI - (i / arcSeg) * (Math.PI / 3); // 180deg -> 120deg
    hole.lineTo(ow + Math.cos(a) * R, spring + Math.sin(a) * R);
  }
  for (let i = 1; i <= arcSeg; i++) {
    const a = Math.PI / 3 - (i / arcSeg) * (Math.PI / 3); // 60deg -> 0deg
    hole.lineTo(-ow + Math.cos(a) * R, spring + Math.sin(a) * R);
  }
  hole.lineTo(ow, 0);
  hole.closePath();
  shape.holes.push(hole);

  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
    curveSegments: 3,
  });
  g.translate(0, 0, -thickness / 2);
  return g;
}

/**
 * A classical column: shaft (optionally fluted, always with entasis), a moulded
 * base, and a capital. Corinthian-ish at LOD 0, a plain drum far away.
 */
export function column(
  h: number,
  rBase: number,
  detail: boolean,
  order: "doric" | "corinthian" = "corinthian",
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const shaftH = h * 0.84;
  const rTop = rBase * 0.82;
  if (detail) {
    // Entasis: the shaft is not a cone, it swells around a third of the way up.
    // Leave it out and a colonnade reads as scaffolding.
    const rows = 6;
    const rings: Float32Array[] = [];
    const seg = order === "corinthian" ? 24 : 20;
    const flutes = order === "corinthian" ? 24 : 20;
    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      const swell = 1 + 0.035 * Math.sin(Math.pow(t, 0.8) * Math.PI);
      const rad = (rBase + (rTop - rBase) * t) * swell;
      rings.push(
        shapedRing(h * 0.08 + t * shaftH, seg, (a) => {
          const s = Math.abs(Math.sin((a * flutes) / 2));
          return rad - rBase * 0.06 * Math.pow(s, 0.6);
        }),
      );
    }
    parts.push(loft(rings, false, false));
  } else {
    parts.push(taperBoxCyl(rBase, rTop, shaftH, 8, h * 0.08));
  }
  // Base: plinth + torus.
  const plinth = box(rBase * 2.3, h * 0.05, rBase * 2.3);
  plinth.translate(0, h * 0.025, 0);
  parts.push(plinth);
  const torus = lathe(
    [rBase * 1.02, h * 0.05, rBase * 1.16, h * 0.062, rBase * 1.14, h * 0.075, rBase * 1.0, h * 0.085],
    detail ? 20 : 10,
  );
  parts.push(torus);
  // Capital.
  const capY = h * 0.08 + shaftH;
  if (order === "corinthian" && detail) {
    // Bell + two rows of acanthus suggested by stepped scallops, then abacus.
    const bell = lathe(
      [
        rTop, capY,
        rTop * 1.05, capY + h * 0.02,
        rTop * 1.22, capY + h * 0.05,
        rTop * 1.16, capY + h * 0.07,
        rTop * 1.42, capY + h * 0.1,
        rTop * 1.5, capY + h * 0.115,
      ],
      16,
    );
    parts.push(bell);
    const ab = box(rTop * 3.2, h * 0.03, rTop * 3.2);
    ab.translate(0, capY + h * 0.13, 0);
    parts.push(ab);
    // Volutes at the four corners.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const v = new THREE.SphereGeometry(rTop * 0.34, 8, 6);
      v.translate(Math.cos(a) * rTop * 1.35, capY + h * 0.105, Math.sin(a) * rTop * 1.35);
      parts.push(v);
    }
  } else {
    const echinus = lathe(
      [rTop, capY, rTop * 1.22, capY + h * 0.04, rTop * 1.3, capY + h * 0.055],
      detail ? 16 : 8,
    );
    parts.push(echinus);
    const ab = box(rTop * 2.8, h * 0.035, rTop * 2.8);
    ab.translate(0, capY + h * 0.072, 0);
    parts.push(ab);
  }
  return mergeAndDispose(parts);
}

/** Low-poly tapered drum, used for far-LOD columns and generic posts. */
export function taperBoxCyl(
  rBottom: number,
  rTop: number,
  h: number,
  seg: number,
  y0 = 0,
): THREE.BufferGeometry {
  return loft([circleRing(rBottom, y0, seg), circleRing(rTop, y0 + h, seg)], true, true);
}

/**
 * A moulded cornice / string course run along X, centred on the origin.
 * Profile is (out, up) pairs relative to the wall face at z = 0.
 */
export function cornice(
  length: number,
  profile: readonly number[],
  depth = 0,
): THREE.BufferGeometry {
  const n = profile.length / 2;
  const rings: Float32Array[] = [];
  // Sweep the profile along X by lofting two identical "rings" — the profile
  // closed back on itself against the wall plane.
  const pts: number[] = [];
  for (let i = 0; i < n; i++) pts.push(profile[i * 2], profile[i * 2 + 1]);
  pts.push(depth, profile[(n - 1) * 2 + 1]);
  pts.push(depth, profile[1]);
  const cnt = pts.length / 2;
  const a = new Float32Array(cnt * 3);
  const b = new Float32Array(cnt * 3);
  for (let i = 0; i < cnt; i++) {
    a[i * 3] = -length / 2;
    a[i * 3 + 1] = pts[i * 2 + 1];
    a[i * 3 + 2] = pts[i * 2];
    b[i * 3] = length / 2;
    b[i * 3 + 1] = pts[i * 2 + 1];
    b[i * 3 + 2] = pts[i * 2];
  }
  return loft([a, b], true, true);
}

/**
 * A flight of stairs running along +X, rising +Y. Returns one merged geometry;
 * `count` risers of `rise` by `run`, `width` wide.
 */
export function stairs(
  count: number,
  rise: number,
  run: number,
  width: number,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const g = box(run, rise * (i + 1), width);
    g.translate(run * (i + 0.5), (rise * (i + 1)) / 2, 0);
    parts.push(g);
  }
  return mergeAndDispose(parts);
}

/**
 * A gabled roof over a `w` x `d` footprint, ridge running along X, with an
 * overhanging eave. Returns the roof planes plus the two gable ends.
 */
export function gableRoof(
  w: number,
  d: number,
  h: number,
  overhang = 0.35,
): THREE.BufferGeometry {
  const hw = w / 2 + overhang;
  const hd = d / 2 + overhang;
  const pos: number[] = [];
  const idx: number[] = [];
  const uv: number[] = [];
  const push = (x: number, y: number, z: number, u: number, v: number) => {
    pos.push(x, y, z);
    uv.push(u, v);
    return pos.length / 3 - 1;
  };
  // Two sloping planes.
  const a0 = push(-hw, 0, -hd, 0, 0);
  const a1 = push(hw, 0, -hd, 1, 0);
  const a2 = push(hw, h, 0, 1, 1);
  const a3 = push(-hw, h, 0, 0, 1);
  idx.push(a0, a1, a2, a0, a2, a3);
  const b0 = push(hw, 0, hd, 0, 0);
  const b1 = push(-hw, 0, hd, 1, 0);
  const b2 = push(-hw, h, 0, 1, 1);
  const b3 = push(hw, h, 0, 0, 1);
  idx.push(b0, b1, b2, b0, b2, b3);
  // Gable ends (triangles closing the roof at each end of the ridge).
  const g0 = push(-hw, 0, -hd, 0, 0);
  const g1 = push(-hw, 0, hd, 1, 0);
  const g2 = push(-hw, h, 0, 0.5, 1);
  idx.push(g0, g2, g1);
  const g3 = push(hw, 0, hd, 0, 0);
  const g4 = push(hw, 0, -hd, 1, 0);
  const g5 = push(hw, h, 0, 0.5, 1);
  idx.push(g3, g5, g4);

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Hipped (pyramidal) roof over a w x d footprint. */
export function hipRoof(w: number, d: number, h: number, overhang = 0.3): THREE.BufferGeometry {
  const hw = w / 2 + overhang;
  const hd = d / 2 + overhang;
  const base = new Float32Array([-hw, 0, -hd, hw, 0, -hd, hw, 0, hd, -hw, 0, hd]);
  const apex = new Float32Array([-0.001, h, -0.001, 0.001, h, -0.001, 0.001, h, 0.001, -0.001, h, 0.001]);
  return loft([base, apex], true, false);
}

/**
 * A ribbon surface swept along a polyline at a given width — roadways, ramps,
 * bridge decks, the Lombard Street switchbacks.
 *
 * `left`/`right` half-widths are separate so a road can be widened on the
 * outside of a bend, which is how the real Lombard hairpins are built.
 */
export function ribbon(
  points: readonly THREE.Vector3[],
  halfWidth: number,
  thickness = 0,
): THREE.BufferGeometry {
  const n = points.length;
  const left: number[] = [];
  const right: number[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const side = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    dir.subVectors(b, a);
    dir.y = 0;
    if (dir.lengthSq() < 1e-8) dir.set(1, 0, 0);
    dir.normalize();
    side.crossVectors(up, dir).normalize().multiplyScalar(halfWidth);
    left.push(p.x + side.x, p.y, p.z + side.z);
    right.push(p.x - side.x, p.y, p.z - side.z);
  }
  const rings: Float32Array[] = [];
  if (thickness > 0) {
    // Closed cross-section: top-left, top-right, bottom-right, bottom-left.
    for (let i = 0; i < n; i++) {
      rings.push(
        new Float32Array([
          left[i * 3], left[i * 3 + 1], left[i * 3 + 2],
          right[i * 3], right[i * 3 + 1], right[i * 3 + 2],
          right[i * 3], right[i * 3 + 1] - thickness, right[i * 3 + 2],
          left[i * 3], left[i * 3 + 1] - thickness, left[i * 3 + 2],
        ]),
      );
    }
    return loft(rings, true, true);
  }
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  const idx: number[] = [];
  let run = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) run += points[i].distanceTo(points[i - 1]);
    pos[i * 6] = left[i * 3];
    pos[i * 6 + 1] = left[i * 3 + 1];
    pos[i * 6 + 2] = left[i * 3 + 2];
    pos[i * 6 + 3] = right[i * 3];
    pos[i * 6 + 4] = right[i * 3 + 1];
    pos[i * 6 + 5] = right[i * 3 + 2];
    uv[i * 4] = 0;
    uv[i * 4 + 1] = run / (halfWidth * 2);
    uv[i * 4 + 2] = 1;
    uv[i * 4 + 3] = run / (halfWidth * 2);
    if (i < n - 1) {
      const a = i * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Merge a throwaway list of geometries into one and dispose the sources. */
export function mergeAndDispose(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (parts.length === 1) return parts[0];
  const prepped = parts.map((p) => prep(p));
  const merged = mergeGeometries(prepped, false);
  for (const p of parts) p.dispose();
  for (const p of prepped) p.dispose();
  return merged ?? new THREE.BufferGeometry();
}
