/**
 * game/missions.ts — authored activities, instantiated on the real map.
 *
 * Nine activity families, every one of them placed at coordinates that mean
 * something: the wingsuit course starts on the real summit of Twin Peaks and
 * finishes at the real Ferry Building; the convoy runs the actual Embarcadero;
 * the race puts Lombard's switchbacks in the middle of it because that is
 * where they are. A mission that could be anywhere is a mission that teaches
 * you nothing about the city.
 *
 * Structure
 * ---------
 *   MissionDef      pure data: objectives, failure conditions, rewards. Built
 *                   once at module load from `sfGeo` + a seeded RNG, so the
 *                   same build always produces the same map.
 *   ObjectiveSpec   a typed condition. Objectives are grouped into *stages*;
 *                   everything in a stage runs at once, and the stage advances
 *                   when all of its non-optional objectives are satisfied.
 *   MissionActor    the things a mission owns that are not scenery: the escort
 *                   ward, convoy trucks, strongpoint targets. The game layer
 *                   simulates them (position, route, health, death) and
 *                   publishes them; the character/vehicle renderers draw them.
 *                   Targets additionally register with the physics destruction
 *                   system, so rockets, blast propagation and shard debris all
 *                   work on them without a special case.
 *   missions        the runtime: one active mission, a stage machine, failure
 *                   watchdogs, and the HUD objective mirror.
 *
 * Objective progress is mirrored into `useSfStore.objectives` for the HUD, but
 * only when it actually changes by a visible amount — a 60 Hz zustand write
 * per objective would be a frame-time bug wearing a UI costume.
 *
 * Public API
 * ----------
 *   MISSIONS / MISSION_BY_ID / missionsInDistrict(key)
 *   missions.start(id) / abort() / tick(dt) / state / active
 *   missions.actors                       for renderers
 *   missions.damageActor(id, amount)      for anything that can hurt them
 *   missions.spendResource(n)             limited-resource missions
 *   missions.onEvent(fn)                  start / stage / complete / fail
 */
import { WORLD_SEED } from "../config";
import { frame, useSfStore } from "../state/store";
import { clamp01, makeRng } from "../math/rng";
import {
  DISTRICTS,
  LANDMARK_BY_KEY,
  WORLD,
  clampToWorld,
  districtAt,
  isWater,
  latLonToWorld,
  terrainHeight,
  walkableHeight,
  type District,
} from "../geo/sfGeo";
import { enemyForce } from "../ai/enemies";
import { destruction, onDestructionStage, onExplosion } from "../physics/destruction";
import { chaos, type ChaosAward } from "./chaos";
import { gameHeat } from "./heat";

/* ================================================================== *
 * Types
 * ================================================================== */

export type MissionKind =
  | "liberation"
  | "chaos-run"
  | "wingsuit-course"
  | "grapple-course"
  | "convoy"
  | "escort"
  | "destruction"
  | "race"
  | "assault";

export const MISSION_KIND_LABEL: Record<MissionKind, string> = {
  liberation: "Liberation",
  "chaos-run": "Chaos Run",
  "wingsuit-course": "Wingsuit Course",
  "grapple-course": "Grapple Trial",
  convoy: "Convoy Intercept",
  escort: "Extraction",
  destruction: "Demolition",
  race: "Road Race",
  assault: "Assault",
};

export type ObjectiveKind =
  | "reach"
  | "gates"
  | "checkpoints"
  | "destroy"
  | "chaos"
  | "clear"
  | "survive"
  | "escort";

export interface WorldPoint {
  x: number;
  y: number;
  z: number;
  radius: number;
}

export interface ObjectiveSpec {
  id: string;
  kind: ObjectiveKind;
  title: string;
  detail: string;
  /** Stage index. Same stage = simultaneous. */
  stage: number;
  /** Marker position (also the centre for radius-based conditions). */
  x: number;
  y: number;
  z: number;
  radius: number;
  /** destroy: how many; clear: unused; chaos: points required. */
  count?: number;
  /** survive: seconds. */
  duration?: number;
  /** Ordered points for gates/checkpoints. */
  points?: WorldPoint[];
  /** Actor tag this objective watches (destroy/escort). */
  tag?: string;
  /** Failing this objective does not fail the mission. */
  optional?: boolean;
}

export interface FailureSpec {
  /** Whole-mission time limit, seconds. 0 = none. */
  timeLimit: number;
  /** Leaving this far from the mission centre aborts it, metres. 0 = none. */
  leash: number;
  /** Dying fails rather than restarts. */
  deathFails: boolean;
  /** The escorted actor dying fails the mission. */
  wardMustSurvive: boolean;
  /** Limited demolition charges / rockets. 0 = unlimited. */
  resources: number;
}

export interface MissionReward {
  chaos: number;
  /** Progression token granted on first completion. */
  unlock?: string;
}

export interface MissionDef {
  id: string;
  kind: MissionKind;
  name: string;
  brief: string;
  districtKey: string;
  /** Start marker / mission centre. */
  x: number;
  y: number;
  z: number;
  objectives: ObjectiveSpec[];
  failure: FailureSpec;
  reward: MissionReward;
  /** Career rank index required before this appears. */
  minRank: number;
  /** How loud this activity is, 0..1 — the director's pacing input. */
  intensity: number;
  /** Timed activities record a best time. */
  timed: boolean;
}

export type MissionState = "idle" | "active" | "complete" | "failed";

export type MissionEvent =
  | { type: "start"; def: MissionDef }
  | { type: "stage"; def: MissionDef; stage: number }
  | { type: "objective"; def: MissionDef; objective: ObjectiveSpec }
  | { type: "complete"; def: MissionDef; elapsed: number; best: boolean }
  | { type: "fail"; def: MissionDef; reason: string };

/* ================================================================== *
 * Mission actors
 * ================================================================== */

export type ActorKind = "ward" | "convoy" | "escort-vehicle" | "target";

export interface MissionActor {
  id: number;
  kind: ActorKind;
  /** Objective tag this actor answers to. */
  tag: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** Metres per second along its route. */
  speed: number;
  /** Flattened route [x,y,z, x,y,z, …] or null for a static actor. */
  route: Float32Array | null;
  routeIndex: number;
  /** Ward only: follow the player instead of a route until told otherwise. */
  follow: boolean;
  /** Destructible id when registered with the physics system, else -1. */
  destructibleId: number;
  /** Radius used for damage and for "reached" tests. */
  radius: number;
}

let nextActorId = 1;

/* ================================================================== *
 * Geometry helpers
 * ================================================================== */

/** lat/lon → world point, with an optional explicit or ground-relative height. */
function pt(lat: number, lon: number, y?: number, agl = 0): WorldPoint {
  const p = latLonToWorld(lat, lon);
  return {
    x: p.x,
    z: p.z,
    y: y != null ? y : walkableHeight(p.x, p.z) + agl,
    radius: 0,
  };
}

