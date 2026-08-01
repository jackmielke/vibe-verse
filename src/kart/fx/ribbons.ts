/**
 * Vibe Kart — trail ribbons: skid marks on the road, shimmer trails in the air.
 *
 * A ribbon is a ring buffer of independent quads, not a triangle strip. Strips
 * are cheaper per vertex but they cannot be recycled: retiring the oldest
 * segment of a strip means rewriting every index behind it. Duplicating the
 * four vertices of each quad costs ~40 KB for the whole game's worth of skid
 * marks and buys an O(1) append that never touches the index buffer.
 *
 * Both use cases run through the same class:
 *
 *   · **Skid marks** — alpha-blended, dark, eight-second life, laid on the road
 *     with a polygon offset so they never z-fight the tarmac. They persist, and
 *     three laps in the corners are black with rubber. That single detail is
 *     most of the difference between a tech demo and a circuit that has been
 *     raced on.
 *
 *   · **Star trail** — additive, rainbow, half-second life, laid in the air
 *     behind the kart and scrolled so it shimmers rather than strobes.
 *
 * Ageing is entirely in the shader: each vertex carries the timestamp it was
 * written at, and the fragment shader fades and then discards. Nothing on the
 * CPU walks the buffer looking for expired geometry.
 */
import * as THREE from "three";
import { RIBBON_FRAG, RIBBON_VERT } from "./shaders";

/** The shared append struct — see `ParticleBatch.p` for the rationale. */
export interface RibbonSegment {
  /** Trailing edge, left and right corners. */
  aLx: number;
  aLy: number;
  aLz: number;
  aRx: number;
  aRy: number;
  aRz: number;
  /** Leading edge, left and right corners. */
  bLx: number;
  bLy: number;
  bLz: number;
  bRx: number;
  bRy: number;
  bRz: number;
  /** Texture coordinate along the ribbon at the trailing and leading edges. */
  u0: number;
  u1: number;
  /** Per-segment opacity, 0..1 — pressure, charge, whatever drives it. */
  fade: number;
}

export interface RibbonPoolOptions {
  name: string;
  /** Quads held before the oldest is recycled. */
  capacity: number;
  map: THREE.Texture;
  /** Tint, in linear working space. */
  color: THREE.Color;
  opacity: number;
  intensity: number;
  /** Seconds from written to gone. */
  life: number;
  additive: boolean;
  renderOrder: number;
  /** Push the ribbon toward the camera in depth — for marks lying on a road. */
  polygonOffset: number;
}

export class RibbonPool {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly geometry: THREE.BufferGeometry;
  readonly s: RibbonSegment = {
    aLx: 0, aLy: 0, aLz: 0,
    aRx: 0, aRy: 0, aRz: 0,
    bLx: 0, bLy: 0, bLz: 0,
    bRx: 0, bRy: 0, bRz: 0,
    u0: 0, u1: 1, fade: 1,
  };
  readonly capacity: number;

  private cursor = 0;
  private dirtyLo = Infinity;
  private dirtyHi = -1;
  private wrapped = false;
  private time = 0;

  private readonly position: Float32Array;
  private readonly uv: Float32Array;
  private readonly birth: Float32Array;
  private readonly fade: Float32Array;
  private readonly aPosition: THREE.BufferAttribute;
  private readonly aUv: THREE.BufferAttribute;
  private readonly aBirth: THREE.BufferAttribute;
  private readonly aFade: THREE.BufferAttribute;

