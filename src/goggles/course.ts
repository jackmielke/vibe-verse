/**
 * The Half-Blind Triathlon: the courses, as data.
 *
 * Three legs, all in scaled metres so each takes about two minutes at a
 * plausible pace. The real numbers (1.5 km, 40 km, 10 km, 1,700 ft of climb)
 * are what the HUD reports; `REAL` holds the scale from sim metres to those.
 *
 * Pure TypeScript, no three: the renderer samples `bikeAt()` and `runAt()` to
 * place the road and the path, and the race state machine samples them for
 * grade and curvature. Both read the same numbers, so the hill you feel is
 * the hill you see.
 */

export interface Sample {
  x: number;
  z: number;
  y: number;
  /** Heading in radians, 0 = +z, increasing clockwise when seen from above. */
  heading: number;
  /** Rise over run, positive uphill. */
  grade: number;
  /** Signed curvature in 1/m: positive turns right. */
  curvature: number;
}

// ---------------------------------------------------------------------------
// SWIM: two lanes out and back, a turn buoy at the far end.
// ---------------------------------------------------------------------------

export const SWIM_LENGTH = 1500;
export const SWIM_TURN = 750;
/** Lateral distance between the out lane and the return lane. */
export const SWIM_LANE_GAP = 44;
/** The buoy line sits this far to the left of the ideal line. */
export const BUOY_X = -8;
/** The kayaks sit this far to the right of it. */
export const KAYAK_X = 15;
export const BUOY_SPACING = 125;

/**
 * Where the swimmer is in the world for a course distance and lateral drift.
 * Positive x is to the swimmer's right.
 */
export function swimAt(s: number, x: number): Sample {
  const out = s < SWIM_TURN;
  if (out) {
    // Heading +z; the swimmer's right is -x.
    return { x: -x, z: 10 + s, y: 0, heading: 0, grade: 0, curvature: 0 };
  }
  const back = s - SWIM_TURN;
  return { x: SWIM_LANE_GAP + x, z: 10 + SWIM_TURN - back, y: 0, heading: Math.PI, grade: 0, curvature: 0 };
}

// ---------------------------------------------------------------------------
// BIKE: a loop of rollers behind the lake.
// ---------------------------------------------------------------------------

interface Segment {
  len: number;
  /** Total heading change over the segment, radians, positive = right. */
  turn: number;
  /** Elevation change over the segment, metres. */
  climb: number;
  name?: string;
}

/**
 * Lengths are multiplied by SEG_SCALE so the loop rides in about two minutes.
 * Grades come out between 6 and 9 percent, which is what the Chelan rollers
 * feel like even though the real climbs are much longer.
 */
const SEG_SCALE = 0.72;
const SEGMENTS: Segment[] = [
  { len: 250, turn: 0, climb: 0, name: "Shore road" },
  { len: 100, turn: -1.0, climb: 3 },
  { len: 280, turn: 0, climb: 20, name: "Climb one" },
  { len: 60, turn: -0.6, climb: 2, name: "Crest" },
  { len: 120, turn: 0.9, climb: -8, name: "Descent one" },
  { len: 120, turn: -1.3, climb: -8 },
  { len: 150, turn: -0.5, climb: 0, name: "Orchards" },
  { len: 350, turn: 0, climb: 28, name: "Climb two" },
  { len: 60, turn: -0.5, climb: 1, name: "Crest" },
  { len: 100, turn: -1.1, climb: -7, name: "Descent two" },
  { len: 100, turn: 0, climb: -8 },
  { len: 110, turn: 1.2, climb: -8 },
  { len: 100, turn: -0.8, climb: -7 },
  { len: 200, turn: -0.4, climb: 0, name: "Vineyards" },
  { len: 220, turn: 0, climb: 16, name: "Climb three" },
  { len: 50, turn: -0.5, climb: 1, name: "Crest" },
  { len: 130, turn: 0.7, climb: -9, name: "Descent three" },
  { len: 130, turn: -1.0, climb: -9 },
  { len: 250, turn: -0.9, climb: -2, name: "Back to the lake" },
];

