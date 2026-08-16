/**
 * The Midnight Zone — shared contracts.
 *
 * A descent. You fly a submersible straight down through the ocean's layers,
 * and the whole game is the fact that light runs out. Everything else — the
 * creatures, the snow, the fog, the sound — is in service of one idea: at the
 * surface you can see for a hundred metres, and at three thousand you can see
 * exactly as far as your lamps reach.
 *
 * Same engine shape as Vibe Golf and Vibe Kart: every subsystem is a `System`
 * handed the shared `DeepCtx`, systems never import one another, and they talk
 * through `ctx.services`. A system that throws costs its own feature and
 * nothing else.
 *
 * Convention: +Y **up**, metres, and the surface is y = 0. So depth is `-y`,
 * and every number in this file that says "depth" is a positive metre count
 * downward. Getting that backwards is the single easiest bug to write here,
 * which is why `depthOf` exists rather than a sprinkling of minus signs.
 */
import type * as THREE from "three";

// ---------------------------------------------------------------------------
// The water column
// ---------------------------------------------------------------------------

/** Depth in metres from a world-space Y. The surface is 0; down is positive. */
export const depthOf = (y: number): number => Math.max(0, -y);

/** World-space Y for a depth in metres. The inverse of `depthOf`. */
export const yOfDepth = (depth: number): number => -Math.max(0, depth);

/**
 * The five layers, by their real names and roughly their real depths.
 *
 * The boundaries are not arbitrary and they are not evenly spaced, because the
 * ocean's are not either: the sunlight zone is a skin 200 m thick and the
 * midnight zone below it is three kilometres of the same darkness. Compressing
 * them to equal bands would be prettier and would tell a lie about the shape
 * of the sea.
 */
export type ZoneId = "sunlight" | "twilight" | "midnight" | "abyss" | "hadal";

export interface Zone {
  id: ZoneId;
  name: string;
  /** Depth this layer begins, metres. */
  from: number;
  /** Depth it ends. The last one ends at the floor. */
  to: number;
  /** One line, shown once, when you first cross into it. */
  epigraph: string;
  /** Ambient water colour at the top of the layer. */
  water: number;
  /**
   * Fog density at the top of the layer.
   *
   * Counter-intuitively this *falls* with depth. Surface water is full of
   * plankton and suspended silt; abyssal water is some of the clearest on the
   * planet. What makes the deep dark is not murk, it is the total absence of
   * anything to light it — which is `sun`, below. Ramping turbidity up with
   * depth would be the easy read, and it would also blind the lamps at exactly
   * the depth where the lamps are the entire game.
   */
  density: number;
  /** Downwelling sunlight still reaching here, 0..1. */
  sun: number;
}

export const ZONES: Zone[] = [
  {
    id: "sunlight",
    name: "Sunlight Zone",
    from: 0,
    to: 200,
    epigraph: "Everything that photosynthesises on Earth's ocean lives in this much water.",
    water: 0x2fb6c8,
    density: 0.0092,
    sun: 1,
  },
  {
    id: "twilight",
    name: "Twilight Zone",
    from: 200,
    to: 1000,
    epigraph: "Enough light to hunt by. Not enough to grow by.",
    water: 0x0b4d7a,
    density: 0.0082,
    sun: 0.32,
  },
  {
    id: "midnight",
    name: "Midnight Zone",
    from: 1000,
    to: 4000,
    epigraph: "No sunlight has ever reached here. Every light you see, something made.",
    water: 0x04122c,
    density: 0.0068,
    sun: 0.02,
  },
  {
    id: "abyss",
    name: "Abyssal Zone",
    from: 4000,
    to: 6000,
    epigraph: "Four degrees, four hundred atmospheres, and no season for a million years.",
    water: 0x01060f,
    density: 0.0058,
    sun: 0,
  },
  {
    id: "hadal",
    name: "Hadal Zone",
    from: 6000,
    to: 8200,
    epigraph: "Named for Hades. More people have stood on the Moon than have been down here.",
    water: 0x000308,
    density: 0.0052,
    sun: 0,
  },
];

