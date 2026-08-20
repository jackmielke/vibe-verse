/**
 * THE EMPYREAN — the launch site.
 *
 * Two kilometres out on the snow, in the mouth of a valley in the western
 * range, there is a spaceport: a graded apron, a launch mount, a catch tower,
 * a tank farm, a build bay, roads, and a two-stage vehicle standing on the
 * pad. Every seven minutes it flies.
 *
 * ## What this is for
 *
 * The island is the thing you look *at*. This is the thing you look *out at*,
 * and the difference is the whole reason it is two kilometres away and 420 m
 * below the plaza: it gives the eye somewhere to go from the rim that is not
 * the mountains, and it gives the world a clock. A city that never does
 * anything on its own is a diorama with a person walking around in it.
 *
 * It is therefore built as a **silhouette and a light**, not as a model:
 *
 *  - The apron is a dark oval on a white plain. At this distance that is the
 *    single most legible thing here — you see *the site* long before you can
 *    resolve anything standing on it, and without it the vehicle is a
 *    two-pixel white hair against white snow.
 *  - The vehicle is 120 m on a 20 m mount and it is *not* scaled up. At 2.2 km
 *    that is a shade under four degrees, which is fifty-odd pixels of dark
 *    needle — small, and correctly small. An over-scale rocket next to a 680 m
 *    city destroys the sense of distance the whole island depends on, and the
 *    temptation to fix legibility with scale is exactly the trap. It is fixed
 *    with contrast instead.
 *  - The launch is fire and steam. A plume that lights the snow under it, a
 *    glow that is visible from anywhere on the island, and a smoke column that
 *    stands there for two minutes afterwards.
 *
 * ## The cycle is a pure function of time
 *
 * `stateAt(time)` is total, allocation-free and has no history in it, exactly
 * like `weather.ts`'s slot cycle: a test can ask what the pad is doing an hour
 * from now without simulating an hour, and two machines watching the same
 * world watch the same launch. Everything that moves — the vehicle, the arms,
 * the plume, the steam, the smoke column — is evaluated from `t` alone, so
 * there is no state to get out of step and nothing to resynchronise when the
 * system is culled for four minutes and comes back.
 *
 * The one thing this file deliberately does **not** do is make a sound. The
 * sound of a launch 2.2 km away arrives six and a half seconds after the
 * light, which is one of the best things about watching one, and it belongs to
 * `audio.ts`. What is exposed instead is `phase`, `t`, `thrust`, the vehicle's
 * world position and `soundDelayFrom(x, y, z)` — enough for audio and a HUD
 * countdown to be wired to it from outside without this system importing
 * either.
 *
 * ## Costs
 *
 * | when | draws |
 * | --- | --- |
 * | quiet (most of the time) | 7 |
 * | flying | 11 |
 * | off screen | 0 — the group is hidden, and `update` returns immediately |
 *
 * Everything static is one merged mesh with one material: apron, trench,
 * mount, tower, tanks, build bay, roads, stand. The rest is what has to move.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { BuildContext, FrameContext, System } from "./types";
import { GROUND_Y, ISLAND_Y, LAKE_R } from "./config";
import { clamp, clamp01, fbm2, makeRng, ridged2, smoothstep } from "@/shared/proc/rng";

/* =========================================================================
 * Where the ground is
 *
 * `terrain.ts` owns the snow and exports the very function this needs — and a
 * system may not import another system, so it is re-derived here instead,
 * character for character. That is a copy, and copies drift, so
 * `empyreanLaunch.test.ts` imports *both* and asserts they agree over a grid
 * covering the site. The test may cross the line this file may not.
 * ====================================================================== */

const RANGE_INNER = LAKE_R * 1.3;
const RANGE_OUTER = 7800;

/** `terrain.ts`'s `groundHeight`, re-derived. Keep the two identical. */
export function snowHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r < LAKE_R) return GROUND_Y;
  const drift = fbm2(x * 0.0011, z * 0.0011, 4, 2, 0.5, 7) * 20;
  const t = (r - RANGE_INNER) / (RANGE_OUTER - RANGE_INNER);
  if (t <= 0 || t >= 1) {
    return GROUND_Y + drift * Math.min(1, Math.max(0, (r - LAKE_R) / 360));
  }
  const band = Math.sin(Math.PI * Math.min(1, t * 2.2)) ** 0.7;
  const ridge = ridged2(x * 0.00048, z * 0.00048, 4, 31);
  const teeth = ridged2(x * 0.0028, z * 0.0028, 3, 91);
  const h = (ridge ** 2.6 * 0.62 + teeth ** 1.9 * 0.72) * 560 * band;
  const CEIL = ISLAND_Y * 0.84;
  const raw = h + drift;
  const capped = raw < CEIL * 0.7 ? raw : CEIL - (CEIL * 0.3 * CEIL * 0.3) / (raw - CEIL * 0.4);
  return GROUND_Y + capped;
}

/* =========================================================================
 * Where the site is
 *
 * Chosen by scanning the height function, not by taste, and the scan settled
 * an argument. The obvious answer was three kilometres out, for the sake of
 * the nine-second sound delay — but the snow is only *flat* from the lake
 * shore to about 1900 m. `RANGE_INNER` is at 1950 and the range comes up fast
 * behind it: by 2.2 km there is nowhere within a kilometre level to better
 * than forty metres, and past 2.5 km the ground is a plateau at 430–460 m,
 * where a 130 m tower would stand level with the city deck — the one thing
 * the ranges are capped to prevent.
 *
 * A pad was built out there and photographed. Forty metres of relief under a
 * 180 m apron means an earthwork, and an earthwork on a hillside whose ground
 * keeps falling away for another two hundred metres reads, from the deck, as a
 * second floating slab — in a world whose entire subject is a floating slab.
 * Distance was the wrong thing to spend the picture on.
 *
 * So it is out on the plain at 1.87 km, on bearing 244°, where the ground runs
 * 0.5–3.8 m across the whole apron and the apron can be what it should be: a
 * dark oval lying flat on white snow, which at this range is the most legible
 * thing here by a distance. You see *the site* long before you can resolve
 * anything standing on it.
 *
 * Two things came free with that spot. The range wall climbs to 265 m within
 * four hundred metres behind it, which is the backdrop the vehicle is read
 * against instead of the sky. And 244° is forty-five degrees off the sunset
 * bearing, which is three-quarter backlight: the stack gets a gold edge and a
 * dark side rather than being a white needle on a white plain. Straight into
 * the sun was tried too, and the sun wins.
 *
 * The sound still takes five and a half seconds to arrive, which is late
 * enough to be the thing it is there for. Moving the site further out is two
 * numbers; the paragraphs above are what it would cost.
 * ====================================================================== */
export const SITE_X = -820;
export const SITE_Z = -1680;

/** Half-extents of the graded apron, in site-local metres. */
export const APRON_X = 92;
export const APRON_Z = 66;

/** Height of the launch mount's deck above the apron. */
export const MOUNT_TOP = 20;

/** Where the tower stands, relative to the mount. */
const TOWER_X = -38;
const TOWER_H = 132;

/** The vehicle. Two stages, nine metres across, 120 m stacked. */
const BOOSTER_H = 70;
const SHIP_H = 50;
const RAD = 4.5;
/** How far up the booster the catch pins are. */
const CATCH_PIN = 62;

/**
 * Where the arms park the incoming booster, above the mount deck.
 *
 * Ten metres of air under it, so the catch is visibly a catch and the descent
 * visibly stops short of the pad rather than landing on it.
 */
const CATCH_CLEAR = 10;

/**
 * Yaw of the arms when they swing round to the ship stand, radians.
 *
 * Well past ninety degrees, so that from the island the waiting upper stage
 * stands clear of the tower rather than in front of it. At -80° the two
 * overlapped from every angle anybody looks at this from.
 */
const STAND_YAW = -1.92;
/** Height of the stand's cradle. */
const STAND_H = 6;

/* Carriage heights, above the apron. Every one of them is a boundary value
 * shared by two branches of the arm animation. */
/** Where the arms sit when there is nothing to do. */
const ARM_PARK = 100;
/** Where they take the weight of a returning booster. */
const ARM_CATCH = 92;
/** Where they grip an upper stage standing on its cradle. */
const ARM_STAND = 22;
/** Where they hold it to mate it: sixteen metres up a stage on a 70 m booster. */
const ARM_MATE = MOUNT_TOP + BOOSTER_H + 16;
/** Open, and closed around a nine-metre vehicle. */
const ARM_OPEN = 0.85;
const ARM_SHUT = 0.06;

const _standDir = { x: Math.cos(STAND_YAW), z: -Math.sin(STAND_YAW) };
const STAND_X = TOWER_X - TOWER_X * _standDir.x;
const STAND_Z = -TOWER_X * _standDir.z;

/**
 * Downrange bearing, in site-local metres.
 *
 * Away from the island, and a little across it. Straight away foreshortens the
 * pitch-over to nothing from the only place anybody is watching from; straight
 * across would fly it over the city, which is both wrong and the thing the
 * trajectory test exists to catch.
 */
const DOWN_X = 0.42;
const DOWN_Z = -0.91;

/* =========================================================================
 * The cycle
 * ====================================================================== */

/** Seconds from one ignition to the next. Seven minutes. */
export const CYCLE = 420;

/** Where T-0 sits inside the cycle. */
const IGNITION_AT = 258;

/**
 * Phase offset at world time zero.
 *
 * Set so the first ignition is 75 seconds after the world boots: long enough
 * that the pad is a thing you notice sitting there first, short enough that
 * somebody who opened the link to show it to somebody else gets a launch.
 */
const START_OFFSET = IGNITION_AT - 75;

/**
 * The wrap point for `t`.
 *
 * `t` is signed seconds around ignition and the cycle has to be cut somewhere;
 * cutting it at T+210 puts the seam in the middle of the long quiet stretch,
 * where nothing is looking at it, rather than inside the countdown.
 */
