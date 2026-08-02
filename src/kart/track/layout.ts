/**
 * SUNSET BLUFF SPEEDWAY — the course DNA.
 *
 * A 2.1 km headland circuit on the Vibe Coast: the paddock straight runs east
 * under the grandstands, the lap climbs inland through a banked double-apex and
 * a hairpin, crosses Gull Creek on a timber bridge, launches off Bluff Jump,
 * carves the concrete bowl at the quarry, dives through the Old Cannery tunnel,
 * runs the anti-gravity plating across the face of the sea cliff, and falls
 * back down to the line on a long descending right-hander with the bay on your
 * left the whole way. Golden hour, always.
 *
 * HOW THE SHAPE IS AUTHORED
 * -------------------------
 * The centreline is a turtle walk: an ordered list of straights and constant-
 * radius arcs, integrated in the XZ plane. That is a deliberate choice over
 * typing raw control-point coordinates — a corner authored as "28 m radius,
 * 145° right" is a corner you can *reason* about, and it guarantees curvature
 * continuity inside every turn, which hand-placed points never quite give you.
 * The walk is then sampled into control points and handed to a centripetal
 * Catmull-Rom spline (see spline.ts), which rounds the joins between segments
 * into the easements a real circuit has.
 *
 * The authored turn angles sum to exactly +360°, so the heading closes by
 * construction. Position closure is *solved*: two link straights are left free
 * and their lengths come out of a 2×2 linear system at load. That is why you
 * can retune the hairpin radius here and the lap still joins up perfectly
 * instead of drifting 40 m apart at the start/finish line.
 *
 * Elevation, bank and half-width are separate key tables sampled in metres
 * along the walk, so the profile of a corner is edited without touching its
 * plan shape.
 */
import { DEG, ScalarTrack, type ScalarKey } from "./util";

// ---------------------------------------------------------------------------
// Section vocabulary
// ---------------------------------------------------------------------------

/** What the drivable ribbon is made of, section by section. */
export type RoadKind = "road" | "wood" | "metal" | "antigrav" | "gap";

/** What guards the edge. `none` means falling off is the intended outcome. */
export type EdgeKind = "none" | "rail" | "barrier" | "tube" | "post";

export interface Segment {
  id: string;
  /** Shown on the debug overlay and used by the scenery system as an anchor. */
  label: string;
  kind: "straight" | "arc";
  /** Horizontal metres (straights only). */
  length: number;
  /** Degrees of heading change, + = right (arcs only). */
  angle: number;
  radius: number;
  road: RoadKind;
  /** Painted kerbs along the drivable edge, [left, right]. */
  kerb: [boolean, boolean];
  edge: [EdgeKind, EdgeKind];
  /**
   * Quarter-pipe lip beyond the drivable edge, [left, right] as
   * [width, height] in metres. This is what makes the bowl rideable rather
   * than a wall you bounce off.
   */
  lip?: { left?: [number, number]; right?: [number, number] };
  /** Terrain must not grade up to this section — bridge deck, cliff, viaduct. */
  elevated?: boolean;
  /** Roofed: the tunnel bore. */
  tunnel?: boolean;
  bridge?: boolean;
  /** Left free for the closure solve. */
  free?: "A" | "B";
}

/**
 * The walk. The lap runs clockwise seen from above, so the sea is always off
 * your left shoulder. Angles sum to exactly +360°: 548° of right against 188°
 * of left, the lefts being the Gull Kink, the opening half of the Creek
 * Chicane, the drift through the tunnel and the long anti-gravity arc around
 * the seaward face of the bluff.
 */
