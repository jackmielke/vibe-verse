/**
 * The Dipsea — the trail as data.
 *
 * Mill Valley to Stinson Beach is 7.3 miles and about 2,200 feet of climbing
 * spread over three real hills: the stairs out of Old Mill Park, Dynamite and
 * Cardiac out of Muir Woods, and Insult on the way into Stinson. The profile
 * below is that route, mile by mile, taken from the course as it is actually
 * run rather than from a topo map — the Dipsea is famous for the places where
 * the two disagree.
 *
 * Everything in the world is derived from this one table. The spline through
 * the control points gives the trail its shape on the ground; the elevation
 * column gives every section its grade; and the terrain, the trees, the fog
 * and the runner's legs all read the same numbers, so they cannot argue.
 *
 * Scale: a mile is 400 metres here and a foot is 0.1 metres. The horizontal
 * compression is so a run takes minutes rather than an hour, and the vertical
 * one is a little gentler so the grades come out *steeper* than life — which
 * is the correct exaggeration, because the Dipsea feels steeper than it is.
 */
import * as THREE from "three";

export const METRES_PER_MILE = 400;
export const METRES_PER_FOOT = 0.1;
export const COURSE_MILES = 7.3;
export const COURSE_LENGTH = COURSE_MILES * METRES_PER_MILE;

export interface Section {
  /** Where the section starts, in miles from Old Mill Park. */
  mile: number;
  name: string;
  /** What a runner would say about it. Shown once, on entering. */
  note: string;
  /** Which kind of ground you are on, for trees and colour. */
  biome: "town" | "stairs" | "redwoods" | "creek" | "chaparral" | "ridge" | "ravine" | "beach";
}

export const SECTIONS: Section[] = [
  { mile: 0.0, name: "Old Mill Park", note: "Mill Valley. Seven point three miles to the ocean.", biome: "town" },
  { mile: 0.2, name: "The Stairs", note: "688 steps, in three flights. Nobody runs all of them.", biome: "stairs" },
  { mile: 0.8, name: "Windy Gap", note: "Top of the stairs. Panoramic Highway, then the drop.", biome: "chaparral" },
  { mile: 1.3, name: "Suicide", note: "The shortcut straight down. Careful legs.", biome: "redwoods" },
  { mile: 2.0, name: "Muir Woods", note: "Redwood Creek. The one reliable water for miles.", biome: "creek" },
  { mile: 2.4, name: "Dynamite", note: "The hill that gives the section its name.", biome: "redwoods" },
  { mile: 3.1, name: "Hogsback", note: "Out of the trees and onto the spine of the hill.", biome: "chaparral" },
  { mile: 3.7, name: "Cardiac", note: "The top: 1,360 feet. On a clear day, the whole Pacific.", biome: "ridge" },
  { mile: 4.3, name: "The Swoop", note: "Downhill at last, and the fog starts here.", biome: "ridge" },
  { mile: 5.0, name: "Steep Ravine", note: "Ladder, creek, ferns. It is as steep as it says.", biome: "ravine" },
  { mile: 6.1, name: "Insult", note: "One more hill, named honestly.", biome: "chaparral" },
  { mile: 6.6, name: "Panoramic", note: "The last drop, road then trail, into town.", biome: "chaparral" },
  { mile: 7.1, name: "Stinson Beach", note: "The ocean. Touch it.", biome: "beach" },
];

/**
 * Elevation, in feet, at mile marks. Linear between them — the sections are
 * short enough that a smoother curve would only hide the stairs.
 */
const PROFILE: [number, number][] = [
  [0.0, 80],
  [0.15, 120],
  [0.25, 300],
  [0.4, 480],
  [0.55, 560],
  [0.8, 760],
  [1.0, 800],
  [1.3, 700],
  [1.7, 400],
  [2.0, 190],
  [2.15, 200],
  [2.4, 260],
  [2.8, 620],
  [3.1, 900],
  [3.4, 1000],
  [3.7, 1360],
  [3.9, 1330],
  [4.3, 1100],
  [4.7, 900],
  [5.0, 800],
  [5.4, 460],
  [5.8, 260],
  [6.1, 220],
  [6.35, 500],
  [6.6, 420],
  [6.9, 160],
  [7.1, 30],
  [7.3, 6],
];

/** Elevation in feet at a mile mark, clamped to the course. */
export function elevationFeet(mile: number): number {
  const m = Math.max(0, Math.min(COURSE_MILES, mile));
  for (let i = 1; i < PROFILE.length; i++) {
    const [m0, e0] = PROFILE[i - 1];
    const [m1, e1] = PROFILE[i];
    if (m <= m1) {
      const t = (m - m0) / (m1 - m0);
      return e0 + (e1 - e0) * t;
    }
  }
  return PROFILE[PROFILE.length - 1][1];
}

/** Grade at a mile mark as rise/run, positive uphill in the Stinson direction. */
export function gradeAt(mile: number): number {
  const d = 0.02;
  const a = elevationFeet(mile - d) * METRES_PER_FOOT;
  const b = elevationFeet(mile + d) * METRES_PER_FOOT;
  return (b - a) / (2 * d * METRES_PER_MILE);
}

export function sectionAt(mile: number): Section {
  let s = SECTIONS[0];
  for (const sec of SECTIONS) if (mile >= sec.mile) s = sec;
  return s;
}

