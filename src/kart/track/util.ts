/**
 * Vibe Kart — track module plumbing.
 *
 * Small, boring, load-bearing. Three things live here:
 *
 * · the scalar maths the course DNA is authored in (a limited Hermite so a
 *   hand-written key list interpolates without overshooting into a hill),
 * · a mesh builder that lets the ribbon/terrain/structure code emit triangles
 *   without allocating a Vector3 per vertex,
 * · the material lookup, which is deliberately structural: the track never
 *   imports the material library, it duck-types whatever is on
 *   `ctx.services.materials` and falls back to tinted PBR if it is not there.
 */
import * as THREE from "three";

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

export const DEG = Math.PI / 180;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-9));
  return t * t * (3 - 2 * t);
}

/** Wrap into [0,1) — every `t` in the track service goes through this. */
export function wrap01(t: number): number {
  const f = t - Math.floor(t);
  return f === 1 ? 0 : f;
}

/** Shortest signed difference between two normalised lap positions. */
export function deltaWrapped(a: number, b: number): number {
  let d = a - b;
  d -= Math.round(d);
  return d;
}

export interface ScalarKey {
  /** Position along the lap, in metres of horizontal arc length. */
  s: number;
  v: number;
}

/**
 * Piecewise cubic Hermite through authored keys, with Fritsch–Carlson tangent
 * limiting.
 *
 * Plain smoothstep between keys was the first attempt and it is wrong for this
 * job: it forces zero slope at every key, which flattens the top of the jump
 * ramp exactly where the launch angle is the whole point. Catmull-Rom tangents
 * keep the slope through a key, and the limiter stops a steep key pair from
 * overshooting into a bump the driver can feel but nobody authored.
 */
export class ScalarTrack {
  private readonly s: Float64Array;
  private readonly v: Float64Array;
  private readonly m: Float64Array;

  constructor(keys: ScalarKey[], period: number) {
    // Two keys at the same arc position (the classic case: a value authored at
    // the end of the last segment *and* the start of the first, either side of
    // the start/finish line) would give a zero-length span and an infinite
    // secant, so the later one wins.
    const sorted: ScalarKey[] = [];
    for (const k of keys.slice().sort((a, b) => a.s - b.s)) {
      const prev = sorted[sorted.length - 1];
      if (prev && Math.abs(prev.s - k.s) < 1e-4) sorted[sorted.length - 1] = k;
      else sorted.push(k);
    }
    if (sorted.length > 1 && sorted[0].s + period - sorted[sorted.length - 1].s < 1e-4) sorted.pop();
    const n = sorted.length;
    this.s = new Float64Array(n);
    this.v = new Float64Array(n);
    this.m = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.s[i] = sorted[i].s;
      this.v[i] = sorted[i].v;
    }
    // The lap is a loop: the tangent at the first and last key has to see
    // across the start/finish line or the profile kinks there.
    const secant = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      let ds = this.s[j] - this.s[i];
      if (ds <= 0) ds += period;
      secant[i] = (this.v[j] - this.v[i]) / Math.max(ds, 1e-4);
    }
    for (let i = 0; i < n; i++) {
      const p = (i + n - 1) % n;
      const a = secant[p];
      const b = secant[i];
      // A local extremum must stay an extremum: zero the tangent when the
      // slope changes sign, otherwise average and clamp to 3× the shallower
      // secant (Fritsch–Carlson).
      if (a * b <= 0) this.m[i] = 0;
      else {
        const avg = (a + b) * 0.5;
        const lim = 3 * Math.min(Math.abs(a), Math.abs(b));
        this.m[i] = Math.sign(avg) * Math.min(Math.abs(avg), lim);
      }
    }
    this.period = period;
  }

  readonly period: number;

  at(s: number): number {
    const n = this.s.length;
    if (n === 0) return 0;
    if (n === 1) return this.v[0];
    let x = s % this.period;
    if (x < 0) x += this.period;
    // Binary search for the span; the tables are 30-50 keys so this is 5 steps.
    let lo = 0;
    let hi = n - 1;
    if (x < this.s[0] || x >= this.s[n - 1]) {
      // Wrap span: between the last key and the first one across the line.
      const s0 = this.s[n - 1];
      const s1 = this.s[0] + this.period;
      const xx = x < this.s[0] ? x + this.period : x;
      return hermite(s0, this.v[n - 1], this.m[n - 1], s1, this.v[0], this.m[0], xx);
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.s[mid] <= x) lo = mid;
      else hi = mid;
    }
    return hermite(this.s[lo], this.v[lo], this.m[lo], this.s[hi], this.v[hi], this.m[hi], x);
  }
}

function hermite(
  s0: number,
  v0: number,
  m0: number,
  s1: number,
  v1: number,
  m1: number,
  x: number,
): number {
  const h = s1 - s0 || 1e-9;
  const t = (x - s0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * v0 +
    (t3 - 2 * t2 + t) * h * m0 +
    (-2 * t3 + 3 * t2) * v1 +
    (t3 - t2) * h * m1
  );
}