export const SEGMENTS: Segment[] = [
  seg("paddock", "Paddock Straight", { straight: 190, kerb: [true, true], edge: ["barrier", "barrier"] }),
  seg("t1a", "Bluff Curve — entry", { arc: 42, radius: 118, kerb: [true, true], edge: ["rail", "barrier"] }),
  seg("t1link", "Bluff Curve — release", { straight: 22, kerb: [true, true], edge: ["rail", "barrier"] }),
  seg("t1b", "Bluff Curve — second apex", { arc: 58, radius: 85, kerb: [true, true], edge: ["rail", "barrier"] }),
  seg("backStraight", "Cannery Straight", { straight: 280, free: "B", kerb: [true, true], edge: ["rail", "rail"] }),
  seg("kink", "Gull Kink", { arc: -30, radius: 150, kerb: [true, true], edge: ["rail", "rail"] }),
  seg("hairpin", "Lantern Hairpin", { arc: 145, radius: 28, kerb: [true, true], edge: ["barrier", "none"] }),
  seg("hairpinExit", "Hairpin Exit", { straight: 40, kerb: [true, true], edge: ["rail", "rail"] }),
  seg("chicane1", "Creek Chicane — left", { arc: -78, radius: 48, kerb: [true, true], edge: ["post", "rail"] }),
  seg("bridge", "Gull Creek Bridge", {
    straight: 30,
    road: "wood",
    kerb: [false, false],
    edge: ["post", "post"],
    bridge: true,
    elevated: true,
  }),
  seg("chicane2", "Creek Chicane — right", { arc: 23, radius: 80, kerb: [true, true], edge: ["rail", "post"] }),
  seg("climb", "Quarry Climb", { straight: 230, free: "A", kerb: [true, true], edge: ["rail", "rail"] }),
  seg("kick", "Bluff Jump — ramp", {
    straight: 20,
    road: "metal",
    kerb: [false, false],
    edge: ["none", "none"],
    elevated: true,
  }),
  seg("gap", "Bluff Jump — air", {
    straight: 22,
    road: "gap",
    kerb: [false, false],
    edge: ["none", "none"],
    elevated: true,
  }),
  seg("land", "Bluff Jump — landing", {
    straight: 30,
    road: "metal",
    kerb: [false, false],
    edge: ["none", "none"],
    elevated: true,
  }),
  seg("landSweep", "Quarry Entry", { arc: 55, radius: 95, kerb: [true, true], edge: ["rail", "barrier"] }),
  seg("bowl", "The Quarry Bowl", {
    arc: 95,
    radius: 76,
    kerb: [false, true],
    edge: ["none", "barrier"],
    lip: { left: [9, 5.5] },
  }),
  seg("tunnelIn", "Cannery Approach", { straight: 45, kerb: [true, true], edge: ["barrier", "barrier"] }),
  seg("tunnel", "Old Cannery Tunnel", {
    arc: -25,
    radius: 150,
    kerb: [true, true],
    edge: ["barrier", "barrier"],
    tunnel: true,
  }),
  seg("tunnelOut", "Cannery Exit", { straight: 30, kerb: [true, true], edge: ["barrier", "rail"] }),
  seg("antigrav", "Cliffside Plating", {
    arc: -55,
    radius: 120,
    road: "antigrav",
    kerb: [false, false],
    edge: ["tube", "tube"],
    elevated: true,
  }),
  seg("agExit", "Bay Viaduct", {
    arc: 45,
    radius: 85,
    road: "antigrav",
    kerb: [false, false],
    edge: ["tube", "tube"],
    elevated: true,
  }),
  seg("descent1", "Sunset Sweep", { arc: 55, radius: 115, kerb: [true, true], edge: ["rail", "rail"] }),
  seg("descent2", "Lighthouse Bend", { arc: 30, radius: 150, kerb: [true, true], edge: ["rail", "barrier"] }),
  seg("pit", "Pit Straight", { straight: 125, kerb: [true, true], edge: ["barrier", "barrier"] }),
];

type SegOpts = {
  straight?: number;
  arc?: number;
  radius?: number;
  road?: RoadKind;
  kerb?: [boolean, boolean];
  edge?: [EdgeKind, EdgeKind];
  lip?: Segment["lip"];
  elevated?: boolean;
  tunnel?: boolean;
  bridge?: boolean;
  free?: "A" | "B";
};

