/**
 * geom.ts — the geometry sink and primitive kit the street layer builds on.
 *
 * Every street chunk is one merged, indexed BufferGeometry per material. That
 * is not an optimisation detail, it is the whole architecture: a city block has
 * a hundred kerb slabs, three hundred lane-marking dashes and forty manhole
 * covers, and if each of those were a Mesh the renderer would spend the entire
 * frame in `WebGLRenderer.renderObject`. So everything writes into a `MeshSink`
 * and comes out the other side as one draw call.
 *
 * The sink stores position / normal / uv / colour interleaved across four
 * parallel typed arrays that double on demand. Colour is *always* present:
 * asphalt patch variation, tyre polish, kerb staining, painted lane colours
 * (white / yellow / SFMTA red / bike-lane green) and prop tinting all ride on
 * it, which is what lets a single cached material serve a dozen visually
 * distinct surfaces without a single extra texture upload.
 *
 * UVs are authored in *world metres divided by the material's world scale*, so
 * a chunk boundary is invisible: two chunks meeting at x=640 agree on the UV
 * because both derive it from the same absolute coordinate.
 */
import * as THREE from "three";

/** Scratch vectors — module scope so nothing allocates inside a build loop. */
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

export class MeshSink {
  pos: Float32Array;
  nor: Float32Array;
  uv: Float32Array;
  col: Float32Array;
  idx: Uint32Array;
  vCount = 0;
  iCount = 0;

  constructor(vertexHint = 4096) {
    const v = Math.max(64, vertexHint);
    this.pos = new Float32Array(v * 3);
    this.nor = new Float32Array(v * 3);
    this.uv = new Float32Array(v * 2);
    this.col = new Float32Array(v * 3);
    this.idx = new Uint32Array(v * 3);
  }

  get empty(): boolean {
    return this.iCount === 0;
  }

  private growVerts(need: number): void {
    let cap = this.pos.length / 3;
    if (this.vCount + need <= cap) return;
    while (cap < this.vCount + need) cap *= 2;
    const p = new Float32Array(cap * 3);
    p.set(this.pos);
    this.pos = p;
    const n = new Float32Array(cap * 3);
    n.set(this.nor);
    this.nor = n;
    const u = new Float32Array(cap * 2);
    u.set(this.uv);
    this.uv = u;
    const c = new Float32Array(cap * 3);
    c.set(this.col);
    this.col = c;
  }

  private growIdx(need: number): void {
    let cap = this.idx.length;
    if (this.iCount + need <= cap) return;
    while (cap < this.iCount + need) cap *= 2;
    const a = new Uint32Array(cap);
    a.set(this.idx);
    this.idx = a;
  }

  /** Push one vertex; returns its index. */
  vert(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    u: number, v: number,
    r: number, g: number, b: number,
  ): number {
    this.growVerts(1);
    const i = this.vCount++;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.nor[i3] = nx; this.nor[i3 + 1] = ny; this.nor[i3 + 2] = nz;
    this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b;
    const i2 = i * 2;
    this.uv[i2] = u; this.uv[i2 + 1] = v;
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.growIdx(3);
    this.idx[this.iCount++] = a;
    this.idx[this.iCount++] = b;
    this.idx[this.iCount++] = c;
  }

  /** Two triangles, a-b-c / a-c-d. Winding is the caller's problem. */
  quad(a: number, b: number, c: number, d: number): void {
    this.growIdx(6);
    this.idx[this.iCount++] = a;
    this.idx[this.iCount++] = b;
    this.idx[this.iCount++] = c;
    this.idx[this.iCount++] = a;
    this.idx[this.iCount++] = c;
    this.idx[this.iCount++] = d;
  }