const T_WRAP = 210;

export type LaunchPhase =
  | "quiet"
  | "prep"
  | "ignition"
  | "ascent"
  | "staging"
  | "return"
  | "catch"
  | "stack";

/** Everything about the launch at one instant. Reused; never allocated per frame. */
export interface LaunchSnapshot {
  phase: LaunchPhase;
  /** Signed seconds around ignition. Negative counts down to T-0. */
  t: number;
  /** Seconds until the next ignition. Always ≥ 0, always continuous. */
  countdown: number;
  /** 0..1 through the whole cycle. */
  cycle: number;
  /** 0..1 booster throttle. What a rumble should be scaled by. */
  thrust: number;
  /**
   * 0..1 upper-stage throttle, which is a different, thinner sound and is
   * fifteen kilometres away by the time it is doing anything.
   */
  shipThrust: number;
  /** True while anything is off the pad. */
  flying: boolean;
  /** Metres above the launch mount's deck. */
  altitude: number;
  /** Metres downrange of the pad. */
  downrange: number;
  /** World position of the vehicle — the booster, once it has staged. */
  x: number;
  y: number;
  z: number;
}

function emptySnapshot(): LaunchSnapshot {
  return {
    phase: "quiet",
    t: 0,
    countdown: 0,
    cycle: 0,
    thrust: 0,
    shipThrust: 0,
    flying: false,
    altitude: 0,
    downrange: 0,
    x: 0,
    y: 0,
    z: 0,
  };
}

/**
 * The flight, as a table.
 *
 * Rows are `[t, altitude above the mount deck, downrange]`. A power curve
 * would do for the ascent and nothing analytic does for the rest of it —
 * boostback, coast, the turn, the landing burn and being set down on the mount
 * are five different regimes that have to end at exactly the right place at
 * exactly the right second — so the whole flight is keyframed and interpolated
 * with a non-uniform Catmull-Rom. That also makes "does it ever come back"
 * something a test can read off the table.
 *
 * The numbers are cinematic, not orbital: 4 km at staging rather than 60, so
 * that the thing you are watching is still a *shape* in the sky when it lets
 * go of the booster rather than a dot that left thirty seconds ago.
 */
const FLIGHT: ReadonlyArray<readonly [number, number, number]> = [
  [-6, 0, 0],
  [0, 0, 0],
  [4, 22, 0],
  [8, 140, 3],
  [12, 360, 18],
  [16, 690, 55],
  [20, 1140, 130],
  [24, 1740, 260],
  [28, 2500, 450],
  [32, 3480, 740],
  [34, 4050, 920],
  [40, 5200, 1600],
  [46, 6000, 2300],
  [54, 6500, 3100],
  [62, 6300, 3500],
  [72, 5300, 3400],
  [82, 3900, 2800],
  [92, 2400, 1800],
  [98, 1300, 900],
  [103, 620, 340],
  [106, 260, 130],
  [108, 90, 40],
  [110, CATCH_CLEAR, 0],
  [114, CATCH_CLEAR, 0],
  [122, 0, 0],
  [168, 0, 0],
];

/** The upper stage after it lets go. Accelerating away, and gone by T+58. */
const SHIP_FLIGHT: ReadonlyArray<readonly [number, number, number]> = [
  [32, 3480, 740],
  [34, 4050, 920],
  [40, 6100, 1900],
  [48, 9500, 3600],
  [56, 14000, 6000],
  [64, 20000, 9200],
  [72, 27000, 13000],
];

/**
 * Monotone cubic interpolation through a keyframe table, one column at a time.
 *
 * Fritsch–Carlson, not Catmull-Rom, and the difference is not a nicety.
 * Catmull-Rom takes its tangent from the neighbouring keys, so a segment that
 * is *flat* between two keys after a steep one overshoots wildly through it —
 * and this table has exactly that shape at the catch, where the booster hangs
 * at ten metres for four seconds at the end of a hundred-metre-a-second
 * descent. The first version dipped it to zero and back in between: seventy
 * metres of booster swung through the launch mount, twice, every cycle.
 *
 * Limiting the tangents to the neighbouring secants costs nothing anywhere
 * else — the ascent is monotone and reads identically — and makes "the curve
 * stays between its keyframes" a property of the interpolator rather than
 * something to be checked by eye.
 */
function sampleTable(
  table: ReadonlyArray<readonly [number, number, number]>,
  col: 1 | 2,
  t: number,
): number {
  const n = table.length;
  if (t <= table[0][0]) return table[0][col];
  if (t >= table[n - 1][0]) return table[n - 1][col];
  let i = 0;
  while (i < n - 2 && table[i + 1][0] <= t) i++;
  const t0 = table[i][0];
  const t1 = table[i + 1][0];
  const p0 = table[i][col];
  const p1 = table[i + 1][col];
  const h = t1 - t0;
  const d = (p1 - p0) / h;
  const m0 = slopeAt(table, col, i, d, h);
  const m1 = slopeAt(table, col, i + 1, d, h);
  const s = (t - t0) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  return (
    (2 * s3 - 3 * s2 + 1) * p0 +
    (s3 - 2 * s2 + s) * m0 * h +
    (-2 * s3 + 3 * s2) * p1 +
    (s3 - s2) * m1 * h
  );
}

/** The limited tangent at key `i`, given the secant of the segment being drawn. */
function slopeAt(
  table: ReadonlyArray<readonly [number, number, number]>,
  col: 1 | 2,
  i: number,
  seg: number,
  segH: number,
): number {
  const n = table.length;
  if (i === 0 || i === n - 1) return seg;
  const hPrev = table[i][0] - table[i - 1][0];
  const hNext = table[i + 1][0] - table[i][0];
  const dPrev = (table[i][col] - table[i - 1][col]) / hPrev;
  const dNext = (table[i + 1][col] - table[i][col]) / hNext;
  // A turning point, or a flat: the curve is level here and may not bulge past
  // the keys on either side of it.
  if (dPrev * dNext <= 0) return 0;
  const w1 = 2 * hNext + hPrev;
  const w2 = hNext + 2 * hPrev;
  void segH;
  return (w1 + w2) / (w1 / dPrev + w2 / dNext);
}

/** Phase boundaries, in `t`. */
const T_PREP = -44;
const T_IGNITE = -6;
const T_LIFT = 0;
const T_STAGE = 34;
const T_COAST = 44;
const T_CATCH = 106;
const T_STACK = 128;
const T_DONE = 168;

function phaseAt(t: number): LaunchPhase {
  if (t < T_PREP) return "quiet";
  if (t < T_IGNITE) return "prep";
  if (t < T_LIFT) return "ignition";
  if (t < T_STAGE) return "ascent";
  if (t < T_COAST) return "staging";
  if (t < T_CATCH) return "return";
  if (t < T_STACK) return "catch";
  if (t < T_DONE) return "stack";
  return "quiet";
}

/**
 * Main-engine throttle at `t`.
 *
 * Four burns: the hold-down ramp, the ascent, the boostback, and the landing
 * burn. Everything between them is zero, which matters more than the shape of
 * any of them — this number is what a sound is scaled by, and a rumble that
 * never quite stops is a rumble nobody believes.
 */
function thrustAt(t: number): number {
  if (t >= T_IGNITE && t < T_STAGE) {
    // Up through the hold-down, full through the climb, throttled at max-Q.
    const start = smoothstep(T_IGNITE, T_IGNITE + 3.2, t);
    const q = 1 - 0.22 * Math.exp(-(((t - 14) / 7) ** 2));
    return start * q;
  }
  if (t >= T_STAGE && t < T_STAGE + 1.6) return 1 - smoothstep(T_STAGE, T_STAGE + 1.6, t);
  // Boostback.
  if (t >= 46 && t < 56) return 0.5 * Math.sin(Math.PI * clamp01((t - 46) / 10)) ** 0.5;
  // Landing burn, hard and short.
  if (t >= 96 && t < 111) {
    return 0.35 + 0.6 * Math.sin(Math.PI * clamp01((t - 96) / 15)) ** 0.7;
  }
  return 0;
}

/** The upper stage's own engines, after separation. */
function shipThrustAt(t: number): number {
  if (t < T_STAGE + 1.2 || t > 62) return 0;
  return smoothstep(T_STAGE + 1.2, T_STAGE + 3, t) * (1 - smoothstep(56, 62, t));
}

/* =========================================================================
 * Geometry plumbing
 *
 * Same shape as `props.ts`: every geometry that reaches the merge carries
 * position, normal, color and aEmis, and nothing carries a uv — `mergeGeometries`
 * refuses a set that disagrees.
 * ====================================================================== */

type Geo = THREE.BufferGeometry;

const _m4 = new THREE.Matrix4();
const _eul = new THREE.Euler();
const _axis = new THREE.Vector3();
const _stack = new THREE.Vector3();
const _white = new THREE.Color(1, 1, 1);

function tag(g: Geo, col: THREE.Color, emis = 0): Geo {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const c = new Float32Array(n * 3);
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    c[i * 3] = col.r;
    c[i * 3 + 1] = col.g;
    c[i * 3 + 2] = col.b;
    e[i] = emis;
  }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  g.setAttribute("aEmis", new THREE.BufferAttribute(e, 1));
  g.deleteAttribute("uv");
  return g;
}

function put(g: Geo, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0): Geo {
  _eul.set(rx, ry, rz, "YXZ");
  _m4.makeRotationFromEuler(_eul);
  _m4.setPosition(x, y, z);
  g.applyMatrix4(_m4);
  return g;
}

const box = (w: number, h: number, d: number): Geo => new THREE.BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, seg = 10): Geo =>
  new THREE.CylinderGeometry(rt, rb, h, seg, 1);

