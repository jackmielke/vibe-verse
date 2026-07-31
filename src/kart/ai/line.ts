/**
 * Vibe Kart — the racing line, baked once at boot.
 *
 * A CPU field is only as good as the path it is asked to follow. Steering at a
 * centreline gives you eight traffic cones in convoy; steering at a *line*
 * gives you a race. So this module spends a few milliseconds at boot solving
 * for a real one and hands the pilots a lookup table.
 *
 * HOW THE LINE IS FOUND
 * ---------------------
 * 1. **Corridor.** Every two metres, walk outward from the centreline with
 *    `track.surfaceAt` until the ground stops being fast tarmac. That finds the
 *    genuine drivable width — including the quarter-pipe lip in the Quarry Bowl
 *    and the narrow timber of Gull Creek Bridge — without this module knowing
 *    anything about how the course was authored. Minus a kart's half-width and
 *    a little slack, that is where the line is allowed to live.
 *
 * 2. **Minimum curvature, on a multigrid.** The line is the stationary point of
 *    `0.35·∑|ΔP|² + ∑|Δ²P|²` — a little "be short" against a lot of "do not
 *    bend" — clamped into the corridor. Under that clamp it converges to the
 *    classic shape on its own: wide entry, clip the inside at the apex, run out
 *    to the far edge on exit. Nobody authors "cut this corner"; it falls out of
 *    the geometry. It is solved coarse-to-fine because plain relaxation is a
 *    diffusion, and a hundred-metre corner is fifty stations long: Jacobi needs
 *    the *square* of that in iterations to tell one end of it about the other,
 *    and an under-converged line hugs the middle of the road and looks it.
 *
 * 3. **Late apex.** Pure minimum curvature puts the apex geometrically in the
 *    middle of the turn, which is the fastest way *through* a corner and the
 *    slowest way *out* of one. A few metres of forward shift, weighted by how
 *    hard the corner is, delays the apex and opens the exit — the difference
 *    between a lap time and a racing line.
 *
 * 4. **Speed profile.** Curvature of the resulting line — only the part of it
 *    that bends about the road normal, because a crest is not a corner — gives
 *    the cornering limit. A backward pass propagates braking distance into the
 *    approach and a forward pass caps how fast the kart could physically have
 *    got there. That makes the field lift for Lantern Hairpin and stay pinned
 *    down Cannery Straight instead of braking on a timer. Afterwards, the
 *    run-up to any gap in the road is stamped with a minimum entry speed, which
 *    nothing may override: the Bluff Jump has a far side, and reaching it is
 *    not a matter of taste.
 *
 * Everything is stored in flat typed arrays and read with linear interpolation.
 * No allocation after boot, and the whole table is a few tens of kilobytes.
 */
import * as THREE from "three";
import { SURFACES, TUNING, type KartQuality, type SurfaceSample, type TrackFrame, type TrackService } from "../types";
import { clamp, wrap01 } from "./math";

/** Half the kart plus slack: how close the line may come to the edge. */
const EDGE_MARGIN = 1.55;

/** How far past the authored half-width to look for driveable lip or apron. */
const OUTWARD_REACH = 5.5;

/** Lateral acceleration the line is planned against, m/s². Under the tyres'
 *  real ceiling so there is something left for a mid-corner correction. */
const PLAN_LAT_ACCEL = 25.5;

/** Planning limits for the speed profile, m/s². Braking is deliberately gentle
 *  — an arcade kart should lift and coast, not stand on the middle pedal. */
const PLAN_BRAKE = 15;
const PLAN_ACCEL = 9.5;

/** How much road before a gap is stamped with the jump's minimum entry speed. */
const JUMP_RUNUP = 90;

/** Tightest radius the planner will believe: 1/18 m. Anything sharper is noise
 *  in the curvature estimate, not a corner the course actually contains. */
const PLAN_MAX_CURVATURE = 1 / 18;

export interface ShortcutRoute {
  /** Sampled centreline of the cut, world space. */
  pos: Float32Array;
  count: number;
  /** Cumulative length at each sample. */
  cum: Float32Array;
  length: number;
  /** Lap position where the cut leaves and rejoins the main line. */
  entryT: number;
  exitT: number;
  /** Metres of road the cut skips. */
  mainLength: number;
  /** Seconds saved on dirt at racing pace. Negative means it is a trap. */
  gain: number;
  /** Seconds saved with a mushroom lit. */
  gainBoosted: number;
}

