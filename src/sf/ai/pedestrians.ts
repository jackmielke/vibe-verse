/**
 * ai/pedestrians.ts — the crowd.
 *
 * Pedestrians are the cheapest thing in the game that makes the most difference
 * to whether a city reads as a city. They are also the easiest thing to get
 * catastrophically wrong: a hundred identical people walking through each other
 * at identical speeds down the middle of the road is worse than an empty street.
 *
 * So the rules here are:
 *
 *   - They walk on the *pavement*, projected off the road graph's own kerb
 *     geometry, on a chosen side, and they round corners by keeping to the same
 *     physical side of the block rather than by teleporting across it.
 *   - They cross at junctions, and only when the signal actually lets them —
 *     the same `signalState` the traffic reads, so a wave of pedestrians steps
 *     off the kerb exactly when the queue of cars stops.
 *   - They avoid each other with the shared RVO field, so two streams passing
 *     on Market interleave instead of interpenetrating.
 *   - Density comes from the district and the hour: the Financial District is
 *     dense at 9 am and dead at 11 pm, the Mission is the opposite, and the
 *     Presidio is never busy.
 *   - Gunfire empties a block in under two seconds. Some run, some freeze and
 *     cower, some sprint for the nearest corner and around it. Nobody keeps
 *     window-shopping.
 *
 * Storage is structure-of-arrays over typed buffers. Four hundred agents ×
 * thirty fields as objects is four hundred allocations, four hundred pointer
 * chases per pass and a garbage collector that runs during firefights.
 *
 * Public API
 * ----------
 *   pedestrians.update(dt, now, cam…)   simulate
 *   pedestrians.render(batch, cam…)     write instances
 *   pedestrians.spawnNear / cullFar / spawnFleeing
 *   pedestrians.hitTest / applyDamage
 */
import { districtAt } from "../geo/sfGeo";
import { frame } from "../state/store";
import { makeRng, type Rng } from "../math/rng";
import {
  edgeSpan,
  roadNetwork,
  signalState,
  approachPhase,
  type RoadEdge,
  type RoadNode,
} from "../world/street/roadNetwork";
import type { CharacterBatch } from "./characters";
import { archetypeBody, archetypeMask, makePalette, PALETTE_FLOATS } from "./characters";
import {
  avoidance,
  chooseContinuation,
  groundHeight,
  navGraph,
  sideOfEdge,
  sidewalkPoint,
} from "./navigation";
import { emitNoise, strongestThreatNear } from "./perception";
import { trafficSim } from "./traffic";
import {
  ANIM_COWER,
  ANIM_DEAD,
  ANIM_IDLE,
  ANIM_RUN,
  ANIM_SIT,
  ANIM_WALK,
  LOD_FROZEN,
  LOD_FULL,
  LOD_SIMPLE,
  nextEntityId,
  type CharacterArchetype,
} from "./types";

/* ================================================================== *
 * States
 * ================================================================== */

const S_WALK = 0;
const S_WAIT = 1;
const S_CROSS = 2;
const S_FLEE = 3;
const S_COWER = 4;
const S_IDLE = 5;
const S_DEAD = 6;

/**
 * The default cast, for a district with nothing more specific to say.
 * Repeats are the weighting: most people on a pavement are just people.
 */
const ARCHETYPES: CharacterArchetype[] = [
  "civilian",
  "civilian",
  "civilian",
  "civilian-slim",
  "civilian-heavy",
  "tourist",
  "worker",
];

/* ================================================================== *
 * Casting
 * ================================================================== *
 * Who is on this pavement, in this neighbourhood, at this hour.
 *
 * The crowd used to be one uniform pick from the list above everywhere in the
 * city, which made every district read the same: the Marina at ten in the
 * morning had the same seven people as the Tenderloin at midnight. San
 * Francisco is nine kilometres of extremely distinct neighbourhoods and the
 * pedestrians are most of what distinguishes them at street level — more than
 * the facades, because you are looking along the pavement, not up.
 *
 * A weighted table per district, biased by the clock. Weights are relative and
 * do not need to sum to anything.
 */
type CastEntry = [CharacterArchetype, number];

/** Ordinary people, in the proportions a street has them. Every cast gets these. */
const BASE_CAST: CastEntry[] = [
  ["civilian", 34],
  ["civilian-slim", 9],
  ["civilian-heavy", 9],
];