/** Landmark → world point at its base (or `agl` above it). */
function lm(key: string, agl = 0): WorldPoint {
  const l = LANDMARK_BY_KEY[key];
  if (!l) return { x: 0, y: walkableHeight(0, 0) + agl, z: 0, radius: 0 };
  return { x: l.x, z: l.z, y: walkableHeight(l.x, l.z) + agl, radius: 0 };
}

/**
 * Resample a polyline into `n` evenly spaced gates. Wingsuit and race routes
 * are authored as a handful of real waypoints; the course wants gates at a
 * consistent spacing, and interpolating is how you get both.
 */
function resample(route: readonly WorldPoint[], n: number, radius: number): WorldPoint[] {
  const segLen: number[] = [];
  let total = 0;
  for (let i = 1; i < route.length; i++) {
    const d = Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z);
    segLen.push(d);
    total += d;
  }
  const out: WorldPoint[] = [];
  for (let g = 0; g < n; g++) {
    const target = (total * g) / (n - 1);
    let acc = 0;
    let i = 0;
    while (i < segLen.length - 1 && acc + segLen[i] < target) {
      acc += segLen[i];
      i++;
    }
    const t = segLen[i] > 0 ? clamp01((target - acc) / segLen[i]) : 0;
    const a = route[i];
    const b = route[i + 1] ?? route[i];
    out.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
      radius,
    });
  }
  return out;
}

/** Flatten a polyline for an actor route. */
function flatten(route: readonly WorldPoint[]): Float32Array {
  const f = new Float32Array(route.length * 3);
  for (let i = 0; i < route.length; i++) {
    f[i * 3] = route[i].x;
    f[i * 3 + 1] = route[i].y;
    f[i * 3 + 2] = route[i].z;
  }
  return f;
}

/** Seeded scatter of target positions on a ring, avoiding water. */
function ring(cx: number, cz: number, count: number, minR: number, maxR: number, seed: string): WorldPoint[] {
  const rng = makeRng(seed);
  const out: WorldPoint[] = [];
  for (let i = 0; i < count; i++) {
    let x = cx;
    let z = cz;
    for (let attempt = 0; attempt < 24; attempt++) {
      const a = ((i + rng.range(-0.32, 0.32)) / count) * Math.PI * 2;
      const r = rng.range(minR, maxR);
      x = cx + Math.cos(a) * r;
      z = cz + Math.sin(a) * r;
      if (!isWater(x, z)) break;
    }
    out.push({ x, z, y: walkableHeight(x, z) + 1.4, radius: 4 });
  }
  return out;
}

/* ================================================================== *
 * Authored routes — real San Francisco
 * ================================================================== */

/**
 * Twin Peaks to the Ferry Building. 282 m of altitude spent over roughly five
 * kilometres of descending street grid: the classic run every player tries
 * first, and the reason the wingsuit has a boost.
 */
const ROUTE_TWIN_PEAKS_DOWNTOWN: WorldPoint[] = [
  pt(37.7544, -122.4477, 300),
  pt(37.7627, -122.4413, 246),
  pt(37.7695, -122.4330, 198),
  pt(37.7758, -122.4258, 158),
  pt(37.7793, -122.4184, 128),
  pt(37.7845, -122.4118, 104),
  pt(37.7879, -122.4075, 86),
  pt(37.7929, -122.4028, 68),
  pt(37.7952, -122.3985, 52),
  pt(37.7955, -122.3937, 34),
];

/**
 * The Golden Gate run: off the Marin Headlands, down the length of the bridge
 * between the towers, and along the Crissy Field shoreline to Marina Green.
 */
const ROUTE_GOLDEN_GATE: WorldPoint[] = [
  pt(37.8290, -122.4970, 320),
  pt(37.8258, -122.4880, 268),
  pt(37.8250, -122.4790, 224),
  pt(37.8199, -122.4783, 186),
  pt(37.8148, -122.4776, 150),
  pt(37.8106, -122.4776, 112),
  pt(37.8078, -122.4620, 84),
  pt(37.8040, -122.4560, 64),
  pt(37.8029, -122.4484, 48),
  pt(37.8072, -122.4430, 32),
];

/** Financial District rooftops. Heights track the real buildings. */
const ROUTE_FIDI_ROOFTOPS: WorldPoint[] = [
  lm("transamerica", 258),
  lm("555cal", 234),
  pt(37.7924, -122.4005, undefined, 120),
  pt(37.7902, -122.3990, undefined, 150),
  lm("millennium", 194),
  lm("salesforce", 320),
  pt(37.7920, -122.3950, undefined, 90),
  lm("ferry", 70),
];

/** Nob Hill down through Chinatown to Coit Tower — shorter, tighter, steeper. */
const ROUTE_NOB_TO_COIT: WorldPoint[] = [
  pt(37.7919, -122.4131, undefined, 56),
  pt(37.7941, -122.4100, undefined, 44),
  pt(37.7952, -122.4098, undefined, 38),
  pt(37.7975, -122.4085, undefined, 40),
  pt(37.8003, -122.4076, undefined, 34),
  lm("coit", 62),
];

/** The Embarcadero, Oracle Park north to Pier 39. Flat, fast, exposed. */
const ROUTE_EMBARCADERO: WorldPoint[] = [
  pt(37.7786, -122.3893, undefined, 0.6),
  pt(37.7830, -122.3878, undefined, 0.6),
  pt(37.7880, -122.3872, undefined, 0.6),
  pt(37.7930, -122.3905, undefined, 0.6),
  pt(37.7955, -122.3930, undefined, 0.6),
  pt(37.8005, -122.3960, undefined, 0.6),
  pt(37.8060, -122.4030, undefined, 0.6),
  pt(37.8087, -122.4090, undefined, 0.6),
];

/** The western span of the Bay Bridge. Deck heights are explicit — it is over water. */
const ROUTE_BAY_BRIDGE: WorldPoint[] = [
  pt(37.7908, -122.3878, 26),
  pt(37.7930, -122.3830, 44),
  pt(37.7952, -122.3770, 58),
  pt(37.7975, -122.3700, 62),
  pt(37.7995, -122.3630, 56),
  pt(37.8010, -122.3570, 44),
];

/**
 * The hill race. Fort Mason to Twin Peaks with Lombard's switchbacks as the
 * second checkpoint, then over Nob Hill and out through Alamo Square.
 */
const ROUTE_HILL_RACE: WorldPoint[] = [
  pt(37.8068, -122.4330, undefined, 1),
  pt(37.8035, -122.4250, undefined, 1),
  pt(37.8021, -122.4187, undefined, 1), // Lombard, the crooked block
  pt(37.7975, -122.4165, undefined, 1),
  pt(37.7930, -122.4161, undefined, 1), // Nob Hill
  pt(37.7860, -122.4220, undefined, 1),
  pt(37.7793, -122.4290, undefined, 1),
  pt(37.7763, -122.4328, undefined, 1), // Alamo Square
  pt(37.7660, -122.4420, undefined, 1),
  pt(37.7544, -122.4477, undefined, 1), // Twin Peaks
];