export interface RacingLine {
  count: number;
  /** Station spacing along the centreline, metres. */
  ds: number;
  length: number;

  /** Station-major flat arrays of the centreline frame. */
  pos: Float32Array;
  fwd: Float32Array;
  rgt: Float32Array;
  up: Float32Array;

  /** Lateral offset of the line from the centreline, metres. */
  off: Float32Array;
  /** Signed lateral bounds the line is allowed to use. */
  corridorL: Float32Array;
  corridorR: Float32Array;
  /** Signed curvature of the *line*, 1/m. Positive turns right. */
  curvature: Float32Array;
  /** Curvature smoothed over ~20 m — what a driver reads as "the corner". */
  corner: Float32Array;
  /** Planned speed at each station, m/s. */
  speed: Float32Array;
  /** Minimum speed the station demands — the run-up to a gap jump. 0 elsewhere. */
  floor: Float32Array;
  /** Lateral of a boost panel at this station, or NaN. */
  padLat: Float32Array;

  /** Arc position of a normalised lap position. */
  sAt(t: number): number;
  /** Fractional station index for an arc position, wrapping. */
  indexAt(s: number): number;
  /** Lateral offset of the line at an arc position. */
  offsetAt(s: number): number;
  /** Planned speed at an arc position. */
  speedAt(s: number): number;
  /** Minimum speed demanded at an arc position — 0 where there is no jump. */
  floorAt(s: number): number;
  /** Smoothed signed corner strength at an arc position. */
  cornerAt(s: number): number;
  /** Corridor bounds at an arc position, written into `out`. */
  corridorAt(s: number, out: { min: number; max: number }): { min: number; max: number };
  /** World point on the road at (arc, lateral), lifted along the road normal. */
  point(s: number, lateral: number, lift: number, out: THREE.Vector3): THREE.Vector3;
  /** Road normal at an arc position. */
  normal(s: number, out: THREE.Vector3): THREE.Vector3;
  /** Nearest boost panel ahead within `range` metres, or null. */
  padAhead(s: number, range: number): { s: number; lateral: number } | null;

  shortcut: ShortcutRoute | null;
}

/** A track service may publish more than the contract; we use it if it is there. */
interface TrackExtras {
  shortcutPath?(): THREE.Vector3[];
}