const DISTRICT_CAST: Record<string, CastEntry[]> = {
  // Downtown: lanyards, couriers, and the people the city has failed, all on
  // the same block — which is the actual experience of walking Market Street.
  fidi: [["techie", 26], ["worker", 10], ["cyclist", 7], ["street", 5], ["tourist", 4]],
  soma: [["techie", 20], ["worker", 14], ["cyclist", 8], ["street", 9]],
  rincon: [["techie", 22], ["cyclist", 7], ["worker", 6], ["street", 4]],
  // Civic Center and the Tenderloin edge: the sharpest contrast in the city.
  civiccenter: [["street", 26], ["worker", 10], ["techie", 6], ["cyclist", 4]],
  // Tourist city.
  embarcadero: [["tourist", 24], ["cyclist", 10], ["techie", 8], ["worker", 6], ["street", 4]],
  chinatown: [["tourist", 20], ["worker", 10], ["street", 3]],
  northbeach: [["tourist", 18], ["worker", 8], ["street", 4]],
  telegraph: [["tourist", 22], ["worker", 4]],
  presidio: [["cyclist", 16], ["tourist", 12]],
  marina: [["cyclist", 12], ["techie", 12], ["tourist", 8]],
  // Residential and the neighbourhood commercial strips.
  mission: [["cyclist", 12], ["worker", 12], ["street", 10], ["techie", 8], ["tourist", 4]],
  castro: [["tourist", 8], ["cyclist", 8], ["worker", 6], ["street", 4]],
  haight: [["tourist", 12], ["street", 10], ["cyclist", 8]],
  hayesvalley: [["techie", 10], ["cyclist", 8], ["worker", 6], ["street", 4]],
  westernaddition: [["worker", 10], ["street", 8], ["cyclist", 5]],
  alamo: [["cyclist", 8], ["techie", 7], ["worker", 5]],
  nobhill: [["tourist", 10], ["techie", 8], ["worker", 6], ["street", 3]],
  russianhill: [["tourist", 8], ["techie", 7], ["cyclist", 5]],
  pacheights: [["techie", 8], ["worker", 7], ["cyclist", 4]],
  potrero: [["techie", 10], ["worker", 10], ["cyclist", 6], ["street", 4]],
  dogpatch: [["worker", 12], ["techie", 8], ["cyclist", 6], ["street", 3]],
  bayview: [["worker", 16], ["street", 8]],
  richmond: [["worker", 8], ["cyclist", 6], ["tourist", 4]],
  sunset: [["worker", 8], ["cyclist", 6], ["tourist", 3]],
};

/* Scratch, refilled per call: the cast and its weights in parallel arrays
   rather than tuples, so casting somebody allocates nothing. */
const _castWho: CharacterArchetype[] = [];
const _castWeight: number[] = [];

/**
 * Pick an archetype for somebody spawning at (x, z) at `hour`.
 *
 * The clock moves the weights rather than the membership: commuters thin out
 * after the evening, tourists go home when it gets dark and cold, and the
 * people who live outside are there at every hour — more visibly at the ones
 * when nobody else is.
 */
export function castArchetype(
  x: number,
  z: number,
  hour: number,
  rng: Rng,
): CharacterArchetype {
  const key = districtAt(x, z).key;
  _castWho.length = 0;
  _castWeight.length = 0;

  const workday = hour >= 7 && hour < 19;
  const daylight = hour >= 8 && hour < 18.5;
  let total = 0;
  const add = (a: CharacterArchetype, w0: number): void => {
    let w = w0;
    if (a === "techie" || a === "worker") w *= workday ? 1 : 0.28;
    else if (a === "tourist") w *= daylight ? 1 : 0.3;
    else if (a === "cyclist") w *= workday ? 1 : 0.5;
    // Not a night-time spike so much as everybody else having gone home.
    else if (a === "street") w *= workday ? 1 : 1.35;
    if (w <= 0) return;
    _castWho.push(a);
    _castWeight.push(w);
    total += w;
  };

  for (const [a, w] of BASE_CAST) add(a, w);
  const extra = DISTRICT_CAST[key];
  if (extra) for (const [a, w] of extra) add(a, w);

  if (total <= 0) return rng.pick(ARCHETYPES);
  let r = rng.next() * total;
  for (let i = 0; i < _castWho.length; i++) {
    r -= _castWeight[i];
    if (r <= 0) return _castWho[i];
  }
  return _castWho[_castWho.length - 1];
}

/** Per-archetype pace multiplier over the population's own spread. */
export function paceFor(archetype: CharacterArchetype): number {
  switch (archetype) {
    // Late for something.
    case "techie":
      return 1.12;
    case "worker":
      return 1.05;
    // Stopping every few paces to look at the thing they came to look at.
    case "tourist":
      return 0.82;
    // Nowhere to be, and usually carrying everything they own.
    case "street":
      return 0.66;
    default:
      return 1;
  }
}

/** Walking speeds, m/s. Real pedestrian mean is 1.34; the spread is the point. */
const WALK_MIN = 1.05;
const WALK_MAX = 1.72;
const RUN_SPEED = 5.4;
const CROSS_SPEED = 1.55;

/* ================================================================== *
 * The crowd
 * ================================================================== */

class Pedestrians {
  /** Hard ceiling. `capacity` is allocated once; `max` is the live budget. */
  private capacity: number;
  max = 260;

  count = 0;

  /* ---- identity ---- */
  private id: Int32Array;
  private seed: Float32Array;
  private mask: Float32Array;
  private heightScale: Float32Array;
  private girth: Float32Array;
  private palette: Float32Array;

  /* ---- kinematics ---- */
  private x: Float32Array;
  private y: Float32Array;
  private z: Float32Array;
  private yaw: Float32Array;
  private vx: Float32Array;
  private vz: Float32Array;
  private speed: Float32Array;
  private phase: Float32Array;

  /* ---- graph state ---- */
  private edge: Int32Array;
  private dir: Int8Array;
  private side: Int8Array;
  private travel: Float32Array;

