/**
 * San Palmas — the atlas.
 *
 * THE SINGLE SOURCE OF TRUTH FOR WORLD LAYOUT. Terrain shapes the land from
 * it, the city lays streets inside its districts, landmarks anchor to its
 * coordinates and vegetation plants against its biomes. If two modules ever
 * disagree about where the shoreline is, it's because one of them stopped
 * reading this file.
 *
 * Geography: a tropical retelling of the San Francisco peninsula. The
 * headland sits north-west, the bay fills the east, the open Pacific runs off
 * the west edge, and the whole thing has been dragged 20° closer to the
 * equator — the hills carry jungle instead of scrub and the shallows go
 * turquoise.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre. North is -Z.
 */
import * as THREE from "three";

/** Half-extent of the playable square, metres. */
export const WORLD_SIZE = 3000;
/** Sea level in world Y. Everything below this is water. */
export const SEA_LEVEL = 0;
/** Beyond this radius the land always falls away to deep ocean. */
export const LAND_RADIUS = 2100;

export interface Hill {
  name: string;
  x: number;
  z: number;
  /** Peak height above sea level, metres. */
  height: number;
  /** Falloff radius, metres. */
  radius: number;
  /** 1 = round dome, >1 = sharper peak. */
  sharpness?: number;
}

/**
 * The hills that give San Palmas its skyline. Heights are exaggerated ~1.6×
 * over real SF so the descents read dramatically from street level.
 */
export const HILLS: Hill[] = [
  { name: "Twin Peaks", x: -260, z: 260, height: 195, radius: 620, sharpness: 1.35 },
  { name: "Mount Palma", x: -520, z: 420, height: 168, radius: 520, sharpness: 1.4 },
  { name: "Nob Hill", x: 60, z: -360, height: 104, radius: 330 },
  { name: "Russian Hill", x: -80, z: -620, height: 96, radius: 300 },
  { name: "Telegraph Hill", x: 430, z: -760, height: 86, radius: 210, sharpness: 1.5 },
  { name: "Potrero", x: 420, z: 380, height: 62, radius: 380 },
  { name: "Presidio Ridge", x: -820, z: -520, height: 118, radius: 560 },
  { name: "Bernal", x: 180, z: 760, height: 74, radius: 300 },
];

export interface District {
  key: string;
  name: string;
  x: number;
  z: number;
  radius: number;
  /** Drives building height, density and palette in the city generator. */
  kind: "downtown" | "victorian" | "chinatown" | "wharf" | "mission" | "industrial" | "resort";
}

export const DISTRICTS: District[] = [
  { key: "downtown", name: "Palma Centro", x: 420, z: -420, radius: 380, kind: "downtown" },
  { key: "chinatown", name: "Little Canton", x: 250, z: -620, radius: 190, kind: "chinatown" },
  { key: "wharf", name: "Pier Verde", x: 380, z: -960, radius: 300, kind: "wharf" },
  { key: "nob", name: "Alta Loma", x: 40, z: -380, radius: 280, kind: "victorian" },
  { key: "haight", name: "Calle Flores", x: -420, z: 60, radius: 340, kind: "victorian" },
  { key: "mission", name: "La Misión", x: 160, z: 340, radius: 420, kind: "mission" },
  { key: "dogpatch", name: "Astillero", x: 560, z: 520, radius: 300, kind: "industrial" },
  { key: "sunset", name: "Costa Dorada", x: -900, z: 380, radius: 460, kind: "resort" },
];

export interface Landmark {
  key: string;
  name: string;
  x: number;
  z: number;
  /** Informational — the landmark module owns real dimensions. */
  note: string;
}

export const LANDMARKS: Landmark[] = [
  { key: "bridge", name: "Puente Dorado", x: -880, z: -1080, note: "suspension bridge across the strait, spans north-south" },
  { key: "pyramid", name: "La Aguja", x: 430, z: -520, note: "tapered pyramid tower, the tallest thing downtown" },
  { key: "coit", name: "Torre Palma", x: 430, z: -760, note: "cylindrical tower on Telegraph Hill" },
  { key: "alcatraz", name: "Isla Roca", x: 260, z: -1520, note: "prison island in the bay" },
  { key: "ferry", name: "Mercado Ferry", x: 620, z: -560, note: "clocktower on the eastern waterfront" },
];

/**
 * The strait the bridge crosses — a channel cut through the northern
 * headland. Terrain must keep this underwater or the bridge spans dry land.
 */
