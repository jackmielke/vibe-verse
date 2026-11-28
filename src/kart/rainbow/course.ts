/**
 * PRISM SKYWAY: the course DNA, as pure data and pure functions.
 *
 * A rainbow ribbon strung between two cloud decks, about 560 m up. The lap
 * runs the Launch Straight north, climbs the Aurora Sweep, drops down the
 * Starfall Chute and jumps the Comet Gap, swings through Halo Hairpin, dives
 * *under* the Launch Straight at the Undercross, and comes home round the long
 * banked Nebula Helix.
 *
 * Everything the physics reads lives here as stations one metre apart, each
 * with a full road frame, exactly like Sunset Bluff's spline: the kart physics,
 * the AI and the items only ever see a `TrackService`, so the karts drive on
 * this course with the same feel they have on the other one.
 *
 * The edges are mostly railed. Three stretches are deliberately open, and the
 * Comet Gap is a real hole: falling off is part of this course.
 */
import * as THREE from "three";

/** Kart-scale: half the drivable width, in metres. */
export const HALF_WIDTH = 8.5;
/** Rail face sits this far outside the drivable edge. */
export const RAIL_OFFSET = 0.5;
export const RAIL_HEIGHT = 1.1;
export const DS = 1;
/** Metres from the first control point to the start line. */
const START = 70;
/**
 * The whole course rides this high: about 1,900 m, above Vibe Summit's own
 * 1,524 m peak, which sits right under the middle of the lap.
 */
export const ALT = 1350;
/** Where the Vibe Summit heightfield is placed: its summit ends up at (0, 1524, SUMMIT_Z_HERE). */
export const MOUNTAIN_OFFSET = { x: 0, z: 2360 };

/**
 * The centreline, as control points for a closed centripetal Catmull-Rom.
 * Order is the direction of travel. y is metres above sea level.
 */
const POINTS: [number, number, number][] = [
  // Launch Straight, heading north (-z). The line sits at the first point.
  [0, 560 + ALT, 150],
  [0, 560 + ALT, 60],
  [0, 561 + ALT, -40],
  [0, 563 + ALT, -140],
  // Aurora Sweep: a long climbing right.
  [14, 567 + ALT, -220],
  [62, 574 + ALT, -282],
  [140, 584 + ALT, -310],
  [222, 592 + ALT, -292],
  [282, 596 + ALT, -238],
  // Starfall Chute, heading south (+z) and falling.
  [312, 594 + ALT, -160],
  [322, 586 + ALT, -80],
  [326, 577 + ALT, -10],
  [326, 570 + ALT, 60],
  // Halo Hairpin: a tight right, back north.
  [318, 566 + ALT, 128],
  [288, 563 + ALT, 176],
  [238, 561 + ALT, 188],
  [196, 559 + ALT, 160],
  [184, 556 + ALT, 100],
  // Down toward the Undercross, swinging left (west).
  [178, 551 + ALT, 30],
  [150, 546 + ALT, -24],
  [96, 541 + ALT, -48],
  [30, 539 + ALT, -54],
  [-40, 540 + ALT, -50],
  [-110, 543 + ALT, -34],
  // Nebula Helix: a long banked left that wraps round to the south and east.
  [-168, 547 + ALT, 4],
  [-200, 551 + ALT, 64],
  [-204, 555 + ALT, 132],
  [-180, 558 + ALT, 196],
  [-130, 560 + ALT, 240],
  [-70, 560 + ALT, 252],
  [-24, 560 + ALT, 226],
];

/** Sections in lap order: arc ranges in fractions of the lap, measured after build. */
export const SECTION_NAMES = [
  { id: "launch", label: "Launch Straight", cp: 0 },
  { id: "aurora", label: "Aurora Sweep", cp: 4 },
  { id: "chute", label: "Starfall Chute", cp: 9 },
  { id: "hairpin", label: "Halo Hairpin", cp: 13 },
  { id: "under", label: "The Undercross", cp: 18 },
  { id: "helix", label: "Nebula Helix", cp: 24 },
] as const;