function seg(id: string, label: string, o: SegOpts): Segment {
  return {
    id,
    label,
    kind: o.arc !== undefined ? "arc" : "straight",
    length: o.straight ?? 0,
    angle: o.arc ?? 0,
    radius: o.radius ?? 0,
    road: o.road ?? "road",
    kerb: o.kerb ?? [true, true],
    edge: o.edge ?? ["rail", "rail"],
    lip: o.lip,
    elevated: o.elevated,
    tunnel: o.tunnel,
    bridge: o.bridge,
    free: o.free,
  };
}

// ---------------------------------------------------------------------------
// Profile keys — [segment id, fraction through it, value]
// ---------------------------------------------------------------------------

type Key = readonly [string, number, number];

/** Centreline elevation, metres. Sea level is −8; the bowl rim is the roof. */
const ELEVATION: Key[] = [
  ["paddock", 0, 0],
  ["paddock", 1, 0.6],
  ["t1a", 1, 2.6],
  ["t1link", 1, 3.4],
  ["t1b", 1, 5.2],
  ["backStraight", 1, 6.6],
  ["kink", 1, 7.2],
  ["hairpin", 0.5, 6.2],
  ["hairpin", 1, 6.6],
  ["hairpinExit", 1, 7.6],
  ["chicane1", 1, 8.6],
  ["bridge", 0.5, 9.0],
  ["bridge", 1, 9.0],
  ["chicane2", 1, 9.2],
  ["climb", 0.1, 10.2],
  ["climb", 1, 22.0],
  // The kicker is 20° of ramp. Everything about the jump — hangtime, the trick
  // window, where the landing has to sit — falls out of this one number.
  ["kick", 1, 29.3],
  // Ballistic through the gap at 28 m/s under the tuning's heavy 26 m/s²: apex
  // 1.8 m over the lip, back down 1 m below it 22 m later.
  ["gap", 0.52, 31.1],
  ["gap", 1, 28.3],
  ["land", 0.4, 26.0],
  ["land", 1, 25.0],
  ["landSweep", 1, 25.6],
  ["bowl", 0.5, 26.6],
  ["bowl", 1, 25.2],
  ["tunnelIn", 1, 24.6],
  ["tunnel", 1, 23.6],
  ["tunnelOut", 1, 23.6],
  ["antigrav", 0.5, 25.0],
  ["antigrav", 1, 24.0],
  ["agExit", 1, 22.0],
  ["descent1", 1, 12.0],
  ["descent2", 1, 3.0],
  ["pit", 1, 0],
];

/**
 * Bank, degrees. + banks into a right-hand turn (outer edge is the left one).
 * The anti-gravity section runs to −88°: the ribbon is very nearly vertical and
 * the karts are driving on the seaward face of the bluff.
 */
const BANK: Key[] = [
  ["paddock", 0, 0],
  ["paddock", 1, 0],
  ["t1a", 0.35, 7],
  ["t1a", 1, 9],
  ["t1link", 1, 10],
  ["t1b", 0.25, 17],
  ["t1b", 0.78, 17],
  ["t1b", 1, 9],
  ["backStraight", 0.3, 0],
  ["backStraight", 1, 0],
  ["kink", 0.6, -4],
  ["kink", 1, -5],
  ["hairpin", 0.18, 9],
  ["hairpin", 0.82, 9],
  ["hairpin", 1, 4],
  ["hairpinExit", 0.45, 0],
  ["hairpinExit", 1, -4],
  ["chicane1", 0.5, -9],
  ["chicane1", 1, -5],
  ["bridge", 0.5, 0],
  ["chicane2", 0.5, 5],
  ["chicane2", 1, 3],
  ["climb", 0.25, 0],
  ["climb", 1, 0],
  ["kick", 1, 0],
  ["gap", 1, 0],
  ["land", 1, 0],
  ["landSweep", 0.45, 12],
  ["landSweep", 1, 22],
  ["bowl", 0.18, 38],
  ["bowl", 0.5, 42],
  ["bowl", 0.84, 36],
  ["bowl", 1, 18],
  ["tunnelIn", 0.55, 3],
  ["tunnelIn", 1, 0],
  ["tunnel", 0.5, -6],
  ["tunnel", 1, -6],
  ["tunnelOut", 1, -4],
  ["antigrav", 0.26, -88],
  ["antigrav", 0.76, -88],
  ["antigrav", 1, -44],
  ["agExit", 0.45, 2],
  ["agExit", 1, 12],
  ["descent1", 0.3, 15],
  ["descent1", 1, 13],
  ["descent2", 0.4, 12],
  ["descent2", 0.92, 8],
  ["pit", 0.3, 0],
  ["pit", 1, 0],
];