/** The ocean race: Ocean Beach through the park and the Haight to Bernal. */
const ROUTE_OCEAN_RACE: WorldPoint[] = [
  pt(37.7600, -122.5105, undefined, 1),
  pt(37.7680, -122.5000, undefined, 1),
  pt(37.7699, -122.4862, undefined, 1),
  pt(37.7700, -122.4700, undefined, 1),
  pt(37.7699, -122.4469, undefined, 1), // Haight-Ashbury
  pt(37.7620, -122.4350, undefined, 1), // Castro
  pt(37.7599, -122.4230, undefined, 1), // Dolores
  pt(37.7500, -122.4180, undefined, 1),
  pt(37.7433, -122.4160, undefined, 1), // Bernal Heights
];

/* ================================================================== *
 * Mission construction helpers
 * ================================================================== */

const NO_FAIL: FailureSpec = {
  timeLimit: 0,
  leash: 0,
  deathFails: false,
  wardMustSurvive: false,
  resources: 0,
};

function fail(p: Partial<FailureSpec>): FailureSpec {
  return { ...NO_FAIL, ...p };
}

function gateObjective(
  id: string,
  title: string,
  detail: string,
  points: WorldPoint[],
  kind: "gates" | "checkpoints",
  stage = 0,
): ObjectiveSpec {
  const first = points[0];
  return {
    id,
    kind,
    title,
    detail,
    stage,
    x: first.x,
    y: first.y,
    z: first.z,
    radius: first.radius,
    points,
    count: points.length,
  };
}

/* ================================================================== *
 * The catalogue
 * ================================================================== */

/** Districts that get a Liberation strongpoint, in the order they unlock. */
const LIBERATION_DISTRICTS = [
  "soma",
  "mission",
  "dogpatch",
  "chinatown",
  "westernaddition",
  "bayview",
  "embarcadero",
  "civiccenter",
];

/** Districts that get a Chaos Run. Chosen for having something worth breaking. */
const CHAOS_RUN_DISTRICTS = [
  "fidi",
  "soma",
  "mission",
  "chinatown",
  "northbeach",
  "marina",
  "haight",
  "potrero",
  "dogpatch",
  "richmond",
];

function buildLiberation(d: District, index: number): MissionDef {
  const rng = makeRng(`${WORLD_SEED}:liberation:${d.key}`);
  // Put the strongpoint off-centre so it is not always at the district pin.
  let cx = d.x;
  let cz = d.z;
  for (let i = 0; i < 24; i++) {
    const a = rng.next() * Math.PI * 2;
    const r = d.radius * rng.range(0.2, 0.55);
    const x = d.x + Math.cos(a) * r;
    const z = d.z + Math.sin(a) * r;
    if (!isWater(x, z)) {
      cx = x;
      cz = z;
      break;
    }
  }
  const cy = walkableHeight(cx, cz);
  const targetCount = 4 + (index % 3);
  const targets = ring(cx, cz, targetCount, 22, 58, `${WORLD_SEED}:libtargets:${d.key}`);

  return {
    id: `liberation-${d.key}`,
    kind: "liberation",
    name: `Liberate ${d.name}`,
    brief: `A private security contractor has fortified a block of ${d.name}. Level the strongpoint and clear the garrison.`,
    districtKey: d.key,
    x: cx,
    y: cy,
    z: cz,
    objectives: [
      {
        id: "targets",
        kind: "destroy",
        title: "Destroy the strongpoint",
        detail: `${targetCount} fortified installations`,
        stage: 0,
        x: cx,
        y: cy,
        z: cz,
        radius: 90,
        count: targetCount,
        tag: `lib-${d.key}`,
      },
      {
        id: "garrison",
        kind: "clear",
        title: "Clear the garrison",
        detail: "No hostiles left standing",
        stage: 1,
        x: cx,
        y: cy,
        z: cz,
        radius: 110,
      },
    ],
    failure: fail({ leash: 420, deathFails: true }),
    reward: { chaos: 2200 + index * 400, unlock: index === 0 ? "grapple-tether-3" : undefined },
    minRank: Math.min(6, Math.floor(index / 2)),
    intensity: 0.8,
    timed: false,
    /* placement note: strongpoint centre is district-local and water-rejected */
  };
}

function buildChaosRun(d: District, index: number): MissionDef {
  const target = Math.round(1200 + d.density * 2400 + index * 220);
  const limit = 150 + index * 6;
  return {
    id: `chaos-run-${d.key}`,
    kind: "chaos-run",
    name: `${d.name} Chaos Run`,
    brief: `${target.toLocaleString()} chaos inside ${d.name} before the clock runs out. Nothing is off limits.`,
    districtKey: d.key,
    x: d.x,
    y: walkableHeight(d.x, d.z),
    z: d.z,
    objectives: [
      {
        id: "chaos",
        kind: "chaos",
        title: `Cause ${target.toLocaleString()} chaos`,
        detail: `Inside ${d.name}`,
        stage: 0,
        x: d.x,
        y: walkableHeight(d.x, d.z),
        z: d.z,
        radius: d.radius * 1.15,
        count: target,
      },
    ],
    failure: fail({ timeLimit: limit, leash: d.radius * 2.2 }),
    reward: { chaos: Math.round(target * 0.55) },
    minRank: Math.min(5, Math.floor(index / 3)),
    intensity: 0.95,
    timed: true,
  };
}