  /**
   * Hand the accumulated buffers to three. Returns null for an empty sink so
   * callers can skip creating a Mesh for a chunk that turned out to be water.
   *
   * `origin` is subtracted from every position: chunk geometry is authored in
   * world coordinates for correct UVs and noise lookups, then rebased so the
   * mesh sits at a local origin. At 7 km from the world origin a float32 has
   * about half a millimetre of precision left, which is visible as z-fighting
   * on a 12 mm lane marking; rebasing puts it back to micrometres.
   */
  finalize(origin?: { x: number; y: number; z: number }): THREE.BufferGeometry | null {
    if (this.iCount === 0) return null;
    const n = this.vCount;
    const pos = this.pos.slice(0, n * 3);
    if (origin) {
      for (let i = 0; i < n; i++) {
        pos[i * 3] -= origin.x;
        pos[i * 3 + 1] -= origin.y;
        pos[i * 3 + 2] -= origin.z;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(this.nor.slice(0, n * 3), 3));
    g.setAttribute("uv", new THREE.BufferAttribute(this.uv.slice(0, n * 2), 2));
    g.setAttribute("color", new THREE.BufferAttribute(this.col.slice(0, n * 3), 3));
    const idx = this.iCount > 65000
      ? new THREE.BufferAttribute(this.idx.slice(0, this.iCount), 1)
      : new THREE.BufferAttribute(Uint16Array.from(this.idx.subarray(0, this.iCount)), 1);
    g.setIndex(idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  /** Reset without releasing the backing store — for pooled builders. */
  reset(): void {
    this.vCount = 0;
    this.iCount = 0;
  }
}

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ *
 * All of these take explicit world positions rather than a transform, because
 * street geometry is nearly always defined by a road centreline sample rather
 * than by a matrix, and going through a matrix would mean allocating one.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Unpack a hex colour into linear-ish floats. Values are sRGB-ish literals
 *  used as vertex tints, so they are passed straight through — three treats
 *  the colour attribute as linear, and the material's own albedo carries the
 *  heavy lifting. Tints are deliberately near-neutral multipliers. */
export function rgb(hex: number, out: RGB = { r: 0, g: 0, b: 0 }): RGB {
  out.r = ((hex >> 16) & 255) / 255;
  out.g = ((hex >> 8) & 255) / 255;
  out.b = (hex & 255) / 255;
  return out;
}

/** sRGB hex → linear, for tints that must match a literal paint colour. */
export function rgbLinear(hex: number, out: RGB = { r: 0, g: 0, b: 0 }): RGB {
  rgb(hex, out);
  out.r = srgbToLinear(out.r);
  out.g = srgbToLinear(out.g);
  out.b = srgbToLinear(out.b);
  return out;
}

function srgbToLinear(c: number): number {
  return c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * A planar quad from four world points, given in order around the perimeter.
 * The normal is derived from the first triangle, so a degenerate quad simply
 * gets a garbage-but-harmless up normal rather than a NaN.
 */
export function addQuad(
  sink: MeshSink,
  p0: ArrayLike<number>, p1: ArrayLike<number>, p2: ArrayLike<number>, p3: ArrayLike<number>,
  uv0: number, uv1: number, uv2: number, uv3: number, uv4: number, uv5: number, uv6: number, uv7: number,
  c: RGB,
): void {
  _a.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  _b.set(p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]);
  _n.crossVectors(_a, _b);
  if (_n.lengthSq() < 1e-12) _n.set(0, 1, 0);
  else _n.normalize();
  const a = sink.vert(p0[0], p0[1], p0[2], _n.x, _n.y, _n.z, uv0, uv1, c.r, c.g, c.b);
  const b = sink.vert(p1[0], p1[1], p1[2], _n.x, _n.y, _n.z, uv2, uv3, c.r, c.g, c.b);
  const cc = sink.vert(p2[0], p2[1], p2[2], _n.x, _n.y, _n.z, uv4, uv5, c.r, c.g, c.b);
  const d = sink.vert(p3[0], p3[1], p3[2], _n.x, _n.y, _n.z, uv6, uv7, c.r, c.g, c.b);
  sink.quad(a, b, cc, d);
}

/**
 * Horizontal quad with world-space planar UVs. This is the workhorse for
 * anything lying on the ground: markings, patches, tree wells, ramps.
 */
export function addGroundQuad(
  sink: MeshSink,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  x3: number, y3: number, z3: number,
  uvScale: number,
  c: RGB,
  nx = 0, ny = 1, nz = 0,
): void {
  const s = 1 / uvScale;
  // Auto-orient. Ground quads are assembled from road-relative coordinates
  // whose handedness flips depending on which end of an edge you approach an
  // intersection from, and a back-facing crosswalk is invisible rather than
  // obviously wrong — which makes it the kind of bug you ship.
  const area = (x1 - x0) * (z2 - z0) - (z1 - z0) * (x2 - x0);
  const flip = area > 0;
  const px = flip ? [x0, x3, x2, x1] : [x0, x1, x2, x3];
  const py = flip ? [y0, y3, y2, y1] : [y0, y1, y2, y3];
  const pz = flip ? [z0, z3, z2, z1] : [z0, z1, z2, z3];
  const a = sink.vert(px[0], py[0], pz[0], nx, ny, nz, px[0] * s, pz[0] * s, c.r, c.g, c.b);
  const b = sink.vert(px[1], py[1], pz[1], nx, ny, nz, px[1] * s, pz[1] * s, c.r, c.g, c.b);
  const d = sink.vert(px[2], py[2], pz[2], nx, ny, nz, px[2] * s, pz[2] * s, c.r, c.g, c.b);
  const e = sink.vert(px[3], py[3], pz[3], nx, ny, nz, px[3] * s, pz[3] * s, c.r, c.g, c.b);
  sink.quad(a, b, d, e);
}

/**
 * An axis-aligned-in-local-space box, rotated about +Y and placed in the world.
 * Bottom face is skipped when `capBottom` is false, which matters more than it
 * sounds: a street is covered in boxes sitting on the ground and their bottoms
 * are 15 % of the triangle count for zero visible benefit.
 */
export function addBox(
  sink: MeshSink,
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
  yaw: number,
  c: RGB,
  uvScale = 1,
  capBottom = false,
): void {
  const co = Math.cos(yaw);
  const si = Math.sin(yaw);
  const s = 1 / uvScale;
  // 8 corners
  const px: number[] = [];
  const py: number[] = [];
  const pz: number[] = [];
  for (let i = 0; i < 8; i++) {
    const lx = i & 1 ? hx : -hx;
    const ly = i & 2 ? hy : -hy;
    const lz = i & 4 ? hz : -hz;
    px.push(cx + lx * co - lz * si);
    py.push(cy + ly);
    pz.push(cz + lx * si + lz * co);
  }
  const face = (
    i0: number, i1: number, i2: number, i3: number,
    nx: number, ny: number, nz: number,
    w: number, h: number,
  ) => {
    const rx = nx * co - nz * si;
    const rz = nx * si + nz * co;
    const a = sink.vert(px[i0], py[i0], pz[i0], rx, ny, rz, 0, 0, c.r, c.g, c.b);
    const b = sink.vert(px[i1], py[i1], pz[i1], rx, ny, rz, w * s, 0, c.r, c.g, c.b);
    const d = sink.vert(px[i2], py[i2], pz[i2], rx, ny, rz, w * s, h * s, c.r, c.g, c.b);
    const e = sink.vert(px[i3], py[i3], pz[i3], rx, ny, rz, 0, h * s, c.r, c.g, c.b);
    sink.quad(a, b, d, e);
  };
  // +X, -X, +Z, -Z, +Y, (-Y)
  // Vertex order is reversed relative to the "obvious" corner walk because the
  // sink treats a counter-clockwise winding *seen from outside* as front-facing
  // and the +X/+Z axes of this coordinate system are left-handed on screen.
  face(3, 7, 5, 1, 1, 0, 0, hz * 2, hy * 2);
  face(6, 2, 0, 4, -1, 0, 0, hz * 2, hy * 2);
  face(7, 6, 4, 5, 0, 0, 1, hx * 2, hy * 2);
  face(2, 3, 1, 0, 0, 0, -1, hx * 2, hy * 2);
  face(6, 7, 3, 2, 0, 1, 0, hx * 2, hz * 2);
  if (capBottom) face(0, 1, 5, 4, 0, -1, 0, hx * 2, hz * 2);
}

/**
 * A vertical tapered cylinder — poles, trunks, bollards, hydrant barrels.
 * `segments` is the only knob that matters for cost: a lamp post at 30 m needs
 * six sides, and the difference between six and sixteen across ten thousand
 * poles is a million triangles.
 */
export function addCylinder(
  sink: MeshSink,
  cx: number, y0: number, cz: number,
  r0: number, r1: number, h: number,
  segments: number,
  c: RGB,
  uvScale = 1,
  capTop = true,
  yawOffset = 0,
): void {
  const s = 1 / uvScale;
  const y1 = y0 + h;
  const ringA: number[] = [];
  const ringB: number[] = [];
  // Slope of the side wall feeds the normal so a strongly tapered pole does not
  // shade like a cylinder.
  const slope = (r0 - r1) / Math.max(h, 1e-4);
  const inv = 1 / Math.sqrt(1 + slope * slope);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const ang = yawOffset + t * Math.PI * 2;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const nx = ca * inv;
    const nz = sa * inv;
    const ny = slope * inv;
    const u = t * Math.PI * 2 * ((r0 + r1) * 0.5) * s;
    ringA.push(sink.vert(cx + ca * r0, y0, cz + sa * r0, nx, ny, nz, u, y0 * s, c.r, c.g, c.b));
    ringB.push(sink.vert(cx + ca * r1, y1, cz + sa * r1, nx, ny, nz, u, y1 * s, c.r, c.g, c.b));
  }
  for (let i = 0; i < segments; i++) {
    sink.quad(ringB[i], ringB[i + 1], ringA[i + 1], ringA[i]);
  }
  if (capTop && r1 > 1e-4) {
    const centre = sink.vert(cx, y1, cz, 0, 1, 0, cx * s, cz * s, c.r, c.g, c.b);
    const cap: number[] = [];
    for (let i = 0; i <= segments; i++) {
      const ang = yawOffset + (i / segments) * Math.PI * 2;
      cap.push(sink.vert(
        cx + Math.cos(ang) * r1, y1, cz + Math.sin(ang) * r1,
        0, 1, 0,
        (cx + Math.cos(ang) * r1) * s, (cz + Math.sin(ang) * r1) * s,
        c.r, c.g, c.b,
      ));
    }
    for (let i = 0; i < segments; i++) sink.tri(centre, cap[i + 1], cap[i]);
  }
}

/** Flat horizontal disc — manhole covers, drain plates, lamp lenses. */
export function addDisc(
  sink: MeshSink,
  cx: number, cy: number, cz: number,
  r: number,
  segments: number,
  c: RGB,
  uvScale = 1,
): void {
  const s = 1 / uvScale;
  const centre = sink.vert(cx, cy, cz, 0, 1, 0, cx * s, cz * s, c.r, c.g, c.b);
  const ring: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const ang = (i / segments) * Math.PI * 2;
    const x = cx + Math.cos(ang) * r;
    const z = cz + Math.sin(ang) * r;
    ring.push(sink.vert(x, cy, z, 0, 1, 0, x * s, z * s, c.r, c.g, c.b));
  }
  for (let i = 0; i < segments; i++) sink.tri(centre, ring[i + 1], ring[i]);
}

/**
 * A swept tube along an arbitrary polyline — overhead wires, catenary spans,
 * handrails, tree branches. Uses a parallel-transport-free frame (a fixed world
 * up reference) because none of these ever loop back on themselves vertically.
 */
export function addTube(
  sink: MeshSink,
  pts: ArrayLike<number>,
  count: number,
  radius: number,
  segments: number,
  c: RGB,
  uvScale = 1,
): void {
  if (count < 2) return;
  const s = 1 / uvScale;
  let prevRing: number[] | null = null;
  let dist = 0;
  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const x = pts[i3];
    const y = pts[i3 + 1];
    const z = pts[i3 + 2];
    // Tangent by central difference.
    const j = i === 0 ? 0 : i - 1;
    const k = i === count - 1 ? count - 1 : i + 1;
    _a.set(pts[k * 3] - pts[j * 3], pts[k * 3 + 1] - pts[j * 3 + 1], pts[k * 3 + 2] - pts[j * 3 + 2]);
    if (_a.lengthSq() < 1e-10) _a.set(0, 0, 1);
    _a.normalize();
    // Side vector: tangent × world up, falling back to +X for a vertical run.
    _b.set(_a.z, 0, -_a.x);
    if (_b.lengthSq() < 1e-8) _b.set(1, 0, 0);
    _b.normalize();
    _c.crossVectors(_a, _b).normalize();
    if (i > 0) {
      dist += Math.hypot(x - pts[i3 - 3], y - pts[i3 - 2], z - pts[i3 - 1]);
    }
    const ring: number[] = [];
    for (let q = 0; q <= segments; q++) {
      const ang = (q / segments) * Math.PI * 2;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const nx = _b.x * ca + _c.x * sa;
      const ny = _b.y * ca + _c.y * sa;
      const nz = _b.z * ca + _c.z * sa;
      ring.push(sink.vert(
        x + nx * radius, y + ny * radius, z + nz * radius,
        nx, ny, nz,
        (q / segments) * radius * 6.28 * s, dist * s,
        c.r, c.g, c.b,
      ));
    }
    if (prevRing) {
      for (let q = 0; q < segments; q++) {
        sink.quad(prevRing[q], prevRing[q + 1], ring[q + 1], ring[q]);
      }
    }
    prevRing = ring;
  }
}

