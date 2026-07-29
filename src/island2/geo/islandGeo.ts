/**
 * islandGeo — the single spatial source of truth for VIBE ISLAND II.
 *
 * Same discipline as San Francisco's `sfGeo`: every system reads the world
 * through this module, so nothing can disagree about where the ground is. The
 * difference is that this world has no ground in the usual sense. It is an
 * archipelago of islands floating in a sky, each one a lens of rock hanging
 * over a cloud sea, with waterfalls that pour off the rim and evaporate before
 * they land.
 *
 * That shape drives everything. An island is defined by a 2D footprint (how
 * far it reaches) and a vertical profile (a rounded top surface you walk on,
 * and a tapering keel underneath that you see from below and while flying).
 * `surfaceHeight` answers "what do I stand on"; `isOverIsland` answers "is
 * there anything under me at all", which is the question that matters when the
 * alternative is a very long fall.
 *
 * Coordinates: 1 unit = 1 metre, +X east, +Z south, +Y up. Origin is the
 * centre of the Plaza on the main island — the spot you arrive at.
 */
import { clamp, clamp01, fbm2, ridged2, smoothstep, valueNoise2 } from "@/shared/proc/rng";

/* ------------------------------------------------------------------ *
 * World envelope
 * ------------------------------------------------------------------ */

export const WORLD = {
  /** Playable bounds; beyond this the sky haze closes in. */
  radius: 2600,
  /** The cloud sea sits at this altitude. Falling below it is the death plane. */
  cloudDeck: -190,
  /** Nothing survives below here. */
  killPlane: -520,
  /** Flight ceiling. */
  skyCeiling: 900,
  /** Where the sun sits in the day cycle by default: eternal golden hour. */
  defaultTimeOfDay: 18.35,
} as const;

export interface Vec2 {
  x: number;
  z: number;
}

/* ------------------------------------------------------------------ *
 * The islands
 * ------------------------------------------------------------------ */

export type IslandKind =
  /** The main island: plaza, palace, cove, jungle. */
  | "heart"
  /** Mid-size satellites you zipline or glide to. */
  | "satellite"
  /** Small stepping stones and set dressing. */
  | "shard";

export interface IslandDef {
  key: string;
  name: string;
  kind: IslandKind;
  /** Centre in world metres. */
  x: number;
  z: number;
  /** Footprint radius, metres. */
  radius: number;
  /** Height of the top surface above y=0 at the centre. */
  elevation: number;
  /** How domed the top surface is. 0 = flat table, 1 = strong dome. */
  dome: number;
  /**
   * How far the keel hangs below the rim, metres. Big islands have long
   * dramatic keels — the silhouette from underneath is half the appeal of a
   * floating world, so this is not a detail.
   */
  keel: number;
  /** Irregularity of the rim, 0 = a perfect disc, 1 = deeply scalloped. */
  irregularity: number;
  /** Seed offset so no two islands share a noise field. */
  seed: number;
}

/**
 * The archipelago. Laid out as a loose spiral around the heart so that from
 * the Plaza you always see two or three neighbours hanging in the haze at
 * different distances — depth cues are what make a floating world read as
 * vast rather than as a diorama.
 */