function buildMissions(): MissionDef[] {
  const out: MissionDef[] = [];

  /* ---- LIBERATION ---- */
  LIBERATION_DISTRICTS.forEach((key, i) => {
    const d = DISTRICTS.find((x) => x.key === key);
    if (d) out.push(buildLiberation(d, i));
  });

  /* ---- CHAOS RUN ---- */
  CHAOS_RUN_DISTRICTS.forEach((key, i) => {
    const d = DISTRICTS.find((x) => x.key === key);
    if (d) out.push(buildChaosRun(d, i));
  });

  /* ---- WINGSUIT COURSES ---- */
  {
    const gates = resample(ROUTE_TWIN_PEAKS_DOWNTOWN, 14, 22);
    const start = gates[0];
    out.push({
      id: "wingsuit-twin-peaks",
      kind: "wingsuit-course",
      name: "Peaks to the Ferry",
      brief:
        "Off the summit of Twin Peaks, down the Market Street diagonal, finishing over the Ferry Building. Fourteen gates. Do not touch the ground.",
      districtKey: districtAt(start.x, start.z).key,
      x: start.x,
      y: start.y,
      z: start.z,
      objectives: [
        gateObjective(
          "gates",
          "Fly the course",
          "14 gates, Twin Peaks to the Embarcadero",
          gates,
          "gates",
        ),
      ],
      failure: fail({ timeLimit: 190, leash: 700 }),
      reward: { chaos: 1800, unlock: "wingsuit-boost-2" },
      minRank: 0,
      intensity: 0.25,
      timed: true,
    });
  }
  {
    const gates = resample(ROUTE_GOLDEN_GATE, 12, 26);
    const start = gates[0];
    out.push({
      id: "wingsuit-golden-gate",
      kind: "wingsuit-course",
      name: "The Golden Gate Run",
      brief:
        "Step off the Marin Headlands, thread the towers of the Golden Gate below deck level, and run the Crissy Field shoreline to Marina Green.",
      districtKey: "presidio",
      x: start.x,
      y: start.y,
      z: start.z,
      objectives: [
        gateObjective("gates", "Fly the course", "12 gates through the Gate", gates, "gates"),
      ],
      failure: fail({ timeLimit: 210, leash: 900 }),
      reward: { chaos: 2600, unlock: "wingsuit-lift-2" },
      minRank: 1,
      intensity: 0.25,
      timed: true,
    });
  }

  /* ---- GRAPPLE COURSES ---- */
  {
    const cps = resample(ROUTE_FIDI_ROOFTOPS, 9, 16);
    const start = cps[0];
    out.push({
      id: "grapple-fidi",
      kind: "grapple-course",
      name: "Rooftops of the Financial District",
      brief:
        "Transamerica to the Ferry Building across the tops of the towers. Nine markers, one clock, no lift.",
      districtKey: "fidi",
      x: start.x,
      y: start.y,
      z: start.z,
      objectives: [
        gateObjective("checkpoints", "Hit every marker", "9 rooftop markers", cps, "checkpoints"),
      ],
      failure: fail({ timeLimit: 150, leash: 900 }),
      reward: { chaos: 1900, unlock: "grapple-range-2" },
      minRank: 0,
      intensity: 0.2,
      timed: true,
    });
  }
  {
    const cps = resample(ROUTE_NOB_TO_COIT, 7, 14);
    const start = cps[0];
    out.push({
      id: "grapple-nob-coit",
      kind: "grapple-course",
      name: "Grace to the Tower",
      brief:
        "Grace Cathedral down through Chinatown and up Telegraph Hill to Coit Tower. Steeper than it looks on the map.",
      districtKey: "nobhill",
      x: start.x,
      y: start.y,
      z: start.z,
      objectives: [
        gateObjective("checkpoints", "Hit every marker", "7 markers", cps, "checkpoints"),
      ],
      failure: fail({ timeLimit: 120, leash: 700 }),
      reward: { chaos: 1500, unlock: "grapple-reel-2" },
      minRank: 1,
      intensity: 0.2,
      timed: true,
    });
  }

  /* ---- CONVOY ---- */
  {
    const start = ROUTE_EMBARCADERO[0];
    out.push({
      id: "convoy-embarcadero",
      kind: "convoy",
      name: "Embarcadero Convoy",
      brief:
        "Four armoured trucks running north from Oracle Park to Pier 39 along the waterfront. They do not stop for anything.",
      districtKey: "embarcadero",
      x: start.x,
      y: start.y,
      z: start.z,
      objectives: [
        {
          id: "trucks",
          kind: "destroy",
          title: "Destroy the convoy",
          detail: "4 armoured trucks",
          stage: 0,
          x: start.x,
          y: start.y,
          z: start.z,
          radius: 1400,
          count: 4,
          tag: "convoy-embarcadero",
        },
      ],
      failure: fail({ timeLimit: 200, deathFails: true }),
      reward: { chaos: 3200, unlock: "weapon-gl" },
      minRank: 2,
      intensity: 0.85,
      timed: true,
    });
  }
  {
    const start = ROUTE_BAY_BRIDGE[0];
    out.push({
      id: "convoy-bay-bridge",
      kind: "convoy",
      name: "Bridge Run",
      brief:
        "A prisoner transport crossing the western span with two escorts. Take the bridge deck away from them.",
      districtKey: "rincon",
      x: start.x,
      y: start.y,
      z: start.z,
      objectives: [
        {
          id: "trucks",
          kind: "destroy",
          title: "Stop the transport",
          detail: "3 vehicles on the span",
          stage: 0,
          x: start.x,
          y: start.y,
          z: start.z,
          radius: 2000,
          count: 3,
          tag: "convoy-bay-bridge",
        },
      ],
      failure: fail({ timeLimit: 170, deathFails: true }),
      reward: { chaos: 3600, unlock: "weapon-rpg" },
      minRank: 3,
      intensity: 0.9,
      timed: true,
    });
  }

  /* ---- ESCORT / EXTRACTION ---- */
  const escorts: {
    id: string;
    name: string;
    brief: string;
    from: WorldPoint;
    to: WorldPoint;
    district: string;
    rank: number;
    reward: number;
    unlock?: string;
  }[] = [
    {
      id: "extract-civic",
      name: "Civic Center Extraction",
      brief:
        "A whistleblower is pinned down behind City Hall. Walk them to the Ferry Building without losing them.",
      from: pt(37.7793, -122.4184, undefined, 1),
      to: lm("ferry", 1),
      district: "civiccenter",
      rank: 1,
      reward: 2400,
      unlock: "weapon-smg",
    },
    {
      id: "extract-mission",
      name: "Mission Pickup",
      brief:
        "A witness is being moved through the Mission. Get them across to the Oracle Park helipad before the second team arrives.",
      from: pt(37.7599, -122.4148, undefined, 1),
      to: lm("oracle-park", 1),
      district: "mission",
      rank: 2,
      reward: 2800,
    },
    {
      id: "extract-chinatown",
      name: "Grant Avenue",
      brief:
        "Get the courier up Telegraph Hill to the Coit Tower parking loop. Grant Avenue is not a good place to be shot at.",
      from: pt(37.7941, -122.4078, undefined, 1),
      to: lm("coit", 2),
      district: "chinatown",
      rank: 3,
      reward: 3000,
      unlock: "weapon-battle",
    },
  ];
  for (const e of escorts) {
    out.push({
      id: e.id,
      kind: "escort",
      name: e.name,
      brief: e.brief,
      districtKey: e.district,
      x: e.from.x,
      y: e.from.y,
      z: e.from.z,
      objectives: [
        {
          id: "meet",
          kind: "reach",
          title: "Reach the contact",
          detail: "They will not move without you",
          stage: 0,
          x: e.from.x,
          y: e.from.y,
          z: e.from.z,
          radius: 12,
        },
        {
          id: "escort",
          kind: "escort",
          title: "Get them to the pickup",
          detail: "Keep them alive",
          stage: 1,
          x: e.to.x,
          y: e.to.y,
          z: e.to.z,
          radius: 16,
          tag: `ward-${e.id}`,
        },
      ],
      failure: fail({ deathFails: true, wardMustSurvive: true, leash: 260, timeLimit: 420 }),
      reward: { chaos: e.reward, unlock: e.unlock },
      minRank: e.rank,
      intensity: 0.7,
      timed: false,
    });
  }

  /* ---- DESTRUCTION ---- */
  const demos: {
    id: string;
    name: string;
    brief: string;
    at: WorldPoint;
    district: string;
    targets: number;
    charges: number;
    rank: number;
    reward: number;
    unlock?: string;
  }[] = [
    {
      id: "demo-sutro",
      name: "Bring Down Sutro",
      brief:
        "Six anchor points hold the Sutro Tower's legs. You have eight charges. The city will notice.",
      at: lm("sutro"),
      district: "haight",
      targets: 6,
      charges: 8,
      rank: 4,
      reward: 6000,
      unlock: "weapon-sticky",
    },
    {
      id: "demo-cranes",
      name: "Pier 70 Cranes",
      brief: "Drop the gantries into the channel. Four charges, four legs, no second attempt.",
      at: lm("cranes"),
      district: "dogpatch",
      targets: 4,
      charges: 5,
      rank: 2,
      reward: 3400,
    },
    {
      id: "demo-soma-depot",
      name: "The SoMa Depot",
      brief:
        "A fuel depot under the freeway ramps. Five tanks, six charges, and everything within a block of it goes with them.",
      at: pt(37.7760, -122.4020, undefined, 0),
      district: "soma",
      targets: 5,
      charges: 6,
      rank: 1,
      reward: 3000,
      unlock: "weapon-shotgun",
    },
    {
      id: "demo-bayview-stacks",
      name: "Hunters Point Stacks",
      brief: "Four stacks left over from the shipyard. Take them down without leaving the yard.",
      at: pt(37.7300, -122.3880, undefined, 0),
      district: "bayview",
      targets: 4,
      charges: 5,
      rank: 3,
      reward: 3800,
    },
  ];
  for (const d of demos) {
    out.push({
      id: d.id,
      kind: "destruction",
      name: d.name,
      brief: d.brief,
      districtKey: d.district,
      x: d.at.x,
      y: d.at.y,
      z: d.at.z,
      objectives: [
        {
          id: "structure",
          kind: "destroy",
          title: "Bring it down",
          detail: `${d.targets} structural points`,
          stage: 0,
          x: d.at.x,
          y: d.at.y,
          z: d.at.z,
          radius: 200,
          count: d.targets,
          tag: `demo-${d.id}`,
        },
      ],
      failure: fail({ leash: 500, resources: d.charges, timeLimit: 300 }),
      reward: { chaos: d.reward, unlock: d.unlock },
      minRank: d.rank,
      intensity: 0.75,
      timed: false,
    });
  }

  /* ---- RACE ---- */
  {
    const cps = resample(ROUTE_HILL_RACE, 10, 18);
    const start = cps[0];
    out.push({
      id: "race-hills",
      kind: "race",
      name: "The Hill Climb",
      brief:
        "Fort Mason to the top of Twin Peaks. Lombard's eight switchbacks are checkpoint three and they are not optional.",
      districtKey: "marina",
      x: start.x,
      y: start.y,
      z: start.z,
      objectives: [
        gateObjective("checkpoints", "Hit every checkpoint", "10 checkpoints", cps, "checkpoints"),
      ],
      failure: fail({ timeLimit: 300, leash: 600 }),
      reward: { chaos: 2200, unlock: "vehicle-tuning" },
      minRank: 1,
      intensity: 0.4,
      timed: true,
    });
  }
  {
    const cps = resample(ROUTE_OCEAN_RACE, 10, 20);
    const start = cps[0];
    out.push({
      id: "race-ocean",
      kind: "race",
      name: "Ocean to Bernal",
      brief:
        "Ocean Beach, through Golden Gate Park and the Haight, over the Castro and up Bernal Heights. Crosstown, no freeway.",
      districtKey: "sunset",
      x: start.x,
      y: start.y,
      z: start.z,
      objectives: [
        gateObjective("checkpoints", "Hit every checkpoint", "10 checkpoints", cps, "checkpoints"),
      ],
      failure: fail({ timeLimit: 340, leash: 700 }),
      reward: { chaos: 2400 },
      minRank: 2,
      intensity: 0.4,
      timed: true,
    });
  }

  /* ---- ASSAULT ---- */
  {
    const a = lm("alcatraz");
    const targets = ring(a.x, a.z, 6, 40, 95, `${WORLD_SEED}:alcatraz`);
    out.push({
      id: "assault-alcatraz",
      kind: "assault",
      name: "Take the Rock",
      brief:
        "Alcatraz has been leased to the contractor as a staging island. Knock out the batteries, clear the yard, and stand on the cellhouse roof.",
      districtKey: "embarcadero",
      x: a.x,
      y: a.y,
      z: a.z,
      objectives: [
        {
          id: "batteries",
          kind: "destroy",
          title: "Knock out the batteries",
          detail: "6 emplacements",
          stage: 0,
          x: a.x,
          y: a.y,
          z: a.z,
          radius: 220,
          count: 6,
          tag: "alcatraz",
        },
        {
          id: "garrison",
          kind: "clear",
          title: "Clear the island",
          detail: "Every hostile on the Rock",
          stage: 1,
          x: a.x,
          y: a.y,
          z: a.z,
          radius: 240,
        },
        {
          id: "roof",
          kind: "reach",
          title: "Stand on the cellhouse",
          detail: "The island is yours",
          stage: 2,
          x: a.x,
          y: a.y + 40,
          z: a.z,
          radius: 30,
        },
        {
          id: "hold",
          kind: "survive",
          title: "Hold it",
          detail: "90 seconds",
          stage: 2,
          x: a.x,
          y: a.y,
          z: a.z,
          radius: 260,
          duration: 90,
        },
      ],
      failure: fail({ deathFails: true, leash: 700 }),
      reward: { chaos: 12000, unlock: "grapple-tether-4" },
      minRank: 5,
      intensity: 1,
      timed: false,
    });
  }

  // Targets stored on the def are consumed by `spawnActors`; the ring layouts
  // are recomputed there from the same seed, so the def stays pure data.
  return out;
}

