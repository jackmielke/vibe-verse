/**
 * chunker.ts — the streaming machinery the whole street layer shares.
 *
 * Two things live here.
 *
 * `ChunkStreamer` keeps a ring of merged-geometry chunks resident around the
 * camera: two rings, a near one at full detail and a coarse one behind it, with
 * a per-frame millisecond budget so crossing a chunk boundary at 90 m/s costs a
 * fraction of a frame rather than a visible hitch. Roads, sidewalks and signage
 * all use it; they differ only in what their builder emits.
 *
 * `InstancePool` is the other half. Street furniture, parked cars and trees are
 * tens of thousands of small objects, and one InstancedMesh per chunk per kind
 * would be a thousand draw calls. Instead every kind gets exactly one
 * InstancedMesh for the whole city, and the resident chunks' pre-baked matrix
 * blocks are memcpy'd into it whenever the resident set changes — which is a
 * couple of hundred microseconds, a few times a minute, instead of per frame.
 */
import * as THREE from "three";

/* ================================================================== *
 * Chunked merged geometry
 * ================================================================== */

export interface ChunkOutput {
  /** Meshes to parent under the streamer's group. Geometry is owned by the
   *  streamer from here on and disposed on eviction. */
  meshes: THREE.Object3D[];
}

export type ChunkBuilder = (
  x: number,
  z: number,
  size: number,
  lod: number,
) => ChunkOutput | null;

interface Chunk {
  key: string;
  x: number;
  z: number;
  size: number;
  lod: number;
  built: boolean;
  meshes: THREE.Object3D[];
}

export interface StreamerOptions {
  /** Near-ring chunk edge, metres. */
  cell: number;
  /** Far-ring chunk edge, metres. Must be an integer multiple of `cell`. */
  farCell: number;
  /** Milliseconds of building allowed per frame. */
  budgetMs: number;
  /** Extra budget while the first ring is still filling in. */
  warmupMs: number;
  /** Camera movement (metres) that triggers a rescan. */
  rescanDistance: number;
}

const DEFAULTS: StreamerOptions = {
  cell: 384,
  farCell: 1152,
  budgetMs: 3.0,
  warmupMs: 8.0,
  rescanDistance: 64,
};

/** Distance from a point to the nearest edge of an axis-aligned square. */
export function boxDistance(px: number, pz: number, x: number, z: number, size: number): number {
  const dx = Math.max(x - px, 0, px - (x + size));
  const dz = Math.max(z - pz, 0, pz - (z + size));
  return Math.hypot(dx, dz);
}

export class ChunkStreamer {
  private chunks = new Map<string, Chunk>();
  private queue: Chunk[] = [];
  private lastX = Infinity;
  private lastZ = Infinity;
  private lastT = -1e9;
  private warm = true;
  private opts: StreamerOptions;