export const ISLANDS: IslandDef[] = [
  {
    key: "heart",
    name: "Vibe Island",
    kind: "heart",
    x: 0, z: 0,
    radius: 460, elevation: 0, dome: 0.55, keel: 300,
    irregularity: 0.42, seed: 1,
  },
  {
    key: "palace-rock",
    name: "The Palace Rock",
    kind: "satellite",
    x: -300, z: -420,
    radius: 190, elevation: 118, dome: 0.78, keel: 210,
    irregularity: 0.5, seed: 2,
  },
  {
    key: "snackfe",
    name: "SnackFe Terrace",
    kind: "satellite",
    x: 340, z: -190,
    radius: 140, elevation: 46, dome: 0.4, keel: 130,
    irregularity: 0.38, seed: 3,
  },
  {
    key: "grove",
    name: "The Hanging Grove",
    kind: "satellite",
    x: -420, z: 300,
    radius: 175, elevation: 62, dome: 0.5, keel: 180,
    irregularity: 0.55, seed: 4,
  },
  {
    key: "arch-isle",
    name: "Arch Isle",
    kind: "satellite",
    x: 470, z: 380,
    radius: 155, elevation: 88, dome: 0.45, keel: 165,
    irregularity: 0.47, seed: 5,
  },
  {
    key: "lantern",
    name: "Lantern Shard",
    kind: "shard",
    x: 130, z: -520, radius: 62, elevation: 150, dome: 0.7, keel: 90,
    irregularity: 0.6, seed: 6,
  },
  {
    key: "quiet",
    name: "Quiet Shard",
    kind: "shard",
    x: -620, z: -80, radius: 70, elevation: -40, dome: 0.6, keel: 100,
    irregularity: 0.62, seed: 7,
  },
  {
    key: "far-drift",
    name: "Far Drift",
    kind: "shard",
    x: 720, z: -640, radius: 88, elevation: 205, dome: 0.65, keel: 120,
    irregularity: 0.58, seed: 8,
  },
  {
    key: "low-shelf",
    name: "The Low Shelf",
    kind: "shard",
    x: -180, z: 640, radius: 96, elevation: -96, dome: 0.35, keel: 140,
    irregularity: 0.5, seed: 9,
  },
];

export const ISLAND_BY_KEY: Record<string, IslandDef> = Object.fromEntries(
  ISLANDS.map((i) => [i.key, i]),
);

/**
 * Signed distance from a point to an island's rim, in metres.
 * Positive inside, negative outside. The rim is a noisy circle rather than a
 * clean one; a perfect disc reads as a game object, a scalloped one reads as
 * rock that weather got at.
 */
export function islandSDF(x: number, z: number, isle: IslandDef): number {
  const dx = x - isle.x;
  const dz = z - isle.z;
  const d = Math.hypot(dx, dz);
  const a = Math.atan2(dz, dx);
  // Two octaves of angular noise so the rim has both broad bays and fine bite.
  const wob =
    valueNoise2(Math.cos(a) * 2.1 + isle.seed * 13, Math.sin(a) * 2.1, isle.seed) * 0.62 +
    valueNoise2(Math.cos(a) * 5.7 + isle.seed * 29, Math.sin(a) * 5.7, isle.seed + 91) * 0.30;
  const r = isle.radius * (1 + wob * isle.irregularity * 0.42);
  return r - d;
}

/** The island whose rim a point is nearest to being inside, plus that distance. */
export function nearestIsland(x: number, z: number): { isle: IslandDef; sd: number } {
  let best = ISLANDS[0];
  let bestSd = -Infinity;
  for (const isle of ISLANDS) {
    // Cheap reject: the noisy rim can only extend ~1.2x the base radius.
    const reach = isle.radius * 1.25;
    if (Math.abs(x - isle.x) > reach + 40 || Math.abs(z - isle.z) > reach + 40) continue;
    const sd = islandSDF(x, z, isle);
    if (sd > bestSd) {
      bestSd = sd;
      best = isle;
    }
  }
  if (bestSd === -Infinity) {
    // Far from everything — report the closest centre so callers can still
    // reason about direction.
    let nearest = ISLANDS[0];
    let nd = Infinity;
    for (const isle of ISLANDS) {
      const d = Math.hypot(x - isle.x, z - isle.z) - isle.radius;
      if (d < nd) {
        nd = d;
        nearest = isle;
      }
    }
    return { isle: nearest, sd: -nd };
  }
  return { isle: best, sd: bestSd };
}

/** True if there is solid ground somewhere below this column. */
export function isOverIsland(x: number, z: number): boolean {
  return nearestIsland(x, z).sd > 0;
}

/* ------------------------------------------------------------------ *
 * Surface height
 * ------------------------------------------------------------------ */

/**
 * The walkable top surface at a point, in metres. Returns `null` in open sky —
 * callers must handle that rather than receive a lie like 0, because "there is
 * no ground here" is the single most important fact in a floating world.
 */