export const STRAIT = { x: -880, zFrom: -1500, zTo: -700, halfWidth: 190 };

/** Signed "landness" at an XZ point: >0 is land, <0 is water, in metres. */
export function landSignedDistance(x: number, z: number): number {
  // Base landmass: an off-centre blob covering the west and south, with the
  // bay eaten out of the north-east.
  const r = Math.hypot(x * 1.0, (z + 120) * 0.86);
  let d = LAND_RADIUS - r;

  // The bay — a large circle bitten out of the north-east quadrant.
  const bay = 1180 - Math.hypot((x - 980) * 0.78, (z + 900) * 1.05);
  d = Math.min(d, -bay);

  // The strait under the bridge: a straight channel through the headland.
  if (z > STRAIT.zFrom && z < STRAIT.zTo) {
    const channel = STRAIT.halfWidth - Math.abs(x - STRAIT.x);
    // Taper the channel ends so it doesn't stop dead in a wall.
    const endFade = Math.min(1, Math.min(z - STRAIT.zFrom, STRAIT.zTo - z) / 160);
    d = Math.min(d, -channel * endFade);
  }

  // The Pacific: hard cut on the far west so the map has an ocean horizon.
  d = Math.min(d, x + 1560);

  // Coastline wobble — keeps the shore from reading as a drafting-compass arc.
  const wob =
    Math.sin(x * 0.0034 + z * 0.0021) * 52 +
    Math.sin(x * 0.0091 - z * 0.0072) * 24 +
    Math.sin(z * 0.0157 + 1.7) * 11;
  return d + wob;
}

/** Convenience: is this XZ position in the water? */
export function isWaterAt(x: number, z: number): boolean {
  return landSignedDistance(x, z) < 0;
}

/**
 * Base land elevation from the coastline alone — hills are added on top by
 * the terrain module. Rises steeply from the shore then flattens.
 */
export function shoreProfile(signedDist: number): number {
  if (signedDist <= 0) {
    // Underwater: shelf out gently, then drop to the deep.
    const d = -signedDist;
    return -(Math.min(d, 120) * 0.09 + Math.max(0, d - 120) * 0.045);
  }
  // Above water: a quick beach rise into a plateau around 22 m.
  return 22 * (1 - Math.exp(-signedDist / 190)) + Math.min(signedDist, 30) * 0.12;
}

/** Additive height from all named hills at an XZ point. */
export function hillHeight(x: number, z: number): number {
  let h = 0;
  for (const hill of HILLS) {
    const d = Math.hypot(x - hill.x, z - hill.z) / hill.radius;
    if (d >= 1) continue;
    // Smooth cosine dome, sharpened by the exponent.
    const t = 0.5 + 0.5 * Math.cos(d * Math.PI);
    h += hill.height * Math.pow(t, hill.sharpness ?? 1);
  }
  return h;
}

/** Nearest district to an XZ point, or null if none is within its radius. */
export function districtAt(x: number, z: number): District | null {
  let best: District | null = null;
  let bestD = Infinity;
  for (const d of DISTRICTS) {
    const dist = Math.hypot(x - d.x, z - d.z);
    if (dist < d.radius && dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

export type Biome = "ocean" | "beach" | "jungle" | "city" | "hillside" | "cliff";

/** Coarse biome classification, used by vegetation and terrain texturing. */
export function biomeAt(x: number, z: number, height: number, slope: number): Biome {
  const d = landSignedDistance(x, z);
  if (d < 0) return "ocean";
  if (d < 26 && height < 8) return "beach";
  if (slope > 0.62) return "cliff";
  if (districtAt(x, z)) return "city";
  if (height > 95) return "hillside";
  return "jungle";
}

/** The player's default spawn: the plaza at the top of Alta Loma. */
export const SPAWN = new THREE.Vector3(40, 0, -330);

/**
 * Primary avenues, as polylines in world space. The city generator lays its
 * grid against these; vehicles path along them.
 */
export const AVENUES: { key: string; points: [number, number][] }[] = [
  { key: "market", points: [[700, -480], [300, -180], [-60, 140], [-380, 420]] },
  { key: "embarcadero", points: [[640, -1000], [660, -620], [600, -260], [560, 160], [520, 560]] },
  { key: "columbus", points: [[430, -900], [300, -640], [180, -420]] },
  { key: "vanness", points: [[-120, -820], [-100, -300], [-80, 200], [-60, 700]] },
  { key: "geary", points: [[-1100, -180], [-700, -230], [-300, -290], [140, -360], [460, -420]] },
];