/**
 * Triangle-fan a convex-ish polygon lying (roughly) in a horizontal plane.
 * Used for intersection decks and kerb corner fillets. Points are [x,y,z]
 * triples in counter-clockwise order seen from above.
 */
export function addPolygon(
  sink: MeshSink,
  pts: ArrayLike<number>,
  count: number,
  uvScale: number,
  c: RGB,
  centroid?: { x: number; y: number; z: number },
): void {
  if (count < 3) return;
  const s = 1 / uvScale;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  if (centroid) {
    cx = centroid.x; cy = centroid.y; cz = centroid.z;
  } else {
    for (let i = 0; i < count; i++) {
      cx += pts[i * 3];
      cy += pts[i * 3 + 1];
      cz += pts[i * 3 + 2];
    }
    cx /= count; cy /= count; cz /= count;
  }
  // Signed area in XZ tells us which way the ring was wound; the fan is emitted
  // in whichever order makes the face point at the sky.
  let area = 0;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    area += pts[i * 3] * pts[j * 3 + 2] - pts[j * 3] * pts[i * 3 + 2];
  }
  const flip = area > 0;
  const centre = sink.vert(cx, cy, cz, 0, 1, 0, cx * s, cz * s, c.r, c.g, c.b);
  const ring: number[] = [];
  for (let i = 0; i < count; i++) {
    const k = flip ? count - 1 - i : i;
    const x = pts[k * 3];
    const y = pts[k * 3 + 1];
    const z = pts[k * 3 + 2];
    ring.push(sink.vert(x, y, z, 0, 1, 0, x * s, z * s, c.r, c.g, c.b));
  }
  for (let i = 0; i < count; i++) {
    sink.tri(centre, ring[i], ring[(i + 1) % count]);
  }
}