export function surfaceHeight(x: number, z: number): number | null {
  const { isle, sd } = nearestIsland(x, z);
  if (sd <= 0) return null;

  // Rim falloff: the ground curves down to meet the cliff edge, so you get a
  // rounded lip rather than a wall meeting a plane at a right angle.
  const rim = smoothstep(0, isle.radius * 0.30, sd);

  // Dome: highest at the centre, easing to the rim.
  const t = clamp01(sd / (isle.radius * 0.95));
  const domeH = Math.sin(t * Math.PI * 0.5) * isle.radius * 0.22 * isle.dome;

  // Terrain detail. Ridged noise gives spines and gullies that read as rock;
  // plain fbm alone gives a lumpy potato.
  const nx = (x - isle.x) * 0.0042;
  const nz = (z - isle.z) * 0.0042;
  const ridges = (ridged2(nx * 1.6, nz * 1.6, 4, isle.seed * 137) - 0.5) * isle.radius * 0.10;
  const rolling = fbm2(nx, nz, 4, 2.05, 0.5, isle.seed * 311) * isle.radius * 0.075;
  const fine = fbm2(nx * 6.5, nz * 6.5, 3, 2.0, 0.5, isle.seed * 733) * 2.4;

  let h = isle.elevation + domeH + (ridges + rolling) * rim + fine * rim;

  if (isle.key === "heart") {
    // Carve the lagoon basin. A smooth bowl, plus a notch in the rim on the
    // spill bearing so the water has a defined place to leave from rather than
    // overflowing evenly all the way round like a bathtub.
    const bx = x - LAGOON.x;
    const bz = z - LAGOON.z;
    const bd = Math.hypot(bx, bz);
    if (bd < LAGOON.radius * 1.45) {
      const t = clamp01(bd / LAGOON.radius);
      // 1 at the middle of the bowl, 0 at its lip.
      const bowl = Math.pow(1 - smoothstep(0.55, 1.0, t), 1.4);
      const target = LAGOON.waterY - LAGOON.depth;
      h = h + (target - h) * bowl;

      // The spill notch: drop the lip along one bearing so the pool drains
      // toward the island's rim.
      const a = Math.atan2(bz, bx);
      let da = Math.abs(((a - LAGOON.spillAngle + Math.PI) % (Math.PI * 2)) - Math.PI);
      const notch = (1 - smoothstep(0.0, 0.42, da)) * smoothstep(0.6, 1.15, t);
      h -= notch * 9.5;
    }
  }

  return h;
}

/**
 * Ground height for a walking character: the surface, or the kill plane in
 * open sky. Use `isOverIsland` first when the distinction matters.
 */
export function walkableHeight(x: number, z: number): number {
  return surfaceHeight(x, z) ?? WORLD.killPlane;
}

/**
 * The underside of an island at a point — the keel. Only meaningful inside an
 * island's footprint. This is what you see when you glide beneath the world,
 * which is a thing players will do constantly, so it gets real shaping: a
 * tapering root with vertical erosion flutes.
 */
export function keelDepth(x: number, z: number): number | null {
  const { isle, sd } = nearestIsland(x, z);
  if (sd <= 0) return null;
  const t = clamp01(sd / isle.radius);
  // A sharp taper to a rounded point, not a cone.
  const taper = Math.pow(t, 0.62);
  const flutes =
    ridged2((x - isle.x) * 0.02, (z - isle.z) * 0.02, 3, isle.seed * 977) * isle.keel * 0.16;
  return isle.elevation - isle.keel * taper - flutes * t;
}