  constructor(opts: RibbonPoolOptions) {
    const cap = (this.capacity = Math.max(8, Math.floor(opts.capacity)));
    const verts = cap * 4;

    this.position = new Float32Array(verts * 3);
    this.uv = new Float32Array(verts * 2);
    this.birth = new Float32Array(verts);
    this.fade = new Float32Array(verts);
    this.birth.fill(-1e9);

    // Indices are written once and never change — that is the payoff for
    // spending four vertices a quad instead of two.
    const index = new Uint32Array(cap * 6);
    for (let q = 0; q < cap; q++) {
      const v = q * 4;
      const i = q * 6;
      index[i] = v;
      index[i + 1] = v + 1;
      index[i + 2] = v + 2;
      index[i + 3] = v;
      index[i + 4] = v + 2;
      index[i + 5] = v + 3;
    }

    const geo = new THREE.BufferGeometry();
    this.aPosition = new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage);
    this.aUv = new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage);
    this.aBirth = new THREE.BufferAttribute(this.birth, 1).setUsage(THREE.DynamicDrawUsage);
    this.aFade = new THREE.BufferAttribute(this.fade, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.aPosition);
    geo.setAttribute("uv", this.aUv);
    geo.setAttribute("aBirth", this.aBirth);
    geo.setAttribute("aFade", this.aFade);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    const mat = new THREE.ShaderMaterial({
      name: opts.name,
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: opts.life },
        uMap: { value: opts.map },
        uColor: { value: opts.color.clone() },
        uOpacity: { value: opts.opacity },
        uIntensity: { value: opts.intensity },
        uScroll: { value: 0 },
        uFogColor: { value: new THREE.Color(0x9fc6e0) },
        uFogDensity: { value: 0 },
      },
      defines: opts.additive ? { ADDITIVE: "" } : {},
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      polygonOffset: opts.polygonOffset !== 0,
      polygonOffsetFactor: -opts.polygonOffset,
      polygonOffsetUnits: -opts.polygonOffset * 2,
      toneMapped: true,
    });
    mat.userData.own = true;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = opts.name;
    mesh.frustumCulled = false;
    mesh.renderOrder = opts.renderOrder;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    this.geometry = geo;
    this.material = mat;
    this.mesh = mesh;
  }

  /** Commit `this.s` as the next quad in the ring. */
  push(): void {
    const q = this.cursor;
    const v = q * 4;
    const s = this.s;
    const P = this.position;
    const U = this.uv;

    const p = v * 3;
    P[p] = s.aLx; P[p + 1] = s.aLy; P[p + 2] = s.aLz;
    P[p + 3] = s.aRx; P[p + 4] = s.aRy; P[p + 5] = s.aRz;
    P[p + 6] = s.bRx; P[p + 7] = s.bRy; P[p + 8] = s.bRz;
    P[p + 9] = s.bLx; P[p + 10] = s.bLy; P[p + 11] = s.bLz;

    const t = v * 2;
    U[t] = s.u0; U[t + 1] = 0;
    U[t + 2] = s.u0; U[t + 3] = 1;
    U[t + 4] = s.u1; U[t + 5] = 1;
    U[t + 6] = s.u1; U[t + 7] = 0;

    for (let k = 0; k < 4; k++) {
      this.birth[v + k] = this.time;
      this.fade[v + k] = s.fade;
    }

    if (q < this.dirtyLo) this.dirtyLo = q;
    if (q > this.dirtyHi) this.dirtyHi = q;
    this.cursor = q + 1;
    if (this.cursor >= this.capacity) {
      this.cursor = 0;
      this.wrapped = true;
    }
  }

  update(elapsed: number): void {
    this.time = elapsed;
    this.material.uniforms.uTime.value = elapsed;
    if (this.dirtyHi < 0) return;
    const lo = this.wrapped ? 0 : this.dirtyLo;
    const hi = this.wrapped ? this.capacity - 1 : this.dirtyHi;
    const count = (hi - lo + 1) * 4;
    const start = lo * 4;
    this.range(this.aPosition, start, count, 3);
    this.range(this.aUv, start, count, 2);
    this.range(this.aBirth, start, count, 1);
    this.range(this.aFade, start, count, 1);
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
    this.wrapped = false;
  }

  private range(attr: THREE.BufferAttribute, start: number, count: number, itemSize: number): void {
    attr.clearUpdateRanges();
    attr.addUpdateRange(start * itemSize, count * itemSize);
    attr.needsUpdate = true;
  }

  setFog(color: THREE.Color, density: number): void {
    (this.material.uniforms.uFogColor.value as THREE.Color).copy(color);
    this.material.uniforms.uFogDensity.value = density;
  }

  setScroll(v: number): void {
    this.material.uniforms.uScroll.value = v;
  }

  clear(): void {
    this.birth.fill(-1e9);
    this.aBirth.clearUpdateRanges();
    this.aBirth.needsUpdate = true;
    this.cursor = 0;
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
    this.wrapped = false;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * One continuous trail being written into a pool — a single tyre, or the tail
 * of one kart. Holds the previous cross-section so each new sample only has to
 * supply the leading edge.
 *
 * `minStep` is the load-bearing parameter: laying a quad every frame at 120 Hz
 * would burn a 2400-quad ring in twenty seconds and produce a mark made of
 * millimetre slivers. Sampling by distance instead gives a constant texel
 * density at any speed and makes the ring's capacity a *duration*.
 */
export class TrailWriter {
  private active = false;
  private lx = 0;
  private ly = 0;
  private lz = 0;
  private rx = 0;
  private ry = 0;
  private rz = 0;
  private cx = 0;
  private cy = 0;
  private cz = 0;
  private u = 0;

  constructor(
    private readonly pool: RibbonPool,
    /** Metres of travel between cross-sections. */
    private readonly minStep: number,
    /** Metres of ribbon per unit of U — sets the texture repeat. */
    private readonly uScale: number,
  ) {}

  /** Break the trail. The next `extend` starts a fresh run. */
  end(): void {
    this.active = false;
  }

  get running(): boolean {
    return this.active;
  }

  /**
   * Advance the trail to a new centre with the given lateral axis and width.
   * Returns true when a quad was actually laid.
   */
  extend(
    cx: number,
    cy: number,
    cz: number,
    ax: number,
    ay: number,
    az: number,
    halfWidth: number,
    fade: number,
  ): boolean {
    const lx = cx - ax * halfWidth;
    const ly = cy - ay * halfWidth;
    const lz = cz - az * halfWidth;
    const rx = cx + ax * halfWidth;
    const ry = cy + ay * halfWidth;
    const rz = cz + az * halfWidth;

    if (!this.active) {
      this.active = true;
      this.lx = lx; this.ly = ly; this.lz = lz;
      this.rx = rx; this.ry = ry; this.rz = rz;
      this.cx = cx; this.cy = cy; this.cz = cz;
      this.u = 0;
      return false;
    }

    const dx = cx - this.cx;
    const dy = cy - this.cy;
    const dz = cz - this.cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < this.minStep) return false;
    // A teleport (respawn, a wall bounce that resolves through geometry) must
    // not stretch a single quad across the circuit.
    if (dist > this.minStep * 30) {
      this.active = false;
      return false;
    }

    const s = this.pool.s;
    s.aLx = this.lx; s.aLy = this.ly; s.aLz = this.lz;
    s.aRx = this.rx; s.aRy = this.ry; s.aRz = this.rz;
    s.bLx = lx; s.bLy = ly; s.bLz = lz;
    s.bRx = rx; s.bRy = ry; s.bRz = rz;
    s.u0 = this.u;
    s.u1 = this.u + dist / this.uScale;
    s.fade = fade;
    this.pool.push();

    this.u = s.u1;
    this.lx = lx; this.ly = ly; this.lz = lz;
    this.rx = rx; this.ry = ry; this.rz = rz;
    this.cx = cx; this.cy = cy; this.cz = cz;
    return true;
  }
}