export interface Course {
  count: number;
  length: number;
  ds: number;
  pos: Float32Array;
  fwd: Float32Array;
  rgt: Float32Array;
  up: Float32Array;
  curvature: Float32Array;
  bank: Float32Array;
  grade: Float32Array;
  /** Extra height of the road surface along its normal (the kicker), per station. */
  lift: Float32Array;
  /** 1 where the road exists, 0 over the Comet Gap. */
  solid: Uint8Array;
  /** Rail on [left, right], per station. */
  railL: Uint8Array;
  railR: Uint8Array;
  /** Boost pad lateral band [l0, l1] per station, or NaN where there is none. */
  boost0: Float32Array;
  boost1: Float32Array;
  /** Station nearest a control point, for authoring things against the layout. */
  stationNear(x: number, y: number, z: number): number;
  /** Named spans in metres. */
  spans: Record<string, { start: number; end: number }>;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Bank gain: radians of bank per unit of curvature. Clamped to a lean that still reads as a road. */
const BANK_GAIN = 16;
const BANK_MAX = 0.42;

export function buildCourse(): Course {
  const curve = new THREE.CatmullRomCurve3(
    POINTS.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
    true,
    "centripetal",
    0.5,
  );

  // Arc-length table over the curve parameter, then stations every DS metres.
  const FINE = 8192;
  const fineS = new Float64Array(FINE + 1);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  curve.getPoint(0, a);
  for (let i = 1; i <= FINE; i++) {
    curve.getPoint(i / FINE, b);
    fineS[i] = fineS[i - 1] + a.distanceTo(b);
    a.copy(b);
  }
  const total = fineS[FINE];
  const count = Math.round(total / DS);
  const ds = total / count;

  const pos = new Float32Array(count * 3);
  let k = 0;
  // The line sits START metres along from the first control point, so the
  // whole grid lines up behind it on the straight rather than in the helix.
  let prevS = -1;
  for (let i = 0; i < count; i++) {
    const s = (i * ds + START) % total;
    if (s < prevS) k = 0;
    prevS = s;
    while (k < FINE - 1 && fineS[k + 1] < s) k++;
    const f = (s - fineS[k]) / Math.max(1e-9, fineS[k + 1] - fineS[k]);
    curve.getPoint((k + f) / FINE, a);
    pos[i * 3] = a.x;
    pos[i * 3 + 1] = a.y;
    pos[i * 3 + 2] = a.z;
  }

  const at = (i: number, out: THREE.Vector3) => {
    const j = ((i % count) + count) % count;
    return out.set(pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]);
  };

