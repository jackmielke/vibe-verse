/**
 * batch.ts — how a whole city becomes a dozen draw calls.
 *
 * Vibe Francisco is about eleven hundred buildings, four hundred street
 * segments, a thousand trees and a heightfield, and all of it is resident at
 * once. As separate meshes that is thousands of draw calls and an unplayable
 * frame on a phone. So nothing here is a mesh until the very end: geometry is
 * written into growable typed arrays, tagged with a per-vertex colour, and
 * merged into one buffer per material at the close of the build.
 *
 * The per-vertex colour is what makes one material enough. Every wall in the
 * city is the same `MeshToonMaterial` — the difference between a cream stucco
 * in North Beach and a slate curtain wall in the FiDi is three floats on each
 * vertex. That is also why the palette in `look.ts` can be a flat list rather
 * than a material library: colour is data here, not configuration.
 *
 * The API is deliberately small and shaped like the job: everything in this
 * world is a box, a prism, a ribbon along the ground, or a cylinder.
 */
import * as THREE from "three";

const V = new THREE.Vector3();
const N = new THREE.Vector3();

/** A growable float buffer. `Float32Array` cannot resize, and `push` on a plain
 *  array for two million numbers is where the build time would go. */
class Buf {
  data: Float32Array;
  len = 0;
  constructor(initial = 4096) {
    this.data = new Float32Array(initial);
  }
  need(n: number): void {
    if (this.len + n <= this.data.length) return;
    let cap = this.data.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.data.subarray(0, this.len));
    this.data = next;
  }
  push1(a: number): void {
    this.need(1);
    this.data[this.len++] = a;
  }
  push3(a: number, b: number, c: number): void {
    this.need(3);
    this.data[this.len++] = a;
    this.data[this.len++] = b;
    this.data[this.len++] = c;
  }
  view(): Float32Array {
    return this.data.subarray(0, this.len);
  }
}

class IndexBuf {
  data: Uint32Array;
  len = 0;
  constructor(initial = 4096) {
    this.data = new Uint32Array(initial);
  }
  push(a: number, b: number, c: number): void {
    if (this.len + 3 > this.data.length) {
      let cap = this.data.length * 2;
      while (cap < this.len + 3) cap *= 2;
      const next = new Uint32Array(cap);
      next.set(this.data.subarray(0, this.len));
      this.data = next;
    }
    this.data[this.len++] = a;
    this.data[this.len++] = b;
    this.data[this.len++] = c;
  }
  view(): Uint32Array {
    return this.data.subarray(0, this.len);
  }
}

/** RGB as three 0..1 floats, from a hex colour. Cached — the palette is small. */
const rgbCache = new Map<number, [number, number, number]>();
export function rgb(hex: number): [number, number, number] {
  const hit = rgbCache.get(hex);
  if (hit) return hit;
  const c = new THREE.Color(hex);
  // Vertex colours are multiplied in linear space, so convert once here rather
  // than living with a city that is uniformly too bright.
  const out: [number, number, number] = [c.r, c.g, c.b];
  rgbCache.set(hex, out);
  return out;
}

/**
 * A deterministic 0..1 from three numbers.
 *
 * Used to decide which window courses are lit at night. It has to be a *hash*
 * rather than an RNG stream because `bandedBox` is called from four different
 * builders and has no seed of its own — and because the answer must be the same
 * for the four faces of one building, or a tower ends up lit on the north side
 * and dark on the east.
 */
