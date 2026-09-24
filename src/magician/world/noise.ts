/**
 * Value noise and the valley's height field.
 *
 * `heightAt` is the one function everything agrees on: the terrain mesh
 * samples it, props sit on it, the player walks on it, water sits where it
 * says the floor is low. It is deterministic, so a spawn at (x, z) lands on
 * the same ground in every browser.
 */

function hash(ix: number, iz: number): number {
  let h = ix * 374761393 + iz * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return ((h >>> 0) % 1000) / 1000;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

export function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fz = smooth(z - iz);
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}

export function fbm(x: number, z: number, octaves = 4): number {
  let v = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    v += valueNoise(x * f, z * f) * amp;
    amp *= 0.5;
    f *= 2.1;
  }
  return v;
}

export const WORLD_HALF = 240;

/** The river's centre line: a gentle S from north-west to south-east. */
export function riverCentre(z: number): number {
  return 26 + Math.sin(z * 0.035) * 14 + Math.sin(z * 0.011 + 1.3) * 10;
}

/**
 * Terrain height in metres. A flat valley floor near the origin, rolling
 * hills outward, a ridge on the north side and a mountain at the head of the
 * valley (north-east). The river cuts a shallow channel.
 */
export function heightAt(x: number, z: number): number {
  const r = Math.hypot(x, z);
  // Broad bowl: flat within ~60 m, rising smoothly beyond.
  const bowl = Math.max(0, r - 55) ** 1.35 * 0.012;
  const rolling = (fbm(x * 0.012 + 3.1, z * 0.012 + 7.7, 4) - 0.5) * 9 * Math.min(1, r / 120 + 0.25);
  const detail = (fbm(x * 0.07, z * 0.07, 3) - 0.5) * 1.1;
  // The mountain: a big cone to the north-east.
  const mx = 150, mz = -170;
  const md = Math.hypot(x - mx, z - mz);
  const mountain = Math.max(0, 1 - md / 210) ** 1.7 * 150;
  // A ridge along the north.
  const ridge = Math.max(0, 1 - Math.abs(z + 175) / 70) * Math.max(0, 1 - Math.abs(x + 60) / 200) * 55;
  // The valley floor sits a little above the water so the river stays in
  // its banks and the square is not a marsh.
  let h = 1.4 + bowl + rolling + detail + mountain + ridge;
  // Shrine hill: a rounded knoll to the south-west.
  const sd = Math.hypot(x + 46, z + 62);
  h += Math.max(0, 1 - sd / 34) ** 1.6 * 11;
  // Paddies: a terrace to the south-east, gently stepped.
  const pd = Math.hypot((x - 42) / 1.4, z - 30);
  if (pd < 34) {
    const t = Math.max(0, 1 - pd / 34);
    const stepped = (Math.floor((z - 30) / 9) + 3) * 0.35;
    h = h * (1 - t) + (0.6 + stepped) * t;
  }
  // The lake bed.
  const ld = Math.hypot(x - 60, z - 56);
  if (ld < 22) h -= Math.max(0, 1 - ld / 22) ** 1.2 * 3.5;
  // The river, carved last so nothing fills it back in. It used to be a
  // dent subtracted early, and the paddies' terraces blended it away: the
  // river was dry for most of its length. Now it is a bed below the water
  // line with banks that ease up to whatever the land is, fading out where
  // the land is high, which is where it springs from.
  const rd = Math.abs(x - riverCentre(z));
  if (rd < 11) {
    const bed = WATER_LEVEL - 0.3 - 0.9 * Math.max(0, 1 - (rd / 4.2) ** 2);
    const bank = smoothstep(3.4, 11, rd);
    const carved = bed + (h - bed) * bank;
    const strength = 1 - smoothstep(6, 13, h);
    if (carved < h) h += (carved - h) * strength;
  }
  return h;
}

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export const WATER_LEVEL = -0.35;

export function riverDistance(x: number, z: number): number {
  return Math.abs(x - riverCentre(z));
}