  constructor(
    private group: THREE.Group,
    private builder: ChunkBuilder,
    private nearRadius: () => number,
    private farRadius: () => number,
    opts: Partial<StreamerOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** True once every scheduled chunk has been built. The screenshot harness
   *  will not grab a frame until this is true for every street subsystem. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Advance one frame. `onChange` fires whenever the resident set changed,
   * which is the signal the instance pools use to refill themselves.
   */
  update(camX: number, camZ: number, time: number, onChange?: () => void): void {
    let changed = false;
    const moved = Math.hypot(camX - this.lastX, camZ - this.lastZ);
    if (moved > this.opts.rescanDistance || time - this.lastT > 0.6) {
      this.lastX = camX;
      this.lastZ = camZ;
      this.lastT = time;
      changed = this.rescan(camX, camZ) || changed;
    }

    if (this.warm && this.queue.length === 0) this.warm = false;
    const deadline = performance.now() + (this.warm ? this.opts.warmupMs : this.opts.budgetMs);
    while (this.queue.length > 0 && performance.now() < deadline) {
      const c = this.queue.shift()!;
      if (!this.chunks.has(c.key)) continue;
      this.build(c);
      changed = true;
    }
    if (changed) onChange?.();
  }

  /** Recompute the resident set. Returns true if anything was evicted. */
  private rescan(cx: number, cz: number): boolean {
    const { cell, farCell } = this.opts;
    const near = this.nearRadius();
    const far = this.farRadius();
    const wanted = new Set<string>();
    let evicted = false;

    const ratio = Math.max(1, Math.round(farCell / cell));
    const bReach = Math.ceil(far / farCell) + 1;
    const bi = Math.floor(cx / farCell);
    const bj = Math.floor(cz / farCell);

    for (let j = bj - bReach; j <= bj + bReach; j++) {
      for (let i = bi - bReach; i <= bi + bReach; i++) {
        const bx = i * farCell;
        const bz = j * farCell;
        const bNear = boxDistance(cx, cz, bx, bz, farCell);
        if (bNear > far) continue;
        if (bNear >= near) {
          this.want(wanted, `F:${i}:${j}`, bx, bz, farCell, 1, bNear);
          continue;
        }
        // Straddles the boundary: resolve into fine cells so the two rings can
        // never overlap or leave a gap.
        for (let sj = 0; sj < ratio; sj++) {
          for (let si = 0; si < ratio; si++) {
            const ax = bx + si * cell;
            const az = bz + sj * cell;
            const aNear = boxDistance(cx, cz, ax, az, cell);
            if (aNear > near) continue;
            this.want(wanted, `N:${Math.round(ax / cell)}:${Math.round(az / cell)}`, ax, az, cell, 0, aNear);
          }
        }
      }
    }

    for (const [key, c] of this.chunks) {
      if (wanted.has(key)) continue;
      this.retire(c);
      this.chunks.delete(key);
      evicted = true;
    }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (!this.chunks.has(this.queue[i].key)) this.queue.splice(i, 1);
    }
    // Nearest first: the chunk under your feet matters more than the one at the
    // horizon, and while flying that ordering is the difference between a road
    // appearing under you and a road appearing behind you.
    this.queue.sort(
      (a, b) => boxDistance(cx, cz, a.x, a.z, a.size) - boxDistance(cx, cz, b.x, b.z, b.size),
    );
    return evicted;
  }

  private want(
    set: Set<string>, key: string, x: number, z: number, size: number, lod: number, _d: number,
  ): void {
    set.add(key);
    if (this.chunks.has(key)) return;
    const c: Chunk = { key, x, z, size, lod, built: false, meshes: [] };
    this.chunks.set(key, c);
    this.queue.push(c);
  }

  private build(c: Chunk): void {
    const out = this.builder(c.x, c.z, c.size, c.lod);
    c.built = true;
    if (!out) return;
    for (const m of out.meshes) {
      this.group.add(m);
      c.meshes.push(m);
    }
  }

  private retire(c: Chunk): void {
    for (const m of c.meshes) {
      this.group.remove(m);
      disposeObject(m);
    }
    c.meshes.length = 0;
  }

  /** Which chunks are currently resident — the pools iterate this. */
  resident(): IterableIterator<Chunk> {
    return this.chunks.values();
  }

  /** Iterate resident chunk keys with their bounds. */
  forEachResident(fn: (key: string, x: number, z: number, size: number, lod: number, built: boolean) => void): void {
    for (const c of this.chunks.values()) fn(c.key, c.x, c.z, c.size, c.lod, c.built);
  }

  dispose(): void {
    for (const c of this.chunks.values()) this.retire(c);
    this.chunks.clear();
    this.queue.length = 0;
  }
}

/**
 * Tell the screenshot harness we are still building.
 *
 * `Buildings` *assigns* `pendingChunks` each frame while we can only add to it,
 * so this deliberately never writes a zero: the worst it can do is delay a
 * screenshot, never take one of a half-built street.
 */
export function reportPending(n: number): void {
  if (n <= 0) return;
  if (typeof window === "undefined" || !window.__sf) return;
  window.__sf.pendingChunks = (window.__sf.pendingChunks ?? 0) + n;
}

/** Dispose a mesh's geometry (materials are shared and cached — never ours). */
export function disposeObject(o: THREE.Object3D): void {
  o.traverse((n) => {
    const m = n as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
  });
}

/* ================================================================== *
 * Instance pools
 * ================================================================== */

/**
 * One InstancedMesh for one prop kind, city-wide.
 *
 * `capacity` is a hard ceiling; when the resident set has more instances than
 * that, the nearest ones win. That is a deliberate design choice rather than a
 * limitation: the alternative is either a per-chunk InstancedMesh (draw calls)
 * or a resizing buffer (a GPU reallocation every time you turn a corner).
 */