/** Half-width of the drivable ribbon, metres. */
const HALF_WIDTH: Key[] = [
  ["paddock", 0, 9.6],
  ["paddock", 1, 9.0],
  ["t1a", 1, 8.6],
  ["t1b", 1, 8.4],
  ["backStraight", 0.5, 8.2],
  ["kink", 1, 7.6],
  ["hairpin", 0.5, 6.6],
  ["hairpin", 1, 7.0],
  ["hairpinExit", 1, 7.4],
  ["chicane1", 1, 6.2],
  ["bridge", 0, 5.8],
  ["bridge", 1, 5.8],
  ["chicane2", 1, 6.6],
  ["climb", 0.4, 7.6],
  ["climb", 1, 8.0],
  ["kick", 1, 8.4],
  ["gap", 1, 8.4],
  ["land", 1, 9.0],
  ["landSweep", 1, 9.2],
  ["bowl", 0.5, 9.4],
  ["bowl", 1, 8.6],
  ["tunnelIn", 1, 7.6],
  ["tunnel", 0.5, 7.2],
  ["tunnelOut", 1, 7.4],
  ["antigrav", 0.3, 6.8],
  ["antigrav", 1, 6.8],
  ["agExit", 1, 7.4],
  ["descent1", 0.5, 8.4],
  ["descent2", 0.5, 8.6],
  ["pit", 0.4, 9.4],
  ["pit", 1, 9.6],
];

// ---------------------------------------------------------------------------
// Dressing — everything placed by (segment, fraction, lateral)
// ---------------------------------------------------------------------------

export interface Placement {
  seg: string;
  f: number;
  /** Signed metres from the centreline, + = the racer's right. */
  lateral: number;
}

/** Rows of five item boxes, spanning the road at places worth a gamble. */
export const ITEM_ROWS: Array<{ seg: string; f: number; spread: number }> = [
  { seg: "paddock", f: 0.62, spread: 6.4 },
  { seg: "backStraight", f: 0.42, spread: 5.8 },
  { seg: "hairpinExit", f: 0.55, spread: 5.0 },
  { seg: "climb", f: 0.5, spread: 5.4 },
  { seg: "landSweep", f: 0.3, spread: 6.0 },
  { seg: "descent1", f: 0.42, spread: 6.2 },
];

/**
 * Which off-road surface flanks each section. Shared by the apron geometry and
 * the physics query so what you see is what you slow down on.
 */
export function apronSurface(segId: string): "grass" | "dirt" {
  switch (segId) {
    case "kink":
    case "hairpin":
    case "hairpinExit":
    case "climb":
    case "kick":
    case "land":
    case "landSweep":
    case "bowl":
      return "dirt";
    default:
      return "grass";
  }
}

/** Boost panels. `lanes` are lateral offsets; each panel is 3.4 × 6 m. */
export const BOOST_PADS: Array<{ seg: string; f: number; lanes: number[] }> = [
  { seg: "backStraight", f: 0.66, lanes: [-3.4, 0, 3.4] },
  { seg: "hairpinExit", f: 0.2, lanes: [-2.6, 2.6] },
  { seg: "land", f: 0.62, lanes: [-3.0, 3.0] },
  { seg: "bowl", f: 0.62, lanes: [-5.5, -1.5] },
  { seg: "tunnelOut", f: 0.45, lanes: [-2.8, 2.8] },
  { seg: "descent2", f: 0.3, lanes: [-3.2, 0.6] },
];