export const MISSIONS: readonly MissionDef[] = buildMissions();

export const MISSION_BY_ID: Record<string, MissionDef> = Object.fromEntries(
  MISSIONS.map((m) => [m.id, m]),
);

export function missionsInDistrict(districtKey: string): MissionDef[] {
  return MISSIONS.filter((m) => m.districtKey === districtKey);
}

/** Route lookup for missions that need actors driven along one. */
const MISSION_ROUTES: Record<string, WorldPoint[]> = {
  "convoy-embarcadero": ROUTE_EMBARCADERO,
  "convoy-bay-bridge": ROUTE_BAY_BRIDGE,
};

/* ================================================================== *
 * Runtime
 * ================================================================== */

interface ObjectiveRuntime {
  spec: ObjectiveSpec;
  complete: boolean;
  /** 0..1 for the HUD. */
  progress: number;
  /** Ordered-point index for gates/checkpoints. */
  index: number;
  /** Accumulated count/chaos/seconds. */
  value: number;
  /** clear: have we ever seen a hostile inside the radius? */
  armed: boolean;
  /** Last progress written to the store, so we only write on visible change. */
  published: number;
}

type MissionEventHandler = (e: MissionEvent) => void;

class MissionRuntime {
  state: MissionState = "idle";
  active: MissionDef | null = null;
  elapsed = 0;
  stage = 0;
  /** Resources spent on a limited-resource mission. */
  resourcesUsed = 0;
  /** Set when a mission ends, for the results card. */
  lastResult: { def: MissionDef; success: boolean; elapsed: number; reason: string } | null = null;