  // Forward, horizontal curvature (+ = right) and grade.
  const fwd = new Float32Array(count * 3);
  const curvature = new Float32Array(count);
  const grade = new Float32Array(count);
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    at(i - 1, p0);
    at(i + 1, p1);
    const d = p1.sub(p0).normalize();
    fwd[i * 3] = d.x;
    fwd[i * 3 + 1] = d.y;
    fwd[i * 3 + 2] = d.z;
    grade[i] = d.y / Math.max(1e-6, Math.hypot(d.x, d.z));
  }
  const W = 4;
  for (let i = 0; i < count; i++) {
    const i0 = (i - W + count) % count;
    const i1 = (i + W) % count;
    const h0 = Math.atan2(fwd[i0 * 3], -fwd[i0 * 3 + 2]);
    const h1 = Math.atan2(fwd[i1 * 3], -fwd[i1 * 3 + 2]);
    let dh = h1 - h0;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    // Heading measured clockwise from north, so +dh is a right turn.
    curvature[i] = dh / (2 * W * ds);
  }

  // Bank from curvature, smoothed over ~40 m so it rolls in and out.
  const rawBank = new Float32Array(count);
  for (let i = 0; i < count; i++) rawBank[i] = clamp(curvature[i] * BANK_GAIN, -BANK_MAX, BANK_MAX);
  const bank = new Float32Array(count);
  const R = Math.round(20 / ds);
  for (let i = 0; i < count; i++) {
    let acc = 0;
    let w = 0;
    for (let j = -R; j <= R; j++) {
      const wt = 1 - Math.abs(j) / (R + 1);
      acc += rawBank[(i + j + count) % count] * wt;
      w += wt;
    }
    bank[i] = acc / w;
  }

  // Frames: up = world up minus its forward part, rolled by the bank toward the right.
  const rgt = new Float32Array(count * 3);
  const up = new Float32Array(count * 3);
  const F = new THREE.Vector3();
  const U = new THREE.Vector3();
  const Rv = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    F.set(fwd[i * 3], fwd[i * 3 + 1], fwd[i * 3 + 2]);
    U.set(0, 1, 0).addScaledVector(F, -F.y).normalize();
    Rv.crossVectors(F, U).normalize();
    const c = Math.cos(bank[i]);
    const s = Math.sin(bank[i]);
    const ux = U.x * c + Rv.x * s;
    const uy = U.y * c + Rv.y * s;
    const uz = U.z * c + Rv.z * s;
    U.set(ux, uy, uz).normalize();
    Rv.crossVectors(F, U).normalize();
    rgt[i * 3] = Rv.x;
    rgt[i * 3 + 1] = Rv.y;
    rgt[i * 3 + 2] = Rv.z;
    up[i * 3] = U.x;
    up[i * 3 + 1] = U.y;
    up[i * 3 + 2] = U.z;
  }

  const stationNear = (x: number, y: number, z: number) => {
    let best = Infinity;
    let bi = 0;
    for (let i = 0; i < count; i++) {
      const dx = pos[i * 3] - x;
      const dy = pos[i * 3 + 1] - y;
      const dz = pos[i * 3 + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    return bi;
  };

  const spans: Record<string, { start: number; end: number }> = {};
  const starts = SECTION_NAMES.map((sec) => {
    if (sec.id === "launch") return 0;
    const [x, y, z] = POINTS[sec.cp];
    return stationNear(x, y, z) * ds;
  });
  SECTION_NAMES.forEach((sec, i) => {
    spans[sec.id] = { start: starts[i], end: i + 1 < starts.length ? starts[i + 1] : total };
  });

  // --- features, in metres along the lap ----------------------------------
  const chute = spans.chute;
  // The Comet Gap: a kicker, then 16 m of nothing, two thirds of the way down the chute.
  const gapStart = chute.start + (chute.end - chute.start) * 0.55;
  const gapEnd = gapStart + 16;
  const kickLen = 18;
  const kickH = 1.8;

  const lift = new Float32Array(count);
  const solid = new Uint8Array(count);
  const railL = new Uint8Array(count);
  const railR = new Uint8Array(count);
  const boost0 = new Float32Array(count).fill(NaN);
  const boost1 = new Float32Array(count).fill(NaN);

  // Open stretches: no rails, nothing to save you. Everywhere else has rails.
  const open: [number, number][] = [
    [spans.launch.start + 40, spans.launch.end - 30],
    [gapStart - 40, gapEnd + 30],
    [spans.under.start + 30, spans.under.end - 20],
  ];
  const pads: { s: number; len: number; l0: number; l1: number }[] = [
    { s: spans.launch.start + 70, len: 7, l0: -2.6, l1: 2.6 },
    { s: gapStart - kickLen - 10, len: 7, l0: -3, l1: 3 },
    { s: spans.hairpin.end - 30, len: 6, l0: 1, l1: 6.5 },
    { s: spans.helix.start + (spans.helix.end - spans.helix.start) * 0.55, len: 7, l0: -6.5, l1: -1 },
  ];

  for (let i = 0; i < count; i++) {
    const s = i * ds;
    solid[i] = s >= gapStart && s < gapEnd ? 0 : 1;
    const dz = gapStart - s;
    if (dz >= 0 && dz <= kickLen) {
      const t = 1 - dz / kickLen;
      lift[i] = kickH * t * t;
    }
    let railed = 1;
    for (const [a0, a1] of open) if (s >= a0 && s <= a1) railed = 0;
    railL[i] = railed;
    railR[i] = railed;
    for (const p of pads) {
      if (s >= p.s && s <= p.s + p.len) {
        boost0[i] = p.l0;
        boost1[i] = p.l1;
      }
    }
  }

  return {
    count,
    length: total,
    ds,
    pos,
    fwd,
    rgt,
    up,
    curvature,
    bank,
    grade,
    lift,
    solid,
    railL,
    railR,
    boost0,
    boost1,
    stationNear,
    spans: { ...spans, gap: { start: gapStart, end: gapEnd }, kick: { start: gapStart - kickLen, end: gapStart } },
  };
}

/** The kicker is a smooth curve up to the lip across the full width. */
export function liftAt(c: Course, s: number): number {
  const idx = (((s / c.ds) % c.count) + c.count) % c.count;
  const i0 = Math.floor(idx);
  const i1 = (i0 + 1) % c.count;
  const w = idx - i0;
  return c.lift[i0] * (1 - w) + c.lift[i1] * w;
}

export { smooth };
