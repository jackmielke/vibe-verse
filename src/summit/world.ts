/**
 * Vibe Summit: the ground, as pure functions.
 *
 * One big mountain whose top is 5,000 ft and whose valley floor is 300 ft.
 * World units are metres, so the summit deck sits at 1,524 m and the village
 * at 91 m; the altimeter shows feet because that is the number on the sign.
 *
 * The descent runs south (+z): the summit is at z = -2400, the village at
 * z = +2000. A smoothed corridor (the Main Run) snakes between them so a
 * skier has somewhere honest to go; everywhere else is ridged and steeper.
 *
 * Physics and the mesh read the same grid (`buildGrid`), sampled with the
 * same triangle split PlaneGeometry uses, so nobody floats above or sinks
 * into the snow by the difference between an equation and its drawing.
 */

export const FT = 3.28084;
export const SUMMIT = { x: 0, z: -2400, y: 1524 };
export const VILLAGE = { x: 0, z: 2000, y: 91.44 };
export const HALF = 5200;
export const GRID = 320;
export const CELL = (HALF * 2) / GRID;

/** A small, deterministic value noise, so the mountain is the same for everybody. */
function hash(i: number, j: number): number {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
function vnoise(x: number, z: number): number {
  const i = Math.floor(x), j = Math.floor(z);
  const fx = x - i, fz = z - j;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}
/** Ridged fbm in 0..~1: sharp crests, which is what makes it read as alpine. */
function ridged(x: number, z: number): number {
  let sum = 0, amp = 0.55, f = 1;
  for (let o = 0; o < 5; o++) {
    const n = 1 - Math.abs(vnoise(x * f, z * f) * 2 - 1);
    sum += n * n * amp;
    f *= 2.03;
    amp *= 0.5;
  }
  return sum;
}
function fbm(x: number, z: number): number {
  let sum = 0, amp = 0.5, f = 1;
  for (let o = 0; o < 4; o++) {
    sum += (vnoise(x * f, z * f) - 0.5) * amp;
    f *= 2.1;
    amp *= 0.5;
  }
  return sum;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Centre of the Main Run at a given z. */
export function runX(z: number): number {
  const t = (z - SUMMIT.z) / (VILLAGE.z - SUMMIT.z);
  const fade = smooth(0.02, 0.22, t) * (1 - smooth(0.88, 1, t));
  return 300 * Math.sin((z - SUMMIT.z) / 620) * fade;
}
export const RUN_HALF = 170;

/** Kickers on the Main Run: z of the lip, height of the lip, length of the ramp. */
export const KICKERS: { z: number; lip: number; len: number; w: number }[] = [
  { z: -1700, lip: 4.5, len: 22, w: 26 },
  { z: -900, lip: 6, len: 28, w: 30 },
  { z: -150, lip: 5, len: 24, w: 28 },
  { z: 600, lip: 7, len: 30, w: 32 },
  { z: 1350, lip: 4, len: 20, w: 26 },
];

/** Extra height a kicker adds on top of the snow. The face is a smooth curve up to the lip, then nothing. */
export function kickerAt(x: number, z: number): number {
  for (const k of KICKERS) {
    const dz = k.z - z; // metres before the lip (we ski +z)
    if (dz < 0 || dz > k.len) continue;
    const lx = Math.abs(x - runX(k.z));
    if (lx > k.w / 2) continue;
    const t = 1 - dz / k.len;
    const edge = 1 - smooth(k.w / 2 - 3, k.w / 2, lx);
    return k.lip * t * t * edge;
  }
  return 0;
}

/** The analytic landform. Use `groundAt` for anything that touches it. */
export function rawHeight(x: number, z: number): number {
  const dx = x - SUMMIT.x;
  const dz = z - SUMMIT.z;
  // Elongated down the descent, steeper on the back side.
  const d = Math.hypot(dx * 1.15, dz > 0 ? dz * 0.92 : dz * 1.6);
  const m = Math.exp(-Math.pow(d / 1650, 1.55));
  let h = 60 + 1400 * m;
  // Crags: big near the top, gentle in the valley.
  const rough = ridged(x / 900, z / 900);
  // The summit face: a wide, clean slope straight down from the deck, so the
  // first few hundred metres of every way down are open snow and not crags.
  const face = dz > 0 ? (1 - smooth(260, 480, Math.abs(dx))) * (1 - smooth(650, 1100, dz)) : 0;
  h += (rough - 0.35) * (40 + 420 * Math.pow(m, 0.8)) * (1 - 0.9 * face);
  h += fbm(x / 140, z / 140) * 14;

  // Hills that frame the valley, one of them the forest hill.
  h += 210 * Math.exp(-((x - 1500) ** 2 + (z - 1500) ** 2) / 700 ** 2);
  h += 260 * Math.exp(-((x + 1700) ** 2 + (z - 1900) ** 2) / 800 ** 2);
  h += 120 * Math.exp(-((x - 700) ** 2 + (z - 3300) ** 2) / 600 ** 2);
  // Far ranges on every side, so the horizon is mountains and not an edge.
  const edge = Math.hypot(x, z * 0.9);
  h += (250 + 1100 * ridged(x / 1400 + 7, z / 1400 - 3)) * smooth(3500, 5000, edge);

  // The Main Run: a smoothed, gently dished corridor from deck to village.
  const t = (z - SUMMIT.z) / (VILLAGE.z - SUMMIT.z);
  if (t > -0.02 && t < 1.05) {
    const lx = Math.abs(x - runX(z));
    const w = 1 - smooth(RUN_HALF * 0.65, RUN_HALF * 1.35, lx);
    if (w > 0) {
      // Smoothed height: the base profile along the run, no crags.
      const base = 60 + 1400 * m + fbm(x / 260, z / 260) * 12 + (lx / RUN_HALF) ** 2 * 10;
      h = h * (1 - w) + base * w;
    }
  }

  // The summit deck.
  const ds = Math.hypot(dx, dz);
  const deck = 1 - smooth(45, 120, ds);
  h = h * (1 - deck) + SUMMIT.y * deck;
  // The village shelf at exactly 300 ft.
  const dv = Math.hypot(x - VILLAGE.x, (z - VILLAGE.z) * 0.8);
  const shelf = 1 - smooth(200, 420, dv);
  h = h * (1 - shelf) + VILLAGE.y * shelf;
  return h;
}

export interface Grid {
  h: Float32Array;
  n: number;
}

export function buildGrid(): Grid {
  const n = GRID + 1;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = -HALF + j * CELL;
    for (let i = 0; i < n; i++) {
      const x = -HALF + i * CELL;
      h[j * n + i] = rawHeight(x, z);
    }
  }
  return { h, n };
}

/**
 * Height of the drawn surface. PlaneGeometry (rotated -90 about x) splits
 * each cell along the a-d diagonal, where a = (i, j) and d = (i+1, j+1), so
 * this does too.
 */
export function gridHeight(g: Grid, x: number, z: number): number {
  const fx = (x + HALF) / CELL;
  const fz = (z + HALF) / CELL;
  const i = Math.min(GRID - 1, Math.max(0, Math.floor(fx)));
  const j = Math.min(GRID - 1, Math.max(0, Math.floor(fz)));
  const u = Math.min(1, Math.max(0, fx - i));
  const v = Math.min(1, Math.max(0, fz - j));
  const n = g.n;
  const a = g.h[j * n + i];
  const b = g.h[j * n + i + 1];
  const c = g.h[(j + 1) * n + i];
  const d = g.h[(j + 1) * n + i + 1];
  // PlaneGeometry's triangles are (a, c, b) and (c, d, b): split on the b-c diagonal.
  if (u + v <= 1) return a + (b - a) * u + (c - a) * v;
  return d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

/** The snow under you, kickers included. */
export function groundAt(g: Grid, x: number, z: number): number {
  return gridHeight(g, x, z) + kickerAt(x, z);
}

/** Surface normal from the same surface. */
export function normalAt(g: Grid, x: number, z: number, out: { x: number; y: number; z: number }) {
  const e = 1.5;
  const hx = groundAt(g, x + e, z) - groundAt(g, x - e, z);
  const hz = groundAt(g, x, z + e) - groundAt(g, x, z - e);
  const nx = -hx, ny = 2 * e, nz = -hz;
  const l = Math.hypot(nx, ny, nz);
  out.x = nx / l;
  out.y = ny / l;
  out.z = nz / l;
  return out;
}

/** Where trees may grow: below the treeline, off the run, not on a cliff, not in the village square. */
export function treeOk(g: Grid, x: number, z: number, rnd: number): boolean {
  const h = gridHeight(g, x, z);
  if (h > 980 + rnd * 120) return false;
  const t = (z - SUMMIT.z) / (VILLAGE.z - SUMMIT.z);
  if (t > -0.05 && t < 1.02 && Math.abs(x - runX(z)) < RUN_HALF * 0.9) return false;
  if (Math.hypot(x - VILLAGE.x, z - VILLAGE.z) < 230) return false;
  const e = 4;
  const s = Math.hypot(gridHeight(g, x + e, z) - gridHeight(g, x - e, z), gridHeight(g, x, z + e) - gridHeight(g, x, z - e)) / (2 * e);
  if (s > 0.85) return false;
  if (Math.abs(x) > HALF - 200 || Math.abs(z) > HALF - 200) return false;
  return true;
}

/** Rising air for the paraglider: a column you can circle in. */
export const THERMALS: { x: number; z: number; r: number; lift: number }[] = [
  { x: 380, z: -1500, r: 70, lift: 3.4 },
  { x: -420, z: -800, r: 80, lift: 3.0 },
  { x: 520, z: 100, r: 90, lift: 3.6 },
  { x: -350, z: 900, r: 80, lift: 2.8 },
  { x: 1500, z: 1500, r: 110, lift: 3.8 },
  { x: -1600, z: 1800, r: 110, lift: 3.2 },
];

export function thermalLift(x: number, z: number): number {
  let lift = 0;
  for (const t of THERMALS) {
    const d = Math.hypot(x - t.x, z - t.z);
    if (d < t.r * 1.6) lift += t.lift * Math.max(0, 1 - (d / (t.r * 1.6)) ** 2);
  }
  return lift;
}

/** Wingsuit rings: fly through them on the way down. They sit on a good glide line, never in the snow. */
export function ringPath(): { x: number; y: number; z: number; yaw: number }[] {
  const out: { x: number; y: number; z: number; yaw: number }[] = [];
  for (let k = 0; k < 13; k++) {
    const z = SUMMIT.z + 320 + k * 310;
    const x = runX(z) + Math.sin(k * 1.7) * 120;
    const ground = rawHeight(x, z);
    const line = SUMMIT.y - 60 - (z - SUMMIT.z) / 3.1;
    out.push({ x, y: Math.max(ground + 45, line), z, yaw: Math.atan2(runX(z + 20) - runX(z - 20), 40) });
  }
  return out;
}