  /* ---- behaviour ---- */
  private state: Uint8Array;
  private timer: Float32Array;
  private clip: Uint8Array;
  private blend: Float32Array;
  private prefSpeed: Float32Array;
  private lod: Uint8Array;
  private lastLook: Float32Array;
  private health: Float32Array;
  private soak: Float32Array;
  /** Crossing endpoints, world space. */
  private crossFromX: Float32Array;
  private crossFromZ: Float32Array;
  private crossToX: Float32Array;
  private crossToZ: Float32Array;
  private crossT: Float32Array;
  /** Where a fleeing pedestrian is running away from. */
  private threatX: Float32Array;
  private threatZ: Float32Array;
  /** This frame's slot in the avoidance field, or −1 when unregistered. */
  private avoidHandle: Int32Array;

  private rng: Rng = makeRng("sf-pedestrians");
  private freeIds: number[] = [];

  stats = { count: 0, full: 0, simple: 0, frozen: 0, fleeing: 0 };

  /** Emitted when a pedestrian is killed — chaos, heat, notifications. */
  onKilled: ((x: number, y: number, z: number) => void) | null = null;

  constructor(capacity = 420) {
    this.capacity = capacity;
    const f = (n = 1) => new Float32Array(capacity * n);
    this.id = new Int32Array(capacity);
    this.seed = f();
    this.mask = f();
    this.heightScale = f();
    this.girth = f();
    this.palette = new Float32Array(capacity * PALETTE_FLOATS);
    this.x = f();
    this.y = f();
    this.z = f();
    this.yaw = f();
    this.vx = f();
    this.vz = f();
    this.speed = f();
    this.phase = f();
    this.edge = new Int32Array(capacity);
    this.dir = new Int8Array(capacity);
    this.side = new Int8Array(capacity);
    this.travel = f();
    this.state = new Uint8Array(capacity);
    this.timer = f();
    this.clip = new Uint8Array(capacity);
    this.blend = f();
    this.prefSpeed = f();
    this.lod = new Uint8Array(capacity);
    this.lastLook = f();
    this.health = f();
    this.soak = f();
    this.crossFromX = f();
    this.crossFromZ = f();
    this.crossToX = f();
    this.crossToZ = f();
    this.crossT = f();
    this.threatX = f();
    this.threatZ = f();
    this.avoidHandle = new Int32Array(capacity);
  }

  reset(seed = "sf-pedestrians"): void {
    this.count = 0;
    this.rng = makeRng(seed);
  }

  /* ---------------- density model ---------------- */

  /**
   * How busy this place is right now, 0..1.5. Real San Francisco: downtown is a
   * weekday machine that empties at seven, North Beach and the Mission fill up
   * as it empties, and nobody is on Ocean Beach at 3 am.
   */
  static crowdFactor(x: number, z: number, hour: number): number {
    const d = districtAt(x, z);
    const day = Math.max(0, Math.sin(((hour - 6.5) / 12) * Math.PI)); // 6:30–18:30 hump
    const evening = Math.max(0, Math.sin(((hour - 17) / 9) * Math.PI)); // 17:00–02:00 hump
    let base = d.density;
    let curve = day * 0.85 + evening * 0.35;
    switch (d.key) {
      case "fidi":
      case "soma":
      case "civiccenter":
      case "rincon":
        curve = day * 1.25 + evening * 0.2;
        base *= 1.15;
        break;
      case "northbeach":
      case "mission":
      case "castro":
      case "haight":
      case "chinatown":
        curve = day * 0.7 + evening * 1.15;
        base *= 1.1;
        break;
      case "embarcadero":
      case "marina":
        curve = day * 1.0 + evening * 0.5;
        break;
      case "presidio":
      case "bayview":
      case "dogpatch":
        base *= 0.4;
        break;
      case "sunset":
      case "richmond":
        base *= 0.55;
        break;
      default:
        break;
    }
    // Never fully empty: a dead city at 4 am is a bug report, not atmosphere.
    return Math.max(0.08, Math.min(1.5, base * (0.14 + curve)));
  }

  /* ---------------- spawning ---------------- */

  /** Spawn one pedestrian on a pavement near (cx, cz). Returns its slot or −1. */
  spawnNear(cx: number, cz: number, minDist: number, maxDist: number, hour: number, now: number): number {
    if (this.count >= this.max || this.count >= this.capacity) return -1;
    const rng = this.rng;
    for (let attempt = 0; attempt < 6; attempt++) {
      const a = rng.next() * Math.PI * 2;
      const d = minDist + rng.next() * (maxDist - minDist);
      const px = cx + Math.cos(a) * d;
      const pz = cz + Math.sin(a) * d;
      navGraph.ensure(px, pz, 160);
      const hit = roadNetwork.nearestEdge(px, pz, 60);
      if (!hit) continue;
      const e = hit.edge;
      const span = edgeSpan(e);
      if (span.len < 10) continue;
      // Density gate — a spawn attempt in the Presidio at 3 am should usually
      // fail, and that is the whole mechanism.
      if (!rng.chance(Math.min(1, Pedestrians.crowdFactor(px, pz, hour) * 0.9))) continue;
      const side: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      const travel = span.s0 + rng.next() * Math.max(1, span.len - 2);
      return this.create(e, side, rng.chance(0.5) ? 1 : -1, travel, now);
    }
    return -1;
  }