export function bakeRacingLine(track: TrackService, quality: KartQuality): RacingLine | null {
  const length = track.length;
  if (!(length > 1)) return null;

  const coarse = quality === "low" || quality === "medium";
  const targetDs = coarse ? 3 : 2;
  // Rounded to a multiple of the coarsest multigrid stride so every level of
  // the solve below closes exactly around the lap with no odd node at the seam.
  const count = Math.round(clamp(Math.round(length / targetDs), 96, 2048) / 16) * 16;
  const ds = length / count;

  const pos = new Float32Array(count * 3);
  const fwd = new Float32Array(count * 3);
  const rgt = new Float32Array(count * 3);
  const up = new Float32Array(count * 3);
  const halfWidth = new Float32Array(count);
  const corridorL = new Float32Array(count);
  const corridorR = new Float32Array(count);
  const padLat = new Float32Array(count).fill(NaN);
  const off = new Float32Array(count);
  const curvature = new Float32Array(count);
  const corner = new Float32Array(count);
  const speed = new Float32Array(count);
  const floor = new Float32Array(count);
  /** Stations where the road simply is not there: the Bluff Jump's air. */
  const gap = new Uint8Array(count);

  const frame: TrackFrame = {
    t: 0,
    position: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    halfWidth: 8,
    bank: 0,
    curvature: 0,
    grade: 0,
  };
  const sample: SurfaceSample = {
    height: 0,
    normal: new THREE.Vector3(0, 1, 0),
    kind: "road",
    onTrack: false,
    lateral: 0,
    t: 0,
  };
  const probe = new THREE.Vector3();

  // -------------------------------------------------------------------------
  // 1. Frames and corridor
  // -------------------------------------------------------------------------
  for (let i = 0; i < count; i++) {
    const t = i / count;
    track.frameAt(t, frame);
    pos[i * 3] = frame.position.x;
    pos[i * 3 + 1] = frame.position.y;
    pos[i * 3 + 2] = frame.position.z;
    fwd[i * 3] = frame.forward.x;
    fwd[i * 3 + 1] = frame.forward.y;
    fwd[i * 3 + 2] = frame.forward.z;
    rgt[i * 3] = frame.right.x;
    rgt[i * 3 + 1] = frame.right.y;
    rgt[i * 3 + 2] = frame.right.z;
    up[i * 3] = frame.up.x;
    up[i * 3 + 1] = frame.up.y;
    up[i * 3 + 2] = frame.up.z;
    halfWidth[i] = frame.halfWidth;
  }

  const tmpR = new THREE.Vector3();
  const tmpU = new THREE.Vector3();

  /** True where the surface under a lateral offset is worth driving on. */
  const fast = (i: number, lateral: number): boolean => {
    probe
      .set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
      .addScaledVector(tmpR.set(rgt[i * 3], rgt[i * 3 + 1], rgt[i * 3 + 2]), lateral)
      .addScaledVector(tmpU.set(up[i * 3], up[i * 3 + 1], up[i * 3 + 2]), 0.6);
    track.surfaceAt(probe, i / count, sample);
    if (!sample.onTrack) return false;
    const props = SURFACES[sample.kind];
    return !!props && !props.lethal && props.speed >= 0.9;
  };

  const step = coarse ? 1.1 : 0.9;

  for (let i = 0; i < count; i++) {
    const hw = halfWidth[i];
    // Falling off a banked wall is unrecoverable in a way that running wide on
    // flat tarmac is not, so the margin grows as the road tips away from level.
    // On the Cliffside Plating that is worth an extra metre and a bit, and it is
    // the difference between a spectacular anti-gravity section and three karts
    // in the bay every lap.
    const tilt = 1 - Math.abs(up[i * 3 + 1]);
    const margin = EDGE_MARGIN + 1.3 * tilt * tilt;
    // The jump's air segment has no surface at all. Trust the authored width
    // there rather than collapsing the corridor to nothing and steering the
    // whole field into the void.
    if (!fast(i, 0)) {
      gap[i] = 1;
      corridorL[i] = -Math.max(0.5, hw - margin);
      corridorR[i] = Math.max(0.5, hw - margin);
      continue;
    }
    for (const side of [1, -1] as const) {
      let edge = hw;
      if (fast(i, side * hw)) {
        // Room to spare: the bowl's quarter-pipe and the wide aprons live here.
        // Capped as a fraction of the road's own width, because a probe that
        // walks five metres up a quarter-pipe has found somewhere the line has
        // no business being.
        const reach = Math.min(OUTWARD_REACH, hw * 0.35);
        for (let l = hw + step; l <= hw + reach; l += step) {
          if (!fast(i, side * l)) break;
          edge = l;
        }
      } else {
        for (let l = hw - step; l > 0.5; l -= step) {
          if (fast(i, side * l)) {
            edge = l;
            break;
          }
          edge = l;
        }
      }
      const usable = Math.max(0.5, edge - margin);
      if (side > 0) corridorR[i] = usable;
      else corridorL[i] = -usable;
    }

    // Boost panels, found the same way — the AI aims for them without ever
    // being told where the course author put them.
    let padSum = 0;
    let padHits = 0;
    const lo = corridorL[i];
    const hi = corridorR[i];
    const lanes = coarse ? 7 : 11;
    for (let k = 0; k < lanes; k++) {
      const lat = lo + ((hi - lo) * k) / (lanes - 1);
      probe
        .set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
        .addScaledVector(tmpR.set(rgt[i * 3], rgt[i * 3 + 1], rgt[i * 3 + 2]), lat)
        .addScaledVector(tmpU.set(up[i * 3], up[i * 3 + 1], up[i * 3 + 2]), 0.6);
      track.surfaceAt(probe, i / count, sample);
      if (sample.kind === "boost") {
        padSum += lat;
        padHits++;
      }
    }
    if (padHits > 0) padLat[i] = padSum / padHits;
  }

  // -------------------------------------------------------------------------
  // 2. Seed, then relax to minimum curvature inside the corridor
  // -------------------------------------------------------------------------
  {
    // Seed from centreline curvature so the relaxation starts on the correct
    // side of every corner. Left to itself from zero it would still converge,
    // just slower and with a chance of settling in the wrong basin through a
    // chicane where both sides are equally short.
    let peak = 1e-4;
    const raw = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const p = (i - 1 + count) % count;
      const n = (i + 1) % count;
      // Curvature of the centreline, measured against the horizontal right so
      // that banking does not masquerade as a corner.
      const dx = fwd[n * 3] - fwd[p * 3];
      const dz = fwd[n * 3 + 2] - fwd[p * 3 + 2];
      const hx = -fwd[i * 3 + 2];
      const hz = fwd[i * 3];
      const hl = Math.hypot(hx, hz) || 1e-6;
      raw[i] = (dx * hx + dz * hz) / (hl * 2 * ds);
      peak = Math.max(peak, Math.abs(raw[i]));
    }
    for (let i = 0; i < count; i++) {
      const bias = clamp(raw[i] / peak, -1, 1);
      off[i] = clamp(bias * (bias > 0 ? corridorR[i] : -corridorL[i]) * 0.85, corridorL[i], corridorR[i]);
    }
  }

  {
    /**
     * The solve.
     *
     * Energy is `W_LEN·∑|ΔP|² + ∑|Δ²P|²` — a little bit of "be short" against a
     * lot of "do not bend". Length alone gives the shortest path, which cuts
     * every corner to the inside kerb and has a *corner* at each tangent point;
     * curvature alone gives a beautiful line that is longer than it needs to
     * be. The mixture is the racing line, and its stationary point is the
     * five-point stencil solved below.
     *
     * It is solved with a multigrid V-down rather than plain relaxation,
     * because plain relaxation is a diffusion and diffusion is hopeless here: a
     * hundred-metre corner is fifty stations long, and Jacobi needs the square
     * of that in iterations to tell one end about the other. Solving on every
     * sixteenth station first, interpolating, and refining converges the whole
     * lap in a few milliseconds — and it is the difference between a line that
     * genuinely runs out to the kerb on exit and one that hugs the middle.
     */
    const W_LEN = 0.35;
    const DENOM = 2 * W_LEN + 6;

    const px = (i: number) => pos[i * 3] + off[i] * rgt[i * 3];
    const py = (i: number) => pos[i * 3 + 1] + off[i] * rgt[i * 3 + 1];
    const pz = (i: number) => pos[i * 3 + 2] + off[i] * rgt[i * 3 + 2];

    const relaxLevel = (stride: number, sweeps: number): void => {
      const nodes = count / stride;
      if (nodes < 5) return;
      for (let it = 0; it < sweeps; it++) {
        // Gauss-Seidel, alternating direction. In-place updates carry
        // information the whole way round the lap in a single sweep, and
        // alternating stops the solution from leaning downstream.
        const back = (it & 1) === 1;
        for (let m = 0; m < nodes; m++) {
          const j = back ? nodes - 1 - m : m;
          const i = j * stride;
          const a1 = ((j - 1 + nodes) % nodes) * stride;
          const b1 = ((j + 1) % nodes) * stride;
          const a2 = ((j - 2 + nodes) % nodes) * stride;
          const b2 = ((j + 2) % nodes) * stride;
          const near = 4 + W_LEN;
          const tx = (near * (px(a1) + px(b1)) - (px(a2) + px(b2))) / DENOM;
          const ty = (near * (py(a1) + py(b1)) - (py(a2) + py(b2))) / DENOM;
          const tz = (near * (pz(a1) + pz(b1)) - (pz(a2) + pz(b2))) / DENOM;
          // Project the target back onto this station's lateral axis: the whole
          // solve stays one-dimensional, which is what makes it cheap and what
          // guarantees the line can never leave the road.
          const d =
            (tx - pos[i * 3]) * rgt[i * 3] +
            (ty - pos[i * 3 + 1]) * rgt[i * 3 + 1] +
            (tz - pos[i * 3 + 2]) * rgt[i * 3 + 2];
          off[i] = clamp(d, corridorL[i], corridorR[i]);
        }
      }
    };

    /** Carry a coarse level's answer down onto every station between its nodes. */
    const refine = (stride: number): void => {
      const nodes = count / stride;
      for (let j = 0; j < nodes; j++) {
        const a = j * stride;
        const b = ((j + 1) % nodes) * stride;
        for (let k = 1; k < stride; k++) {
          const i = a + k;
          const w = k / stride;
          off[i] = clamp(off[a] * (1 - w) + off[b] * w, corridorL[i], corridorR[i]);
        }
      }
    };

    // Sweeps per level, coarse to fine. The coarse grids carry the long
    // wavelengths — which corner cuts which way over a hundred metres — and the
    // fine ones only have to tidy up behind them, so spending the iteration
    // budget at the top is both faster and better converged.
    const schedule = coarse ? [110, 90, 70, 45, 30] : [240, 200, 160, 100, 60];
    const strides = [16, 8, 4, 2, 1];
    for (let level = 0; level < strides.length; level++) {
      relaxLevel(strides[level], schedule[level]);
      if (strides[level] > 1) refine(strides[level]);
    }
  }

  // -------------------------------------------------------------------------
  // 3. Late apex, then a final tidy
  // -------------------------------------------------------------------------
  {
    const shift = Math.max(1, Math.round(4.5 / ds));
    const src = off.slice();
    let peak = 1e-4;
    const bend = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const p = (i - 1 + count) % count;
      const n = (i + 1) % count;
      bend[i] = Math.abs(src[n] - 2 * src[i] + src[p]);
      peak = Math.max(peak, bend[i]);
    }
    for (let i = 0; i < count; i++) {
      // Taking the value from *behind* moves the apex forward in time, which is
      // the late apex. Only where the line is actually bending — a straight
      // shifted against itself is a no-op, but doing it anyway would smear the
      // corner entries.
      const w = 0.42 * clamp(bend[i] / peak, 0, 1);
      off[i] = clamp(src[i] + (src[(i - shift + count) % count] - src[i]) * w, corridorL[i], corridorR[i]);
    }
  }

  {
    const radius = Math.max(1, Math.round(5 / ds));
    const src = off.slice();
    for (let i = 0; i < count; i++) {
      let acc = 0;
      let w = 0;
      for (let k = -radius; k <= radius; k++) {
        const weight = 1 - Math.abs(k) / (radius + 1);
        acc += src[(i + k + count * 2) % count] * weight;
        w += weight;
      }
      off[i] = clamp(acc / w, corridorL[i], corridorR[i]);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Curvature of the line, and the speed profile
  // -------------------------------------------------------------------------
  const lineSeg = new Float32Array(count); // metres from station i to i+1 along the line
  {
    const px = (i: number) => pos[i * 3] + off[i] * rgt[i * 3];
    const py = (i: number) => pos[i * 3 + 1] + off[i] * rgt[i * 3 + 1];
    const pz = (i: number) => pos[i * 3 + 2] + off[i] * rgt[i * 3 + 2];

    for (let i = 0; i < count; i++) {
      const n = (i + 1) % count;
      lineSeg[i] = Math.max(0.05, Math.hypot(px(n) - px(i), py(n) - py(i), pz(n) - pz(i)));
    }

    for (let i = 0; i < count; i++) {
      const p = (i - 1 + count) % count;
      const n = (i + 1) % count;
      // Menger curvature of the three points: 4·area / (a·b·c). Stable where a
      // second-difference estimate would blow up on unevenly spaced samples,
      // which the line very much is once it has been pulled to the inside.
      const ax = px(i) - px(p);
      const ay = py(i) - py(p);
      const az = pz(i) - pz(p);
      const bx = px(n) - px(i);
      const by = py(n) - py(i);
      const bz = pz(n) - pz(i);
      const cx = ay * bz - az * by;
      const cy = az * bx - ax * bz;
      const cz = ax * by - ay * bx;
      const la = Math.hypot(ax, ay, az);
      const lb = Math.hypot(bx, by, bz);
      const lc = Math.hypot(px(n) - px(p), py(n) - py(p), pz(n) - pz(p));
      // Only the component of the bend about the *road normal* counts. The rest
      // is the course going up and down, and a crest is not a corner: taking the
      // magnitude here makes the planner brake for the ramp at Bluff Jump, which
      // means the field arrives at 17 m/s and lands in the gap. Ask any of them.
      // Signed so that positive is a right-hander, as everywhere else in the game.
      const about = -(cx * up[i * 3] + cy * up[i * 3 + 1] + cz * up[i * 3 + 2]);
      curvature[i] = (2 * about) / Math.max(1e-6, la * lb * lc);
    }
  }

  {
    // A driver does not react to the curvature under the front axle, they react
    // to the shape of the corner. Twenty metres of forward-weighted average is
    // what turns a noisy per-station number into "this is a right-hander".
    const radius = Math.max(1, Math.round(7 / ds));
    for (let i = 0; i < count; i++) {
      let acc = 0;
      let w = 0;
      for (let k = -radius; k <= radius; k++) {
        const weight = 1 - Math.abs(k) / (radius + 1);
        acc += curvature[(i + k + count * 2) % count] * weight;
        w += weight;
      }
      corner[i] = acc / w;
    }
  }

  {
    const ceiling = TUNING.topSpeed * 1.35;
    // Plan against a lightly filtered curvature, and never against more than
    // `PLAN_MAX_CURVATURE`. A single noisy station reporting a four-metre radius
    // would otherwise put a hard braking point in the middle of a corner and
    // the whole field would stand on the brakes for one frame, every lap.
    for (let i = 0; i < count; i++) {
      const p1 = (i - 1 + count) % count;
      const n1 = (i + 1) % count;
      const p2 = (i - 2 + count) % count;
      const n2 = (i + 2) % count;
      const smoothed =
        (curvature[p2] + 2 * curvature[p1] + 3 * curvature[i] + 2 * curvature[n1] + curvature[n2]) / 9;
      const k = Math.min(PLAN_MAX_CURVATURE, Math.max(Math.abs(smoothed), Math.abs(corner[i]) * 0.85));
      speed[i] = k > 1e-4 ? Math.min(ceiling, Math.sqrt(PLAN_LAT_ACCEL / k)) : ceiling;
    }
    // Backward pass: braking distance. Two laps of it, because the profile has
    // to be consistent across the start/finish seam and one pass only carries
    // information as far as the wrap.
    for (let pass = 0; pass < 2; pass++) {
      for (let n = 0; n < count; n++) {
        const i = (count - 1 - n + count) % count;
        const j = (i + 1) % count;
        const limit = Math.sqrt(speed[j] * speed[j] + 2 * PLAN_BRAKE * lineSeg[i]);
        if (limit < speed[i]) speed[i] = limit;
      }
    }
    // Forward pass: you cannot arrive faster than you could have accelerated.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < count; i++) {
        const p = (i - 1 + count) % count;
        const limit = Math.sqrt(speed[p] * speed[p] + 2 * PLAN_ACCEL * lineSeg[p]);
        if (limit < speed[i]) speed[i] = limit;
      }
    }

    // A gap has a minimum entry speed, and it is not negotiable. The run-up to
    // the Bluff Jump is stamped with a floor *after* the braking pass, so no
    // amount of caution, rubber banding or cc class can talk a rival into
    // arriving at the kicker too slowly to reach the other side. Landing in the
    // ravine every lap is not a difficulty setting.
    const runup = Math.max(1, Math.round(JUMP_RUNUP / ds));
    for (let i = 0; i < count; i++) {
      if (!gap[i]) continue;
      for (let k = -runup; k <= 2; k++) {
        const j = (i + k + count * 2) % count;
        floor[j] = TUNING.topSpeed;
        if (speed[j] < TUNING.topSpeed) speed[j] = TUNING.topSpeed;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. The dirt cut, if the course published one
  // -------------------------------------------------------------------------
  let shortcut: ShortcutRoute | null = null;
  {
    const extra = track as TrackService & TrackExtras;
    let path: THREE.Vector3[] | null = null;
    try {
      path = typeof extra.shortcutPath === "function" ? extra.shortcutPath() : null;
    } catch {
      path = null;
    }
    if (path && path.length >= 4) {
      const n = path.length;
      const sp = new Float32Array(n * 3);
      const cum = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        sp[i * 3] = path[i].x;
        sp[i * 3 + 1] = path[i].y;
        sp[i * 3 + 2] = path[i].z;
        if (i > 0) cum[i] = cum[i - 1] + path[i].distanceTo(path[i - 1]);
      }
      const entryT = track.project(path[0]).t;
      const exitT = track.project(path[n - 1]).t;
      let mainLength = (wrap01(exitT - entryT) || 0) * length;
      if (mainLength < 1) mainLength = length;
      const routeLen = cum[n - 1];
      // Worth it only in seconds, not metres: the cut is loose dirt, and the
      // physics charges roughly SURFACES.dirt.speed for driving on it.
      const vRoad = TUNING.topSpeed * 0.92;
      const vDirt = TUNING.topSpeed * SURFACES.dirt.speed;
      const vBoost = TUNING.topSpeed * Math.min(1, SURFACES.dirt.speed * TUNING.boostSpeedMul);
      shortcut = {
        pos: sp,
        count: n,
        cum,
        length: routeLen,
        entryT,
        exitT,
        mainLength,
        gain: mainLength / vRoad - routeLen / vDirt,
        gainBoosted: mainLength / vRoad - routeLen / vBoost,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Readers
  // -------------------------------------------------------------------------
  const indexAt = (s: number): number => {
    let x = s % length;
    if (x < 0) x += length;
    return x / ds;
  };

  const sampleArray = (arr: Float32Array, s: number): number => {
    const idx = indexAt(s);
    const i0 = Math.floor(idx) % count;
    const i1 = (i0 + 1) % count;
    const w = idx - Math.floor(idx);
    return arr[i0] + (arr[i1] - arr[i0]) * w;
  };

  const scratchR = new THREE.Vector3();
  const scratchU = new THREE.Vector3();

  const line: RacingLine = {
    count,
    ds,
    length,
    pos,
    fwd,
    rgt,
    up,
    off,
    corridorL,
    corridorR,
    curvature,
    corner,
    speed,
    floor,
    padLat,
    shortcut,

    sAt: (t) => wrap01(t) * length,
    indexAt,
    offsetAt: (s) => sampleArray(off, s),
    speedAt: (s) => sampleArray(speed, s),
    floorAt: (s) => sampleArray(floor, s),
    cornerAt: (s) => sampleArray(corner, s),

    corridorAt(s, out) {
      out.min = sampleArray(corridorL, s);
      out.max = sampleArray(corridorR, s);
      return out;
    },

    point(s, lateral, lift, out) {
      const idx = indexAt(s);
      const i0 = Math.floor(idx) % count;
      const i1 = (i0 + 1) % count;
      const w = idx - Math.floor(idx);
      const iw = 1 - w;
      out.set(
        pos[i0 * 3] * iw + pos[i1 * 3] * w,
        pos[i0 * 3 + 1] * iw + pos[i1 * 3 + 1] * w,
        pos[i0 * 3 + 2] * iw + pos[i1 * 3 + 2] * w,
      );
      scratchR
        .set(
          rgt[i0 * 3] * iw + rgt[i1 * 3] * w,
          rgt[i0 * 3 + 1] * iw + rgt[i1 * 3 + 1] * w,
          rgt[i0 * 3 + 2] * iw + rgt[i1 * 3 + 2] * w,
        )
        .normalize();
      out.addScaledVector(scratchR, lateral);
      if (lift !== 0) {
        scratchU
          .set(
            up[i0 * 3] * iw + up[i1 * 3] * w,
            up[i0 * 3 + 1] * iw + up[i1 * 3 + 1] * w,
            up[i0 * 3 + 2] * iw + up[i1 * 3 + 2] * w,
          )
          .normalize();
        out.addScaledVector(scratchU, lift);
      }
      return out;
    },

    normal(s, out) {
      const idx = indexAt(s);
      const i0 = Math.floor(idx) % count;
      const i1 = (i0 + 1) % count;
      const w = idx - Math.floor(idx);
      const iw = 1 - w;
      return out
        .set(
          up[i0 * 3] * iw + up[i1 * 3] * w,
          up[i0 * 3 + 1] * iw + up[i1 * 3 + 1] * w,
          up[i0 * 3 + 2] * iw + up[i1 * 3 + 2] * w,
        )
        .normalize();
    },

    padAhead(s, range) {
      const first = Math.floor(indexAt(s));
      const span = Math.ceil(range / ds);
      for (let k = 1; k <= span; k++) {
        const i = (first + k) % count;
        if (!Number.isNaN(padLat[i])) return { s: i * ds, lateral: padLat[i] };
      }
      return null;
    },
  };

  return line;
}