  readonly actors: MissionActor[] = [];
  private objectives: ObjectiveRuntime[] = [];
  /** Set once the player has been inside the mission leash at least once. */
  private leashArmed = false;
  private handlers: MissionEventHandler[] = [];
  private completed = new Set<string>();
  private detach: (() => void)[] = [];

  /** Chaos accumulated inside the active chaos-run radius. */
  private chaosAccum = 0;

  /* ---------------- lifecycle ---------------- */

  /** Wire the world event sources. Called once by the GameDirector. */
  install(): () => void {
    const offAward = chaos.onAward((a: ChaosAward, x: number, _y: number, z: number) => {
      this.onChaosAward(a, x, z);
    });
    // Mission targets are real destructibles; this is how they report in.
    const offStage = onDestructionStage((e) => {
      const ref = e.target.desc.ref as { actorId?: number } | null;
      if (e.stage !== "destroyed" || !ref || ref.actorId == null) return;
      this.killActor(ref.actorId);
    });
    // Convoy vehicles and wards are not destructibles, so blast damage has to
    // be applied to them explicitly.
    const offBoom = onExplosion((e) => {
      for (let i = 0; i < this.actors.length; i++) {
        const a = this.actors[i];
        if (!a.alive || a.destructibleId >= 0) continue;
        const d = Math.hypot(a.x - e.x, a.z - e.z, a.y - e.y);
        if (d > e.radius) continue;
        const falloff = 1 - d / e.radius;
        this.damageActor(a.id, e.damage * falloff * falloff);
      }
    });
    this.detach = [offAward, offStage, offBoom];
    return () => {
      for (const d of this.detach) d();
      this.detach = [];
    };
  }

  onEvent(fn: MissionEventHandler): () => void {
    this.handlers.push(fn);
    return () => {
      const i = this.handlers.indexOf(fn);
      if (i >= 0) {
        this.handlers[i] = this.handlers[this.handlers.length - 1];
        this.handlers.pop();
      }
    };
  }

  private emit(e: MissionEvent): void {
    for (let i = 0; i < this.handlers.length; i++) this.handlers[i](e);
  }

  isComplete(id: string): boolean {
    return this.completed.has(id);
  }

  get completedCount(): number {
    return this.completed.size;
  }

  completedIds(): string[] {
    return Array.from(this.completed);
  }

  hydrate(ids: readonly string[]): void {
    for (const id of ids) if (MISSION_BY_ID[id]) this.completed.add(id);
  }

  /* ---------------- start / stop ---------------- */

  start(id: string): boolean {
    const def = MISSION_BY_ID[id];
    if (!def) return false;
    if (this.state === "active") this.abort("Replaced");

    this.active = def;
    this.state = "active";
    this.elapsed = 0;
    this.stage = 0;
    this.resourcesUsed = 0;
    this.chaosAccum = 0;
    this.leashArmed = false;
    this.objectives = def.objectives.map((spec) => ({
      spec,
      complete: false,
      progress: 0,
      index: 0,
      value: 0,
      armed: false,
      published: -1,
    }));

    this.clearActors();
    this.spawnActors(def);
    this.publishObjectives();

    const store = useSfStore.getState();
    store.notify(`${MISSION_KIND_LABEL[def.kind]}: ${def.name}`, "objective");
    this.emit({ type: "start", def });
    return true;
  }

  abort(reason = "Abandoned"): void {
    if (this.state !== "active" || !this.active) return;
    const def = this.active;
    this.finish(false, reason);
    this.emit({ type: "fail", def, reason });
  }

  private finish(success: boolean, reason: string): void {
    const def = this.active;
    if (!def) return;
    this.lastResult = { def, success, elapsed: this.elapsed, reason };
    this.state = success ? "complete" : "failed";
    this.active = null;
    this.clearActors();
    // Drop the HUD objectives belonging to this mission in one write rather
    // than patching each of them on the way out.
    useSfStore.setState((s) => ({
      objectives: s.objectives.filter((o) => !o.id.startsWith(`${def.id}:`)),
    }));
    this.objectives = [];
  }

  /* ---------------- actors ---------------- */

  private spawnActors(def: MissionDef): void {
    const now = frame.time;

    for (const spec of def.objectives) {
      if (spec.kind === "destroy" && spec.tag && spec.count) {
        const positions =
          def.kind === "convoy"
            ? null
            : ring(spec.x, spec.z, spec.count, def.kind === "destruction" ? 14 : 22,
                def.kind === "destruction" ? 46 : 58, `${WORLD_SEED}:targets:${def.id}`);

        if (positions) {
          for (let i = 0; i < positions.length; i++) {
            this.addTarget(def, spec.tag, positions[i], i);
          }
          // A strongpoint without a garrison is a shooting gallery.
          if (def.kind === "liberation" || def.kind === "assault") {
            const squads = def.kind === "assault" ? 4 : 2;
            for (let s = 0; s < squads; s++) {
              const p = positions[(s * 2) % positions.length];
              enemyForce.spawnSquad(p.x, p.z, 4, "cartel", "soldier", "rifle", now);
            }
          }
        } else {
          this.addConvoy(def, spec.tag, spec.count);
        }
      }

      if (spec.kind === "escort" && spec.tag) {
        this.addWard(def, spec.tag);
      }
    }
  }

  private addTarget(def: MissionDef, tag: string, p: WorldPoint, index: number): void {
    const hy = def.kind === "destruction" ? 5.5 : 2.6;
    const actor: MissionActor = {
      id: nextActorId++,
      kind: "target",
      tag,
      x: p.x,
      y: p.y + hy,
      z: p.z,
      yaw: 0,
      hp: def.kind === "destruction" ? 400 : 260,
      maxHp: def.kind === "destruction" ? 400 : 260,
      alive: true,
      speed: 0,
      route: null,
      routeIndex: 0,
      follow: false,
      destructibleId: -1,
      radius: 3.4,
    };
    // Register as a real destructible so rockets, chained blasts and shard
    // debris all work on it exactly as they do on the rest of the world.
    const d = destruction.register({
      x: actor.x,
      y: actor.y,
      z: actor.z,
      hx: 2.4,
      hy,
      hz: 2.4,
      hp: actor.maxHp,
      material: "metal",
      archetype: def.kind === "destruction" ? "mission-structure" : "mission-generator",
      explosiveRadius: 14,
      explosiveForce: 11000,
      explosiveDamage: 190,
      chaosPoints: def.kind === "destruction" ? 320 : 220,
      ref: { actorId: actor.id, missionId: def.id, index },
    });
    actor.destructibleId = d.id;
    this.actors.push(actor);
  }