/**
 * The dirt cut through the inside of Lantern Hairpin.
 *
 * Leaves the road just before turn-in, runs across the scrub inside the loop
 * and rejoins on the exit. Roughly 62 m against 96 m the long way — worth about
 * eight tenths if you keep it clean, and it is loose dirt with a bump halfway,
 * so you often do not.
 */
export const SHORTCUT = {
  entry: { seg: "kink", f: 0.58, lateral: 6.4 },
  exit: { seg: "hairpinExit", f: 0.34, lateral: 5.6 },
  /** Waypoint at the hairpin's midpoint, this far beyond the inside edge. */
  apex: { seg: "hairpin", f: 0.5, inset: 17 },
  halfWidth: 3.7,
  /** Rise at the middle of the cut, over the straight line — a blind crest. */
  crest: 1.7,
  /** Fraction of the cut that is a boost strip, rewarding a clean exit. */
  boost: [0.66, 0.84] as [number, number],
};

/**
 * Eight beauty shots. These are what the course is photographed with, so they
 * are framed like key art rather than dropped on the centreline: low and wide
 * down the straights, inside the apex where the banking reads, and always with
 * something in the near foreground for depth.
 */
/**
 * `lateral` and `height` are read in a *horizontal* frame — flat right, world
 * up — not the banked road frame. On the anti-gravity wall the road frame's
 * "up" points sideways, and nobody should have to think about that while
 * framing a photograph.
 */
export interface ScenicSpec {
  name: string;
  from: Placement;
  /** Metres above the centreline point at `from`. */
  height: number;
  to: Placement;
  toHeight: number;
  /** Overrides the default 55° beauty-shot field of view. */
  fov?: number;
}

export const SCENIC: ScenicSpec[] = [
  {
    // On the tarmac at the edge of the road, not behind the wall: the pit
    // straight is walled on both sides and a camera outside it photographs
    // concrete.
    name: "Paddock Straight, low three-quarter",
    from: { seg: "pit", f: 0.72, lateral: 7.6 },
    height: 1.9,
    to: { seg: "paddock", f: 0.55, lateral: -3 },
    toHeight: 1.3,
    fov: 38,
  },
  {
    name: "Bluff Curve, inside the banking at the second apex",
    from: { seg: "t1b", f: 0.1, lateral: 19 },
    height: 3.4,
    to: { seg: "t1b", f: 0.66, lateral: -4 },
    toHeight: 2.4,
    fov: 48,
  },
  {
    name: "Bluff Jump, from the landing side",
    from: { seg: "land", f: 0.95, lateral: 19 },
    height: 5.0,
    to: { seg: "kick", f: 0.8, lateral: 0 },
    toHeight: 3.0,
    fov: 50,
  },
  {
    name: "The Quarry Bowl, from the floor of the banking",
    from: { seg: "bowl", f: 0.52, lateral: 27 },
    height: -5.5,
    to: { seg: "bowl", f: 0.26, lateral: -8 },
    toHeight: 5.0,
    fov: 58,
  },
  {
    name: "Old Cannery tunnel mouth",
    from: { seg: "tunnelIn", f: 0.3, lateral: -13 },
    height: 6.0,
    to: { seg: "tunnel", f: 0.4, lateral: 0 },
    toHeight: 1.2,
    fov: 52,
  },
  {
    name: "Cliffside plating, out over the bay",
    from: { seg: "antigrav", f: 0.46, lateral: -44 },
    height: -14,
    to: { seg: "antigrav", f: 0.66, lateral: 0 },
    toHeight: 2,
    fov: 55,
  },
  {
    name: "Gull Creek bridge, from the gully",
    from: { seg: "chicane2", f: 0.6, lateral: 30 },
    height: -13,
    to: { seg: "bridge", f: 0.45, lateral: 0 },
    toHeight: 1.0,
    fov: 50,
  },
  {
    name: "Grandstand pan over the start line",
    from: { seg: "pit", f: 0.9, lateral: -42 },
    height: 30,
    to: { seg: "paddock", f: 0.3, lateral: 3 },
    toHeight: 0,
    fov: 44,
  },
];

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

