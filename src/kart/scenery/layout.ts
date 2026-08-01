/**
 * Vibe Kart — where things go.
 *
 * The track system owns an analytic spline; this module turns it into the two
 * queries the dressing actually needs and cannot get from `TrackService`:
 *
 *   · **"How far is this point from *any* part of the road?"** `frameAt` tells
 *     you about one t; a circuit folds back on itself, so a tree placed 25 m
 *     outside turn 3 can land squarely on the back straight. Every scatter in
 *     this directory rejects against a global clearance test.
 *
 *   · **"How high is the ground here?"** Off-ribbon there is no authored
 *     surface, so ground is the nearest centreline's height with a shallow
 *     run-off fall away from it — which is what a real circuit's verge does.
 *
 * Both are answered from a resampled polyline held in flat typed arrays behind
 * a uniform grid, not by calling back into the track. That is deliberate:
 * dressing issues tens of thousands of these queries during boot and the cost
 * must not depend on another system's search strategy.
 *
 * If the track never booted — a failed stage, or this module under test — the
 * sampler synthesises a plausible circuit so the world is still a place rather
 * than a void. Degrade, never throw.
 */
import * as THREE from "three";
import type { TrackFrame, TrackService } from "../types";
import { TAU, clamp, fbm2, lerp } from "./util";

export interface SampleFrame {
  position: THREE.Vector3;
  forward: THREE.Vector3;
  /** Unit lateral, the racer's right. Flattened to horizontal. */
  right: THREE.Vector3;
  halfWidth: number;
  curvature: number;
  /**
   * Road bank in radians. Trackside dressing has to know about this: on a
   * heavily banked section the ribbon rears up into a wall, and a barrier
   * offset horizontally from the centreline ends up *inside* the road.
   */
  bank: number;
  t: number;
}

/**
 * Past this much bank the road is a wall, not a verge, and nothing may be
 * planted beside it. Roughly 16° — steeper than any real circuit's camber and
 * shallower than any wall-ride worth building.
 */
export const MAX_BUILDABLE_BANK = 0.28;

/** Cell side of the nearest-point acceleration grid, metres. */
const CELL = 24;
/** Nothing further than this from the road is ever "near" it. */
const MAX_SEARCH = 96;

export class TrackSampler {
  /** True when a real `TrackService` backed this sampler. */
  readonly real: boolean;
  readonly length: number;
  readonly count: number;
  readonly sectorCount: number;
  readonly centre = new THREE.Vector3();
  readonly radius: number;
  readonly minY: number;
  readonly maxY: number;
  readonly meanY: number;

  private px: Float32Array;
  private py: Float32Array;
  private pz: Float32Array;
  private fx: Float32Array;
  private fz: Float32Array;
  private hw: Float32Array;
  private curv: Float32Array;
  private bank: Float32Array;
  private grid = new Map<number, number[]>();
  private gx0 = 0;
  private gz0 = 0;

  constructor(track: TrackService | undefined, samples = 1024) {
    let ok = false;
    let length = 1800;
    const n = samples;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.fx = new Float32Array(n);
    this.fz = new Float32Array(n);
    this.hw = new Float32Array(n);
    this.curv = new Float32Array(n);
    this.bank = new Float32Array(n);

    if (track && typeof track.frameAt === "function") {
      try {
        const probe = track.frameAt(0);
        if (probe && probe.position && probe.forward) {
          for (let i = 0; i < n; i++) {
            const f: TrackFrame = track.frameAt(i / n);
            this.px[i] = f.position.x;
            this.py[i] = f.position.y;
            this.pz[i] = f.position.z;
            this.fx[i] = f.forward.x;
            this.fz[i] = f.forward.z;
            this.hw[i] = f.halfWidth || 9;
            this.curv[i] = f.curvature || 0;
            this.bank[i] = f.bank || 0;
          }
          length = track.length || this.polylineLength();
          ok = true;
        }
      } catch (err) {
        console.error("[Vibe Kart/scenery] track sampling failed; dressing a stand-in circuit", err);
        ok = false;
      }
    }

    if (!ok) this.synthesise(n);

    this.real = ok;
    this.length = length || this.polylineLength();
    this.count = n;

    // Bounds, used by everything from stand placement to where the mountains go.
    let minY = Infinity;
    let maxY = -Infinity;
    let sumY = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      minY = Math.min(minY, this.py[i]);
      maxY = Math.max(maxY, this.py[i]);
      sumY += this.py[i];
      minX = Math.min(minX, this.px[i]);
      maxX = Math.max(maxX, this.px[i]);
      minZ = Math.min(minZ, this.pz[i]);
      maxZ = Math.max(maxZ, this.pz[i]);
    }
    this.centre.set((minX + maxX) * 0.5, minY, (minZ + maxZ) * 0.5);
    let r = 0;
    for (let i = 0; i < n; i++) {
      r = Math.max(r, Math.hypot(this.px[i] - this.centre.x, this.pz[i] - this.centre.z));
    }
    this.radius = r;
    this.minY = minY;
    this.maxY = maxY;
    this.meanY = sumY / n;