/** Depth of the seafloor. The descent ends here. */
export const FLOOR_DEPTH = 8200;

export function zoneAt(depth: number): Zone {
  for (const z of ZONES) if (depth < z.to) return z;
  return ZONES[ZONES.length - 1];
}

/**
 * Water colour and fog density at a depth, interpolated across the boundary.
 *
 * Stepping these per zone reads as five walls of coloured glass; ramping them
 * continuously is what makes the descent feel like one movement. The zones
 * still exist — they name what you are looking at — but nothing about the
 * picture snaps when you cross one.
 */
export function waterAt(depth: number): { color: number; density: number; sun: number } {
  const zone = zoneAt(depth);
  const next = ZONES[Math.min(ZONES.indexOf(zone) + 1, ZONES.length - 1)];
  const span = Math.max(1, zone.to - zone.from);
  const t = Math.min(1, Math.max(0, (depth - zone.from) / span));
  return {
    color: mixHex(zone.water, next.water, t),
    density: zone.density + (next.density - zone.density) * t,
    sun: zone.sun + (next.sun - zone.sun) * t,
  };
}

/** Channel-wise lerp between two 0xRRGGBB colours. Cheap, and gamma-naive on
 *  purpose: these are art-directed values, not measurements. */
export function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export type DeepQuality = "low" | "medium" | "high" | "ultra";

export interface DeepInput {
  /** -1 back … +1 forward. */
  surge: number;
  /** -1 left … +1 right, a yaw rate. */
  yaw: number;
  /** -1 down … +1 up. Ballast. */
  heave: number;
  /** Look, radians, accumulated by mouse/touch drag. */
  lookYaw: number;
  lookPitch: number;
  /** Held: run the thrusters hard. */
  boost: boolean;
  /** Edge-triggered, cleared at the end of every frame. */
  scanPressed: boolean;
  lightsPressed: boolean;
  pausePressed: boolean;
}

export function makeDeepInput(): DeepInput {
  return {
    surge: 0,
    yaw: 0,
    heave: 0,
    lookYaw: 0,
    lookPitch: 0,
    boost: false,
    scanPressed: false,
    lightsPressed: false,
    pausePressed: false,
  };
}

export interface DeepCtx {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** Published by systems, read by anyone. Every lookup must tolerate absence. */
  services: Record<string, unknown>;
  input: DeepInput;
  /** Seconds since boot. */
  elapsed: number;
  dt: number;
  quality: DeepQuality;
  rng(): number;
  viewport: { width: number; height: number; aspect: number; dpr: number };
  emit(event: string, payload?: unknown): void;
  on(event: string, fn: (payload: never) => void): () => void;
}

export interface System {
  update?(dt: number, ctx: DeepCtx): void;
  lateUpdate?(dt: number, ctx: DeepCtx): void;
  resize?(width: number, height: number): void;
  dispose?(): void;
}

export type SystemFactory = (ctx: DeepCtx) => System | Promise<System>;

/** Deterministic PRNG (mulberry32) so a seed reproduces a dive exactly. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export interface SubService {
  object: THREE.Object3D;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Metres per second along the hull's forward axis. */
  speed: number;
  depth: number;
  /** Lamp state — the difference between a world and a black rectangle. */
  lightsOn: boolean;
  /** 0..1. Lamps and thrusters both draw on it. */
  power: number;
  /** Hull integrity 0..1. Pressure bites below crush depth. */
  hull: number;
  setLights(on: boolean): void;
}

export interface CreatureService {
  /** Everything currently alive around the sub. */
  alive(): CreatureInstance[];
  /** Nearest scannable creature inside `range`, or null. */
  nearest(from: THREE.Vector3, range: number): CreatureInstance | null;
}

export interface CreatureInstance {
  id: number;
  speciesId: string;
  object: THREE.Object3D;
  position: THREE.Vector3;
  /** Metres. Used for the scan reticle and the log entry. */
  size: number;
  scanned: boolean;
}

export interface LogService {
  /** Species ids seen and logged, in the order they were found. */
  found: string[];
  has(speciesId: string): boolean;
  total: number;
}