export interface ControlPoint {
  x: number;
  y: number;
  z: number;
  /** Horizontal arc length at this point. */
  s: number;
  bank: number;
  halfWidth: number;
  /** Index into `SEGMENTS`. */
  seg: number;
}

export interface LayoutResult {
  name: string;
  place: string;
  points: ControlPoint[];
  /** Horizontal arc range of each segment, indexed like `SEGMENTS`. */
  spans: Array<{ start: number; end: number }>;
  /** Control-point index at which each segment starts. */
  segStartIndex: number[];
  /** Total horizontal length of the walk. */
  length: number;
  /** Residual closure error after the solve, metres. Diagnostic only. */
  closureError: number;
  /** The solved lengths of the two free link straights. */
  solved: { A: number; B: number };
}

/** Control points roughly this far apart; segment joins always get one. */
const CP_SPACING = 11;

/**
 * Integrate the walk for a given pair of free-straight lengths, returning the
 * end position and heading. Straight lengths enter the result linearly, which
 * is the whole reason the closure solve below is a 2×2 solve and not a search.
 */
function walk(A: number, B: number): { x: number; z: number; theta: number; spans: Array<{ start: number; end: number }>; length: number } {
  let x = 0;
  let z = 0;
  let theta = 0;
  let s = 0;
  const spans: Array<{ start: number; end: number }> = [];
  for (const g of SEGMENTS) {
    const start = s;
    if (g.kind === "straight") {
      const len = g.free === "A" ? A : g.free === "B" ? B : g.length;
      x += Math.cos(theta) * len;
      z += Math.sin(theta) * len;
      s += len;
    } else {
      const a = g.angle * DEG;
      const len = Math.abs(a) * g.radius;
      // Centre of the turn sits `radius` to the inside; +angle turns right, and
      // the racer's right is (−sinθ, cosθ) in the XZ plane.
      const sgn = Math.sign(g.angle);
      const cx = x + -Math.sin(theta) * g.radius * sgn;
      const cz = z + Math.cos(theta) * g.radius * sgn;
      const rx = x - cx;
      const rz = z - cz;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      x = cx + rx * ca - rz * sa;
      z = cz + rx * sa + rz * ca;
      theta += a;
      s += len;
    }
    spans.push({ start, end: s });
  }
  return { x, z, theta, spans, length: s };
}

/**
 * Solve the two free straights for exact position closure.
 *
 * Heading already closes by construction (the authored angles sum to 360°), so
 * the end position is `base + A·dA + B·dB` for the two fixed unit headings the
 * free straights point along. Two equations, two unknowns, one solve — and the
 * lap joins to the millimetre no matter how the corners are retuned.
 */
function solveClosure(): { A: number; B: number; error: number } {
  const base = walk(0, 0);
  const wa = walk(1, 0);
  const wb = walk(0, 1);
  const ax = wa.x - base.x;
  const az = wa.z - base.z;
  const bx = wb.x - base.x;
  const bz = wb.z - base.z;
  const det = ax * bz - az * bx;
  if (Math.abs(det) < 1e-6) {
    // The two free straights ended up parallel — no solution. Fall back to the
    // authored lengths and let the spline absorb the (visible) kink.
    const A = SEGMENTS.find((g) => g.free === "A")?.length ?? 0;
    const B = SEGMENTS.find((g) => g.free === "B")?.length ?? 0;
    const w = walk(A, B);
    return { A, B, error: Math.hypot(w.x, w.z) };
  }
  const A = (-base.x * bz + base.z * bx) / det;
  const B = (-ax * base.z + az * base.x) / det;
  const check = walk(A, B);
  return { A, B, error: Math.hypot(check.x, check.z) };
}