export class InstancePool {
  readonly mesh: THREE.InstancedMesh;
  private cursor = 0;
  private readonly cap: number;
  private readonly matrices: Float32Array;
  private readonly colors: Float32Array | null;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    opts: { castShadow?: boolean; receiveShadow?: boolean; color?: boolean; name?: string } = {},
  ) {
    this.cap = Math.max(1, capacity);
    this.mesh = new THREE.InstancedMesh(geometry, material, this.cap);
    this.mesh.count = 0;
    this.mesh.castShadow = opts.castShadow ?? true;
    this.mesh.receiveShadow = opts.receiveShadow ?? true;
    this.mesh.frustumCulled = false; // the pool spans the whole streamed region
    this.mesh.name = opts.name ?? "sf-street-pool";
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.matrices = this.mesh.instanceMatrix.array as Float32Array;
    if (opts.color) {
      this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 3), 3);
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.colors = this.mesh.instanceColor.array as Float32Array;
    } else {
      this.colors = null;
    }
  }

  get capacity(): number {
    return this.cap;
  }

  get count(): number {
    return this.cursor;
  }

  begin(): void {
    this.cursor = 0;
  }

  /** Bulk-append a pre-baked block of matrices (and optionally colours). */
  pushBlock(mat: Float32Array, n: number, col: Float32Array | null): number {
    const room = this.cap - this.cursor;
    const take = Math.min(n, room);
    if (take <= 0) return 0;
    this.matrices.set(mat.subarray(0, take * 16), this.cursor * 16);
    if (this.colors && col) this.colors.set(col.subarray(0, take * 3), this.cursor * 3);
    else if (this.colors) this.colors.fill(1, this.cursor * 3, (this.cursor + take) * 3);
    this.cursor += take;
    return take;
  }

  /** Append one instance from a matrix. */
  push(m: THREE.Matrix4, r = 1, g = 1, b = 1): boolean {
    if (this.cursor >= this.cap) return false;
    m.toArray(this.matrices, this.cursor * 16);
    if (this.colors) {
      const i3 = this.cursor * 3;
      this.colors[i3] = r;
      this.colors[i3 + 1] = g;
      this.colors[i3 + 2] = b;
    }
    this.cursor++;
    return true;
  }

  end(): void {
    this.mesh.count = this.cursor;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Rewrite one instance's colour in place — used by the signal heads. */
  setColorAt(i: number, r: number, g: number, b: number): void {
    if (!this.colors || i >= this.cursor) return;
    const i3 = i * 3;
    this.colors[i3] = r;
    this.colors[i3 + 1] = g;
    this.colors[i3 + 2] = b;
  }

  flushColors(): void {
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Releases the instance buffers only. Geometry and material are shared and
   *  owned by their caches, so disposing them here would break the next mount. */
  dispose(): void {
    this.mesh.dispose();
  }
}

/* ================================================================== *
 * Baked instance blocks
 * ================================================================== */

/**
 * A growable matrix block. Chunk generators write into one of these per prop
 * kind, and the pool memcpy's the finished array. Keeping the data in a flat
 * Float32Array rather than an array of Matrix4 is what makes the refill cheap
 * enough to do synchronously.
 */
export class InstanceBlock {
  mat: Float32Array;
  col: Float32Array;
  meta: Int32Array;
  n = 0;

  constructor(hint = 32) {
    this.mat = new Float32Array(hint * 16);
    this.col = new Float32Array(hint * 3);
    this.meta = new Int32Array(hint * 2);
  }

  private grow(): void {
    let cap = this.mat.length / 16;
    while (cap <= this.n) cap *= 2;
    const m = new Float32Array(cap * 16);
    m.set(this.mat);
    this.mat = m;
    const c = new Float32Array(cap * 3);
    c.set(this.col);
    this.col = c;
    const t = new Int32Array(cap * 2);
    t.set(this.meta);
    this.meta = t;
  }

  push(m: THREE.Matrix4, r = 1, g = 1, b = 1, meta0 = 0, meta1 = 0): void {
    if (this.n * 16 >= this.mat.length) this.grow();
    m.toArray(this.mat, this.n * 16);
    const i3 = this.n * 3;
    this.col[i3] = r;
    this.col[i3 + 1] = g;
    this.col[i3 + 2] = b;
    this.meta[this.n * 2] = meta0;
    this.meta[this.n * 2 + 1] = meta1;
    this.n++;
  }
}

/** A chunk's worth of baked instances, keyed by prop kind. */
export type InstanceChunk = Map<string, InstanceBlock>;

export function blockFor(chunk: InstanceChunk, kind: string): InstanceBlock {
  let b = chunk.get(kind);
  if (!b) {
    b = new InstanceBlock();
    chunk.set(kind, b);
  }
  return b;
}