// ---------------------------------------------------------------------------
// Noise — terrain only, so it is cheap and deterministic rather than pretty
// ---------------------------------------------------------------------------

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695040) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/** Value noise with a quintic fade — smooth enough to derive normals from. */
export function valueNoise(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

export function fbm2(x: number, y: number, octaves: number, seed = 0): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(fx, fy, seed + i * 131) * amp;
    norm += amp;
    amp *= 0.5;
    // Rotate each octave so the lattice never lines up into visible axes.
    const nx = fx * 1.94 + fy * 0.53;
    const ny = fy * 1.94 - fx * 0.53;
    fx = nx;
    fy = ny;
  }
  return sum / norm;
}

/** Distance from a point to a 2D segment, plus the parameter along it. */
export function segmentDistance(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): { d: number; t: number } {
  const vx = bx - ax;
  const vz = bz - az;
  const len2 = vx * vx + vz * vz || 1e-9;
  const t = clamp01(((px - ax) * vx + (pz - az) * vz) / len2);
  const dx = px - (ax + vx * t);
  const dz = pz - (az + vz * t);
  return { d: Math.sqrt(dx * dx + dz * dz), t };
}

// ---------------------------------------------------------------------------
// Mesh building
// ---------------------------------------------------------------------------

/**
 * A growable non-indexed-until-the-end triangle soup.
 *
 * Every ribbon in this module is a grid of stations × cross-section samples, so
 * the builder exposes `grid()` for exactly that and `quad()` for one-offs. It
 * holds plain arrays and only touches typed arrays at the end — pushing into a
 * JS array and copying once measured faster than growing Float32Arrays.
 */
export class MeshBuilder {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly uv: number[] = [];
  readonly color: number[] = [];
  readonly index: number[] = [];
  private useColor = false;

  get vertexCount(): number {
    return this.position.length / 3;
  }

  vertex(
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
  ): number {
    const i = this.position.length / 3;
    this.position.push(px, py, pz);
    this.normal.push(nx, ny, nz);
    this.uv.push(u, v);
    if (this.useColor) this.color.push(1, 1, 1);
    return i;
  }

  vertexColor(r: number, g: number, b: number): void {
    if (!this.useColor) {
      // Back-fill white for anything already emitted, so a mesh can start
      // uncoloured and pick up tinting halfway through.
      this.useColor = true;
      for (let i = this.color.length; i < this.position.length; i += 3) this.color.push(1, 1, 1);
    }
    const n = this.position.length;
    const c = this.color;
    c[n - 3] = r;
    c[n - 2] = g;
    c[n - 1] = b;
  }

  tri(a: number, b: number, c: number): void {
    this.index.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.index.push(a, b, c, a, c, d);
  }

  /**
   * Stitch a `rows × cols` lattice of already-emitted vertices, where `base` is
   * the index of (0,0) and rows advance by `cols`. `closed` wraps the last row
   * back onto the first, which is how a lap-length ribbon closes seamlessly.
   *
   * The default winding faces `rowStep × colStep`. For a track ribbon — rows
   * along the tangent, columns along the racer's right — that product is
   * *−up*, i.e. the road would face the ground and vanish under back-face
   * culling. Hence `flip`, which every strip whose columns run rightwards has
   * to pass. (Ask how long that took to find.)
   */
  grid(base: number, rows: number, cols: number, closed = false, flip = false): void {
    const last = closed ? rows : rows - 1;
    for (let r = 0; r < last; r++) {
      const r0 = base + (r % rows) * cols;
      const r1 = base + ((r + 1) % rows) * cols;
      for (let c = 0; c < cols - 1; c++) {
        if (flip) {
          this.index.push(r0 + c, r1 + c + 1, r1 + c, r0 + c, r0 + c + 1, r1 + c + 1);
        } else {
          this.index.push(r0 + c, r1 + c, r1 + c + 1, r0 + c, r1 + c + 1, r0 + c + 1);
        }
      }
    }
  }

  toGeometry(name?: string): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.position, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.normal, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.useColor) g.setAttribute("color", new THREE.Float32BufferAttribute(this.color, 3));
    g.setIndex(this.index);
    g.computeBoundingSphere();
    if (name) g.name = name;
    return g;
  }
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/**
 * The shape of the material library, described here rather than imported.
 *
 * Systems do not import each other in this engine, and the track is not going
 * to be the exception. Everything below is optional-chained and every lookup
 * has a fallback, so a materials system that failed to boot costs us texture
 * detail and nothing else.
 */
export interface MaterialSource {
  get(name: string): THREE.Material | undefined;
  /** World metres one texture tile covers. Optional — we have our own table. */
  tileSize?(name: string): number;
}

function isMaterialSource(v: unknown): v is MaterialSource {
  return !!v && typeof (v as MaterialSource).get === "function";
}

/**
 * World metres per texture tile.
 *
 * The library publishes the same numbers via `tileSize()` and we prefer those
 * when they are there; this table is the fallback so the track still tiles
 * sensibly against invented materials.
 */