  /** Spawn a pedestrian already running — used when a driver is thrown out. */
  spawnFleeing(x: number, y: number, z: number, awayX: number, awayZ: number, now: number): number {
    navGraph.ensure(x, z, 120);
    const hit = roadNetwork.nearestEdge(x, z, 60);
    if (!hit) return -1;
    const i = this.create(hit.edge, sideOfEdge(hit.edge, x, z), 1, hit.s, now);
    if (i < 0) return i;
    this.x[i] = x;
    this.y[i] = groundHeight(x, z, y + 3, 8);
    this.z[i] = z;
    this.state[i] = S_FLEE;
    this.timer[i] = 6 + this.rng.next() * 6;
    this.threatX[i] = x - awayX * 12;
    this.threatZ[i] = z - awayZ * 12;
    return i;
  }

  private create(e: RoadEdge, side: 1 | -1, dir: 1 | -1, travel: number, now: number): number {
    if (this.count >= this.max || this.count >= this.capacity) return -1;
    const i = this.count++;
    const rng = this.rng;

    /* Place first, then cast. Who somebody is depends on which pavement they
       are standing on, so the position has to exist before the wardrobe does —
       this used to pick uniformly from one list and every district got the
       same seven people. */
    this.edge[i] = e.id;
    this.dir[i] = dir;
    this.side[i] = side;
    this.travel[i] = travel;
    this.placeOnSidewalk(i, e);

    const arche = castArchetype(this.x[i], this.z[i], frame.timeOfDay, rng);
    this.id[i] = nextEntityId();
    this.seed[i] = rng.next();
    this.mask[i] = archetypeMask(arche, rng);
    const [h, g] = archetypeBody(arche, rng);
    this.heightScale[i] = h;
    this.girth[i] = g;
    const pal = makePalette(rng, arche);
    this.palette.set(pal, i * PALETTE_FLOATS);

    this.state[i] = S_WALK;
    this.timer[i] = 0;
    this.clip[i] = ANIM_WALK;
    this.blend[i] = 0;
    this.prefSpeed[i] =
      (WALK_MIN + rng.next() * (WALK_MAX - WALK_MIN)) * paceFor(arche);
    this.speed[i] = this.prefSpeed[i];
    this.phase[i] = rng.next();
    this.lod[i] = LOD_FULL;
    this.lastLook[i] = now - rng.next();
    this.health[i] = 40;
    this.soak[i] = 0;
    this.crossT[i] = 0;
    this.vx[i] = 0;
    this.vz[i] = 0;

    this.yaw[i] = dir === 1 ? Math.atan2(e.dz, e.dx) : Math.atan2(-e.dz, -e.dx);
    return i;
  }

  private placeOnSidewalk(i: number, e: RoadEdge): void {
    const s = this.dir[i] === 1 ? this.travel[i] : e.length - this.travel[i];
    const p = sidewalkPoint(e, clamp(s, 0, e.length), this.side[i] as 1 | -1);
    this.x[i] = p.x;
    this.y[i] = p.y;
    this.z[i] = p.z;
  }

  private removeAt(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.copySlot(last, i);
  }

  private copySlot(from: number, to: number): void {
    this.id[to] = this.id[from];
    this.seed[to] = this.seed[from];
    this.mask[to] = this.mask[from];
    this.heightScale[to] = this.heightScale[from];
    this.girth[to] = this.girth[from];
    this.palette.copyWithin(to * PALETTE_FLOATS, from * PALETTE_FLOATS, (from + 1) * PALETTE_FLOATS);
    this.x[to] = this.x[from];
    this.y[to] = this.y[from];
    this.z[to] = this.z[from];
    this.yaw[to] = this.yaw[from];
    this.vx[to] = this.vx[from];
    this.vz[to] = this.vz[from];
    this.speed[to] = this.speed[from];
    this.phase[to] = this.phase[from];
    this.edge[to] = this.edge[from];
    this.dir[to] = this.dir[from];
    this.side[to] = this.side[from];
    this.travel[to] = this.travel[from];
    this.state[to] = this.state[from];
    this.timer[to] = this.timer[from];
    this.clip[to] = this.clip[from];
    this.blend[to] = this.blend[from];
    this.prefSpeed[to] = this.prefSpeed[from];
    this.lod[to] = this.lod[from];
    this.lastLook[to] = this.lastLook[from];
    this.health[to] = this.health[from];
    this.soak[to] = this.soak[from];
    this.crossFromX[to] = this.crossFromX[from];
    this.crossFromZ[to] = this.crossFromZ[from];
    this.crossToX[to] = this.crossToX[from];
    this.crossToZ[to] = this.crossToZ[from];
    this.crossT[to] = this.crossT[from];
    this.threatX[to] = this.threatX[from];
    this.threatZ[to] = this.threatZ[from];
    this.avoidHandle[to] = this.avoidHandle[from];
  }

