/**
 * GeoSink — the typed-array geometry accumulator every building writes into.
 *
 * A chunk of San Francisco is somewhere between a hundred and four hundred
 * buildings. If each one were its own THREE.Mesh the renderer would spend the
 * whole frame in `WebGLRenderer.renderBufferDirect` and never get to the
 * pixels. So the generator never creates a Mesh: it appends triangles into
 * growable typed arrays here, and the chunk hands the renderer exactly one
 * BufferGeometry with one material.
 *
 * Layout notes (these matter — a 60k-vertex chunk at 60 bytes/vertex is 3.6 MB
 * of VRAM and we keep ~30 chunks resident):
 *
 *   position  float32 x3   chunk-local metres. Local, not world, so a building
 *                          4 km from origin still has millimetre precision.
 *   normal    int8   x4 n  flat face normal. Buildings are hard-edged; there
 *                          is nothing to gain from float precision here.
 *   uv        float32 x2   *metres*, not 0..1: u runs along the face, v runs
 *                          up from the building's own base. The facade shader
 *                          builds the window grid from these, which is why
 *                          window rows line up across a building's four walls
 *                          and across a whole terraced row.
 *   color     uint8  x4 n  sRGB-encoded paint colour (decoded in the shader).
 *                          8-bit *linear* would band in the shadows; 8-bit
 *                          sRGB is exactly what a texture would give us.
 *   aFacade   uint8  x4 n  x = surface id, y = floor height / 8 m,
 *                          z = per-building hash, w = window intensity.
 *
 * Total 32 bytes/vertex. Geometry is non-indexed: every quad needs its own
 * UV origin and flat normal anyway, so an index buffer would save nothing and
 * cost a lookup.
 */
import * as THREE from "three";

/* ------------------------------------------------------------------ *
 * Surface identifiers — must match the switch in facadeMaterial.ts
 * ------------------------------------------------------------------ */
export const SURF = {
  /** Painted stucco / plaster. Windows. */
  STUCCO: 0,
  /** Fired brick with real courses and per-brick colour jitter. Windows. */
  BRICK: 1,
  /** Cut stone / terracotta, horizontal banding. Windows. */
  STONE: 2,
  /** Curtain wall: continuous glazing with mullions and spandrel bands. */
  CURTAIN: 3,
  /** Built-up tar-and-gravel roof. */
  ROOF: 4,
  /** Painted or galvanised metal — railings, mechanical, fire escapes. */
  METAL: 5,
  /** Victorian wood clapboard with window trim. Windows. */
  WOOD: 6,
  /** Spanish clay roof tile (Presidio, Mission). */
  TILE: 7,
  /** Corrugated steel siding, industrial. */
  CORRUGATED: 8,
  /** Plain glazing — storefronts, clerestories, skylights. */
  GLASS: 9,
  /** Board-formed concrete — podiums, parapet caps, docks. */
  CONCRETE: 10,
  /** Asphalt / painted deck — helipads, parking decks. */
  ASPHALT: 11,
} as const;

export type SurfaceId = (typeof SURF)[keyof typeof SURF];

/** Surfaces the facade shader draws windows on. */
export const WINDOWED = new Set<number>([SURF.STUCCO, SURF.BRICK, SURF.STONE, SURF.WOOD]);

const GROW = 1.7;