  private addConvoy(def: MissionDef, tag: string, count: number): void {
    const route = MISSION_ROUTES[def.id];
    if (!route) return;
    const flat = flatten(route);
    for (let i = 0; i < count; i++) {
      // Stagger them back along the first segment so they read as a column.
      const back = i * 26;
      const dirX = route[1].x - route[0].x;
      const dirZ = route[1].z - route[0].z;
      const len = Math.hypot(dirX, dirZ) || 1;
      this.actors.push({
        id: nextActorId++,
        kind: i === 0 ? "convoy" : i < count - 1 ? "convoy" : "escort-vehicle",
        tag,
        x: route[0].x - (dirX / len) * back,
        y: route[0].y,
        z: route[0].z - (dirZ / len) * back,
        yaw: Math.atan2(dirX, dirZ),
        hp: 320,
        maxHp: 320,
        alive: true,
        speed: 17,
        route: flat,
        routeIndex: 1,
        follow: false,
        destructibleId: -1,
        radius: 2.6,
      });
    }
  }

  private addWard(def: MissionDef, tag: string): void {
    this.actors.push({
      id: nextActorId++,
      kind: "ward",
      tag,
      x: def.x,
      y: def.y + 0.9,
      z: def.z,
      yaw: 0,
      hp: 120,
      maxHp: 120,
      alive: true,
      speed: 5.2,
      route: null,
      routeIndex: 0,
      follow: false,
      destructibleId: -1,
      radius: 0.6,
    });
  }

  private clearActors(): void {
    for (const a of this.actors) {
      if (a.destructibleId >= 0) destruction.unregister(a.destructibleId);
    }
    this.actors.length = 0;
  }

  /** Public damage entry point for anything outside the destruction system. */
  damageActor(id: number, amount: number): boolean {
    const a = this.findActor(id);
    if (!a || !a.alive || amount <= 0) return false;
    if (a.destructibleId >= 0) {
      destruction.applyDamage(a.destructibleId, amount, a.x, a.y, a.z);
      return true;
    }
    a.hp -= amount;
    if (a.hp <= 0) this.killActor(a.id);
    return true;
  }

  private killActor(id: number): void {
    const a = this.findActor(id);
    if (!a || !a.alive) return;
    a.alive = false;
    if (a.kind === "convoy" || a.kind === "escort-vehicle") {
      chaos.report("vehicle", a.x, a.y, a.z, { base: 220, label: "Convoy vehicle destroyed" });
      gameHeat.provoke("vehicle-destroyed", a.x, a.z, true);
    }
    if (a.kind === "ward") {
      useSfStore.getState().notify("Contact killed", "damage");
    }
  }

  findActor(id: number): MissionActor | null {
    for (let i = 0; i < this.actors.length; i++) if (this.actors[i].id === id) return this.actors[i];
    return null;
  }