    // Sector granularity: ~130 m of track per sector, which at the view
    // distances used here means four or five sectors alive at once.
    this.sectorCount = Math.round(clamp(this.length / 130, 8, 24));

    this.buildGrid();
  }

  /** A hand-drawn stand-in circuit: a kinked oval, so the fallback still reads. */
  private synthesise(n: number): void {
    const a = 240;
    const b = 165;
    for (let i = 0; i < n; i++) {
      const th = (i / n) * TAU;
      const wob = 1 + Math.sin(th * 3) * 0.12 + Math.sin(th * 5 + 1.1) * 0.06;
      const x = Math.cos(th) * a * wob;
      const z = Math.sin(th) * b * wob;
      this.px[i] = x;
      this.py[i] = Math.sin(th * 2) * 6;
      this.pz[i] = z;
      this.hw[i] = 9.5;
      this.curv[i] = Math.sin(th * 3) * 0.01;
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = this.px[j] - this.px[i];
      const dz = this.pz[j] - this.pz[i];
      const l = Math.hypot(dx, dz) || 1;
      this.fx[i] = dx / l;
      this.fz[i] = dz / l;
    }
  }

  private polylineLength(): number {
    let sum = 0;
    for (let i = 0; i < this.px.length; i++) {
      const j = (i + 1) % this.px.length;
      sum += Math.hypot(this.px[j] - this.px[i], this.py[j] - this.py[i], this.pz[j] - this.pz[i]);
    }
    return sum;
  }

  private key(cx: number, cz: number): number {
    // 16-bit packing: circuits do not span 1000 cells (24 km) in either axis.
    return ((cx + 32768) << 16) | (cz + 32768);
  }

  private buildGrid(): void {
    this.gx0 = Math.floor(this.centre.x / CELL);
    this.gz0 = Math.floor(this.centre.z / CELL);
    for (let i = 0; i < this.count; i++) {
      const cx = Math.floor(this.px[i] / CELL);
      const cz = Math.floor(this.pz[i] / CELL);
      const k = this.key(cx, cz);
      let list = this.grid.get(k);
      if (!list) this.grid.set(k, (list = []));
      list.push(i);
    }
  }

  /** Index of the nearest centreline sample to (x, z), or -1 if far outside. */
  nearest(x: number, z: number): { index: number; dist: number } {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const span = Math.ceil(MAX_SEARCH / CELL);
    let best = -1;
    let bestD = Infinity;
    let hitRing = -1;
    // Expanding square rings. Most queries resolve in the first or second, and
    // stopping early is what keeps a 30 000-sample scatter inside a frame.
    for (let ring = 0; ring <= span; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dz = -ring; dz <= ring; dz++) {
          if (ring > 0 && Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const list = this.grid.get(this.key(cx + dx, cz + dz));
          if (!list) continue;
          for (const i of list) {
            const d = (this.px[i] - x) ** 2 + (this.pz[i] - z) ** 2;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      // One ring of slack before stopping: a cell diagonal is longer than a
      // cell side, so the true nearest can sit one ring beyond the first hit.
      if (best >= 0) {
        if (hitRing < 0) hitRing = ring;
        else if (ring > hitRing) break;
      }
    }
    return { index: best, dist: best < 0 ? MAX_SEARCH : Math.sqrt(bestD) };
  }

  /**
   * Metres of clear ground between (x, z) and the edge of the nearest road.
   * Negative means the point is on the ribbon and must not be built on.
   */
  clearance(x: number, z: number): number {
    const { index, dist } = this.nearest(x, z);
    if (index < 0) return MAX_SEARCH;
    return dist - this.hw[index];
  }

  /**
   * Ground height. Off the ribbon it falls away gently — a verge, then run-off,
   * then the surrounding land — capped so a prop 80 m out is not in a pit.
   */
  groundAt(x: number, z: number): number {
    const { index, dist } = this.nearest(x, z);
    if (index < 0) return this.meanY - 4 + fbm2(x * 0.004, z * 0.004) * 5;
    const off = Math.max(0, dist - this.hw[index]);
    const fall = Math.min(3.2, off * 0.055) + Math.min(2.4, Math.max(0, off - 30) * 0.03);
    // A whisper of undulation so a hundred trees do not sit on one plane.
    const bump = fbm2(x * 0.02, z * 0.02) * Math.min(1.6, off * 0.04);
    return this.py[index] - fall + bump;
  }

  frameAt(t: number, out?: SampleFrame): SampleFrame {
    const n = this.count;
    const u = ((t % 1) + 1) % 1;
    const fi = u * n;
    const i0 = Math.floor(fi) % n;
    const i1 = (i0 + 1) % n;
    const f = fi - Math.floor(fi);
    const o: SampleFrame = out ?? {
      position: new THREE.Vector3(),
      forward: new THREE.Vector3(),
      right: new THREE.Vector3(),
      halfWidth: 9,
      curvature: 0,
      bank: 0,
      t: 0,
    };
    o.position.set(
      lerp(this.px[i0], this.px[i1], f),
      lerp(this.py[i0], this.py[i1], f),
      lerp(this.pz[i0], this.pz[i1], f),
    );
    o.forward.set(lerp(this.fx[i0], this.fx[i1], f), 0, lerp(this.fz[i0], this.fz[i1], f));
    if (o.forward.lengthSq() < 1e-8) o.forward.set(0, 0, 1);
    else o.forward.normalize();
    // right = forward × (0,1,0) = (-fz, 0, fx). With three's -Z-forward
    // convention that puts +right where the driver's right hand is.
    o.right.set(-o.forward.z, 0, o.forward.x);
    o.halfWidth = lerp(this.hw[i0], this.hw[i1], f);
    o.curvature = lerp(this.curv[i0], this.curv[i1], f);
    o.bank = lerp(this.bank[i0], this.bank[i1], f);
    o.t = u;
    return o;
  }

  /** Mean |curvature| over a window of the lap — how straight a stretch is. */
  straightness(t: number, windowT: number): number {
    const n = this.count;
    const half = Math.max(1, Math.round((windowT * n) / 2));
    const c0 = Math.round(((t % 1) + 1) % 1 * n);
    let sum = 0;
    for (let k = -half; k <= half; k++) {
      sum += Math.abs(this.curv[(c0 + k + n * 4) % n]);
    }
    return sum / (half * 2 + 1);
  }

  /** Absolute bank at `t`, in radians. */
  bankAt(t: number): number {
    const n = this.count;
    const u = ((t % 1) + 1) % 1;
    return Math.abs(this.bank[Math.min(n - 1, Math.floor(u * n))]);
  }

  /** Bank of the nearest centreline sample to a world point, in radians. */
  bankNear(x: number, z: number): number {
    const { index } = this.nearest(x, z);
    return index < 0 ? 0 : Math.abs(this.bank[index]);
  }

  sectorOf(t: number): number {
    const u = ((t % 1) + 1) % 1;
    return Math.min(this.sectorCount - 1, Math.floor(u * this.sectorCount));
  }

  /** Sector of a world point — for scatter that was not placed from a t. */
  sectorAtPoint(x: number, z: number): number {
    const { index } = this.nearest(x, z);
    if (index < 0) return 0;
    return this.sectorOf(index / this.count);
  }

  /**
   * Landmark ring radius: far enough outside the circuit that nothing can
   * intersect the road however the track system laid the spline out.
   */
  farRadius(extra: number): number {
    return this.radius + extra;
  }
}

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

export interface ScatterOptions {
  /** How many placements to make. Attempts are capped at 8× this. */
  count: number;
  /** Metres beyond the road edge where the band starts and ends. */
  minOffset: number;
  maxOffset: number;
  /**
   * How hard density drops with distance from the road. 0 fills the band
   * evenly; 1 puts almost everything on the verge. Vegetation wants a high
   * value — a forest of uniform density looks like a field of stamps.
   */
  falloff: number;
  /** Minimum metres between two accepted placements. */
  spacing: number;
  /** Extra clear ground demanded beyond the road edge. */
  clearance: number;
}

export interface ScatterHit {
  x: number;
  y: number;
  z: number;
  /** Lap position of the centreline sample this came from. */
  t: number;
  /** Metres from the road edge. */
  offset: number;
  /** +1 if placed on the racer's right. */
  side: 1 | -1;
}

/**
 * Lay points out along the circuit, rejecting anything that would land on the
 * road, inside a keep-out circle, or on top of a neighbour.
 *
 * The occupancy check is a hash grid at the spacing radius, which is what keeps
 * a nine-thousand-tuft grass layer at a few milliseconds instead of the
 * quadratic all-pairs test the obvious implementation reaches for.
 */
export function scatter(
  sampler: TrackSampler,
  rng: () => number,
  opts: ScatterOptions,
  keepOut: ReadonlyArray<{ x: number; z: number; r: number }>,
  visit: (hit: ScatterHit) => void,
): void {
  const cell = Math.max(1, opts.spacing);
  const taken = new Map<number, number[]>();
  const frame = sampler.frameAt(0);
  const maxAttempts = opts.count * 8;
  let placed = 0;

  const key = (cx: number, cz: number) => ((cx + 32768) << 16) | (cz + 32768);

  for (let attempt = 0; attempt < maxAttempts && placed < opts.count; attempt++) {
    const t = rng();
    sampler.frameAt(t, frame);
    // Bias toward the verge by raising the uniform sample to a power; falloff
    // 0 leaves it linear, falloff 1 crowds it hard against the road.
    const u = Math.pow(rng(), 1 + opts.falloff * 3);
    const offset = opts.minOffset + (opts.maxOffset - opts.minOffset) * u;
    const side: 1 | -1 = rng() < 0.5 ? 1 : -1;
    const x = frame.position.x + frame.right.x * side * (frame.halfWidth + offset);
    const z = frame.position.z + frame.right.z * side * (frame.halfWidth + offset);

    if (sampler.clearance(x, z) < opts.clearance) continue;
    // A banked section is a wall. Planting on the horizontal offset from its
    // centreline puts the tree inside the road surface.
    if (Math.abs(frame.bank) > MAX_BUILDABLE_BANK * 1.4) continue;

    let blocked = false;
    for (const k of keepOut) {
      const dx = x - k.x;
      const dz = z - k.z;
      if (dx * dx + dz * dz < k.r * k.r) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    for (let ox = -1; ox <= 1 && !blocked; ox++) {
      for (let oz = -1; oz <= 1 && !blocked; oz++) {
        const list = taken.get(key(cx + ox, cz + oz));
        if (!list) continue;
        for (let i = 0; i < list.length; i += 2) {
          const dx = list[i] - x;
          const dz = list[i + 1] - z;
          if (dx * dx + dz * dz < opts.spacing * opts.spacing) {
            blocked = true;
            break;
          }
        }
      }
    }
    if (blocked) continue;

    const k = key(cx, cz);
    let list = taken.get(k);
    if (!list) taken.set(k, (list = []));
    list.push(x, z);

    visit({ x, y: sampler.groundAt(x, z), z, t, offset, side });
    placed++;
  }
}