/**
 * The trail's shape on the ground. Mill Valley is east, Stinson is west, and
 * the trail wanders the way a trail does: north around the shoulder of the
 * hill, south down into the creek, a long bend over the top.
 *
 * Control points are in world metres; x runs west, z runs south.
 */
const GROUND_POINTS: [number, number][] = [
  [0, 0],
  [90, -60],
  [180, -130],
  [300, -110],
  [420, -40],
  [560, 40],
  [700, 90],
  [860, 60],
  [1020, -30],
  [1180, -90],
  [1340, -60],
  [1480, 20],
  [1620, 100],
  [1780, 150],
  [1960, 120],
  [2140, 40],
  [2320, -30],
  [2500, -80],
  [2680, -60],
  [2840, -10],
  [2920, 0],
];

/**
 * A point on the trail, by arc length in metres from the start. The curve is
 * sampled once into a dense table so lookups are cheap enough for a terrain
 * with sixty thousand vertices to make.
 */
export interface TrailPoint {
  x: number;
  y: number;
  z: number;
  /** Unit direction of travel toward Stinson, on the ground plane. */
  dx: number;
  dz: number;
  mile: number;
}

class Trail {
  private readonly curve: THREE.CatmullRomCurve3;
  private readonly table: TrailPoint[] = [];
  private readonly step = 2;
  readonly length: number;

  constructor() {
    const pts = GROUND_POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.curve = new THREE.CatmullRomCurve3(pts, false, "centripetal", 0.5);
    // The ground curve's own length is what we walk along; the mile scale is
    // then fitted to it so mile 7.3 lands exactly on the last control point.
    const n = 4000;
    const samples = this.curve.getSpacedPoints(n);
    let len = 0;
    for (let i = 1; i <= n; i++) len += samples[i].distanceTo(samples[i - 1]);
    this.length = len;
    const count = Math.ceil(len / this.step) + 1;
    for (let i = 0; i < count; i++) {
      const s = Math.min(len, i * this.step);
      const u = s / len;
      const p = this.curve.getPointAt(u);
      const t = this.curve.getTangentAt(u);
      const mile = (s / len) * COURSE_MILES;
      this.table.push({
        x: p.x,
        y: elevationFeet(mile) * METRES_PER_FOOT,
        z: p.z,
        dx: t.x,
        dz: t.z,
        mile,
      });
    }
  }

  /** Metres per mile along *this* curve (close to METRES_PER_MILE). */
  get metresPerMile(): number {
    return this.length / COURSE_MILES;
  }

  at(s: number): TrailPoint {
    const c = Math.max(0, Math.min(this.length, s));
    const f = c / this.step;
    const i = Math.min(this.table.length - 2, Math.floor(f));
    const t = f - i;
    const a = this.table[i];
    const b = this.table[i + 1];
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
      dx: a.dx + (b.dx - a.dx) * t,
      dz: a.dz + (b.dz - a.dz) * t,
      mile: a.mile + (b.mile - a.mile) * t,
    };
  }

  /** Nearest table sample to a ground position, plus the distance to it. */
  nearest(x: number, z: number): { point: TrailPoint; dist: number } {
    // Coarse scan every 10th sample, then refine — the trail is 2,900 m of
    // gentle curves and this is called once per terrain vertex at build time.
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.table.length; i += 10) {
      const p = this.table[i];
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const lo = Math.max(0, best - 10);
    const hi = Math.min(this.table.length - 1, best + 10);
    for (let i = lo; i <= hi; i++) {
      const p = this.table[i];
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return { point: this.table[best], dist: Math.sqrt(bestD) };
  }
}

export const TRAIL = new Trail();

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

function hash(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function vnoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

export function fbm(x: number, z: number, octaves = 4): number {
  let v = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    v += amp * vnoise(x * f, z * f);
    amp *= 0.5;
    f *= 2.07;
  }
  return v;
}

/**
 * Height of the ground anywhere.
 *
 * The trail is a shelf cut into a hillside: near it the ground *is* the
 * trail's elevation, and away from it the hill keeps rising on the uphill
 * side and falling on the downhill side, with noise for the folds. The whole
 * mountain sinks to sea level west of Stinson, which is where the ocean is.
 */
export function groundHeight(x: number, z: number): number {
  const { point, dist } = TRAIL.nearest(x, z);
  // Which side of the trail: uphill is north (negative z) for the first half
  // and south for the second — the mountain is to the runner's right going
  // out through the woods, then to the left along the ridge. Encoded as the
  // cross product against the direction of travel, flipped past Cardiac.
  const side = (x - point.x) * point.dz - (z - point.z) * point.dx;
  const flip = point.mile > 3.8 ? -1 : 1;
  const uphill = side * flip;
  const shelf = Math.max(0, 1 - dist / 14);
  const slope = Math.tanh(uphill / 120) * 90 * (0.6 + 0.4 * Math.sin(point.mile * 1.3));
  const folds = (fbm(x * 0.006, z * 0.006, 4) - 0.5) * 60 + (fbm(x * 0.03, z * 0.03, 3) - 0.5) * 8;
  let h = point.y + (slope + folds) * (1 - shelf);
  // Sea level past the beach, and a soft shoulder down to it.
  const beach = Math.max(0, (x - (TRAIL.length - 60)) / 120);
  h = h * Math.max(0, 1 - beach) - 3 * Math.min(1, beach);
  // Richardson Bay is behind the start, low and flat.
  const bay = Math.max(0, (-x - 80) / 160);
  h = h * Math.max(0, 1 - bay) - 3 * Math.min(1, bay);
  return h;
}