/** Surface normal of the top surface, via central differences. */
export function surfaceNormal(x: number, z: number, eps = 1.5): [number, number, number] {
  const h = (px: number, pz: number) => surfaceHeight(px, pz) ?? 0;
  const nx = h(x - eps, z) - h(x + eps, z);
  const nz = h(x, z - eps) - h(x, z + eps);
  const ny = 2 * eps;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** Slope in radians (0 = flat). Drives footing, grass placement and cliff rock. */
export function surfaceSlope(x: number, z: number, eps = 2.5): number {
  return Math.acos(clamp(surfaceNormal(x, z, eps)[1], -1, 1));
}

/* ------------------------------------------------------------------ *
 * Biomes
 * ------------------------------------------------------------------ */

export type Biome =
  | "cove" // warm sand at the waterline
  | "lagoon" // the shallow pool that spills off the rim
  | "meadow" // soft grass, the plaza's apron
  | "jungle" // dense canopy on the flanks
  | "terrace" // cultivated steps near SnackFe
  | "stone" // exposed rock and cliff
  | "summit"; // the bare high ground the Palace sits on

/**
 * Biome at a point. Driven by elevation above the island's own base, slope,
 * and distance to the rim — so the same rules produce a beach on the low
 * flank and bare stone on a cliff without anything being hand-painted.
 */
export function biomeAt(x: number, z: number): Biome {
  const { isle, sd } = nearestIsland(x, z);
  if (sd <= 0) return "stone";
  const h = surfaceHeight(x, z) ?? 0;
  const rel = h - isle.elevation;
  const slope = surfaceSlope(x, z);

  if (slope > 0.72) return "stone";
  // The lagoon and the sand ring around it, driven by the carved basin.
  if (isle.key === "heart") {
    const bd = Math.hypot(x - LAGOON.x, z - LAGOON.z);
    if (bd < LAGOON.radius * 1.18) {
      if (h < LAGOON.waterY - 0.15) return "lagoon";
      if (h < LAGOON.waterY + 2.6) return "cove";
    }
  }
  if (sd < isle.radius * 0.10) return "cove";
  if (rel > isle.radius * 0.17) return "summit";
  if (isle.key === "snackfe") return "terrace";
  const jungleNoise = fbm2(x * 0.0031, z * 0.0031, 3, 2, 0.5, isle.seed * 51);
  if (jungleNoise > 0.02 && slope < 0.55) return "jungle";
  return "meadow";
}

/**
 * The lagoon basin on the heart island.
 *
 * A dome is highest at its centre, so a lagoon "in the middle" would sit on
 * top of a hill — water does not do that. The basin is therefore carved
 * explicitly: an off-centre bowl cut into the dome, with a low lip on the
 * seaward side so the pool has somewhere to overflow. That overflow is The
 * Spill, and the whole reason the lagoon exists is to have something that
 * visibly pours off the edge of the world.
 */
export const LAGOON = {
  /** Centre of the basin, world metres (on the heart island). */
  x: 150,
  z: 105,
  /** Radius of the carved bowl. */
  radius: 132,
  /** Surface height of the water, absolute metres. */
  waterY: 21,
  /** How far below the water the bed sits at the deepest point. */
  depth: 7.5,
  /** Bearing of the low lip where the water escapes, radians. */
  spillAngle: 0.62,
} as const;

/** Kept for callers that only need the water plane's height. */
export const LAGOON_LEVEL = LAGOON.waterY;

/** Absolute Y of the lagoon surface. */
export const LAGOON_Y = LAGOON.waterY;

/* ------------------------------------------------------------------ *
 * Landmarks — the canon, rebuilt
 * ------------------------------------------------------------------ */

export type LandmarkKind =
  | "plaza"
  | "palace"
  | "snackfe"
  | "arch"
  | "graffiti-wall"
  | "zeppelin-mast"
  | "zipline-tower"
  | "lighthouse"
  | "waterfall"
  | "bridge"
  | "shrine";

export interface LandmarkDef {
  key: string;
  kind: LandmarkKind;
  name: string;
  /** Which island it sits on. */
  island: string;
  x: number;
  z: number;
  /** Yaw, radians. */
  rotation: number;
  /** Footprint radius — the generator keeps vegetation and rocks out of it. */
  radius: number;
  /** Shown on the compass. */
  navpoint: boolean;
  /** One line of flavour, surfaced when you discover it. */
  blurb: string;
}

export const LANDMARKS: LandmarkDef[] = [
  {
    key: "plaza", kind: "plaza", name: "The Plaza", island: "heart",
    x: 0, z: 0, rotation: 0, radius: 68, navpoint: true,
    blurb: "Where everyone arrives. The mosaic underfoot was laid one tile per visitor.",
  },
  {
    key: "palace", kind: "palace", name: "THE PALACE", island: "palace-rock",
    x: -300, z: -420, rotation: 0.4, radius: 74, navpoint: true,
    blurb: "Ninjas live here. They are extremely welcoming, which is the confusing part.",
  },
  {
    key: "snackfe", kind: "snackfe", name: "SnackFe", island: "snackfe",
    x: 340, z: -190, rotation: -0.6, radius: 40, navpoint: true,
    blurb: "The cafe at the edge of the sky. VIBE FM broadcasts from the back room.",
  },
  {
    key: "arch", kind: "arch", name: "The Arch", island: "arch-isle",
    x: 470, z: 380, rotation: 0.9, radius: 52, navpoint: true,
    blurb: "Step through and you are somewhere else. Nobody has explained how.",
  },
  {
    key: "graffiti", kind: "graffiti-wall", name: "The Graffiti Wall", island: "heart",
    x: 96, z: 118, rotation: -0.35, radius: 26, navpoint: true,
    blurb: "Everything written here was written by somebody who was actually here.",
  },
  {
    key: "mast", kind: "zeppelin-mast", name: "The Mooring Mast", island: "heart",
    x: -118, z: -96, rotation: 0, radius: 22, navpoint: true,
    blurb: "The zeppelin comes back every few minutes. You can be on it when it leaves.",
  },
  {
    key: "zip-heart", kind: "zipline-tower", name: "Zipline — Heart", island: "heart",
    x: -232, z: -204, rotation: 0, radius: 14, navpoint: false,
    blurb: "Grab the handle. Do not think about it too hard.",
  },
  {
    key: "zip-grove", kind: "zipline-tower", name: "Zipline — Grove", island: "grove",
    x: -420, z: 300, rotation: 0, radius: 14, navpoint: false,
    blurb: "The far end of the longest line on the island.",
  },
  {
    key: "lighthouse", kind: "lighthouse", name: "The Lantern", island: "lantern",
    x: 130, z: -520, rotation: 0, radius: 20, navpoint: true,
    blurb: "It does not warn anyone away. It just likes being on.",
  },
  {
    key: "falls-main", kind: "waterfall", name: "The Spill", island: "heart",
    x: 214, z: 176, rotation: 2.1, radius: 34, navpoint: true,
    blurb: "The lagoon pours off the rim here and never reaches anything.",
  },
  {
    key: "shrine", kind: "shrine", name: "The Quiet Shrine", island: "quiet",
    x: -620, z: -80, rotation: 1.2, radius: 18, navpoint: true,
    blurb: "Somebody put a bench here facing away from everything. It is the best seat.",
  },
];

export const LANDMARK_BY_KEY: Record<string, LandmarkDef> = Object.fromEntries(
  LANDMARKS.map((l) => [l.key, l]),
);

/** True where the procedural scatter must not place anything. */
export function isReserved(x: number, z: number): boolean {
  for (const l of LANDMARKS) {
    const dx = x - l.x;
    const dz = z - l.z;
    if (dx * dx + dz * dz < l.radius * l.radius) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Zipline routes
 * ------------------------------------------------------------------ */

export interface ZiplineRoute {
  key: string;
  from: string;
  to: string;
  /** Sag of the cable at midspan, metres. */
  sag: number;
}

export const ZIPLINES: ZiplineRoute[] = [
  { key: "heart-grove", from: "zip-heart", to: "zip-grove", sag: 26 },
];

/* ------------------------------------------------------------------ *
 * Spawns
 * ------------------------------------------------------------------ */

export interface SpawnPoint {
  key: string;
  name: string;
  x: number;
  z: number;
  /** Metres above the surface. */
  yOffset: number;
  heading: number;
  blurb: string;
}

export const SPAWNS: SpawnPoint[] = [
  {
    key: "plaza", name: "The Plaza", x: 0, z: 34, yOffset: 1.7, heading: Math.PI,
    blurb: "You arrive where everyone arrives.",
  },
  {
    key: "overlook", name: "The Overlook", x: 236, z: 150, yOffset: 1.7, heading: -2.3,
    blurb: "The rim above the falls. Mind the edge.",
  },
  {
    key: "palace", name: "THE PALACE", x: -300, z: -350, yOffset: 1.7, heading: -0.6,
    blurb: "On the Palace Rock, with the whole archipelago below.",
  },
  {
    key: "sky", name: "Open Sky", x: 0, z: 700, yOffset: 420, heading: Math.PI,
    blurb: "Falling. Deliberately.",
  },
];

/** Clamp a position into the playable envelope. */
export function clampToWorld(x: number, z: number): Vec2 {
  const d = Math.hypot(x, z);
  if (d <= WORLD.radius) return { x, z };
  const s = WORLD.radius / d;
  return { x: x * s, z: z * s };
}