const STEP = 2;
const bikeSamples: Sample[] = [];
const bikeNames: { s: number; name: string }[] = [];
let bikeLength = 0;
let bikeClimb = 0;
{
  // Start at the beach heading west along the south shore.
  let x = -30;
  let z = -14;
  let y = 1.5;
  let heading = -Math.PI / 2;
  let s = 0;
  bikeSamples.push({ x, z, y, heading, grade: 0, curvature: 0 });
  for (const seg of SEGMENTS) {
    const len = seg.len * SEG_SCALE;
    if (seg.name) bikeNames.push({ s, name: seg.name });
    const curvature = seg.turn / len;
    const grade = seg.climb / len;
    if (seg.climb > 0) bikeClimb += seg.climb;
    const n = Math.max(1, Math.round(len / STEP));
    const d = len / n;
    for (let i = 0; i < n; i++) {
      heading += curvature * d;
      x += Math.sin(heading) * d;
      z += Math.cos(heading) * d;
      y += grade * d;
      s += d;
      bikeSamples.push({ x, z, y, heading, grade, curvature });
    }
  }
  bikeLength = s;
}

export const BIKE_LENGTH = bikeLength;
/** Metres climbed over the loop, in sim metres. */
export const BIKE_CLIMB = bikeClimb;
export const BIKE_NAMES = bikeNames;

export function bikeAt(s: number): Sample {
  const t = Math.max(0, Math.min(bikeSamples.length - 1, s / STEP));
  const i = Math.floor(t);
  const a = bikeSamples[i];
  const b = bikeSamples[Math.min(bikeSamples.length - 1, i + 1)];
  const f = t - i;
  // Headings never wrap across a step (steps are 2 m and turns are gentle).
  return {
    x: a.x + (b.x - a.x) * f,
    z: a.z + (b.z - a.z) * f,
    y: a.y + (b.y - a.y) * f,
    heading: a.heading + (b.heading - a.heading) * f,
    grade: b.grade,
    curvature: b.curvature,
  };
}

export function bikeSectionAt(s: number): string {
  let name = bikeNames[0].name;
  for (const n of bikeNames) if (s >= n.s) name = n.name;
  return name;
}

/** The next corner ahead, for the HUD arrow: distance to it and its direction. */
export function nextCorner(s: number): { distance: number; dir: -1 | 1; curvature: number } | null {
  const start = Math.max(0, Math.floor(s / STEP));
  for (let i = start; i < bikeSamples.length; i++) {
    const c = bikeSamples[i].curvature;
    if (Math.abs(c) > 0.006) {
      return { distance: Math.max(0, i * STEP - s), dir: c > 0 ? 1 : -1, curvature: Math.abs(c) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// RUN: the shore path, out along the lake and back.
// ---------------------------------------------------------------------------

export const RUN_LENGTH = 800;
export const RUN_TURN = RUN_LENGTH / 2;

/** The lake is an ellipse; the shore path hugs its southern edge. */
export const LAKE_CX = 0;
export const LAKE_CZ = 700;
export const LAKE_RX = 620;
export const LAKE_RZ = 700;

/** The z of the lake's southern shore at a given x. */
export function shoreZ(x: number): number {
  const u = Math.min(0.999, Math.abs(x) / LAKE_RX);
  return LAKE_CZ - LAKE_RZ * Math.sqrt(1 - u * u);
}

const RUN_STEP = 4;
const runSamples: Sample[] = [];
{
  // East along the shore from the beach, 12 m back from the water.
  let x = 30;
  let s = 0;
  while (s <= RUN_TURN + RUN_STEP * 2) {
    const z = shoreZ(x) - 12;
    const zNext = shoreZ(x + 1) - 12;
    const heading = Math.atan2(1, zNext - z);
    runSamples.push({ x, z, y: 1.2, heading, grade: 0, curvature: 0 });
    const dz = zNext - z;
    const dx = RUN_STEP / Math.sqrt(1 + dz * dz);
    x += dx;
    s += RUN_STEP;
  }
}

export function runAt(s: number): Sample {
  const out = s <= RUN_TURN;
  const local = out ? s : RUN_TURN - (s - RUN_TURN);
  const t = Math.max(0, Math.min(runSamples.length - 1, local / RUN_STEP));
  const i = Math.floor(t);
  const a = runSamples[i];
  const b = runSamples[Math.min(runSamples.length - 1, i + 1)];
  const f = t - i;
  const heading = a.heading + (b.heading - a.heading) * f;
  return {
    x: a.x + (b.x - a.x) * f,
    z: a.z + (b.z - a.z) * f,
    y: a.y,
    heading: out ? heading : heading + Math.PI,
    grade: 0,
    curvature: 0,
  };
}

/** Sim metres to the numbers on the bib. */
export const REAL = {
  swimMetres: 1500 / SWIM_LENGTH,
  bikeKm: 40 / BIKE_LENGTH,
  climbFeet: 1700 / BIKE_CLIMB,
  runKm: 10 / RUN_LENGTH,
};