const TILE: Record<string, number> = {
  asphalt: 4, asphaltWorn: 4, kerb: 3.2, roadLine: 4, startLine: 8, boostPad: 4,
  grass: 6, dirt: 6, sand: 7, water: 12, ice: 8, wood: 3.2, metal: 3, grate: 1.6,
  concrete: 4, brick: 1, stone: 3, rubber: 0.6, chrome: 1, glass: 2, plastic: 1.5,
  foliage: 1.6, bark: 1.2, cloth: 1.5, banner: 4, neon: 1.5, antigrav: 4, crowd: 8,
};

/**
 * Fallback tints, used only when the material library is missing. They are the
 * course's colour identity in flat form — an ugly build, but a *readable* one.
 */
const FALLBACK: Record<string, { color: number; rough: number; metal: number }> = {
  asphalt: { color: 0x3b3f4a, rough: 0.92, metal: 0 },
  asphaltWorn: { color: 0x474b56, rough: 0.95, metal: 0 },
  kerb: { color: 0xe23b3b, rough: 0.6, metal: 0 },
  roadLine: { color: 0xf4f2ea, rough: 0.55, metal: 0 },
  startLine: { color: 0xdedad0, rough: 0.55, metal: 0 },
  boostPad: { color: 0xffb02e, rough: 0.35, metal: 0.6 },
  grass: { color: 0x54b04a, rough: 0.95, metal: 0 },
  dirt: { color: 0x8a6a45, rough: 0.96, metal: 0 },
  sand: { color: 0xe8d18a, rough: 0.95, metal: 0 },
  water: { color: 0x2e93d9, rough: 0.12, metal: 0 },
  wood: { color: 0x9a6b3f, rough: 0.82, metal: 0 },
  metal: { color: 0x9aa4ad, rough: 0.38, metal: 0.85 },
  chrome: { color: 0xdfe6ec, rough: 0.15, metal: 1 },
  grate: { color: 0x6b7178, rough: 0.5, metal: 0.8 },
  concrete: { color: 0xb9b4a8, rough: 0.9, metal: 0 },
  brick: { color: 0x9c5b46, rough: 0.88, metal: 0 },
  stone: { color: 0x7d7a72, rough: 0.9, metal: 0 },
  antigrav: { color: 0x2c3d55, rough: 0.4, metal: 0.7 },
  neon: { color: 0x35e8ff, rough: 0.3, metal: 0 },
  plastic: { color: 0xdddddd, rough: 0.4, metal: 0 },
  banner: { color: 0xffcc22, rough: 0.7, metal: 0 },
  foliage: { color: 0x3f8f3a, rough: 0.9, metal: 0 },
  glass: { color: 0xbfe2ef, rough: 0.1, metal: 0 },
};

/**
 * Resolve a named surface, remembering anything we had to invent so `dispose`
 * can free it. Library materials are shared and owned by the library — we never
 * mutate or dispose those.
 */
export class MaterialResolver {
  private readonly lib: MaterialSource | null;
  private readonly owned: THREE.Material[] = [];
  private readonly cache = new Map<string, THREE.Material>();

  constructor(services: unknown) {
    const svc = (services as { materials?: unknown } | undefined)?.materials;
    this.lib = isMaterialSource(svc) ? svc : null;
  }

  get available(): boolean {
    return this.lib !== null;
  }

  /** World metres covered by one tile of `name`. */
  tile(name: string): number {
    try {
      const v = this.lib?.tileSize?.(name);
      if (typeof v === "number" && v > 0.01) return v;
    } catch {
      /* the library is allowed to not have this */
    }
    return TILE[name] ?? 4;
  }

  get(name: string): THREE.Material {
    const hit = this.cache.get(name);
    if (hit) return hit;
    let mat: THREE.Material | undefined;
    try {
      mat = this.lib?.get(name);
    } catch {
      mat = undefined;
    }
    if (!mat) {
      const spec = FALLBACK[name] ?? { color: 0x808080, rough: 0.85, metal: 0 };
      mat = new THREE.MeshStandardMaterial({
        name: `track/fallback/${name}`,
        color: new THREE.Color(spec.color),
        roughness: spec.rough,
        metalness: spec.metal,
      });
      this.owned.push(mat);
    }
    this.cache.set(name, mat);
    return mat;
  }

  /**
   * A private variant of a library surface — needed wherever the track wants
   * vertex colours or double-sided rendering that the shared instance must not
   * gain. Cloning keeps the textures (three shares the underlying Source).
   */
  variant(name: string, key: string, tweak: (m: THREE.Material) => void): THREE.Material {
    const id = `${name}#${key}`;
    const hit = this.cache.get(id);
    if (hit) return hit;
    const mat = this.get(name).clone();
    mat.name = `track/${id}`;
    tweak(mat);
    this.owned.push(mat);
    this.cache.set(id, mat);
    return mat;
  }

  dispose(): void {
    for (const m of this.owned) m.dispose();
    this.owned.length = 0;
    this.cache.clear();
  }
}