  /** Living actors carrying a tag. */
  countAlive(tag: string): number {
    let n = 0;
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      if (a.alive && a.tag === tag) n++;
    }
    return n;
  }

  /** Limited-resource missions call this when a charge/rocket is spent. */
  spendResource(n = 1): boolean {
    if (this.state !== "active" || !this.active) return true;
    const limit = this.active.failure.resources;
    if (limit <= 0) return true;
    this.resourcesUsed += n;
    if (this.resourcesUsed > limit) {
      this.failMission("Out of charges");
      return false;
    }
    return true;
  }

  get resourcesLeft(): number {
    if (!this.active || this.active.failure.resources <= 0) return Infinity;
    return Math.max(0, this.active.failure.resources - this.resourcesUsed);
  }

  /* ---------------- per-frame ---------------- */

  tick(dt: number): void {
    if (this.state !== "active" || !this.active || frame.paused) return;
    const def = this.active;
    this.elapsed += dt;

    this.updateActors(dt);

    // Failure watchdogs first — a mission that is already lost should not
    // award a checkpoint on the same frame it fails.
    if (def.failure.timeLimit > 0 && this.elapsed > def.failure.timeLimit) {
      this.failMission("Out of time");
      return;
    }
    if (def.failure.leash > 0) {
      const d = Math.hypot(frame.position.x - def.x, frame.position.z - def.z);
      // The leash only arms once you have actually been inside it. You cannot
      // "leave the mission area" before you have entered it, and without this
      // a mission accepted from the map fails on its first tick — the player
      // is still standing wherever they accepted it from.
      if (!this.leashArmed && d <= def.failure.leash) this.leashArmed = true;
      if (this.leashArmed && d > def.failure.leash) {
        this.failMission("Left the mission area");
        return;
      }
    }
    if (def.failure.deathFails && useSfStore.getState().phase === "dead") {
      this.failMission("You died");
      return;
    }
    if (def.failure.wardMustSurvive) {
      for (const a of this.actors) {
        if (a.kind === "ward" && !a.alive) {
          this.failMission("The contact was killed");
          return;
        }
      }
    }

    this.updateObjectives(dt);
    this.publishObjectives();

    // Stage advance / mission completion.
    let stageDone = true;
    let any = false;
    for (const o of this.objectives) {
      if (o.spec.stage !== this.stage) continue;
      any = true;
      if (!o.complete && !o.spec.optional) stageDone = false;
    }
    if (any && stageDone) {
      const maxStage = this.objectives.reduce((m, o) => Math.max(m, o.spec.stage), 0);
      if (this.stage >= maxStage) {
        this.completeMission();
      } else {
        this.stage++;
        this.emit({ type: "stage", def, stage: this.stage });
        useSfStore.getState().notify("Objective complete", "objective");
      }
    }
  }

  private updateActors(dt: number): void {
    const px = frame.position.x;
    const pz = frame.position.z;
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      if (!a.alive) continue;

      if (a.route) {
        const n = a.route.length / 3;
        if (a.routeIndex < n) {
          const tx = a.route[a.routeIndex * 3];
          const ty = a.route[a.routeIndex * 3 + 1];
          const tz = a.route[a.routeIndex * 3 + 2];
          const dx = tx - a.x;
          const dz = tz - a.z;
          const d = Math.hypot(dx, dz);
          if (d < 6) {
            a.routeIndex++;
          } else {
            const step = Math.min(d, a.speed * dt);
            a.x += (dx / d) * step;
            a.z += (dz / d) * step;
            a.y += (ty - a.y) * Math.min(1, dt * 2.5);
            a.yaw = Math.atan2(dx, dz);
          }
        }
      } else if (a.kind === "ward" && a.follow) {
        // Wards hang back a couple of metres and jog to keep up, which reads
        // as a person following rather than a magnet.
        const dx = px - a.x;
        const dz = pz - a.z;
        const d = Math.hypot(dx, dz);
        if (d > 3.2) {
          const step = Math.min(d - 2.4, a.speed * dt * (d > 12 ? 1.35 : 1));
          a.x += (dx / d) * step;
          a.z += (dz / d) * step;
          a.yaw = Math.atan2(dx, dz);
        }
        a.y = walkableHeight(a.x, a.z) + 0.9;
      }
    }
  }

  private updateObjectives(dt: number): void {
    const def = this.active!;
    const px = frame.position.x;
    const py = frame.position.y;
    const pz = frame.position.z;

    for (const o of this.objectives) {
      if (o.complete || o.spec.stage !== this.stage) continue;
      const s = o.spec;

      switch (s.kind) {
        case "reach": {
          const d = Math.hypot(px - s.x, pz - s.z);
          const dy = Math.abs(py - s.y);
          o.progress = clamp01(1 - (d - s.radius) / Math.max(1, s.radius * 8));
          if (d < s.radius && dy < Math.max(20, s.radius)) this.completeObjective(o);
          break;
        }

        case "gates":
        case "checkpoints": {
          const pts = s.points!;
          const g = pts[o.index];
          if (!g) {
            this.completeObjective(o);
            break;
          }
          const d = Math.hypot(px - g.x, pz - g.z);
          // Gates are spheres in the air; checkpoints are cylinders on the
          // ground, because a car cannot be asked to hit a specific altitude.
          const hit =
            s.kind === "gates"
              ? d < g.radius && Math.abs(py - g.y) < g.radius
              : d < g.radius && py > g.y - 30 && py < g.y + 40;
          if (hit) {
            o.index++;
            o.value = o.index;
            if (o.index >= pts.length) this.completeObjective(o);
            else useSfStore.getState().notify(`${o.index} / ${pts.length}`, "objective");
          }
          o.progress = o.index / pts.length;
          break;
        }

        case "destroy": {
          const total = s.count ?? 1;
          const left = s.tag ? this.countAlive(s.tag) : 0;
          o.value = total - left;
          o.progress = clamp01(o.value / total);
          if (left <= 0) this.completeObjective(o);
          break;
        }

        case "chaos": {
          const need = s.count ?? 1000;
          o.value = this.chaosAccum;
          o.progress = clamp01(o.value / need);
          if (o.value >= need) this.completeObjective(o);
          break;
        }

        case "clear": {
          let alive = 0;
          const r2 = s.radius * s.radius;
          for (const e of enemyForce.enemies) {
            if (!e.alive) continue;
            if (e.faction !== "cartel" && e.faction !== "military" && e.faction !== "police") continue;
            const dx = e.x - s.x;
            const dz = e.z - s.z;
            if (dx * dx + dz * dz < r2) alive++;
          }
          // `value` holds the high-water mark of the garrison, so the bar
          // measures how much of it you have removed rather than flickering
          // with reinforcements. It also arms the objective: a clear task must
          // not tick complete on the frame before the squads finish spawning.
          if (alive > o.value) o.value = alive;
          if (alive > 0) o.armed = true;
          o.progress = o.armed ? clamp01(1 - alive / Math.max(1, o.value)) : 0;
          if (o.armed && alive === 0) this.completeObjective(o);
          break;
        }

        case "survive": {
          const need = s.duration ?? 60;
          const d = Math.hypot(px - s.x, pz - s.z);
          // Leaving the area pauses the clock rather than resetting it: the
          // punishment for running is that you are not making progress.
          if (d < s.radius) o.value += dt;
          o.progress = clamp01(o.value / need);
          if (o.value >= need) this.completeObjective(o);
          break;
        }

        case "escort": {
          let ward: MissionActor | null = null;
          for (const a of this.actors) if (a.kind === "ward" && a.alive) ward = a;
          if (!ward) break;
          ward.follow = true;
          const d = Math.hypot(ward.x - s.x, ward.z - s.z);
          const total = Math.hypot(def.x - s.x, def.z - s.z) || 1;
          o.progress = clamp01(1 - d / total);
          if (d < s.radius) this.completeObjective(o);
          break;
        }
      }
    }
  }

  private completeObjective(o: ObjectiveRuntime): void {
    if (o.complete) return;
    o.complete = true;
    o.progress = 1;
    if (this.active) this.emit({ type: "objective", def: this.active, objective: o.spec });
  }

  /** Chaos scored inside a chaos-run radius counts toward it. */
  private onChaosAward(a: ChaosAward, x: number, z: number): void {
    if (this.state !== "active" || !this.active) return;
    if (a.points <= 0) return;
    for (const o of this.objectives) {
      if (o.spec.kind !== "chaos" || o.complete) continue;
      const dx = x - o.spec.x;
      const dz = z - o.spec.z;
      if (dx * dx + dz * dz > o.spec.radius * o.spec.radius) continue;
      this.chaosAccum += a.points;
    }
  }

  /* ---------------- HUD mirror ---------------- */

  private publishObjectives(): void {
    const def = this.active;
    if (!def) return;
    const store = useSfStore.getState();
    for (const o of this.objectives) {
      if (o.spec.stage > this.stage) continue;
      const id = `${def.id}:${o.spec.id}`;
      // Only write when the bar would visibly move, or on a state change.
      const moved = Math.abs(o.progress - o.published) > 0.02;
      const flipped = o.complete && o.published < 1;
      if (o.published < 0) {
        const target = o.spec.points ? o.spec.points[Math.min(o.index, o.spec.points.length - 1)] : o.spec;
        store.addObjective({
          id,
          title: o.spec.title,
          detail: o.spec.detail,
          x: target.x,
          y: target.y,
          z: target.z,
          complete: o.complete,
          progress: o.progress,
        });
        o.published = o.progress;
      } else if (moved || flipped) {
        const target = o.spec.points ? o.spec.points[Math.min(o.index, o.spec.points.length - 1)] : o.spec;
        store.updateObjective(id, {
          complete: o.complete,
          progress: o.progress,
          x: target.x,
          y: target.y,
          z: target.z,
        });
        o.published = o.complete ? 1 : o.progress;
      }
    }
  }

  /* ---------------- endings ---------------- */

  private completeMission(): void {
    const def = this.active;
    if (!def) return;
    const first = !this.completed.has(def.id);
    this.completed.add(def.id);
    const elapsed = this.elapsed;

    chaos.payout(def.reward.chaos, `${def.name} complete`);
    useSfStore.getState().notify(`${def.name} — complete`, "objective", def.reward.chaos);

    // Best-time bookkeeping is the progression module's job; the event carries
    // everything it needs, so missions do not have to know about unlocks.
    this.finish(true, "Complete");
    this.emit({ type: "complete", def, elapsed, best: first });
  }

  private failMission(reason: string): void {
    const def = this.active;
    if (!def) return;
    useSfStore.getState().notify(`${def.name} — failed: ${reason}`, "damage");
    this.finish(false, reason);
    this.emit({ type: "fail", def, reason });
  }

  reset(): void {
    if (this.state === "active") this.abort("Reset");
    this.completed.clear();
    this.state = "idle";
    this.lastResult = null;
  }

  get stats() {
    return {
      state: this.state,
      active: this.active?.id ?? null,
      stage: this.stage,
      elapsed: Math.round(this.elapsed),
      actors: this.actors.length,
      completed: this.completed.size,
      total: MISSIONS.length,
    };
  }
}

export const missions = new MissionRuntime();

/** Terrain-aware Y for a mission marker, so map pins do not float or sink. */
export function markerHeight(x: number, z: number): number {
  return Math.max(terrainHeight(x, z), 0);
}