  /**
   * Remove pedestrians the player cannot see. "Politely" means: never despawn
   * inside the view cone at close range, and prefer bodies that are behind the
   * camera or beyond the fade radius. A person who blinks out of existence in
   * your peripheral vision is more noticeable than one too many on screen.
   */
  cullFar(cx: number, cz: number, fx: number, fz: number, radius: number, now: number): number {
    const far2 = radius * radius;
    const near2 = (radius * 0.55) * (radius * 0.55);
    let removed = 0;
    for (let i = this.count - 1; i >= 0; i--) {
      if (this.state[i] === S_DEAD && this.timer[i] > 0) continue;
      const dx = this.x[i] - cx;
      const dz = this.z[i] - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < near2) continue;
      if (d2 > far2) {
        this.removeAt(i);
        removed++;
        continue;
      }
      // Between the two radii: only cull what is behind the camera.
      const inv = 1 / Math.max(1e-3, Math.sqrt(d2));
      if (dx * inv * fx + dz * inv * fz < -0.1) {
        this.removeAt(i);
        removed++;
      }
    }
    return removed;
  }

  /* ---------------- simulation ---------------- */

  update(dt: number, now: number, cx: number, cz: number): void {
    let full = 0;
    let simple = 0;
    let frozen = 0;
    let fleeing = 0;

    // Register everyone in the avoidance field first, so the solve pass sees a
    // complete picture. Vehicles go in too, with a high priority — people get
    // out of the way of cars, not the other way round.
    for (let i = 0; i < this.count; i++) {
      if (this.state[i] === S_DEAD) {
        this.avoidHandle[i] = -1;
        continue;
      }
      // Keep the handle: solving with −1 means the agent does not know which
      // entry in the field is itself, sees itself as an overlapping obstacle
      // and stops avoiding anything at all.
      this.avoidHandle[i] = avoidance.add(this.x[i], this.z[i], this.vx[i], this.vz[i], 0.34, 0);
    }
    trafficSim.forEachNear(cx, cz, 220, (v) => {
      const fx = Math.cos(v.yaw);
      const fz = Math.sin(v.yaw);
      avoidance.add(v.x, v.z, fx * v.speed, fz * v.speed, v.spec.width * 0.6, 3);
    });

    for (let i = this.count - 1; i >= 0; i--) {
      const dx = this.x[i] - cx;
      const dz = this.z[i] - cz;
      const d2 = dx * dx + dz * dz;
      const lod = d2 < 70 * 70 ? LOD_FULL : d2 < 200 * 200 ? LOD_SIMPLE : LOD_FROZEN;
      this.lod[i] = lod;
      if (lod === LOD_FULL) full++;
      else if (lod === LOD_SIMPLE) simple++;
      else frozen++;

      const st = this.state[i];
      if (st === S_FLEE) fleeing++;

      if (st === S_DEAD) {
        this.timer[i] -= dt;
        this.blend[i] = Math.min(1, this.blend[i] + dt * 3.5);
        if (this.timer[i] <= -12) this.removeAt(i);
        continue;
      }

      // Perception: 5 Hz near, 1.5 Hz mid, never far. A gunshot on Market has
      // to reach the whole block inside two seconds, and 5 Hz is 0.2 s.
      const lookInterval = lod === LOD_FULL ? 0.2 : lod === LOD_SIMPLE ? 0.65 : 3;
      if (now - this.lastLook[i] > lookInterval) {
        this.lastLook[i] = now;
        this.perceive(i, now);
      }

      switch (this.state[i]) {
        case S_CROSS:
          this.stepCross(i, dt, now);
          break;
        case S_WAIT:
          this.stepWait(i, dt, now);
          break;
        case S_COWER:
          this.stepCower(i, dt, now);
          break;
        case S_IDLE:
          this.stepIdle(i, dt, now);
          break;
        case S_FLEE:
        case S_WALK:
        default:
          this.stepWalk(i, dt, now);
          break;
      }

      // Gait phase advances with distance covered, not with time — which is
      // the whole reason feet do not skate.
      const stride = 0.78 * this.heightScale[i];
      this.phase[i] = (this.phase[i] + (this.speed[i] * dt) / stride) % 1;
      this.soak[i] = Math.max(0, this.soak[i] - dt * 0.04);
    }

    this.stats.count = this.count;
    this.stats.full = full;
    this.stats.simple = simple;
    this.stats.frozen = frozen;
    this.stats.fleeing = fleeing;
  }

  /** Look for reasons to stop being a pedestrian. */
  private perceive(i: number, now: number): void {
    const st = this.state[i];
    if (st === S_FLEE || st === S_COWER) return;
    const t = strongestThreatNear(this.x[i], this.z[i], now - 2.5);
    if (!t || t.threat < 0.35) return;

    const dx = this.x[i] - t.x;
    const dz = this.z[i] - t.z;
    const d = Math.hypot(dx, dz);
    this.threatX[i] = t.x;
    this.threatZ[i] = t.z;

    // Very close and very loud: freeze. Further out: run. This split is what
    // makes a shooting look like a shooting instead of a fire drill.
    const freeze = d < 16 && t.threat > 0.8 ? 0.45 : 0.12;
    if (this.rng.chance(freeze)) {
      this.state[i] = S_COWER;
      this.clip[i] = ANIM_COWER;
      this.blend[i] = 0;
      this.timer[i] = 5 + this.rng.next() * 6;
      this.speed[i] = 0;
    } else {
      this.state[i] = S_FLEE;
      this.clip[i] = ANIM_RUN;
      this.blend[i] = 0;
      this.timer[i] = 7 + this.rng.next() * 7;
      // Run the way that increases the distance along this pavement. `travel`
      // is measured from whichever node we entered by, so reversing direction
      // means mirroring it — forget that and the runner teleports a block.
      const e = roadNetwork.edges[this.edge[i]];
      if (e) {
        const away = dx * e.dx + dz * e.dz;
        const newDir: 1 | -1 = away >= 0 ? 1 : -1;
        if (newDir !== this.dir[i]) {
          this.travel[i] = e.length - this.travel[i];
          this.dir[i] = newDir;
        }
      }
      if (this.rng.chance(0.55)) {
        emitNoise("scream", this.x[i], this.y[i] + 1.5, this.z[i], "civilian", this.id[i]);
      }
    }
  }

  /* ---- the pavement walk ---- */

  private stepWalk(i: number, dt: number, now: number): void {
    const e = roadNetwork.edges[this.edge[i]];
    if (!e) {
      this.rejoinGraph(i);
      return;
    }
    const fleeing = this.state[i] === S_FLEE;
    if (fleeing) {
      this.timer[i] -= dt;
      if (this.timer[i] <= 0) {
        this.state[i] = S_WALK;
        this.clip[i] = ANIM_WALK;
      }
    }

    const target = fleeing ? RUN_SPEED : this.prefSpeed[i];
    this.speed[i] += (target - this.speed[i]) * Math.min(1, dt * 4);

    // Where the pavement says to go next.
    const dirSign = this.dir[i];
    const sNow = dirSign === 1 ? this.travel[i] : e.length - this.travel[i];
    const ahead = clamp(sNow + dirSign * 2.4, 0, e.length);
    const p = sidewalkPoint(e, ahead, this.side[i] as 1 | -1);
    let dx = p.x - this.x[i];
    let dz = p.z - this.z[i];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;

    let vx = dx * this.speed[i];
    let vz = dz * this.speed[i];

    // Local avoidance only where it can be seen.
    if (this.lod[i] === LOD_FULL) {
      avoidance.solve(this.avoidHandle[i], this.x[i], this.z[i], vx, vz, 0.34, _steer, 2.0, 0);
      vx = _steer[0];
      vz = _steer[1];
    }

    this.x[i] += vx * dt;
    this.z[i] += vz * dt;
    this.vx[i] = vx;
    this.vz[i] = vz;
    this.travel[i] += this.speed[i] * dt;
    this.y[i] = p.y;
    const spd = Math.hypot(vx, vz);
    if (spd > 0.05) {
      this.yaw[i] = approach(this.yaw[i], Math.atan2(vz, vx), dt * (fleeing ? 7 : 4.5));
    }
    this.speed[i] = spd;
    this.clip[i] = fleeing ? ANIM_RUN : ANIM_WALK;
    this.blend[i] = fleeing ? Math.min(1, this.blend[i] + dt * 4) : 0;

    if (this.travel[i] >= e.length - 1.5) {
      this.atJunction(i, e, now);
    }
  }

  /** Decide what happens at the end of a block. */
  private atJunction(i: number, e: RoadEdge, now: number): void {
    const exitNodeId = this.dir[i] === 1 ? e.b : e.a;
    const node = roadNetwork.nodes[exitNodeId];
    if (!node) {
      this.dir[i] = this.dir[i] === 1 ? -1 : 1;
      this.travel[i] = 1;
      return;
    }
    navGraph.ensure(node.x, node.z, 200);

    // A fleeing pedestrian takes the first turning that puts a building between
    // them and the noise; everyone else wanders with a straight-ahead bias.
    const fleeing = this.state[i] === S_FLEE;
    const nextId = fleeing
      ? this.turnAwayFrom(node, e, this.threatX[i], this.threatZ[i])
      : chooseContinuation(node, e.id, 0.75, this.rng.next(), false);
    const next = roadNetwork.edges[nextId];

    // Sometimes step off the kerb instead of rounding the corner.
    if (!fleeing && this.rng.chance(0.22)) {
      this.beginCross(i, e, node.id, now);
      return;
    }

    if (!next || nextId === e.id) {
      this.dir[i] = this.dir[i] === 1 ? -1 : 1;
      this.travel[i] = 1.5;
      return;
    }
    const overshoot = Math.max(0, this.travel[i] - e.length);
    this.edge[i] = next.id;
    this.dir[i] = next.a === exitNodeId ? 1 : -1;
    this.travel[i] = overshoot + 0.5;
    // Keep to the same *physical* side of the block: recompute the side from
    // where the body actually is, rather than carrying a sign across a corner
    // and teleporting the walker to the other pavement.
    this.side[i] = sideOfEdge(next, this.x[i], this.z[i]);
  }

  /** The outgoing edge whose heading points most directly away from a threat. */
  private turnAwayFrom(node: RoadNode, from: RoadEdge, tx: number, tz: number): number {
    const edges = roadNetwork.edges;
    let best = -1;
    let bestScore = -Infinity;
    const toThreatX = tx - node.x;
    const toThreatZ = tz - node.z;
    const l = Math.hypot(toThreatX, toThreatZ) || 1;
    for (const eid of node.edges) {
      if (eid === from.id) continue;
      const cand = edges[eid];
      if (!cand) continue;
      const outX = cand.a === node.id ? cand.dx : -cand.dx;
      const outZ = cand.a === node.id ? cand.dz : -cand.dz;
      // Most negative dot with the direction of the threat wins.
      const score = -(outX * toThreatX + outZ * toThreatZ) / l;
      if (score > bestScore) {
        bestScore = score;
        best = eid;
      }
    }
    return best;
  }

  /* ---- crossings ---- */

  private beginCross(i: number, e: RoadEdge, nodeId: number, now: number): void {
    const s = this.dir[i] === 1 ? this.travel[i] : e.length - this.travel[i];
    const from = sidewalkPoint(e, clamp(s, 0, e.length), this.side[i] as 1 | -1);
    this.crossFromX[i] = from.x;
    this.crossFromZ[i] = from.z;
    const to = sidewalkPoint(e, clamp(s, 0, e.length), (-this.side[i]) as 1 | -1);
    this.crossToX[i] = to.x;
    this.crossToZ[i] = to.z;
    this.crossT[i] = 0;
    this.state[i] = S_WAIT;
    this.timer[i] = 0;
    this.speed[i] = 0;
    this.clip[i] = ANIM_IDLE;
  }

  private stepWait(i: number, dt: number, now: number): void {
    this.speed[i] += (0 - this.speed[i]) * Math.min(1, dt * 8);
    this.timer[i] += dt;
    const e = roadNetwork.edges[this.edge[i]];
    if (!e) {
      this.state[i] = S_WALK;
      return;
    }
    // Face the crossing while waiting — a queue of people all staring down the
    // street is what a real kerb looks like.
    const dx = this.crossToX[i] - this.x[i];
    const dz = this.crossToZ[i] - this.z[i];
    this.yaw[i] = approach(this.yaw[i], Math.atan2(dz, dx), dt * 3);

    if (this.canCross(i, e, now) || this.timer[i] > 26) {
      this.state[i] = S_CROSS;
      this.clip[i] = ANIM_WALK;
      this.crossT[i] = 0;
    }
  }

  /**
   * May this pedestrian step off the kerb? Signals first — the same state the
   * traffic reads, so the two systems can never disagree about whose turn it
   * is. Unsignalised, it is a gap-acceptance test against real vehicles.
   */
  private canCross(i: number, e: RoadEdge, now: number): boolean {
    const exitNodeId = this.dir[i] === 1 ? e.b : e.a;
    const node = roadNetwork.nodes[exitNodeId];
    if (node && node.control === "signal") {
      const st = signalState(node, now);
      const vehiclePhase = approachPhase(node, e.id);
      // Cross this street while the traffic *on* it is stopped.
      if (st.green === vehiclePhase && !st.allRed) return false;
      return true;
    }
    // No signal: accept a gap. Anything within 3 s of arriving is not a gap.
    let clear = true;
    const cx = (this.crossFromX[i] + this.crossToX[i]) * 0.5;
    const cz = (this.crossFromZ[i] + this.crossToZ[i]) * 0.5;
    trafficSim.forEachNear(cx, cz, 34, (v, d) => {
      if (!clear) return;
      const toX = cx - v.x;
      const toZ = cz - v.z;
      const fwd = Math.cos(v.yaw) * toX + Math.sin(v.yaw) * toZ;
      if (fwd < 0) return; // behind the car; irrelevant
      if (d < 6 || d / Math.max(1, v.speed) < 3) clear = false;
    });
    return clear;
  }

  private stepCross(i: number, dt: number, now: number): void {
    const dx = this.crossToX[i] - this.crossFromX[i];
    const dz = this.crossToZ[i] - this.crossFromZ[i];
    const len = Math.hypot(dx, dz) || 1;
    const speed = this.state[i] === S_FLEE ? RUN_SPEED : CROSS_SPEED * (0.9 + this.seed[i] * 0.35);
    this.crossT[i] += (speed * dt) / len;
    this.speed[i] = speed;
    const t = Math.min(1, this.crossT[i]);
    this.x[i] = this.crossFromX[i] + dx * t;
    this.z[i] = this.crossFromZ[i] + dz * t;
    this.y[i] = groundHeight(this.x[i], this.z[i], this.y[i] + 2.5, 6);
    this.yaw[i] = approach(this.yaw[i], Math.atan2(dz, dx), dt * 6);
    this.vx[i] = (dx / len) * speed;
    this.vz[i] = (dz / len) * speed;
    this.clip[i] = ANIM_WALK;
    if (t >= 1) {
      this.side[i] = (-this.side[i]) as 1 | -1;
      this.state[i] = S_WALK;
      const e = roadNetwork.edges[this.edge[i]];
      if (e) this.travel[i] = clamp(this.travel[i] - 2, 0, e.length - 2);
    }
  }

  private stepCower(i: number, dt: number, now: number): void {
    this.speed[i] = 0;
    this.vx[i] = 0;
    this.vz[i] = 0;
    this.blend[i] = Math.min(1, this.blend[i] + dt * 4);
    this.timer[i] -= dt;
    this.clip[i] = ANIM_COWER;
    if (this.timer[i] <= 0) {
      const t = strongestThreatNear(this.x[i], this.z[i], now - 3);
      if (t && t.threat > 0.5) {
        this.timer[i] = 3;
        return;
      }
      this.state[i] = S_FLEE;
      this.clip[i] = ANIM_RUN;
      this.timer[i] = 4 + this.rng.next() * 4;
      this.blend[i] = 0;
    }
  }

  private stepIdle(i: number, dt: number, now: number): void {
    this.speed[i] += (0 - this.speed[i]) * Math.min(1, dt * 5);
    this.vx[i] = 0;
    this.vz[i] = 0;
    this.timer[i] -= dt;
    if (this.timer[i] <= 0) {
      this.state[i] = S_WALK;
      this.clip[i] = ANIM_WALK;
    }
  }

  /** Snap a pedestrian who lost their edge (streamed out) back onto the graph. */
  private rejoinGraph(i: number): void {
    const hit = roadNetwork.nearestEdge(this.x[i], this.z[i], 90);
    if (!hit) {
      this.removeAt(i);
      return;
    }
    this.edge[i] = hit.edge.id;
    this.dir[i] = 1;
    this.travel[i] = hit.s;
    this.side[i] = sideOfEdge(hit.edge, this.x[i], this.z[i]);
    this.state[i] = S_WALK;
  }

  /* ---------------- damage ---------------- */

  /** Index of the pedestrian with this entity id, or −1. */
  indexOf(entityId: number): number {
    for (let i = 0; i < this.count; i++) if (this.id[i] === entityId) return i;
    return -1;
  }

  /** Apply damage. Returns true if this killed them. */
  applyDamage(entityId: number, amount: number, now: number): boolean {
    const i = this.indexOf(entityId);
    if (i < 0 || this.state[i] === S_DEAD) return false;
    this.health[i] -= amount;
    this.soak[i] = Math.min(1, this.soak[i] + amount / 60);
    if (this.health[i] <= 0) {
      this.state[i] = S_DEAD;
      this.clip[i] = ANIM_DEAD;
      this.blend[i] = 0;
      this.timer[i] = 24; // body persists, then fades from the crowd budget
      this.speed[i] = 0;
      emitNoise("scream", this.x[i], this.y[i] + 1.4, this.z[i], "civilian", this.id[i]);
      this.onKilled?.(this.x[i], this.y[i], this.z[i]);
      return true;
    }
    // Wounded civilians run.
    if (this.state[i] !== S_FLEE) {
      this.state[i] = S_FLEE;
      this.clip[i] = ANIM_RUN;
      this.timer[i] = 9;
      this.blend[i] = 0;
    }
    return false;
  }

  /**
   * Append hitbox capsules for everyone near a segment. Written straight into
   * the weapon stack's own record type by the caller, which owns the array.
   */
  forEachHitbox(
    ax: number,
    az: number,
    radius: number,
    cb: (entityId: number, x: number, y: number, z: number, height: number, alive: boolean) => void,
  ): void {
    const r2 = radius * radius;
    for (let i = 0; i < this.count; i++) {
      const dx = this.x[i] - ax;
      const dz = this.z[i] - az;
      if (dx * dx + dz * dz > r2) continue;
      cb(this.id[i], this.x[i], this.y[i], this.z[i], 1.8 * this.heightScale[i], this.state[i] !== S_DEAD);
    }
  }

  /* ---------------- rendering ---------------- */

  render(batch: CharacterBatch, cx: number, cy: number, cz: number): void {
    for (let i = 0; i < this.count; i++) {
      const dx = this.x[i] - cx;
      const dy = this.y[i] - cy;
      const dz = this.z[i] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const clip = this.clip[i];
      // Locomotion clips are the base pose, so their blend is irrelevant; the
      // special clips need theirs, and it is what the batch expects.
      const blend = clip === ANIM_WALK || clip === ANIM_RUN || clip === ANIM_IDLE ? 0 : this.blend[i];
      batch.push(
        this.x[i],
        this.y[i],
        this.z[i],
        this.yaw[i],
        this.phase[i],
        this.speed[i],
        clip === ANIM_WALK || clip === ANIM_RUN || clip === ANIM_IDLE ? 0 : clip,
        blend,
        this.heightScale[i],
        this.girth[i],
        this.mask[i],
        this.seed[i],
        this.soak[i],
        this.palette,
        i * PALETTE_FLOATS,
        d2,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const _steer = new Float32Array(2);

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function approach(a: number, b: number, step: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d <= -Math.PI) d += Math.PI * 2;
  if (d > step) return a + step;
  if (d < -step) return a - step;
  return b;
}

export const pedestrians = new Pedestrians();
export { Pedestrians };