/**
 * A camera-facing-agnostic crossed-quad cluster — the classic vegetation card.
 * `planes` intersecting quads through a common vertical axis, each of size
 * w × h, centred at (cx, cy, cz). Normals point outward-and-up so the canopy
 * lights like a rounded mass instead of like two flat sheets.
 */
export function addCrossQuads(
  sink: MeshSink,
  cx: number, cy: number, cz: number,
  w: number, h: number,
  planes: number,
  yawOffset: number,
  c: RGB,
  uvRect: [number, number, number, number] = [0, 0, 1, 1],
): void {
  const [u0, v0, u1, v1] = uvRect;
  for (let p = 0; p < planes; p++) {
    const ang = yawOffset + (p / planes) * Math.PI;
    const dx = Math.cos(ang) * w * 0.5;
    const dz = Math.sin(ang) * w * 0.5;
    // Outward-and-up normals: a hemispherical fake that reads as volume.
    const nOutX = Math.cos(ang + Math.PI / 2);
    const nOutZ = Math.sin(ang + Math.PI / 2);
    const bl = sink.vert(cx - dx, cy - h * 0.5, cz - dz, -nOutX * 0.5, -0.4, -nOutZ * 0.5, u0, v0, c.r, c.g, c.b);
    const br = sink.vert(cx + dx, cy - h * 0.5, cz + dz, nOutX * 0.5, -0.4, nOutZ * 0.5, u1, v0, c.r, c.g, c.b);
    const tr = sink.vert(cx + dx, cy + h * 0.5, cz + dz, nOutX * 0.5, 0.8, nOutZ * 0.5, u1, v1, c.r, c.g, c.b);
    const tl = sink.vert(cx - dx, cy + h * 0.5, cz - dz, -nOutX * 0.5, 0.8, -nOutZ * 0.5, u0, v1, c.r, c.g, c.b);
    sink.quad(bl, br, tr, tl);
    sink.quad(tl, tr, br, bl); // double-sided; foliage is alpha-tested
  }
}