const PALETTE = {
  concrete: new THREE.Color("#5c6068"),
  concreteDark: new THREE.Color("#3b3f47"),
  trench: new THREE.Color("#22242a"),
  steel: new THREE.Color("#767f8c"),
  steelDark: new THREE.Color("#3f4650"),
  hull: new THREE.Color("#b7c1cd"),
  hullShade: new THREE.Color("#8e98a5"),
  tile: new THREE.Color("#191d24"),
  tank: new THREE.Color("#d8dee6"),
  road: new THREE.Color("#4a4e56"),
  roof: new THREE.Color("#6a7078"),
  glass: new THREE.Color("#ffcf92"),
  beacon: new THREE.Color("#ff5a4a"),
};

/**
 * A graded platform: a top face and a battered skirt, no bottom.
 *
 * The apron cannot be a slab at ground level — the site sits on a slope that
 * falls forty metres across its own footprint — so it is an earthwork: the
 * deck is level at the highest ground under it and the fill runs out and down
 * to well below the lowest. That is what a real pad on a hillside is, and it
 * is also the only shape that cannot poke through the snow mesh, whose
 * triangles out here are seventy metres wide and interpolate straight through
 * anything the height function does in between.
 */
function platform(pts: ReadonlyArray<readonly [number, number]>, drop: number, spread: number): Geo {
  const n = pts.length;
  const positions: number[] = [0, 0, 0];
  for (const [x, z] of pts) positions.push(x, 0, z);
  for (const [x, z] of pts) positions.push(x * spread, -drop, z * spread);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = 1 + i;
    const b = 1 + ((i + 1) % n);
    idx.push(0, b, a);
    const c = 1 + n + i;
    const d = 1 + n + ((i + 1) % n);
    idx.push(a, b, d, a, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A rounded rectangle as a ring of points, counter-clockwise in (x, z). */
function roundedRect(hx: number, hz: number, r: number, seg = 5): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  const corners: Array<[number, number, number]> = [
    [hx - r, hz - r, 0],
    [-(hx - r), hz - r, Math.PI / 2],
    [-(hx - r), -(hz - r), Math.PI],
    [hx - r, -(hz - r), -Math.PI / 2],
  ];
  for (const [cx, cz, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
  }
  return pts;
}

/**
 * A road: a ribbon of quads laid on the snow, following the ground.
 *
 * `pts` are site-local, and the height at each is looked up rather than
 * assumed, which is the whole point — a road drawn at pad level runs twenty
 * metres in the air by the time it reaches the build bay.
 */
function road(
  pts: ReadonlyArray<readonly [number, number]>,
  half: number,
  toWorld: (lx: number, lz: number, out: { x: number; z: number }) => void,
  padY: number,
): Geo {
  const positions: number[] = [];
  const idx: number[] = [];
  const w = { x: 0, z: 0 };
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i];
    const p = pts[Math.max(0, i - 1)];
    const q = pts[Math.min(pts.length - 1, i + 1)];
    let dx = q[0] - p[0];
    let dz = q[1] - p[1];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    for (const s of [-1, 1]) {
      const ox = x + -dz * half * s;
      const oz = z + dx * half * s;
      toWorld(ox, oz, w);
      positions.push(ox, snowHeight(w.x, w.z) - padY + 0.5, oz);
    }
  }
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* =========================================================================
 * The handle
 * ====================================================================== */

export interface LaunchSiteHandle extends System {
  /** World position of the launch mount's deck. */
  readonly pad: Readonly<THREE.Vector3>;
  /** Live, this frame. */
  readonly phase: LaunchPhase;
  readonly t: number;
  readonly countdown: number;
  readonly thrust: number;
  /** Metres above the mount deck. */
  readonly altitude: number;
  /** Live world position of the vehicle. Read it; do not mutate it. */
  readonly vehicle: Readonly<THREE.Vector3>;
  /** True while the site is within the camera's cone and drawing. */
  readonly onScreen: boolean;
  /**
   * The whole cycle, at any time, without simulating anything.
   * Pass `out` to avoid the allocation.
   */
  stateAt(time: number, out?: LaunchSnapshot): LaunchSnapshot;
  /** Seconds until the next ignition, from any time. */
  nextIgnition(time: number): number;
  /** How long the sound takes to get from the vehicle to a listener. */
  soundDelayFrom(x: number, y: number, z: number): number;
  /** Switch the whole thing off without tearing it down. */
  setEnabled(on: boolean): void;
}

/** Metres a second, at -20 °C over a frozen lake. */
const SPEED_OF_SOUND = 331;

/* =========================================================================
 * Build
 * ====================================================================== */

export function buildLaunchSite(ctx: BuildContext): LaunchSiteHandle {
  const low = ctx.quality === "low";
  const rng = makeRng(`empyrean-launchsite-${ctx.seedSalt}`);

  const group = new THREE.Group();
  group.name = "empyrean-launchsite";

  /* ---- the frame the whole site is built in ---------------------------- */

  /** Yaw that points site-local +Z at the island. */
  const faceYaw = Math.atan2(-SITE_X, -SITE_Z);
  const cy = Math.cos(faceYaw);
  const sy = Math.sin(faceYaw);
  const _w = { x: 0, z: 0 };
  const toWorld = (lx: number, lz: number, out: { x: number; z: number }): void => {
    out.x = SITE_X + lx * cy + lz * sy;
    out.z = SITE_Z + -lx * sy + lz * cy;
  };

  /**
   * The deck height, sampled rather than assumed.
   *
   * The maximum of the ground under the apron, not the mean: fill can be built
   * up and rock cannot be wished away, and half a metre of terrain through the
   * middle of a launch pad is the kind of thing nobody sees for a month.
   */
  let padY = -Infinity;
  for (let i = -8; i <= 8; i++) {
    for (let j = -8; j <= 8; j++) {
      toWorld((i / 8) * APRON_X, (j / 8) * APRON_Z, _w);
      padY = Math.max(padY, snowHeight(_w.x, _w.z));
    }
  }
  padY += 1.5;

  group.position.set(SITE_X, padY, SITE_Z);
  group.rotation.y = faceYaw;

  /* ---- materials ------------------------------------------------------- */

  const shared = {
    uNight: { value: 0 },
    uTime: { value: 0 },
    uSun: { value: new THREE.Vector3(0, 1, 0) },
  };

  const structureMat = new THREE.MeshStandardMaterial({
    name: "EmpyreanLaunchSteel",
    vertexColors: true,
    roughness: 0.72,
    /* Metalness stays low even though the vehicle is stainless. There is no
       environment map in this world, so a metal surface has nothing to
       reflect and renders black — a chrome rocket comes out as a hole. */
    metalness: 0.12,
    emissive: new THREE.Color(0x000000),
  });
  structureMat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = shared.uNight;
    shader.vertexShader = `attribute float aEmis;\nvarying float vEmis;\n${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n  vEmis = aEmis;",
    );
    shader.fragmentShader = `uniform float uNight;\nvarying float vEmis;\n${shader.fragmentShader}`.replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * (vEmis * uNight);",
    );
  };
  structureMat.customProgramCacheKey = () => "empyrean-launch-v1";

  /* ---- the works: one merged mesh -------------------------------------- */

  const parts: Geo[] = [];

  // The apron, and the fill it stands on.
  const apronRing = roundedRect(APRON_X, APRON_Z, 34, low ? 2 : 5);
  parts.push(tag(platform(apronRing, 34, 1.16), PALETTE.concrete));

  // The flame trench: a dark inset running away from the island, with a
  // deflector at the far end. Two walls and a floor read as a trench from two
  // kilometres; a hole cut through the apron would not read as anything more.
  parts.push(tag(put(box(26, 0.6, 96), 0, 0.12, -34), PALETTE.trench));
  for (const s of [-1, 1]) {
    parts.push(tag(put(box(2.4, 5, 96), s * 14, 2.4, -34), PALETTE.concreteDark));
  }
  parts.push(tag(put(box(26, 9, 16), 0, 4.4, -80, 0, -0.5), PALETTE.concreteDark));

  // The launch mount: an octagonal table on six legs, with the flame hole
  // under it.
  parts.push(tag(put(cyl(15, 16, 6, 8), 0, MOUNT_TOP - 3), PALETTE.steelDark));
  parts.push(tag(put(cyl(11, 11, 1.6, 8), 0, MOUNT_TOP + 0.4), PALETTE.steel));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    parts.push(
      tag(put(cyl(1.7, 2.1, MOUNT_TOP - 6, 6), Math.cos(a) * 12, (MOUNT_TOP - 6) / 2, Math.sin(a) * 12), PALETTE.steelDark),
    );
  }

  // The tower. Four columns, a band every twelve metres, one diagonal a bay.
  {
    const HW = 5.5;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        parts.push(tag(put(box(1.7, TOWER_H, 1.7), TOWER_X + sx * HW, TOWER_H / 2, sz * HW), PALETTE.steel));
      }
    }
    const bays = low ? 6 : 11;
    for (let i = 1; i <= bays; i++) {
      const y = (i / bays) * TOWER_H;
      parts.push(tag(put(box(HW * 2 + 1.7, 1.1, 1.1), TOWER_X, y, -HW), PALETTE.steelDark));
      parts.push(tag(put(box(HW * 2 + 1.7, 1.1, 1.1), TOWER_X, y, HW), PALETTE.steelDark));
      parts.push(tag(put(box(1.1, 1.1, HW * 2), TOWER_X - HW, y, 0), PALETTE.steelDark));
      parts.push(tag(put(box(1.1, 1.1, HW * 2), TOWER_X + HW, y, 0), PALETTE.steelDark));
      if (!low) {
        const h = TOWER_H / bays;
        const d = Math.hypot(HW * 2, h);
        const ang = Math.atan2(HW * 2, h) * (i % 2 ? 1 : -1);
        parts.push(tag(put(box(0.9, d, 0.9), TOWER_X, y - h / 2, HW, 0, 0, ang), PALETTE.steelDark));
        parts.push(tag(put(box(0.9, d, 0.9), TOWER_X, y - h / 2, -HW, 0, 0, -ang), PALETTE.steelDark));
      }
    }
    // Crown, mast, beacon.
    parts.push(tag(put(box(15, 4, 15), TOWER_X, TOWER_H + 2, 0), PALETTE.steelDark));
    parts.push(tag(put(cyl(0.35, 0.6, 14, 5), TOWER_X, TOWER_H + 11), PALETTE.steel));
    parts.push(tag(put(cyl(1.1, 1.1, 1.6, 6), TOWER_X, TOWER_H + 18.5), PALETTE.beacon, 3.2));
  }

  // The ship stand: a cradle the arms lift the next upper stage off.
  parts.push(tag(put(cyl(6.4, 7.4, STAND_H, 8), STAND_X, STAND_H / 2, STAND_Z), PALETTE.steelDark));
  parts.push(tag(put(cyl(5.2, 5.2, 1, 8), STAND_X, STAND_H + 0.4, STAND_Z), PALETTE.steel));

  // The tank farm: five cryo tanks and two spheres behind a berm.
  {
    const bx = 62;
    const bz = -22;
    parts.push(tag(put(box(58, 2.4, 40), bx, 1.2, bz), PALETTE.concreteDark));
    for (let i = 0; i < 5; i++) {
      const x = bx - 22 + i * 11;
      parts.push(tag(put(cyl(6, 6, 26, low ? 7 : 12), x, 15.4, bz + 6), PALETTE.tank));
      parts.push(tag(put(cyl(6.2, 5.4, 3, low ? 7 : 12), x, 29.6, bz + 6), PALETTE.steel));
    }
    for (const s of [-1, 1]) {
      parts.push(
        tag(put(new THREE.SphereGeometry(8, low ? 8 : 14, low ? 5 : 8), bx + s * 17, 11, bz - 14), PALETTE.tank),
      );
      parts.push(tag(put(cyl(1.4, 1.8, 4, 6), bx + s * 17, 2, bz - 14), PALETTE.steelDark));
    }
  }

  // The build bay and two sheds, out on the snow past the apron, each standing
  // on the ground under it rather than on the pad's level.
  {
    const sit = (lx: number, lz: number): number => {
      toWorld(lx, lz, _w);
      return snowHeight(_w.x, _w.z) - padY;
    };
    const bx = 30;
    const bz = 210;
    const by = sit(bx, bz);
    parts.push(tag(put(platform(roundedRect(60, 40, 15, 3), 26, 1.18), bx, by + 3, bz), PALETTE.concreteDark));
    parts.push(tag(put(box(30, 46, 30), bx - 14, by + 3 + 23, bz), PALETTE.roof));
    parts.push(tag(put(box(32, 2.6, 32), bx - 14, by + 3 + 47, bz), PALETTE.steelDark));
    parts.push(tag(put(box(7, 34, 2), bx - 14, by + 3 + 17, bz + 15.6), PALETTE.trench));
    parts.push(tag(put(box(38, 14, 22), bx + 24, by + 3 + 7, bz + 4), PALETTE.roof));
    parts.push(tag(put(box(40, 2.2, 24), bx + 24, by + 3 + 15, bz + 4), PALETTE.steelDark));
    if (!low) {
      for (let i = 0; i < 6; i++) {
        parts.push(
          tag(put(box(4, 2.4, 0.6), bx + 11 + i * 5.4, by + 3 + 8, bz + 15.2), PALETTE.glass, 0.85),
        );
      }
      parts.push(tag(put(box(1.2, 22, 1.2), bx + 46, by + 3 + 11, bz - 9), PALETTE.steel));
    }

    // Roads: apron to build bay, and a spur out to the tank farm.
    parts.push(
      tag(
        road(
          [
            [8, APRON_Z + 2],
            [16, 96],
            [26, 146],
            [30, 184],
          ],
          7,
          toWorld,
          padY,
        ),
        PALETTE.road,
      ),
    );
    parts.push(tag(put(box(150, 0.5, 12), 24, 0.35, 44, -0.22), PALETTE.road));
  }

  const worksGeo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!worksGeo) throw new Error("launchsite: the works failed to merge");
  worksGeo.computeBoundingSphere();
  const works = new THREE.Mesh(worksGeo, structureMat);
  works.name = "launchsite-works";
  group.add(works);

  /* ---- the catch arms -------------------------------------------------- */

  const carriage = new THREE.Group();
  carriage.name = "launchsite-carriage";
  carriage.position.set(TOWER_X, 100, 0);
  group.add(carriage);

  const carriageGeo = mergeGeometries(
    [
      tag(put(box(16, 7, 15), 0, 0, 0), PALETTE.steelDark),
      tag(put(box(6, 4, 20), 7, 1, 0), PALETTE.steel),
    ],
    false,
  );
  if (!carriageGeo) throw new Error("launchsite: the carriage failed to merge");
  const carriageMesh = new THREE.Mesh(carriageGeo, structureMat);
  carriageMesh.name = "launchsite-carriage-frame";
  carriage.add(carriageMesh);

  /**
   * One arm, pivoting about a vertical axis at the carriage.
   *
   * Built pointing along +X with the pivot at the origin, so `rotation.y` is
   * the open angle and zero is closed around the vehicle.
   */
  const armGeo = mergeGeometries(
    [
      tag(put(box(34, 3.4, 3.6), 17, 0, 0), PALETTE.steel),
      tag(put(box(31, 1.2, 1.2), 16, 2.6, 0), PALETTE.steelDark),
      tag(put(box(7, 2.6, 2.6), 33, -0.5, 0), PALETTE.steelDark),
    ],
    false,
  );
  if (!armGeo) throw new Error("launchsite: an arm failed to merge");
  const arms: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(armGeo, structureMat);
    arm.name = `launchsite-arm-${s > 0 ? "n" : "s"}`;
    arm.position.set(6, 0, s * 6);
    arms.push(arm);
    carriage.add(arm);
  }

  /* ---- the vehicle ----------------------------------------------------- */

  const boosterParts: Geo[] = [
    tag(put(cyl(RAD, RAD, BOOSTER_H - 7, low ? 10 : 20), 0, (BOOSTER_H - 7) / 2), PALETTE.hull),
    /* The interstage, deliberately darker and a shade proud of the tank.
       Without a seam here the stack reads as one missile, and "two stages"
       is the whole reason there is a tower with arms on it. */
    tag(put(cyl(RAD + 0.12, RAD + 0.12, 7, low ? 10 : 20), 0, BOOSTER_H - 3.5), PALETTE.steelDark),
    tag(put(cyl(RAD - 0.4, RAD, 5, low ? 10 : 16), 0, 2.5), PALETTE.steelDark),
    tag(put(cyl(RAD - 1.2, RAD - 1.2, 1.2, low ? 8 : 14), 0, 0.4), PALETTE.trench),
  ];
  for (const s of [-1, 1]) {
    // Catch pins — what the arms take the weight on.
    boosterParts.push(tag(put(box(3, 1.6, 1.6), s * (RAD + 1), CATCH_PIN, 0), PALETTE.steelDark));
    // Grid fins.
    boosterParts.push(tag(put(box(1, 5, 4.4), 0, BOOSTER_H - 12, s * (RAD + 2)), PALETTE.steelDark));
    boosterParts.push(tag(put(box(4.4, 5, 1), s * (RAD + 2), BOOSTER_H - 12, 0), PALETTE.steelDark));
  }
  const boosterGeo = mergeGeometries(boosterParts, false);
  for (const p of boosterParts) p.dispose();
  if (!boosterGeo) throw new Error("launchsite: the booster failed to merge");
  const booster = new THREE.Mesh(boosterGeo, structureMat);
  booster.name = "launchsite-booster";
  group.add(booster);

  const shipParts: Geo[] = [
    tag(put(cyl(RAD, RAD, SHIP_H - 16, low ? 10 : 20), 0, (SHIP_H - 16) / 2), PALETTE.hull),
    tag(put(cyl(0.4, RAD, 16, low ? 10 : 20), 0, SHIP_H - 8), PALETTE.hull),
    /* The dark side. A stainless hull is brighter than the snow behind it and
       disappears into it; the heat shield is the reason the real thing reads
       as two colours at any distance, so it is here for the same reason. */
    tag(
      put(
        /* Turned to face the island.
         *
         * The heat shield is the reason the real thing reads as two colours at
         * any distance, and which way it points is not a detail: a dark flank
         * against sunlit snow is the whole contrast budget. Facing it away —
         * which is where it started — spends it on the mountains. */
        new THREE.CylinderGeometry(RAD + 0.06, RAD + 0.06, SHIP_H - 18, low ? 8 : 14, 1, true, -Math.PI * 0.45, Math.PI * 0.9),
        0,
        (SHIP_H - 16) / 2,
      ),
      PALETTE.tile,
    ),
    tag(put(cyl(RAD - 0.9, RAD - 0.9, 1.2, low ? 8 : 14), 0, 0.4), PALETTE.trench),
  ];
  for (const s of [-1, 1]) {
    shipParts.push(tag(put(box(1, 9, 5), 0, SHIP_H - 20, s * (RAD + 2.2)), PALETTE.hullShade));
    shipParts.push(tag(put(box(1, 7, 4), 0, 7, s * (RAD + 1.9)), PALETTE.hullShade));
  }
  const shipGeo = mergeGeometries(shipParts, false);
  for (const p of shipParts) p.dispose();
  if (!shipGeo) throw new Error("launchsite: the ship failed to merge");
  const ship = new THREE.Mesh(shipGeo, structureMat);
  ship.name = "launchsite-ship";
  group.add(ship);

  /* ---- the plume ------------------------------------------------------- */

  const plumeMat = new THREE.ShaderMaterial({
    name: "EmpyreanLaunchPlume",
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: true,
    uniforms: {
      uTime: shared.uTime,
      uLen: { value: 0 },
      uWid: { value: 0 },
      uSpread: { value: 2.6 },
      uGlow: { value: 0 },
      uPower: { value: 0 },
      fogColor: { value: new THREE.Color(0xffffff) },
      fogDensity: { value: 0.0001 },
    },
    vertexShader: /* glsl */ `
      attribute float aKind;
      uniform float uLen;
      uniform float uWid;
      uniform float uSpread;
      uniform float uGlow;
      varying vec2 vUv;
      varying float vKind;
      varying float vDepth;
      void main() {
        vUv = uv;
        vKind = aKind;
        vec3 p = position;
        if (aKind < 0.5) {
          p.x *= uWid * mix(1.0, uSpread, uv.y);
          p.y *= uLen;
        } else {
          p.xy *= uGlow;
        }
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime;
      uniform float uPower;
      uniform float fogDensity;
      varying vec2 vUv;
      varying float vKind;
      varying float vDepth;
      void main() {
        vec3 col;
        float a;
        if (vKind < 0.5) {
          // Along the exhaust: white hot at the throat, gold, then a violet
          // tail. The banding near the throat is the shock diamonds.
          float y = vUv.y;
          float edge = abs(vUv.x - 0.5) * 2.0;
          float body = pow(1.0 - edge, 1.6) * (1.0 - smoothstep(0.35, 1.0, y));
          float flick = 0.86 + 0.14 * sin(uTime * 37.0 + y * 26.0);
          float diamonds = 1.0 + 0.5 * exp(-y * 9.0) * sin(y * 62.0 - uTime * 5.0);
          /* Kept well down. Everything above 1.18 blooms in postfx and these
             quads stack — flame over glow over the wash on the snow — so
             values chosen to look hot on their own add up to a white disc with
             no fire in it. The core is the only part allowed to clip. */
          vec3 core = vec3(2.5, 2.1, 1.5);
          vec3 mid = vec3(2.2, 0.82, 0.20);
          vec3 tail = vec3(0.80, 0.26, 0.62);
          col = mix(tail, mid, smoothstep(0.0, 0.42, 1.0 - y));
          col = mix(col, core, smoothstep(0.72, 1.0, (1.0 - y) * (1.0 - edge)));
          col *= flick * diamonds;
          a = body;
        } else {
          // The glow. This is the part that carries two kilometres.
          float r = length(vUv - 0.5) * 2.0;
          float f = pow(clamp(1.0 - r, 0.0, 1.0), 2.4);
          col = mix(vec3(1.15, 0.36, 0.10), vec3(2.4, 1.30, 0.55), f * f) * (0.45 + 0.7 * f);
          a = f * 0.8;
        }
        // Additive elements have to be *dimmed* into the distance, not mixed
        // toward the fog colour — mixing adds light where fog should be
        // taking it away, and the trail is twenty kilometres long.
        float fd = fogDensity * vDepth;
        col *= mix(1.0, exp(-fd * fd), 0.72);
        gl_FragColor = vec4(col * uPower, a * uPower);
        if (gl_FragColor.a < 0.004) discard;
      }
    `,
  });

  const plumeGeo = new THREE.BufferGeometry();
  plumeGeo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [-0.5, 0, 0, 0.5, 0, 0, -0.5, -1, 0, 0.5, -1, 0, -1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0],
      3,
    ),
  );
  plumeGeo.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0, 1, 1, 1], 2),
  );
  plumeGeo.setAttribute("aKind", new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 1, 1, 1], 1));
  plumeGeo.setIndex([0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7]);
  plumeGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4000);
  const plume = new THREE.Mesh(plumeGeo, plumeMat);
  plume.name = "launchsite-plume";
  plume.frustumCulled = false;
  plume.renderOrder = 6;
  plume.visible = false;
  group.add(plume);

  const shipPlume = new THREE.Mesh(plumeGeo, plumeMat.clone());
  shipPlume.name = "launchsite-shipplume";
  shipPlume.frustumCulled = false;
  shipPlume.renderOrder = 6;
  shipPlume.visible = false;
  const shipPlumeMat = shipPlume.material as THREE.ShaderMaterial;
  shipPlumeMat.uniforms.uTime = shared.uTime;
  group.add(shipPlume);

  /* ---- the light on the snow ------------------------------------------- */

  const glareMat = new THREE.ShaderMaterial({
    name: "EmpyreanLaunchGlare",
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: true,
    uniforms: {
      uPower: { value: 0 },
      uReach: { value: 150 },
      fogColor: { value: new THREE.Color(0xffffff) },
      fogDensity: { value: 0.0001 },
    },
    vertexShader: /* glsl */ `
      attribute float aR;
      varying float vR;
      varying float vDepth;
      void main() {
        vR = aR;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uPower;
      uniform float uReach;
      uniform float fogDensity;
      varying float vR;
      varying float vDepth;
      void main() {
        float d = vR / uReach;
        float f = 1.0 / (1.0 + d * d * 2.2);
        f = pow(f, 1.5);
        vec3 col = mix(vec3(1.05, 0.42, 0.16), vec3(1.55, 0.92, 0.48), f);
        float fd = fogDensity * vDepth;
        col *= mix(1.0, exp(-fd * fd), 0.7);
        gl_FragColor = vec4(col * uPower * f, f * uPower * 0.5);
        if (gl_FragColor.a < 0.004) discard;
      }
    `,
  });

  /**
   * The wash of light the exhaust throws on the snow.
   *
   * A disc, but not a flat one: the ground here falls forty metres across the
   * pad and another eighty before the glare runs out, so the mesh is built
   * from the same height function the terrain is and lies a metre and a half
   * over it. A flat disc would slice into the hillside on one side and float
   * over it on the other, which at dusk is a bright straight line across the
   * snow that nothing explains.
   */
  const glare = (() => {
    const rings = low ? 6 : 11;
    const segs = low ? 16 : 28;
    const reach = 430;
    const pos: number[] = [];
    const rad: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= rings; i++) {
      const r = ((i / rings) ** 1.7) * reach;
      for (let j = 0; j <= segs; j++) {
        const a = (j / segs) * Math.PI * 2;
        const lx = Math.cos(a) * r;
        const lz = Math.sin(a) * r;
        toWorld(lx, lz, _w);
        const g = snowHeight(_w.x, _w.z) - padY;
        const inApron = Math.abs(lx) < APRON_X - 6 && Math.abs(lz) < APRON_Z - 6;
        pos.push(lx, Math.max(g, inApron ? 0 : g) + 1.6, lz);
        rad.push(r);
      }
    }
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segs; j++) {
        const a = i * (segs + 1) + j;
        const b = a + segs + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aR", new THREE.Float32BufferAttribute(rad, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, glareMat);
    m.name = "launchsite-glare";
    m.renderOrder = 4;
    m.visible = false;
    group.add(m);
    return m;
  })();

  /* ---- steam and vapour ------------------------------------------------ */

  const PUFFS = low ? 0 : 54;
  const puffSeed = new Float32Array(PUFFS * 4);
  for (let i = 0; i < PUFFS; i++) {
    const a = rng.range(0, Math.PI * 2);
    puffSeed[i * 4] = a;
    puffSeed[i * 4 + 1] = rng.range(0.35, 1);
    puffSeed[i * 4 + 2] = rng.range(0, 1);
    puffSeed[i * 4 + 3] = rng.range(0.6, 1.4);
  }

  const steamMat = new THREE.ShaderMaterial({
    name: "EmpyreanLaunchSteam",
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms: {
      uTint: { value: new THREE.Color(1, 1, 1) },
      uLit: { value: new THREE.Color(1, 1, 1) },
      fogColor: { value: new THREE.Color(0xffffff) },
      fogDensity: { value: 0.0001 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aOrigin;
      attribute float aSize;
      attribute float aFade;
      attribute float aHeat;
      varying float vFade;
      varying float vHeat;
      varying vec2 vUv;
      varying float vDepth;
      void main() {
        vUv = uv;
        vFade = aFade;
        vHeat = aHeat;
        vec4 mv = modelViewMatrix * vec4(aOrigin, 1.0);
        mv.xy += position.xy * aSize;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uTint;
      uniform vec3 uLit;
      uniform vec3 fogColor;
      uniform float fogDensity;
      varying float vFade;
      varying float vHeat;
      varying vec2 vUv;
      varying float vDepth;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float f = pow(clamp(1.0 - r, 0.0, 1.0), 1.7);
        vec3 col = mix(uTint, uLit, 0.5) + vec3(1.4, 0.55, 0.12) * vHeat;
        float fd = fogDensity * vDepth;
        float trans = exp(-fd * fd);
        col = mix(fogColor, col, trans);
        gl_FragColor = vec4(col, f * vFade * 0.5);
        if (gl_FragColor.a < 0.004) discard;
      }
    `,
  });

  let steam: THREE.Mesh | null = null;
  let steamOrigin: THREE.InstancedBufferAttribute | null = null;
  let steamSize: THREE.InstancedBufferAttribute | null = null;
  let steamFade: THREE.InstancedBufferAttribute | null = null;
  let steamHeat: THREE.InstancedBufferAttribute | null = null;
  let steamGeo: THREE.InstancedBufferGeometry | null = null;
  if (PUFFS > 0) {
    steamGeo = new THREE.InstancedBufferGeometry();
    steamGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0], 3),
    );
    steamGeo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    steamGeo.setIndex([0, 1, 2, 2, 1, 3]);
    steamOrigin = new THREE.InstancedBufferAttribute(new Float32Array(PUFFS * 3), 3);
    steamSize = new THREE.InstancedBufferAttribute(new Float32Array(PUFFS), 1);
    steamFade = new THREE.InstancedBufferAttribute(new Float32Array(PUFFS), 1);
    steamHeat = new THREE.InstancedBufferAttribute(new Float32Array(PUFFS), 1);
    steamGeo.setAttribute("aOrigin", steamOrigin);
    steamGeo.setAttribute("aSize", steamSize);
    steamGeo.setAttribute("aFade", steamFade);
    steamGeo.setAttribute("aHeat", steamHeat);
    steamGeo.instanceCount = PUFFS;
    steamGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 100, 0), 900);
    steam = new THREE.Mesh(steamGeo, steamMat);
    steam.name = "launchsite-steam";
    steam.frustumCulled = false;
    steam.renderOrder = 5;
    steam.visible = false;
    group.add(steam);
  }

  /* ---- the smoke column ------------------------------------------------ */

  /**
   * The trail, as a ribbon sampled backwards along the flight path.
   *
   * Not a particle pool. A pool has history in it, and this system is culled
   * whenever nobody is pointing at it — so a player who turns round two
   * minutes into a launch would find a column that had been emitted only while
   * they were looking. Reading the same pure path function backwards from the
   * current second gives the identical column whether it has been on screen
   * for two minutes or two frames.
   */
  const TRAIL_SEG = low ? 34 : 68;
  const TRAIL_AGE = 104;
  const trailPos = new Float32Array(TRAIL_SEG * 2 * 3);
  const trailAge = new Float32Array(TRAIL_SEG * 2);
  /* Which edge of the ribbon a vertex is on.
   *
   * Without it the strip has uniform alpha right up to its border and reads as
   * a cut-out paper cone against the sky; a smoke column has no edge at all. */
  const trailSide = new Float32Array(TRAIL_SEG * 2);
  for (let i = 0; i < TRAIL_SEG; i++) {
    trailSide[i * 2] = -1;
    trailSide[i * 2 + 1] = 1;
  }
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
  trailGeo.setAttribute("aAge", new THREE.BufferAttribute(trailAge, 1));
  trailGeo.setAttribute("aSide", new THREE.BufferAttribute(trailSide, 1));
  {
    const idx: number[] = [];
    for (let i = 0; i + 1 < TRAIL_SEG; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    trailGeo.setIndex(idx);
  }
  trailGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 6000, 0), 22000);

  const trailMat = new THREE.ShaderMaterial({
    name: "EmpyreanLaunchTrail",
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    uniforms: {
      uFade: { value: 0 },
      uSpan: { value: TRAIL_AGE },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uLit: { value: new THREE.Color(1, 1, 1) },
      fogColor: { value: new THREE.Color(0xffffff) },
      fogDensity: { value: 0.0001 },
    },
    vertexShader: /* glsl */ `
      attribute float aAge;
      attribute float aSide;
      varying float vAge;
      varying float vSide;
      varying float vDepth;
      void main() {
        vAge = aAge;
        vSide = aSide;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uFade;
      uniform float uSpan;
      uniform vec3 uTint;
      uniform vec3 uLit;
      uniform vec3 fogColor;
      uniform float fogDensity;
      varying float vAge;
      varying float vSide;
      varying float vDepth;
      void main() {
        float a = clamp(vAge / uSpan, 0.0, 1.0);
        float across = 1.0 - vSide * vSide;
        // Hot and thin at the young end, cold and thick at the old one.
        vec3 col = mix(uLit * 1.25 + vec3(0.5, 0.22, 0.05), uTint, smoothstep(0.0, 0.24, a));
        float alpha = (1.0 - a) * (1.0 - a) * 0.66 * uFade * pow(across, 0.85);
        float fd = fogDensity * vDepth;
        float trans = exp(-fd * fd);
        col = mix(fogColor, col, trans);
        gl_FragColor = vec4(col, alpha);
        if (gl_FragColor.a < 0.004) discard;
      }
    `,
  });

  const trail = new THREE.Mesh(trailGeo, trailMat);
  trail.name = "launchsite-trail";
  trail.frustumCulled = false;
  trail.renderOrder = 3;
  trail.visible = false;
  group.add(trail);

  /* ---- the lights ------------------------------------------------------ */

  const lightPos: number[] = [];
  const lightCol: number[] = [];
  const lightSize: number[] = [];
  const lightBlink: number[] = [];
  const addLight = (x: number, y: number, z: number, c: THREE.Color, s: number, blink = 0) => {
    lightPos.push(x, y, z);
    lightCol.push(c.r, c.g, c.b);
    lightSize.push(s);
    lightBlink.push(blink);
  };
  {
    const warm = new THREE.Color("#ffd9a0");
    const cold = new THREE.Color("#cfe6ff");
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.2;
      addLight(Math.cos(a) * (APRON_X - 12), 16, Math.sin(a) * (APRON_Z - 10), warm, 5.5);
    }
    for (let i = 1; i <= 4; i++) {
      addLight(TOWER_X, (i / 4) * TOWER_H - 6, 0, cold, 3.4);
    }
    addLight(TOWER_X, TOWER_H + 18.5, 0, PALETTE.beacon, 8, 1);
    addLight(62, 32, -16, cold, 3.2);
    toWorld(30, 210, _w);
    const bayY = snowHeight(_w.x, _w.z) - padY + 3;
    addLight(16, bayY + 50, 210, PALETTE.beacon, 6, 1);
    addLight(54, bayY + 17, 214, warm, 4.4);
  }
  const lightGeo = new THREE.BufferGeometry();
  lightGeo.setAttribute("position", new THREE.Float32BufferAttribute(lightPos, 3));
  lightGeo.setAttribute("aColor", new THREE.Float32BufferAttribute(lightCol, 3));
  lightGeo.setAttribute("aSize", new THREE.Float32BufferAttribute(lightSize, 1));
  lightGeo.setAttribute("aBlink", new THREE.Float32BufferAttribute(lightBlink, 1));
  lightGeo.computeBoundingSphere();

  const lightMat = new THREE.ShaderMaterial({
    name: "EmpyreanLaunchLights",
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: { uNight: shared.uNight, uTime: shared.uTime, uScale: { value: 620 } },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aBlink;
      uniform float uTime;
      varying vec3 vCol;
      varying float vOn;
      void main() {
        vCol = aColor;
        vOn = aBlink > 0.5 ? step(0.55, fract(uTime * 0.55)) : 1.0;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        /* A floor of three and a half pixels, not one.
         *
         * Physically a five-metre floodlight two kilometres away is under two
         * pixels, and a two-pixel sprite with a radial falloff on it is a
         * smear of nothing — the site went completely dark at night while the
         * lights were all present and correct. A light is the one thing in a
         * frame that is allowed to be bigger than it is. */
        gl_PointSize = clamp(aSize * 760.0 / max(-mv.z, 1.0), 3.4, 48.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uNight;
      varying vec3 vCol;
      varying float vOn;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float f = pow(clamp(1.0 - length(d) * 2.0, 0.0, 1.0), 2.0);
        gl_FragColor = vec4(vCol * (0.55 + f) * 2.7, f * uNight * vOn);
        if (gl_FragColor.a < 0.006) discard;
      }
    `,
  });
  const lights = new THREE.Points(lightGeo, lightMat);
  lights.name = "launchsite-lights";
  group.add(lights);

  /* =======================================================================
   * State
   * ==================================================================== */

  const padWorld = new THREE.Vector3(SITE_X, padY + MOUNT_TOP, SITE_Z);
  const vehicleWorld = new THREE.Vector3().copy(padWorld);
  const live = emptySnapshot();
  let enabled = true;
  let onScreen = true;

  /** Fill `out` with the launch's state at `time`. Pure; allocates nothing. */
  function stateAt(time: number, out: LaunchSnapshot = emptySnapshot()): LaunchSnapshot {
    const u = (((time + START_OFFSET) % CYCLE) + CYCLE) % CYCLE;
    let t = u - IGNITION_AT;
    if (t < -T_WRAP) t += CYCLE;
    let countdown = IGNITION_AT - u;
    if (countdown < 0) countdown += CYCLE;

    const phase = phaseAt(t);
    const alt = Math.max(0, sampleTable(FLIGHT, 1, t));
    const down = Math.max(0, sampleTable(FLIGHT, 2, t));

    out.phase = phase;
    out.t = t;
    out.countdown = countdown;
    out.cycle = u / CYCLE;
    out.thrust = thrustAt(t);
    out.shipThrust = shipThrustAt(t);
    out.flying = alt > 0.5;
    out.altitude = alt;
    out.downrange = down;

    const lx = DOWN_X * down;
    const lz = DOWN_Z * down;
    out.x = SITE_X + lx * cy + lz * sy;
    out.y = padY + MOUNT_TOP + alt;
    out.z = SITE_Z + -lx * sy + lz * cy;
    return out;
  }

  const nextIgnition = (time: number): number => {
    const u = (((time + START_OFFSET) % CYCLE) + CYCLE) % CYCLE;
    const c = IGNITION_AT - u;
    return c < 0 ? c + CYCLE : c;
  };

  const soundDelayFrom = (x: number, y: number, z: number): number =>
    Math.hypot(x - vehicleWorld.x, y - vehicleWorld.y, z - vehicleWorld.z) / SPEED_OF_SOUND;

  /* ---- per-frame scratch, all of it allocated exactly once -------------- */

  const _tint = new THREE.Color();
  const _lit = new THREE.Color();
  const shipPlumeUniforms = shipPlumeMat.uniforms;

  /** Local-space position of the ascending column at flight time τ. */
  const _pathX = { v: 0 };
  const _pathY = { v: 0 };
  const _pathZ = { v: 0 };
  function trailPathAt(tau: number): void {
    const table = tau <= T_STAGE ? FLIGHT : SHIP_FLIGHT;
    const alt = Math.max(0, sampleTable(table, 1, tau));
    const down = Math.max(0, sampleTable(table, 2, tau));
    _pathX.v = DOWN_X * down;
    _pathY.v = MOUNT_TOP + alt;
    _pathZ.v = DOWN_Z * down;
  }

  /**
   * Is the site worth a frame at all?
   *
   * It is two kilometres away and off screen most of the time, and the cheap
   * question — is it inside the camera's cone — answers that for a couple of
   * dot products. Both ends are tested, because the vehicle is twenty
   * kilometres up by the end of a launch and a cone around the pad does not
   * contain it.
   */
  const _fwd = new THREE.Vector3();
  function inView(camera: THREE.PerspectiveCamera): boolean {
    const e = camera.matrixWorld.elements;
    _fwd.set(-e[8], -e[9], -e[10]);
    const cx = camera.position.x;
    const cy2 = camera.position.y;
    const cz = camera.position.z;
    // Generous: half the diagonal FOV plus a margin, so nothing ever pops in
    // at the edge of the frame.
    const limit = Math.cos(Math.min(Math.PI * 0.98, (camera.fov * Math.PI) / 180 * 0.9 + 0.55));
    for (const p of [padWorld, vehicleWorld]) {
      const dx = p.x - cx;
      const dy = p.y - cy2;
      const dz = p.z - cz;
      const d = Math.hypot(dx, dy, dz);
      if (d < 600) return true;
      if ((dx * _fwd.x + dy * _fwd.y + dz * _fwd.z) / d > limit) return true;
    }
    return false;
  }

  /* =======================================================================
   * Frame
   * ==================================================================== */

  function update(frame: FrameContext): void {
    if (!enabled) return;

    stateAt(frame.time, live);
    const t = live.t;

    // The vehicle's world position is needed by the audio hook whether or not
    // anything is being drawn, so it is computed before the cull.
    vehicleWorld.set(live.x, live.y, live.z);

    onScreen = inView(frame.camera);
    group.visible = onScreen;
    if (!onScreen) return;

    shared.uTime.value = frame.time;
    // The lamp switch, and only that. `daylight` is 0.32 at this world's
    // sunset, which is exactly when a pad floodlight is worth having on.
    shared.uNight.value = clamp01(1 - (frame.daylight - 0.28) / 0.46);

    const thrust = live.thrust;
    const shipThrust = live.shipThrust;
    const alt = live.altitude;

    /* ---- the vehicle --------------------------------------------------- */

    const lx = DOWN_X * live.downrange;
    const lz = DOWN_Z * live.downrange;
    booster.position.set(lx, MOUNT_TOP + alt, lz);
    /* Pitch-over: the lean follows the climb angle, so the vehicle is always
       pointing along the path it is actually on rather than along a curve
       somebody tuned separately. */
    const lean = clamp(Math.atan2(live.downrange, Math.max(alt, 1)) * 0.9, 0, 1.25);
    /* The flip.
     *
     * A booster turns round after separation so its engines face the way it is
     * going, burns, and turns back the right way up long before it comes near
     * the tower — which is not a detail at this distance, it is the difference
     * between a shape that is flying and a model being slid about. Eased, and
     * finished by T+97: an instantaneous flip is a pop, and one still running
     * at the catch would put seventy metres of booster through the pad. */
    const flip = smoothstep(38, 46, t) - smoothstep(90, 97, t);
    booster.rotation.set(0, 0, 0);
    booster.rotateOnAxis(_axis.set(-DOWN_Z, 0, DOWN_X).normalize(), lean + Math.PI * flip);

    /* Where the upper stage is, which is four different places.
     *
     * There is exactly one discontinuity in this and it is deliberate: at
     * T+60 the stage that flew is seventeen kilometres up and a pixel wide,
     * and the next one appears on the stand. Something has to appear
     * somewhere for the cycle to close, and that is the second in the whole
     * seven minutes when nothing is looking at either place. */
    if (t >= T_STAGE && t < 60) {
      // Away, under its own engines.
      const salt = Math.max(0, sampleTable(SHIP_FLIGHT, 1, t));
      const sdown = Math.max(0, sampleTable(SHIP_FLIGHT, 2, t));
      ship.position.set(DOWN_X * sdown, MOUNT_TOP + salt, DOWN_Z * sdown);
      const slean = clamp(Math.atan2(sdown, Math.max(salt, 1)) * 0.95, 0, 1.4);
      ship.rotation.set(0, 0, 0);
      ship.rotateOnAxis(_axis.set(-DOWN_Z, 0, DOWN_X).normalize(), slean);
      ship.visible = true;
    } else if (t >= 60 && t < T_STACK) {
      // The next one, waiting on the stand for the tower to be free.
      ship.position.set(STAND_X, STAND_H, STAND_Z);
      ship.rotation.set(0, 0, 0);
      ship.visible = true;
    } else if (t >= T_STACK && t < T_DONE) {
      // Being lifted off the stand and mated. The arms carry it, so it rides
      // wherever the carriage is.
      const lift = smoothstep(T_STACK + 16, T_STACK + 30, t);
      const yaw = STAND_YAW * (1 - lift);
      const r = -TOWER_X;
      const gy = ARM_STAND + (ARM_MATE - ARM_STAND) * lift;
      ship.position.set(TOWER_X + Math.cos(yaw) * r, gy - 16, -Math.sin(yaw) * r);
      ship.rotation.set(0, 0, 0);
      ship.visible = true;
    } else {
      // Stacked: carried up the booster's own axis, not straight up, so the
      // stack leans as one object.
      _stack.set(0, BOOSTER_H, 0).applyQuaternion(booster.quaternion);
      ship.position.copy(booster.position).add(_stack);
      ship.quaternion.copy(booster.quaternion);
      ship.visible = true;
    }
    booster.visible = true;

    /* ---- the arms ------------------------------------------------------ */

    /* The carriage and the arms, as one continuous curve.
     *
     * Every branch below has to *meet* its neighbours at the boundary. The
     * first draft did not — the countdown left the carriage at 112 and the
     * receive phase started it at 100 — and a twelve-metre jump on a piece of
     * machinery that has been sitting perfectly still for four minutes is the
     * loudest thing in the frame. The end value of each branch is written
     * where the next one starts.
     */
    let carY = ARM_PARK;
    let carYaw = 0;
    let open = ARM_OPEN;
    if (t >= T_PREP && t < 96) {
      // Out of the way for the launch, and wider.
      const back = smoothstep(T_PREP, T_PREP + 18, t);
      carY = ARM_PARK + 12 * back;
      open = ARM_OPEN + 0.35 * back;
    } else if (t >= 96 && t < T_CATCH) {
      // Down to the catch height, arms wide, waiting.
      const ready = smoothstep(96, T_CATCH, t);
      carY = ARM_PARK + 12 - (ARM_PARK + 12 - ARM_CATCH) * ready;
      open = ARM_OPEN + 0.35 - 0.15 * ready;
    } else if (t >= T_CATCH && t < T_STACK) {
      // Close on the booster, lower it onto the mount, let go, step back up.
      const closed = smoothstep(T_CATCH, T_CATCH + 4, t);
      const lowered = smoothstep(T_CATCH + 8, T_CATCH + 16, t);
      const released = smoothstep(T_CATCH + 18, T_CATCH + 22, t);
      carY = ARM_CATCH - CATCH_CLEAR * lowered + (ARM_PARK - (ARM_CATCH - CATCH_CLEAR)) * released;
      open = (ARM_OPEN + 0.2) * (1 - closed) + ARM_SHUT * closed + (ARM_OPEN - ARM_SHUT) * released;
    } else if (t >= T_STACK && t < T_DONE) {
      // Round to the stand, take the next upper stage, mate it, come home.
      const swing = smoothstep(T_STACK, T_STACK + 8, t);
      const grip = smoothstep(T_STACK + 10, T_STACK + 14, t);
      const lift = smoothstep(T_STACK + 16, T_STACK + 30, t);
      const letGo = smoothstep(T_STACK + 32, T_STACK + 36, t);
      const home = smoothstep(T_STACK + 34, T_DONE, t);
      carYaw = STAND_YAW * swing * (1 - lift);
      const reach = ARM_STAND + (ARM_MATE - ARM_STAND) * lift;
      carY = ARM_PARK + (reach - ARM_PARK) * swing;
      carY += (ARM_PARK - carY) * home;
      /* Ends *open*, at exactly `ARM_OPEN`, because that is where the quiet
         branch picks it up four seconds later. */
      open = ARM_OPEN * (1 - grip) + ARM_SHUT * grip + (ARM_OPEN - ARM_SHUT) * letGo;
    }
    carriage.position.y = carY;
    carriage.rotation.y = carYaw;
    arms[0].rotation.y = -open;
    arms[1].rotation.y = open;

    /* ---- the plume ----------------------------------------------------- */

    const firing = thrust > 0.02;
    plume.visible = firing;
    if (firing) {
      plume.position.copy(booster.position);
      // Billboard about the vehicle's own axis: the flame is a vertical thing
      // and only ever needs to be turned to face the viewer, never tipped.
      const camL = worldToLocalX(frame.camera.position.x, frame.camera.position.z);
      const camLz = worldToLocalZ(frame.camera.position.x, frame.camera.position.z);
      plume.rotation.set(0, Math.atan2(camL - plume.position.x, camLz - plume.position.z), 0);
      /* Held down, the exhaust has nowhere to go: it is short, wide and
         angry. Off the pad it stretches, and in the thin air at altitude it
         blooms out into the shape everybody knows from the tracking cameras. */
      const ground = 1 - smoothstep(0, 90, alt);
      const high = smoothstep(1200, 6000, alt);
      const u = plumeMat.uniforms;
      u.uLen.value = (52 + 190 * (1 - ground) + 150 * high) * thrust;
      u.uWid.value = 9 + 8 * ground;
      u.uSpread.value = 1.9 + 1.5 * ground + 3.4 * high;
      u.uGlow.value = 46 + 120 * thrust + 90 * high;
      u.uPower.value = thrust;
      // Retrograde on the way down: the landing burn points the other way.
      plume.scale.y = flip > 0.5 ? -1 : 1;
    }

    shipPlume.visible = shipThrust > 0.02;
    if (shipPlume.visible) {
      shipPlume.position.copy(ship.position);
      const camL = worldToLocalX(frame.camera.position.x, frame.camera.position.z);
      const camLz = worldToLocalZ(frame.camera.position.x, frame.camera.position.z);
      shipPlume.rotation.set(0, Math.atan2(camL - shipPlume.position.x, camLz - shipPlume.position.z), 0);
      shipPlumeUniforms.uLen.value = 210 * shipThrust;
      shipPlumeUniforms.uWid.value = 7;
      shipPlumeUniforms.uSpread.value = 5.5;
      shipPlumeUniforms.uGlow.value = 60 + 150 * shipThrust;
      shipPlumeUniforms.uPower.value = shipThrust;
    }

    /* ---- the light on the snow ----------------------------------------- */

    const wash = thrust * Math.exp(-alt / 240);
    glare.visible = wash > 0.01;
    if (glare.visible) {
      glareMat.uniforms.uPower.value = wash * 0.95;
      glareMat.uniforms.uReach.value = 130 + 150 * (1 - Math.exp(-alt / 120));
    }

    /* ---- steam --------------------------------------------------------- */

    /* Tinted from the frame, not from a constant.
     *
     * Vapour is white only at noon. At the hour this world lives at it is gold
     * on the sunward side and lavender everywhere else, and a steam cloud that
     * ignores that is the loudest possible tell that a particle system was
     * pasted on top of a world rather than built inside one. */
    const sunUp = clamp01(frame.gradeDaylight);
    _tint.setRGB(0.72, 0.72, 0.86).lerp(_white, sunUp * 0.35);
    _lit.setRGB(1.0, 0.86, 0.68).lerp(_white, 1 - sunUp);
    (steamMat.uniforms.uTint.value as THREE.Color).copy(_tint);
    (steamMat.uniforms.uLit.value as THREE.Color).copy(_lit);
    (trailMat.uniforms.uTint.value as THREE.Color).copy(_tint);
    (trailMat.uniforms.uLit.value as THREE.Color).copy(_lit);

    if (steam && steamOrigin && steamSize && steamFade && steamHeat) {
      /* Vent puffs through the countdown, then the flood the mount throws out
         at ignition. Both are the same fifty-four quads read at different
         times, because both are a pure function of `t` and neither needs a
         particle to be born. */
      const ventOn = t >= T_PREP && t < T_LIFT + 4;
      const blastOn = t >= T_IGNITE && t < T_LIFT + 26;
      const anyOn = ventOn || blastOn;
      steam.visible = anyOn;
      if (anyOn) {
        const op = steamOrigin.array as Float32Array;
        const sz = steamSize.array as Float32Array;
        const fd = steamFade.array as Float32Array;
        const ht = steamHeat.array as Float32Array;
        for (let i = 0; i < PUFFS; i++) {
          const ang = puffSeed[i * 4];
          const spd = puffSeed[i * 4 + 1];
          const off = puffSeed[i * 4 + 2];
          const gro = puffSeed[i * 4 + 3];
          let age: number;
          let fade = 0;
          let heat = 0;
          if (blastOn && i >= PUFFS * 0.25) {
            // The blast: a ring rolling out of the trench and up the flanks.
            age = t - T_IGNITE - off * 3.2;
            if (age <= 0) {
              fd[i] = 0;
              continue;
            }
            const reach = 20 + spd * 34;
            const r = reach * Math.min(age, 8) * 0.62;
            op[i * 3] = Math.cos(ang) * r * 0.55;
            op[i * 3 + 1] = 3 + age * (6 + spd * 12) + r * 0.1;
            op[i * 3 + 2] = -34 + Math.sin(ang) * r;
            /* Capped. Ungrown, a puff reaches six hundred metres across by
               T+20 and the site disappears into a milk-white wash. */
            sz[i] = Math.min(24 + age * 8.5 * gro, 132);
            fade = clamp01(age / 0.7) * (1 - smoothstep(7, 19, age)) * 0.8;
            heat = Math.exp(-age * 1.6) * 0.85;
          } else if (ventOn) {
            // The vents: little wisps off the tank tops and the ship's flank.
            const period = 6 + off * 5;
            age = ((t - T_PREP + off * 9) % period + period) % period;
            const src = i % 3;
            const ox = src === 0 ? 62 - 22 + (i % 5) * 11 : src === 1 ? 0 : 62 + 17;
            const oy = src === 0 ? 30 : src === 1 ? MOUNT_TOP + BOOSTER_H + 34 : 20;
            const oz = src === 0 ? -16 : src === 1 ? RAD + 1 : -36;
            op[i * 3] = ox + Math.cos(ang) * age * 1.6;
            op[i * 3 + 1] = oy + age * (1.4 + spd);
            op[i * 3 + 2] = oz + Math.sin(ang) * age * 1.6;
            sz[i] = 5 + age * 3.4 * gro;
            fade = clamp01(age / 0.6) * (1 - smoothstep(period * 0.4, period, age)) * 0.5;
          } else {
            fd[i] = 0;
            continue;
          }
          fd[i] = fade;
          ht[i] = heat;
        }
        steamOrigin.needsUpdate = true;
        steamSize.needsUpdate = true;
        steamFade.needsUpdate = true;
        steamHeat.needsUpdate = true;
      }
    }

    /* ---- the smoke column ---------------------------------------------- */

    const trailAlive = t >= 1 && t < 58 + TRAIL_AGE;
    trail.visible = trailAlive;
    if (trailAlive) {
      const newest = Math.min(t, 58);
      const oldest = Math.max(0, newest - TRAIL_AGE);
      for (let i = 0; i < TRAIL_SEG; i++) {
        const f = i / (TRAIL_SEG - 1);
        const tau = newest - (newest - oldest) * f ** 1.35;
        const age = t - tau;
        trailPathAt(tau);
        // Drift: the column shears downwind as it ages, which is what stops it
        // reading as a solid pillar drawn in one go.
        const drift = age * 1.9;
        const px = _pathX.v + drift * 0.75;
        const py = _pathY.v - age * 0.16;
        const pz = _pathZ.v + drift * 0.5;
        const w = Math.min(9 + age * 2.35, 190) * (0.55 + 0.45 * smoothstep(0, 18, age));
        // Widen across the view, not across a fixed axis: the ribbon is flat
        // and has to be turned edge-on to nothing.
        const a = i * 6;
        trailPos[a] = px - w;
        trailPos[a + 1] = py;
        trailPos[a + 2] = pz;
        trailPos[a + 3] = px + w;
        trailPos[a + 4] = py;
        trailPos[a + 5] = pz;
        trailAge[i * 2] = age;
        trailAge[i * 2 + 1] = age;
      }
      (trailGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      (trailGeo.getAttribute("aAge") as THREE.BufferAttribute).needsUpdate = true;
      trailMat.uniforms.uFade.value = clamp01(1 - smoothstep(58 + TRAIL_AGE - 26, 58 + TRAIL_AGE, t));
    }
  }

  /* ---- local/world helpers, allocation free ---------------------------- */

  function worldToLocalX(wx: number, wz: number): number {
    const dx = wx - SITE_X;
    const dz = wz - SITE_Z;
    return dx * cy - dz * sy;
  }
  function worldToLocalZ(wx: number, wz: number): number {
    const dx = wx - SITE_X;
    const dz = wz - SITE_Z;
    return dx * sy + dz * cy;
  }

  /* =======================================================================
   * The handle
   * ==================================================================== */

  const handle = {
    name: "launchsite",
    group,
    /**
     * Not in the lake.
     *
     * The mirror is a clone of the silhouette group scaled -1 in Y, and it
     * exists for the rock and the towers, which *are* the reflection. This is
     * two kilometres beyond the far shore and 200 m above the ice, so its
     * mirror image is buried under a hillside — and during a launch the copy
     * would be a rocket twenty kilometres *below* the world, drawn every
     * frame, visible from nowhere.
     */
    reflected: false,
    pad: padWorld as Readonly<THREE.Vector3>,
    vehicle: vehicleWorld as Readonly<THREE.Vector3>,
    get phase(): LaunchPhase {
      return live.phase;
    },
    get t(): number {
      return live.t;
    },
    get countdown(): number {
      return live.countdown;
    },
    get thrust(): number {
      return live.thrust;
    },
    get altitude(): number {
      return live.altitude;
    },
    get onScreen(): boolean {
      return onScreen;
    },
    stateAt(time: number, out?: LaunchSnapshot): LaunchSnapshot {
      /* A fresh object when none is offered, never the one `update` is using.
         Handing out the shared scratch would make two snapshots taken a
         thousand seconds apart compare equal — which is exactly the assertion
         a determinism test is trying to make. */
      return stateAt(time, out ?? emptySnapshot());
    },
    nextIgnition,
    soundDelayFrom,
    setEnabled(on: boolean): void {
      enabled = on;
      group.visible = on;
    },
    update,
    dispose(): void {
      worksGeo.dispose();
      carriageGeo.dispose();
      armGeo.dispose();
      boosterGeo.dispose();
      shipGeo.dispose();
      plumeGeo.dispose();
      glare.geometry.dispose();
      trailGeo.dispose();
      lightGeo.dispose();
      steamGeo?.dispose();
      structureMat.dispose();
      plumeMat.dispose();
      shipPlumeMat.dispose();
      glareMat.dispose();
      steamMat.dispose();
      trailMat.dispose();
      lightMat.dispose();
    },
  };

  // One evaluation before the first frame, so anything reading the handle at
  // build time — a HUD, a test — sees the truth rather than zeroes.
  stateAt(0, live);
  vehicleWorld.set(live.x, live.y, live.z);

  return handle;
}