/** sRGB byte encode of a linear 0..1 channel. Matches the shader's decode. */
function toSrgbByte(linear: number): number {
  const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

/**
 * Growable non-indexed triangle soup with the building vertex layout.
 *
 * Usage is stateful on purpose — `setSurface`/`setColor` latch, then every
 * quad pushed inherits them. That keeps the call sites (which are already
 * dense with geometry maths) from repeating eight arguments per face.
 */
export class GeoSink {
  private pos: Float32Array;
  private nrm: Int8Array;
  private uv: Float32Array;
  private col: Uint8Array;
  private fac: Uint8Array;
  /** Vertex count written so far. */
  count = 0;
  private cap: number;

  /* latched state */
  private sSurf = 0;
  private sFloor = 0; // stored byte
  private sHash = 0; // stored byte
  private sWin = 0; // stored byte
  private cr = 200;
  private cg = 200;
  private cb = 200;

  /** Running local-space bounds, so chunks get a bounding box for free. */
  minX = Infinity;
  minY = Infinity;
  minZ = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  maxZ = -Infinity;

  constructor(capacity = 4096) {
    this.cap = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.nrm = new Int8Array(capacity * 4);
    this.uv = new Float32Array(capacity * 2);
    this.col = new Uint8Array(capacity * 4);
    this.fac = new Uint8Array(capacity * 4);
  }

  private ensure(extra: number): void {
    if (this.count + extra <= this.cap) return;
    let cap = this.cap;
    while (cap < this.count + extra) cap = Math.ceil(cap * GROW) + 64;
    const pos = new Float32Array(cap * 3);
    pos.set(this.pos.subarray(0, this.count * 3));
    const nrm = new Int8Array(cap * 4);
    nrm.set(this.nrm.subarray(0, this.count * 4));
    const uv = new Float32Array(cap * 2);
    uv.set(this.uv.subarray(0, this.count * 2));
    const col = new Uint8Array(cap * 4);
    col.set(this.col.subarray(0, this.count * 4));
    const fac = new Uint8Array(cap * 4);
    fac.set(this.fac.subarray(0, this.count * 4));
    this.pos = pos;
    this.nrm = nrm;
    this.uv = uv;
    this.col = col;
    this.fac = fac;
    this.cap = cap;
  }

  /**
   * Latch the surface every following face uses.
   * @param surf       one of SURF.*
   * @param floorH     storey height in metres (drives the window grid)
   * @param hash01     per-building 0..1 hash — decorrelates window widths,
   *                   lit-window patterns and material jitter between
   *                   neighbours so a row never reads as a copy-paste.
   * @param windows01  0 = blind wall (party walls, light wells, side
   *                   elevations), 1 = fully fenestrated street facade.
   */
  setSurface(surf: number, floorH = 3.4, hash01 = 0.5, windows01 = 1): this {
    this.sSurf = surf & 255;
    this.sFloor = Math.max(0, Math.min(255, Math.round((floorH / 8) * 255)));
    this.sHash = Math.max(0, Math.min(255, Math.round(hash01 * 255)));
    this.sWin = Math.max(0, Math.min(255, Math.round(windows01 * 255)));
    return this;
  }

  /** Latch the paint colour (linear 0..1 — the sink encodes to sRGB bytes). */
  setColor(r: number, g: number, b: number): this {
    this.cr = toSrgbByte(r);
    this.cg = toSrgbByte(g);
    this.cb = toSrgbByte(b);
    return this;
  }

  setColorHexLinear(c: THREE.Color): this {
    return this.setColor(c.r, c.g, c.b);
  }

  private vert(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
  ): void {
    const i = this.count;
    const p = i * 3;
    this.pos[p] = x;
    this.pos[p + 1] = y;
    this.pos[p + 2] = z;
    const n = i * 4;
    this.nrm[n] = Math.max(-127, Math.min(127, Math.round(nx * 127)));
    this.nrm[n + 1] = Math.max(-127, Math.min(127, Math.round(ny * 127)));
    this.nrm[n + 2] = Math.max(-127, Math.min(127, Math.round(nz * 127)));
    this.nrm[n + 3] = 0;
    const t = i * 2;
    this.uv[t] = u;
    this.uv[t + 1] = v;
    const c = i * 4;
    this.col[c] = this.cr;
    this.col[c + 1] = this.cg;
    this.col[c + 2] = this.cb;
    this.col[c + 3] = 255;
    const f = i * 4;
    this.fac[f] = this.sSurf;
    this.fac[f + 1] = this.sFloor;
    this.fac[f + 2] = this.sHash;
    this.fac[f + 3] = this.sWin;
    this.count++;
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (z < this.minZ) this.minZ = z;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
    if (z > this.maxZ) this.maxZ = z;
  }

  /** Triangle with explicit UVs and a computed flat normal. */
  tri(
    ax: number, ay: number, az: number, au: number, av: number,
    bx: number, by: number, bz: number, bu: number, bv: number,
    cx: number, cy: number, cz: number, cu: number, cv: number,
  ): void {
    this.ensure(3);
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    this.vert(ax, ay, az, nx, ny, nz, au, av);
    this.vert(bx, by, bz, nx, ny, nz, bu, bv);
    this.vert(cx, cy, cz, nx, ny, nz, cu, cv);
  }

  /** Quad a→b→c→d (CCW seen from the front) with explicit per-corner UVs. */
  quad(
    ax: number, ay: number, az: number, au: number, av: number,
    bx: number, by: number, bz: number, bu: number, bv: number,
    cx: number, cy: number, cz: number, cu: number, cv: number,
    dx: number, dy: number, dz: number, du: number, dv: number,
  ): void {
    this.tri(ax, ay, az, au, av, bx, by, bz, bu, bv, cx, cy, cz, cu, cv);
    this.tri(ax, ay, az, au, av, cx, cy, cz, cu, cv, dx, dy, dz, du, dv);
  }

  /**
   * A vertical wall panel from (x0,z0) to (x1,z1), from y0 up to y1.
   * `vBase` is the building's own base height, so v is metres-above-base and
   * the window grid stays continuous when a wall is split into pieces.
   * `uOffset` keeps the horizontal window rhythm continuous around corners.
   */
  wall(
    x0: number, z0: number,
    x1: number, z1: number,
    y0: number, y1: number,
    vBase: number,
    uOffset = 0,
  ): void {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-4 || y1 - y0 < 1e-4) return;
    const u0 = uOffset;
    const u1 = uOffset + len;
    const v0 = y0 - vBase;
    const v1 = y1 - vBase;
    // Front face is the side you see walking anticlockwise around the
    // footprint; callers always feed the footprint anticlockwise.
    this.quad(
      x0, y0, z0, u0, v0,
      x1, y0, z1, u1, v0,
      x1, y1, z1, u1, v1,
      x0, y1, z0, u0, v1,
    );
  }

  /** Horizontal slab face at height y over an axis-aligned-in-local rect. */
  horizontal(
    ax: number, az: number,
    bx: number, bz: number,
    cx: number, cz: number,
    dx: number, dz: number,
    y: number,
    up = true,
  ): void {
    if (up) {
      this.quad(ax, y, az, ax, az, bx, y, bz, bx, bz, cx, y, cz, cx, cz, dx, y, dz, dx, dz);
    } else {
      this.quad(ax, y, az, ax, az, dx, y, dz, dx, dz, cx, y, cz, cx, cz, bx, y, bz, bx, bz);
    }
  }

  /**
   * Oriented box. `yaw` rotates about +Y. UV v is measured from `vBase`, so a
   * stack of boxes forming one tower shares one continuous window grid.
   * `faces` is a bitmask: 1 +u, 2 -u, 4 +w, 8 -w, 16 top, 32 bottom.
   */
  box(
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    yaw: number,
    vBase: number,
    faces = 0b011111,
  ): void {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    // Footprint corners anticlockwise when viewed from above (+Y down the -Y axis).
    const px = [-hx, hx, hx, -hx];
    const pz = [-hz, -hz, hz, hz];
    const wx: number[] = [];
    const wz: number[] = [];
    for (let i = 0; i < 4; i++) {
      wx.push(cx + px[i] * c - pz[i] * s);
      wz.push(cz + px[i] * s + pz[i] * c);
    }
    const y0 = cy - hy;
    const y1 = cy + hy;
    let uAcc = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) & 3;
      const segLen = Math.hypot(wx[j] - wx[i], wz[j] - wz[i]);
      const bit = 1 << i;
      if (faces & bit) this.wall(wx[i], wz[i], wx[j], wz[j], y0, y1, vBase, uAcc);
      uAcc += segLen;
    }
    if (faces & 16) this.horizontal(wx[0], wz[0], wx[1], wz[1], wx[2], wz[2], wx[3], wz[3], y1, true);
    if (faces & 32) this.horizontal(wx[0], wz[0], wx[1], wz[1], wx[2], wz[2], wx[3], wz[3], y0, false);
  }

  /**
   * Extrude an arbitrary closed footprint (anticlockwise) between two heights,
   * optionally capping the top. This is what non-rectangular massing — chamfered
   * tower corners, wedge lots at Market, octagonal crowns — runs through.
   */
  extrude(
    fx: readonly number[],
    fz: readonly number[],
    y0: number,
    y1: number,
    vBase: number,
    cap = true,
    walls = true,
  ): void {
    const n = fx.length;
    if (n < 3) return;
    let uAcc = 0;
    if (walls) {
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        this.wall(fx[i], fz[i], fx[j], fz[j], y0, y1, vBase, uAcc);
        uAcc += Math.hypot(fx[j] - fx[i], fz[j] - fz[i]);
      }
    }
    if (cap) {
      // Fan triangulation is safe here: every footprint we generate is convex
      // or star-shaped about its centroid, which we enforce at construction.
      let ccx = 0;
      let ccz = 0;
      for (let i = 0; i < n; i++) {
        ccx += fx[i];
        ccz += fz[i];
      }
      ccx /= n;
      ccz /= n;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        this.tri(ccx, y1, ccz, ccx, ccz, fx[i], y1, fz[i], fx[i], fz[i], fx[j], y1, fz[j], fx[j], fz[j]);
      }
    }
  }

  /** Vertical cylinder — water tanks, columns, antennas, silos, domes' drums. */
  cylinder(
    cx: number, cy: number, cz: number,
    rBottom: number, rTop: number, h: number,
    segs: number,
    vBase: number,
    capTop = true,
    capBottom = false,
    phase = 0,
  ): void {
    const y0 = cy;
    const y1 = cy + h;
    const circ = Math.PI * 2 * Math.max(rBottom, rTop);
    for (let i = 0; i < segs; i++) {
      const a0 = phase + (i / segs) * Math.PI * 2;
      const a1 = phase + ((i + 1) / segs) * Math.PI * 2;
      const u0 = (i / segs) * circ;
      const u1 = ((i + 1) / segs) * circ;
      const x0b = cx + Math.cos(a0) * rBottom;
      const z0b = cz + Math.sin(a0) * rBottom;
      const x1b = cx + Math.cos(a1) * rBottom;
      const z1b = cz + Math.sin(a1) * rBottom;
      const x0t = cx + Math.cos(a0) * rTop;
      const z0t = cz + Math.sin(a0) * rTop;
      const x1t = cx + Math.cos(a1) * rTop;
      const z1t = cz + Math.sin(a1) * rTop;
      this.quad(
        x0b, y0, z0b, u0, y0 - vBase,
        x1b, y0, z1b, u1, y0 - vBase,
        x1t, y1, z1t, u1, y1 - vBase,
        x0t, y1, z0t, u0, y1 - vBase,
      );
    }
    if (capTop && rTop > 1e-3) {
      for (let i = 0; i < segs; i++) {
        const a0 = phase + (i / segs) * Math.PI * 2;
        const a1 = phase + ((i + 1) / segs) * Math.PI * 2;
        this.tri(
          cx, y1, cz, cx, cz,
          cx + Math.cos(a0) * rTop, y1, cz + Math.sin(a0) * rTop, cx + Math.cos(a0) * rTop, cz + Math.sin(a0) * rTop,
          cx + Math.cos(a1) * rTop, y1, cz + Math.sin(a1) * rTop, cx + Math.cos(a1) * rTop, cz + Math.sin(a1) * rTop,
        );
      }
    }
    if (capBottom && rBottom > 1e-3) {
      for (let i = 0; i < segs; i++) {
        const a0 = phase + (i / segs) * Math.PI * 2;
        const a1 = phase + ((i + 1) / segs) * Math.PI * 2;
        this.tri(
          cx, y0, cz, cx, cz,
          cx + Math.cos(a1) * rBottom, y0, cz + Math.sin(a1) * rBottom, cx + Math.cos(a1) * rBottom, cz + Math.sin(a1) * rBottom,
          cx + Math.cos(a0) * rBottom, y0, cz + Math.sin(a0) * rBottom, cx + Math.cos(a0) * rBottom, cz + Math.sin(a0) * rBottom,
        );
      }
    }
  }

  /** Hemispherical-ish dome (City Hall, Palace-style rotundas). */
  dome(cx: number, cy: number, cz: number, r: number, h: number, segs: number, rings: number, vBase: number): void {
    for (let ry = 0; ry < rings; ry++) {
      const t0 = ry / rings;
      const t1 = (ry + 1) / rings;
      const p0 = (t0 * Math.PI) / 2;
      const p1 = (t1 * Math.PI) / 2;
      const r0 = Math.cos(p0) * r;
      const r1 = Math.cos(p1) * r;
      const y0 = cy + Math.sin(p0) * h;
      const y1 = cy + Math.sin(p1) * h;
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        const u0 = (i / segs) * Math.PI * 2 * r;
        const u1 = ((i + 1) / segs) * Math.PI * 2 * r;
        this.quad(
          cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0, u0, y0 - vBase,
          cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0, u1, y0 - vBase,
          cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1, u1, y1 - vBase,
          cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1, u0, y1 - vBase,
        );
      }
    }
  }

  /** True when nothing has been written — chunks with no geometry are dropped. */
  get empty(): boolean {
    return this.count === 0;
  }

  /**
   * Hand the accumulated soup to the GPU. Buffers are copied down to exactly
   * the used length; the sink is dead afterwards.
   */
  finalize(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const n = this.count;
    g.setAttribute("position", new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(this.nrm.slice(0, n * 4), 4, true));
    g.setAttribute("uv", new THREE.BufferAttribute(this.uv.slice(0, n * 2), 2));
    // Deliberately NOT called "color": three would see a 4-component colour
    // attribute, define USE_COLOR_ALPHA and turn vColor into a vec4 behind our
    // back. We own this channel, so we name it ourselves.
    g.setAttribute("aTint", new THREE.BufferAttribute(this.col.slice(0, n * 4), 4, true));
    g.setAttribute("aFacade", new THREE.BufferAttribute(this.fac.slice(0, n * 4), 4, true));
    g.boundingBox = new THREE.Box3(
      new THREE.Vector3(this.minX, this.minY, this.minZ),
      new THREE.Vector3(this.maxX, this.maxY, this.maxZ),
    );
    g.boundingSphere = new THREE.Sphere();
    g.boundingBox.getBoundingSphere(g.boundingSphere);
    return g;
  }
}