/**
 * A vertical billboard quad standing on the ground at (x,z), width w, height h,
 * facing `yaw`. Signage, ivy panels, construction hoarding.
 */
export function addPanel(
  sink: MeshSink,
  cx: number, cy: number, cz: number,
  w: number, h: number,
  yaw: number,
  c: RGB,
  uvRect: [number, number, number, number] = [0, 0, 1, 1],
  doubleSided = false,
): void {
  const [u0, v0, u1, v1] = uvRect;
  const dx = Math.cos(yaw) * w * 0.5;
  const dz = Math.sin(yaw) * w * 0.5;
  const nx = -Math.sin(yaw);
  const nz = Math.cos(yaw);
  const bl = sink.vert(cx - dx, cy - h * 0.5, cz - dz, nx, 0, nz, u0, v0, c.r, c.g, c.b);
  const br = sink.vert(cx + dx, cy - h * 0.5, cz + dz, nx, 0, nz, u1, v0, c.r, c.g, c.b);
  const tr = sink.vert(cx + dx, cy + h * 0.5, cz + dz, nx, 0, nz, u1, v1, c.r, c.g, c.b);
  const tl = sink.vert(cx - dx, cy + h * 0.5, cz - dz, nx, 0, nz, u0, v1, c.r, c.g, c.b);
  sink.quad(bl, br, tr, tl);
  if (doubleSided) {
    const bl2 = sink.vert(cx - dx, cy - h * 0.5, cz - dz, -nx, 0, -nz, u1, v0, c.r, c.g, c.b);
    const br2 = sink.vert(cx + dx, cy - h * 0.5, cz + dz, -nx, 0, -nz, u0, v0, c.r, c.g, c.b);
    const tr2 = sink.vert(cx + dx, cy + h * 0.5, cz + dz, -nx, 0, -nz, u0, v1, c.r, c.g, c.b);
    const tl2 = sink.vert(cx - dx, cy + h * 0.5, cz - dz, -nx, 0, -nz, u1, v1, c.r, c.g, c.b);
    sink.quad(tl2, tr2, br2, bl2);
  }
}