function hash3(a: number, b: number, c: number): number {
  let h = (Math.round(a * 7.3) * 374761393 + Math.round(b * 7.3) * 668265263 + c * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Multiply a colour by a scalar — the cheapest way to shade a face by hand. */
export function shade(c: [number, number, number], k: number): [number, number, number] {
  return [c[0] * k, c[1] * k, c[2] * k];
}

/**
 * One accumulating mesh.
 *
 * Positions, normals and colours; no UVs anywhere in this world, because
 * nothing in it is textured.
 */
export class Batch {
  private pos = new Buf(1 << 16);
  private nrm = new Buf(1 << 16);
  private col = new Buf(1 << 16);
  /**
   * Per-vertex emission, 0 or 1. What lights up at night.
   *
   * A channel rather than a separate mesh, and that is the whole trick: the
   * city is one material painting nine thousand buildings out of vertex
   * colour, and splitting the window bands into their own mesh so they could
   * have their own material would have meant threading a second `Batch`
   * through every builder in the world. One float per vertex costs 3.4 MB on
   * a city this size, is uploaded once, and lets `look.ts` add
   * `glow * night * lamplight` in the fragment shader for free.
   *
   * Geometry that never sets it is not paying for a decision it did not make:
   * an attribute a shader reads and a geometry lacks reads as zero.
   */
  private glo = new Buf(1 << 14);
  private idx = new IndexBuf(1 << 16);
  private vertexCount = 0;
  triangles = 0;

  get isEmpty(): boolean {
    return this.vertexCount === 0;
  }

  vertex(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    c: [number, number, number],
    glow = 0,
  ): number {
    this.pos.push3(x, y, z);
    this.nrm.push3(nx, ny, nz);
    this.col.push3(c[0], c[1], c[2]);
    this.glo.push1(glow);
    return this.vertexCount++;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
    this.triangles++;
  }

  /** A planar quad, wound counter-clockwise seen from the normal's side. */
  quad(
    p0: readonly [number, number, number],
    p1: readonly [number, number, number],
    p2: readonly [number, number, number],
    p3: readonly [number, number, number],
    c: [number, number, number],
    normal?: readonly [number, number, number],
    glow = 0,
  ): void {
    let nx: number, ny: number, nz: number;
    if (normal) {
      [nx, ny, nz] = normal;
    } else {
      V.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
      N.set(p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]);
      V.cross(N).normalize();
      nx = V.x; ny = V.y; nz = V.z;
    }
    const a = this.vertex(p0[0], p0[1], p0[2], nx, ny, nz, c, glow);
    const b = this.vertex(p1[0], p1[1], p1[2], nx, ny, nz, c, glow);
    const d = this.vertex(p2[0], p2[1], p2[2], nx, ny, nz, c, glow);
    const e = this.vertex(p3[0], p3[1], p3[2], nx, ny, nz, c, glow);
    this.tri(a, b, d);
    this.tri(a, d, e);
  }

  /**
   * An axis-aligned box, optionally tapered toward the top, with each face a
   * different shade of the same colour.
   *
   * The shading is by hand rather than by light, and that is a toy-city trick
   * worth knowing: baking a little face-direction contrast into the vertex
   * colour means a building still reads as a solid object when it is in shadow,
   * or lit flat by an overcast sky, or seen from the one angle where the sun is
   * directly behind it. Toon shading has only three bands; this puts detail
   * between them.
   */
  box(
    cx: number, y0: number, cz: number,
    hw: number, h: number, hd: number,
    c: [number, number, number],
    taper = 1,
    yaw = 0,
  ): void {
    const y1 = y0 + h;
    const tw = hw * taper;
    const td = hd * taper;
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const P = (lx: number, ly: number, lz: number): [number, number, number] => [
      cx + lx * cs - lz * sn,
      ly,
      cz + lx * sn + lz * cs,
    ];
    // Corners: bottom then top.
    const b0 = P(-hw, y0, -hd), b1 = P(hw, y0, -hd), b2 = P(hw, y0, hd), b3 = P(-hw, y0, hd);
    const t0 = P(-tw, y1, -td), t1 = P(tw, y1, -td), t2 = P(tw, y1, td), t3 = P(-tw, y1, td);
    // North, east, south, west, top. No bottom — nothing in this city is
    // ever seen from below, and a million unseen triangles is a million
    // triangles.
    this.quad(b1, b0, t0, t1, shade(c, 0.86));
    this.quad(b2, b1, t1, t2, shade(c, 1.0));
    this.quad(b3, b2, t2, t3, shade(c, 0.92));
    this.quad(b0, b3, t3, t0, shade(c, 0.78));
    this.quad(t0, t3, t2, t1, shade(c, 1.08), [0, 1, 0]);
  }

  /**
   * A vertically banded box — the city's windows.
   *
   * A tower with rows of windows would be hundreds of little quads. This is the
   * same box with its side faces split into `floors` bands, alternating between
   * the wall colour and a window colour, so a forty-storey building costs eighty
   * quads instead of a thousand and still reads, from the street and from the
   * air, as a building with floors in it.
   */
  bandedBox(
    cx: number, y0: number, cz: number,
    hw: number, h: number, hd: number,
    wall: [number, number, number],
    window: [number, number, number],
    floors: number,
    taper = 1,
    yaw = 0,
  ): void {
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const P = (lx: number, ly: number, lz: number): [number, number, number] => [
      cx + lx * cs - lz * sn,
      ly,
      cz + lx * sn + lz * cs,
    ];
    const faces: Array<{ ax: number; az: number; k: number }> = [
      { ax: 0, az: -1, k: 0.86 },
      { ax: 1, az: 0, k: 1.0 },
      { ax: 0, az: 1, k: 0.92 },
      { ax: -1, az: 0, k: 0.78 },
    ];
    const steps = Math.max(1, floors);
    for (const f of faces) {
      for (let i = 0; i < steps; i++) {
        const fy0 = y0 + (h * i) / steps;
        const fy1 = y0 + (h * (i + 1)) / steps;
        const s0 = taper === 1 ? 1 : 1 + (taper - 1) * (i / steps);
        const s1 = taper === 1 ? 1 : 1 + (taper - 1) * ((i + 1) / steps);
        /* One band in three is glass, not every other one.
           Alternating equally makes a tower half glass by area, and the result
           reads as a barcode rather than as a building — from the air the whole
           city turns into cyan stripes and the district palettes underneath it
           stop being visible at all. A narrow window course between wider
           spandrels is both what a real facade looks like and what lets the
           wall colour do the work of telling neighbourhoods apart. */
        const isWindow = i % 3 === 1;
        const c = shade(isWindow ? window : wall, f.k);
        /* Which floors have the lights on, and how brightly.
           Lighting every course of every building turned night into a city made
           of fluorescent tubes — correct in mechanism and completely wrong to
           look at, because the thing that makes a night skyline read is that it
           is *patchy*. Just over half of them, at varying brightness, and the
           value is hashed off the building's own position so it is the same on
           every face and the same on every reload. */
        const roll = hash3(cx, cz, i);
        const lit = isWindow && roll > 0.42 ? 0.45 + roll * 0.55 : 0;
        const w0 = hw * s0, d0 = hd * s0, w1 = hw * s1, d1 = hd * s1;
        // Corners of this band on this face.
        const corner = (w: number, d: number, y: number, sign: number): [number, number, number] => {
          if (f.ax !== 0) return P(f.ax * w, y, sign * d);
          return P(sign * w, y, f.az * d);
        };
        /* Which way round the two in-plane corners go, per face.
           It was `f.ax !== 0 ? 1 : -1`, which is correct for the east and
           south faces and backwards for the west and north ones — so every
           banded building in the world was built with two of its four walls
           inside out, and back-face culling threw them away. You could see
           into three thousand buildings from the north-west, and out the far
           side of them, and it read as "the walls have not loaded yet".

           Seen from outside a face whose outward axis is `n`, screen-right is
           `up x n`, and the first corner is the one *left* of centre. That is
           `+f.ax` along Z for the east/west pair and `-f.az` along X for the
           north/south pair, with no case left over to get wrong. */
        const lead = f.ax !== 0 ? f.ax : -f.az;
        const a = corner(w0, d0, fy0, lead);
        const b = corner(w0, d0, fy0, -lead);
        const cc = corner(w1, d1, fy1, -lead);
        const dd = corner(w1, d1, fy1, lead);
        /* The normal has to be turned by `yaw` too, and for a long time it was
           not — the face axis was handed over raw.

           It is only a lighting error, so it hides: a block turned by three
           degrees on the northern grid looks fine. But the grid *south* of
           Market is turned 2.4 radians, so every building in SoMa was lit as
           though it were facing a completely different way, and half of them
           landed in the toon ramp's darkest band on the side the sun was
           actually on. The whole district read as flat grey and the obvious
           conclusion was that its palette was wrong.

           The inverted-hull outline made it worse than cosmetic: that shader
           pushes the shell along this same normal, so a wrong one pushes the
           black hull out through the face it is supposed to sit behind. The
           Ferry Building rendered as a solid black slab with a gold clock on
           it. */
        // The window courses carry the glow. At night `look.ts` adds it back as
        // emission, which is why a banded building turns into a lit one for the
        // cost of a single float per vertex and no extra draw.
        this.quad(
          a, b, cc, dd, c,
          [f.ax * cs - f.az * sn, 0, f.ax * sn + f.az * cs],
          lit,
        );
      }
    }
    // Roof.
    const tw = hw * taper, td = hd * taper;
    this.quad(
      P(-tw, y0 + h, -td), P(-tw, y0 + h, td), P(tw, y0 + h, td), P(tw, y0 + h, -td),
      shade(wall, 1.08), [0, 1, 0],
    );
  }

  /** A prism roof: a box that comes to a ridge along its long axis. */
  gable(
    cx: number, y0: number, cz: number,
    hw: number, h: number, hd: number,
    c: [number, number, number],
    yaw = 0,
  ): void {
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const P = (lx: number, ly: number, lz: number): [number, number, number] => [
      cx + lx * cs - lz * sn, ly, cz + lx * sn + lz * cs,
    ];
    const y1 = y0 + h;
    const a = P(-hw, y0, -hd), b = P(hw, y0, -hd), cc = P(hw, y0, hd), d = P(-hw, y0, hd);
    const r0 = P(-hw, y1, 0), r1 = P(hw, y1, 0);
    this.quad(b, a, r0, r1, shade(c, 0.95));
    this.quad(d, cc, r1, r0, shade(c, 1.05));
    // Gable ends.
    const t0 = this.vertex(a[0], a[1], a[2], -cs, 0, -sn, shade(c, 0.8));
    const t1 = this.vertex(d[0], d[1], d[2], -cs, 0, -sn, shade(c, 0.8));
    const t2 = this.vertex(r0[0], r0[1], r0[2], -cs, 0, -sn, shade(c, 0.8));
    this.tri(t0, t1, t2);
    const u0 = this.vertex(cc[0], cc[1], cc[2], cs, 0, sn, shade(c, 0.9));
    const u1 = this.vertex(b[0], b[1], b[2], cs, 0, sn, shade(c, 0.9));
    const u2 = this.vertex(r1[0], r1[1], r1[2], cs, 0, sn, shade(c, 0.9));
    this.tri(u0, u1, u2);
  }

  /** A cylinder (or cone, or truncated cone) standing on Y. */
  cylinder(
    cx: number, y0: number, cz: number,
    rBottom: number, rTop: number, h: number,
    seg: number,
    c: [number, number, number],
    cap = true,
  ): void {
    const y1 = y0 + h;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0);
      const c1 = Math.cos(a1), s1 = Math.sin(a1);
      // Face brightness follows the facing direction, same trick as `box`.
      const k = 0.8 + 0.28 * (0.5 + 0.5 * Math.cos(a0 + 0.6));
      const col = shade(c, k);
      const p0: [number, number, number] = [cx + c0 * rBottom, y0, cz + s0 * rBottom];
      const p1: [number, number, number] = [cx + c1 * rBottom, y0, cz + s1 * rBottom];
      const p2: [number, number, number] = [cx + c1 * rTop, y1, cz + s1 * rTop];
      const p3: [number, number, number] = [cx + c0 * rTop, y1, cz + s0 * rTop];
      /* Wound so the faces point OUT.
         Taking the ring anticlockwise in XZ and reading the quad in the obvious
         order (bottom-left, bottom-right, top-right, top-left) gives an inward
         normal, and every tree in the city renders inside-out — which, with
         back-face culling on, means the trunks and canopies are invisible
         except for a few slivers where two of them overlap. The water fan had
         the identical bug. Any time a ring is fanned or lofted in this file,
         check which way it ends up facing. */
      if (rTop < 1e-4) {
        const n0 = this.vertex(p0[0], p0[1], p0[2], c0, 0.3, s0, col);
        const n1 = this.vertex(p3[0], p3[1], p3[2], c0, 0.3, s0, col);
        const n2 = this.vertex(p1[0], p1[1], p1[2], c1, 0.3, s1, col);
        this.tri(n0, n1, n2);
      } else {
        this.quad(p3, p2, p1, p0, col);
      }
    }
    if (cap && rTop > 1e-4) {
      const centre = this.vertex(cx, y1, cz, 0, 1, 0, shade(c, 1.08));
      const ring: number[] = [];
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        ring.push(this.vertex(cx + Math.cos(a) * rTop, y1, cz + Math.sin(a) * rTop, 0, 1, 0, shade(c, 1.08)));
      }
      for (let i = 0; i < seg; i++) this.tri(centre, ring[i + 1], ring[i]);
    }
  }

  /**
   * A flat ribbon following a polyline on the ground — every road, every
   * pavement, every path in the world.
   *
   * `heightAt` samples the terrain so the ribbon lies ON the hills rather than
   * cutting through them, which is the whole reason San Francisco's streets are
   * worth drawing: they roll.
   */
  ribbon(
    points: readonly { x: number; z: number }[],
    halfWidth: number,
    lift: number,
    c: [number, number, number],
    heightAt: (x: number, z: number) => number,
  ): void {
    if (points.length < 2) return;
    let prevL = -1;
    let prevR = -1;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const a = points[Math.max(0, i - 1)];
      const b = points[Math.min(points.length - 1, i + 1)];
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      // Left normal in XZ.
      const nx = dz;
      const nz = -dx;
      const lx = p.x + nx * halfWidth;
      const lz = p.z + nz * halfWidth;
      const rx = p.x - nx * halfWidth;
      const rz = p.z - nz * halfWidth;
      const l = this.vertex(lx, heightAt(lx, lz) + lift, lz, 0, 1, 0, c);
      const r = this.vertex(rx, heightAt(rx, rz) + lift, rz, 0, 1, 0, c);
      if (prevL >= 0) {
        this.tri(prevL, prevR, r);
        this.tri(prevL, r, l);
      }
      prevL = l;
      prevR = r;
    }
  }

  /** Resolve into a BufferGeometry. The batch is spent afterwards. */
  finish(): THREE.BufferGeometry | null {
    if (this.vertexCount === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos.view().slice(), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(this.nrm.view().slice(), 3));
    g.setAttribute("color", new THREE.BufferAttribute(this.col.view().slice(), 3));
    g.setAttribute("glow", new THREE.BufferAttribute(this.glo.view().slice(), 1));
    g.setIndex(new THREE.BufferAttribute(this.idx.view().slice(), 1));
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * A grid of batches, so the city can be frustum-culled.
 *
 * The whole point of `Batch` is that a city becomes a dozen draw calls, and
 * that is still the point — but one merged mesh for every building in a
 * 3.4 × 4.4 km map is also a mesh that is *always* drawn. Standing on Market
 * Street facing east, the entire Mission, Hayes Valley and the avenues are
 * behind you, and every triangle of them was submitted anyway, because
 * three.js culls objects and there was only one object.
 *
 * Splitting the same geometry across a coarse grid changes nothing about how
 * it is built, when it is built, or whether it can change while you look at it
 * — which is the property this world exists to have. Nothing streams, nothing
 * loads late, nothing swaps tiers. The only difference is that a chunk wholly
 * outside the frustum is skipped, and a bounding-sphere test is exact, so a
 * chunk never half-appears at the edge of the screen the way an LOD does.
 *
 * The cost is draw calls: one mesh per occupied cell instead of one for the
 * lot. At 4 × 4 that is at most sixteen, against the sixty to a hundred this
 * world already submits, and from any position on the ground most of them are
 * culled — which is the entire trade.
 */
export class Chunks {
  private cells: Batch[];
  private readonly stepX: number;
  private readonly stepZ: number;

  constructor(
    readonly nx: number,
    readonly nz: number,
    private readonly minX: number,
    private readonly minZ: number,
    width: number,
    depth: number,
  ) {
    this.stepX = width / nx;
    this.stepZ = depth / nz;
    this.cells = Array.from({ length: nx * nz }, () => new Batch());
  }

  /** The batch covering a point. Out-of-range points clamp to the edge cell. */
  at(x: number, z: number): Batch {
    const i = Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.minX) / this.stepX)));
    const j = Math.max(0, Math.min(this.nz - 1, Math.floor((z - this.minZ) / this.stepZ)));
    return this.cells[j * this.nx + i];
  }

  get triangles(): number {
    let n = 0;
    for (const c of this.cells) n += c.triangles;
    return n;
  }

  /** Every non-empty cell, as geometry. */
  finish(): THREE.BufferGeometry[] {
    const out: THREE.BufferGeometry[] = [];
    for (const c of this.cells) {
      const g = c.finish();
      if (g) out.push(g);
    }
    return out;
  }
}