/** Resolve a `[segment, fraction]` pair to horizontal metres along the lap. */
function keyToS(key: Key | Placement, spans: Array<{ start: number; end: number }>): number {
  const tuple = key as Key;
  const named = key as Placement;
  const isKey = Array.isArray(key);
  const id = isKey ? tuple[0] : named.seg;
  const f = isKey ? tuple[1] : named.f;
  const i = SEGMENTS.findIndex((g) => g.id === id);
  if (i < 0) return 0;
  const span = spans[i];
  return span.start + (span.end - span.start) * f;
}

function buildScalar(keys: Key[], spans: Array<{ start: number; end: number }>, period: number): ScalarTrack {
  const out: ScalarKey[] = keys.map((k) => ({ s: keyToS(k, spans), v: k[2] }));
  return new ScalarTrack(out, period);
}

/** Cached, because half a dozen modules ask for the layout. */
let cached: LayoutResult | null = null;

export function buildLayout(): LayoutResult {
  if (cached) return cached;

  const { A, B, error } = solveClosure();
  const path = walk(A, B);
  const spans = path.spans;
  const period = path.length;

  const elevation = buildScalar(ELEVATION, spans, period);
  const bank = buildScalar(BANK, spans, period);
  const halfWidth = buildScalar(HALF_WIDTH, spans, period);

  // Re-walk, emitting control points. Sampling is per segment so every join
  // lands exactly on a point and the section boundaries stay crisp.
  const points: ControlPoint[] = [];
  const segStartIndex: number[] = [];
  let x = 0;
  let z = 0;
  let theta = 0;
  let s = 0;

  const emit = (px: number, pz: number, ps: number, segIndex: number) => {
    points.push({
      x: px,
      y: elevation.at(ps),
      z: pz,
      s: ps,
      bank: bank.at(ps) * DEG,
      halfWidth: halfWidth.at(ps),
      seg: segIndex,
    });
  };

  for (let gi = 0; gi < SEGMENTS.length; gi++) {
    const g = SEGMENTS[gi];
    segStartIndex.push(points.length);
    if (g.kind === "straight") {
      const len = g.free === "A" ? A : g.free === "B" ? B : g.length;
      const n = Math.max(1, Math.round(len / CP_SPACING));
      const dx = Math.cos(theta);
      const dz = Math.sin(theta);
      for (let i = 0; i < n; i++) {
        const d = (len * i) / n;
        emit(x + dx * d, z + dz * d, s + d, gi);
      }
      x += dx * len;
      z += dz * len;
      s += len;
    } else {
      const a = g.angle * DEG;
      const len = Math.abs(a) * g.radius;
      const sgn = Math.sign(g.angle);
      const cx = x + -Math.sin(theta) * g.radius * sgn;
      const cz = z + Math.cos(theta) * g.radius * sgn;
      const rx = x - cx;
      const rz = z - cz;
      // Tighter sampling in tight corners: a 26 m hairpin at 11 m spacing would
      // be a polygon, and the spline can only round what it is given.
      const spacing = Math.min(CP_SPACING, Math.max(3.5, g.radius * 0.22));
      const n = Math.max(2, Math.round(len / spacing));
      for (let i = 0; i < n; i++) {
        const phi = (a * i) / n;
        const c = Math.cos(phi);
        const si = Math.sin(phi);
        emit(cx + rx * c - rz * si, cz + rx * si + rz * c, s + (len * i) / n, gi);
      }
      const c = Math.cos(a);
      const si = Math.sin(a);
      x = cx + rx * c - rz * si;
      z = cz + rx * si + rz * c;
      theta += a;
      s += len;
    }
  }

  cached = {
    name: "Sunset Bluff Speedway",
    place: "Vibe Coast",
    points,
    spans,
    segStartIndex,
    length: path.length,
    closureError: error,
    solved: { A, B },
  };
  return cached;
}

/** Horizontal metres along the lap for a `(segment, fraction)` placement. */
export function placementS(p: Placement | { seg: string; f: number }): number {
  const layout = buildLayout();
  return keyToS({ seg: p.seg, f: p.f, lateral: 0 }, layout.spans);
}

export function segmentIndex(id: string): number {
  return SEGMENTS.findIndex((g) => g.id === id);
}