/**
 * Sweep a constant-width strip along a polyline of centre points, offset
 * laterally. `pts` is [x,y,z,...] and `right` is the matching per-sample right
 * vector [rx,rz,...]. This is how every lane marking, kerb and rail is built.
 */
export function addStrip(
  sink: MeshSink,
  pts: ArrayLike<number>,
  right: ArrayLike<number>,
  count: number,
  offset: number,
  width: number,
  yLift: number,
  uvScale: number,
  c: RGB,
): void {
  if (count < 2) return;
  const s = 1 / uvScale;
  const hw = width * 0.5;
  let prevL = -1;
  let prevR = -1;
  let run = 0;
  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const i2 = i * 2;
    const rx = right[i2];
    const rz = right[i2 + 1];
    const x = pts[i3] + rx * offset;
    const y = pts[i3 + 1] + yLift;
    const z = pts[i3 + 2] + rz * offset;
    if (i > 0) {
      run += Math.hypot(x - pts[i3 - 3] - right[i2 - 2] * offset, z - pts[i3 - 1] - right[i2 - 1] * offset);
    }
    const l = sink.vert(x - rx * hw, y, z - rz * hw, 0, 1, 0, 0, run * s, c.r, c.g, c.b);
    const r = sink.vert(x + rx * hw, y, z + rz * hw, 0, 1, 0, width * s, run * s, c.r, c.g, c.b);
    if (prevL >= 0) sink.quad(prevL, prevR, r, l);
    prevL = l;
    prevR = r;
  }
}
