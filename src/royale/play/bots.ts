/**
 * DROP ZERO — the rivals.
 *
 * Ninety-nine other people dropped onto this island. This module is all of
 * them, and it is what turns a very pretty walking simulator into a battle
 * royale: the thing you hear shooting two ridges over, the thing that lands on
 * your roof, the thing that throws a wall up in your face when you catch it in
 * the open.
 *
 * ## The population is split in two, on purpose
 *
 * **Simulated rivals** (~40 at `high`) are real: a capsule that walks the
 * terrain, an inventory-ish weapon, line of sight, a state machine, a skeleton,
 * and the ability to shoot you or each other. They are the ones you will
 * actually meet.
 *
 * **Phantom rivals** (the remaining ~59) are a name and a clock. They die on a
 * schedule shaped like a real match's death curve — a spike in the first ninety
 * seconds while everyone lands on top of each other, a long quiet middle, and a
 * second spike as each circle closes — and all they cost is one timer tick.
 * A battle royale lives or dies on the alive-counter falling at the right rate;
 * simulating a hundred agents to produce a number is not a good trade.
 *
 * The player cannot tell which is which, because a phantom is only ever
 * observed through the elimination feed, and the simulated forty are spread
 * across the map so the ones near you are always real.
 *
 * ## Why the character is a SkinnedMesh and the player's is not
 *
 * `player.ts` builds its humanoid as a hierarchy of rigid joint meshes, which
 * is exactly right for ONE character you see up close: no skinning cost, no
 * bind-pose bookkeeping, and every seam can be a real ball joint. Forty of them
 * would be forty times ten draw calls before shadows.
 *
 * So the rivals are authored the same way — bevelled boxes, faceted balls,
 * real chamfers, vertex-baked AO and edge wear — and then *baked into one
 * geometry* with skin indices, so a whole rival is four draw calls (cloth,
 * gear, skin, metal) instead of forty. The four are separate materials rather
 * than one atlas because four materials is four draw calls and an atlas is a
 * lifetime of `fract()` seam bugs; at ten visible rigs that is forty calls,
 * which is nothing against the 900 budget.
 *
 * ## LOD, which is not optional
 *
 *  - **L0** — the full rig, shadow-casting. The nearest few, inside ~70 m.
 *  - **L1** — the same skeleton and the same materials, a coarser geometry with
 *    the pouches/straps/laces dropped. Out to ~210 m. Swapping `mesh.geometry`
 *    on a bound `SkinnedMesh` is legal and free, so L0↔L1 is a pointer write.
 *  - **L2** — one `InstancedMesh` of a chunky low-poly figure with per-instance
 *    colour, for everything beyond that. One draw call for the other eighty.
 *
 * ## Per-rival colour
 *
 * Each surface material carries three tint uniforms and every vertex carries an
 * `azone` weight telling the shader which of the three it belongs to (jacket /
 * trousers / accent; on skin: complexion / hair / lip). The baked vertex colour
 * still carries all the AO, the edge wear and the panel shading — the tint only
 * multiplies it. That way one geometry serves every rival and no two of them
 * are the same colour, at the cost of a per-slot material clone.
 *
 * Publishes `ctx.services.bots` (see the contract note at the bottom of this
 * file — `WorldServices` has no `bots` field, so the publish is through a
 * locally-widened view of `ctx.services`).
 */
import * as THREE from "three";
import { GRID } from "../types";
import type {
  AudioService,
  CollisionService,
  CombatService,
  DamageSource,
  DamageTarget,
  LootService,
  MaterialsService,
  MatchService,
  PlayerService,
  Poi,
  RayHit,
  StormService,
  System,
  SystemFactory,
  TerrainService,
  VfxService,
  WorldCtx,
  WorldServices,
} from "../types";

/* ------------------------------------------------------------------------ *
 * Service surface + the local view of ctx.services
 * ------------------------------------------------------------------------ */

/** One rival, as anything outside this module needs to see it. */
export interface BotInfo {
  id: string;
  name: string;
  position: THREE.Vector3;
  hp: number;
  shield: number;
  alive: boolean;
  /** Current behaviour, for the debug overlay and the spectate camera. */
  state: string;
}

export interface BotsService {
  /** Every simulated rival, alive or not. Do not mutate. */
  readonly bots: readonly BotInfo[];
  /** Simulated rivals still standing. */
  readonly aliveCount: number;
  /** Simulated + phantom rivals still standing. */
  readonly totalAlive: number;
  /** Nearest living rival to a point, or null. */
  nearest(point: THREE.Vector3, maxDist: number): BotInfo | null;
  /** Kill one outright — used by the match system to force a victory. */
  eliminate(id: string, source?: DamageSource): void;
  /** Start the drop. Idempotent; the match system calls it when the bus flies. */
  begin(): void;
}

/**
 * Everything we may reach for. All optional, all read late: boot order is a
 * promise about sequence, not about anything actually having worked.
 */
interface BotServices extends WorldServices {
  materials?: MaterialsService;
  terrain?: TerrainService;
  collision?: CollisionService;
  combat?: CombatService;
  vfx?: VfxService;
  audio?: AudioService;
  player?: PlayerService;
  storm?: StormService;
  match?: MatchService;
  loot?: LootService;
  pois?: Poi[];
  bots?: BotsService;
}

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

/** Rivals in the match, not counting the local player. 99 + you = 100. */
const RIVAL_COUNT = 99;

interface Tier {
  /** How many rivals get a body, a brain and a gun. */
  simulated: number;
  /** Full-detail skeletal rigs alive at once. */
  rigSlots: number;
  /** Distance at which a rig drops from L0 to L1. */
  l0Distance: number;
  /** Distance at which a rig gives up and becomes an instanced proxy. */
  l1Distance: number;
  /** Baked surface texture edge, px. */
  texSize: number;
  /** Faceted-ball segments/rings for the L0 rig. */
  ballSeg: number;
  ballRing: number;
  /** Whether L0 rigs cast shadows. */
  shadows: boolean;
  /** Simultaneous bot-built walls before the oldest is recycled. */
  wallBudget: number;
  /** Nameplates drawn at once. */
  plates: number;
}

const TIERS: Record<string, Tier> = {
  low: {
    simulated: 16, rigSlots: 4, l0Distance: 42, l1Distance: 120,
    texSize: 128, ballSeg: 6, ballRing: 4, shadows: false, wallBudget: 16, plates: 5,
  },
  medium: {
    simulated: 26, rigSlots: 7, l0Distance: 55, l1Distance: 170,
    texSize: 256, ballSeg: 8, ballRing: 5, shadows: true, wallBudget: 28, plates: 7,
  },
  high: {
    simulated: 40, rigSlots: 10, l0Distance: 70, l1Distance: 210,
    texSize: 256, ballSeg: 10, ballRing: 6, shadows: true, wallBudget: 40, plates: 9,
  },
  ultra: {
    simulated: 44, rigSlots: 14, l0Distance: 92, l1Distance: 280,
    texSize: 512, ballSeg: 12, ballRing: 7, shadows: true, wallBudget: 56, plates: 12,
  },
};

// ---- body ---------------------------------------------------------------

/** Capsule radius. Matches the player's, so cover works symmetrically. */
const BOT_RADIUS = 0.4;
const BOT_HEIGHT = 1.85;
const BOT_CROUCH_HEIGHT = 1.25;
/** Eye height — where LOS rays start and where a headshot registers. */
const BOT_EYE = 1.62;
const BOT_CROUCH_EYE = 1.02;
/** Chest height — what other actors aim at. Centre of mass, not the head. */
const BOT_CHEST = 1.22;

const BOT_HP = 100;
const BOT_SHIELD_MAX = 100;

// ---- movement -----------------------------------------------------------

const BOT_WALK = 5.2;
const BOT_RUN = 9.0;
const BOT_CROUCH_SPEED = 2.9;
/** Acceleration. Lower than the player's 92 — bots should not out-juke you. */
const BOT_ACCEL = 34;
const BOT_FRICTION = 11;
const BOT_GRAVITY = -30;
const BOT_JUMP = 7.0;
/**
 * How far the rig root drops in a crouch. A bone hierarchy has no IK, so this
 * has to agree with `poseCrouch`'s hip/knee angles or the feet either sink into
 * the ground or hover above it. 0.26 m is exactly how far that pose lifts the
 * ankle above its bind height — change one and you must change the other.
 */
const CROUCH_RIG_DROP = 0.26;
/** Steeper than this and a bot refuses to climb — it steers around instead. */
const BOT_MAX_SLOPE_COS = Math.cos(THREE.MathUtils.degToRad(46));

/** How fast a bot turns to face where it is going, rad/s. */
const BOT_TURN_RATE = 7.0;
/** How fast the aim tracks a target. Skill scales this — see `botAimRate`. */
const AIM_RATE_MIN = 2.6;
const AIM_RATE_MAX = 8.5;

/**
 * Whisker probe distance for obstacle avoidance. 3.2 m is a little over half a
 * second at a run, which is the shortest lookahead that still lets the steering
 * turn a bot around a building corner instead of into it.
 */
const WHISKER_LENGTH = 3.2;
/** Half-angle of the two side whiskers. */
const WHISKER_SPREAD = 0.62;
/**
 * How hard a blocked whisker pushes the steering sideways. High enough to
 * dominate the goal direction at contact range — a bot that politely blends
 * "go to the chest" with "there is a wall" walks into the wall forever.
 */
const AVOID_GAIN = 2.4;
/**
 * Metres of progress a bot must make in `STUCK_WINDOW` seconds or it declares
 * itself stuck and picks a random sidestep. Jitter and stuck bots are the two
 * ways bot movement reads as broken, and this is the fix for the second.
 */
const STUCK_DISTANCE = 1.1;
const STUCK_WINDOW = 1.4;
/** Seconds a stuck bot commits to its sidestep before re-evaluating. */
const UNSTICK_TIME = 1.05;

// ---- drop ---------------------------------------------------------------

/** Bus altitude. Rivals leave it between these two fractions of the route. */
const BUS_ALTITUDE = 620;
const BUS_JUMP_MIN = 0.06;
const BUS_JUMP_MAX = 0.86;
/** Dive speed, and the speed once the glider is out. */
const DIVE_SPEED = 68;
const GLIDE_SPEED = 24;
const GLIDE_SINK = 11.5;
/** Altitude above the ground where the glider snaps open. */
const DEPLOY_ALTITUDE = 105;

// ---- combat -------------------------------------------------------------

/**
 * Reaction lag before a bot that has just acquired you may fire. This single
 * number is most of "beatable but not blind": at 0.22 s a good player who
 * peeks first wins the trade, and at 0.05 s nobody ever wins one.
 */
const REACTION_MIN = 0.16;
const REACTION_MAX = 0.52;
/** How long a bot keeps shooting at a target it can no longer see. */
const LOST_TARGET_TIME = 2.4;
/** How long the memory of being shot at steers behaviour (build, retreat). */
const THREAT_MEMORY = 4.0;
/** Under this fraction of effective health, a bot disengages and heals. */
const RETREAT_HEALTH = 0.32;
/** Seconds a heal takes; shield gained per heal. */
const HEAL_TIME = 3.4;
const HEAL_AMOUNT = 50;

/** Storm damage is applied in whole seconds so the numbers read cleanly. */
const STORM_TICK = 1.0;

/** How often the (expensive) decision pass runs per bot, seconds. */
const THINK_INTERVAL = 0.22;
/** LOS raycasts per frame across the whole population. Hard budget. */
const LOS_BUDGET = 6;

// ---- build --------------------------------------------------------------

/** Wall HP for a bot-placed panel. Wood-tier: two AR bursts. */
const BOT_WALL_HP = 150;
/** Seconds a bot-built wall stands before it dissolves. */
const BOT_WALL_LIFE = 22;
/** Cooldown between a bot's walls. */
const BOT_WALL_COOLDOWN = 2.6;
/** How far in front of itself a bot plants the wall. */
const BOT_WALL_DISTANCE = 2.3;

// ---- misc ---------------------------------------------------------------

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/* ------------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------------ */

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
/** Frame-rate independent exponential approach. `rate` is roughly 1/seconds. */
const approach = (cur: number, target: number, rate: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));

/** Shortest signed angular distance from `from` to `to`. */
function angleDelta(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Rotate `cur` toward `target` by at most `maxStep`. */
function turnToward(cur: number, target: number, maxStep: number): number {
  const d = angleDelta(cur, target);
  if (Math.abs(d) <= maxStep) return target;
  return cur + Math.sign(d) * maxStep;
}

/** Hash-based value noise, deterministic and allocation-free. */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable value noise over a `period`-cell lattice. */
function tileNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const wrap = (v: number) => ((v % period) + period) % period;
  const x0 = wrap(xi), x1 = wrap(xi + 1);
  const y0 = wrap(yi), y1 = wrap(yi + 1);
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** Tileable fBm. Octaves double the lattice, so every octave still tiles. */
function tileFbm(x: number, y: number, period: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let p = period;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += tileNoise(x * f, y * f, p, seed + o * 977) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
    p *= 2;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------------ *
 * Geometry accumulator
 * ------------------------------------------------------------------------ *
 *
 * Same idea as the one in world/props.ts, plus two extra streams the rivals
 * need: `zone` (which of the three tint slots a vertex answers to) and `skin`
 * (which bone drives it). Binding is rigid — one bone per vertex, weight 1 —
 * because the seams are real ball joints, exactly like the player's rig. A
 * skinned shoulder that stretches is a *worse* look than a chunky ball joint
 * at this art direction, and rigid binding costs nothing to author.
 */

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Color();

/** Which of the three per-material tint slots a run of geometry belongs to. */
type Zone = 0 | 1 | 2 | 3;
/** 3 = untinted: the vertex colour is used raw. Trim, soles, gun metal. */
const ZONE_NONE: Zone = 3;

class Geo {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  zone: number[] = [];
  bone: number[] = [];
  idx: number[] = [];

  vert(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    u: number, vv: number,
    r: number, g: number, b: number,
  ): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, vv);
    this.col.push(r, g, b);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /**
   * Append another Geo through a rigid matrix, stamping the whole run with one
   * bone and one tint zone. `transformDirection` is correct for the normals
   * because every matrix authored in this file is rotation + translation.
   */
  append(src: Geo, m: THREE.Matrix4 | null, bone: number, zone: Zone): void {
    const base = this.pos.length / 3;
    for (let i = 0; i < src.pos.length; i += 3) {
      _v.set(src.pos[i], src.pos[i + 1], src.pos[i + 2]);
      _n.set(src.nor[i], src.nor[i + 1], src.nor[i + 2]);
      if (m) {
        _v.applyMatrix4(m);
        _n.transformDirection(m);
      }
      this.pos.push(_v.x, _v.y, _v.z);
      this.nor.push(_n.x, _n.y, _n.z);
      this.bone.push(bone);
      this.zone.push(zone === 0 ? 1 : 0, zone === 1 ? 1 : 0, zone === 2 ? 1 : 0);
    }
    for (let i = 0; i < src.uv.length; i++) this.uv.push(src.uv[i]);
    for (let i = 0; i < src.col.length; i++) this.col.push(src.col[i]);
    for (let i = 0; i < src.idx.length; i++) this.idx.push(src.idx[i] + base);
  }
}

/** Per-part surface description: tint, plus the AO/wear knobs. */
interface Paint {
  /** Base albedo, multiplied by the material's zone tint at render time. */
  color: number;
  /** How much brighter the chamfers get — edge wear, rub marks on corners. */
  wear?: number;
  /** Occlusion applied to the underside, fading out toward the top. */
  ao?: number;
  /** Flat multiplier, for parts that live in permanent shadow. */
  shade?: number;
}

/** Resolve a Paint to linear RGB — vertex colours are linear-space. */
function paintRgb(p: Paint): [number, number, number] {
  _c.setHex(p.color, THREE.SRGBColorSpace);
  const k = p.shade ?? 1;
  return [_c.r * k, _c.g * k, _c.b * k];
}

/**
 * A chamfered box centred on the origin.
 *
 * Hard 90° edges are one of the loudest "this is a Three.js demo" tells: real
 * objects have a radius, and a chamfer wide enough to catch a single pixel of
 * the key light is enough to read as one. Every panel on every rival goes
 * through here, and the chamfer quads are also where the edge wear lives — a
 * lighter rim along every edge is what a jacket elbow, a boot toe and the top
 * of a backpack actually look like after a week of being worn.
 */
function bevelBox(hx: number, hy: number, hz: number, bevel: number, paint: Paint): Geo {
  const g = new Geo();
  const h = [hx, hy, hz];
  let b = Math.max(0, Math.min(bevel, hx * 0.45, hy * 0.45, hz * 0.45));
  // Under a centimetre the chamfer is sub-pixel at any range a rival is ever
  // seen from, and it costs four times the vertices. Drop it.
  if (b < 0.008) b = 0;

  const wear = paint.wear ?? 0.16;
  const ao = paint.ao ?? 0.24;
  const [br, bg, bb] = paintRgb(paint);
  const shadeAt = (y: number) => {
    const t = hy > 1e-5 ? clamp01((y + hy) / (2 * hy)) : 1;
    return 1 - ao * (1 - smoothstep(t));
  };

  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, edge: number) => {
    const k = shadeAt(y) * (1 + wear * edge);
    return g.vert(x, y, z, nx, ny, nz, (x + z) * 2.4, y * 2.4, br * k, bg * k, bb * k);
  };

  /**
   * Emit a quad with whichever winding agrees with the supplied normal. The
   * six faces, twelve chamfers and eight corners below are generated by axis
   * permutation and half of those permutations come out mirrored; deriving the
   * winding is how you avoid a character that is solid from the inside.
   */
  const quad = (
    p0: number[], p1: number[], p2: number[], p3: number[],
    nx: number, ny: number, nz: number, edge: number,
  ) => {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    const flip = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz < 0;
    const i0 = push(p0[0], p0[1], p0[2], nx, ny, nz, edge);
    const i1 = push(p1[0], p1[1], p1[2], nx, ny, nz, edge);
    const i2 = push(p2[0], p2[1], p2[2], nx, ny, nz, edge);
    const i3 = push(p3[0], p3[1], p3[2], nx, ny, nz, edge);
    if (flip) {
      g.tri(i0, i2, i1);
      g.tri(i0, i3, i2);
    } else {
      g.tri(i0, i1, i2);
      g.tri(i0, i2, i3);
    }
  };

  // six inset faces
  for (let a = 0; a < 3; a++) {
    for (let si = 0; si < 2; si++) {
      const sgn = si === 0 ? 1 : -1;
      const u = (a + 1) % 3;
      const v = (a + 2) % 3;
      const corners: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      const pts = corners.map(([cu, cv]) => {
        const out = [0, 0, 0];
        out[a] = sgn * h[a];
        out[u] = cu * (h[u] - b);
        out[v] = cv * (h[v] - b);
        return out;
      });
      const nrm = [0, 0, 0];
      nrm[a] = sgn;
      quad(pts[0], pts[1], pts[2], pts[3], nrm[0], nrm[1], nrm[2], 0);
    }
  }
  if (b <= 1e-5) return g;

  // twelve edge chamfers
  const p = [0, 0, 0], q = [0, 0, 0], r = [0, 0, 0], s = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    for (let a2 = a + 1; a2 < 3; a2++) {
      const c = 3 - a - a2;
      for (let sa = -1; sa <= 1; sa += 2) {
        for (let sb = -1; sb <= 1; sb += 2) {
          for (let k = 0; k < 3; k++) { p[k] = 0; q[k] = 0; r[k] = 0; s[k] = 0; }
          p[a] = sa * h[a]; p[a2] = sb * (h[a2] - b); p[c] = -(h[c] - b);
          q[a] = sa * h[a]; q[a2] = sb * (h[a2] - b); q[c] = h[c] - b;
          r[a] = sa * (h[a] - b); r[a2] = sb * h[a2]; r[c] = h[c] - b;
          s[a] = sa * (h[a] - b); s[a2] = sb * h[a2]; s[c] = -(h[c] - b);
          const nrm = [0, 0, 0];
          nrm[a] = sa * Math.SQRT1_2;
          nrm[a2] = sb * Math.SQRT1_2;
          quad(p.slice(), q.slice(), r.slice(), s.slice(), nrm[0], nrm[1], nrm[2], 1);
        }
      }
    }
  }

  // eight corner triangles
  const kk = 1 / Math.sqrt(3);
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        const i0 = push(sx * hx, sy * (hy - b), sz * (hz - b), sx * kk, sy * kk, sz * kk, 1);
        const i1 = push(sx * (hx - b), sy * hy, sz * (hz - b), sx * kk, sy * kk, sz * kk, 1);
        const i2 = push(sx * (hx - b), sy * (hy - b), sz * hz, sx * kk, sy * kk, sz * kk, 1);
        // Four of the eight octants are mirrored; sx·sy·sz is exactly that
        // parity, so it decides the winding.
        if (sx * sy * sz > 0) g.tri(i0, i1, i2);
        else g.tri(i0, i2, i1);
      }
    }
  }
  return g;
}

/**
 * A faceted sphere, used for every ball joint. Flat-shaded per quad on purpose:
 * a smooth sphere on a chunky character reads as bubblegum, and the facets give
 * the key light something to break on as the limb rotates.
 */
function ball(radius: number, seg: number, rings: number, paint: Paint): Geo {
  const g = new Geo();
  const [br, bg, bb] = paintRgb(paint);
  const ao = paint.ao ?? 0.28;
  for (let ri = 0; ri < rings; ri++) {
    const t0 = (ri / rings) * Math.PI;
    const t1 = ((ri + 1) / rings) * Math.PI;
    for (let si = 0; si < seg; si++) {
      const a0 = (si / seg) * TAU;
      const a1 = ((si + 1) / seg) * TAU;
      const pt = (t: number, a: number) => [
        Math.sin(t) * Math.cos(a) * radius,
        Math.cos(t) * radius,
        Math.sin(t) * Math.sin(a) * radius,
      ];
      const p0 = pt(t0, a0), p1 = pt(t0, a1), p2 = pt(t1, a1), p3 = pt(t1, a0);
      _n.set(
        (p0[0] + p1[0] + p2[0] + p3[0]) / 4,
        (p0[1] + p1[1] + p2[1] + p3[1]) / 4,
        (p0[2] + p1[2] + p2[2] + p3[2]) / 4,
      ).normalize();
      const ids: number[] = [];
      for (const pp of [p0, p1, p2, p3]) {
        const k = 1 - ao * (1 - clamp01((pp[1] / radius + 1) * 0.5));
        ids.push(g.vert(pp[0], pp[1], pp[2], _n.x, _n.y, _n.z, pp[0] * 2.4, pp[1] * 2.4, br * k, bg * k, bb * k));
      }
      g.tri(ids[0], ids[1], ids[2]);
      g.tri(ids[0], ids[2], ids[3]);
    }
  }
  return g;
}

/** A faceted cylinder about +Y. Scarf rolls, bedrolls, barrels, ear cups. */
function tube(rBottom: number, rTop: number, height: number, seg: number, paint: Paint, caps = true): Geo {
  const g = new Geo();
  const [br, bg, bb] = paintRgb(paint);
  const ao = paint.ao ?? 0.2;
  const y0 = -height * 0.5;
  const y1 = height * 0.5;
  const slope = (rBottom - rTop) / Math.max(height, 1e-4);
  const ns = 1 / Math.hypot(1, slope);
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * TAU;
    const a1 = ((i + 1) / seg) * TAU;
    const am = (a0 + a1) * 0.5;
    const nx = Math.cos(am) * ns, ny = slope * ns, nz = Math.sin(am) * ns;
    const kb = 1 - ao;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const i0 = g.vert(c0 * rBottom, y0, s0 * rBottom, nx, ny, nz, a0 * 1.6, y0 * 2.4, br * kb, bg * kb, bb * kb);
    const i1 = g.vert(c1 * rBottom, y0, s1 * rBottom, nx, ny, nz, a1 * 1.6, y0 * 2.4, br * kb, bg * kb, bb * kb);
    const i2 = g.vert(c1 * rTop, y1, s1 * rTop, nx, ny, nz, a1 * 1.6, y1 * 2.4, br, bg, bb);
    const i3 = g.vert(c0 * rTop, y1, s0 * rTop, nx, ny, nz, a0 * 1.6, y1 * 2.4, br, bg, bb);
    // Walking the ring in +angle and then up gives a left-handed triangle
    // against the outward normal, so the middle two indices swap.
    g.tri(i0, i2, i1);
    g.tri(i0, i3, i2);
    if (!caps) continue;
    if (rTop > 1e-4) {
      const ct = g.vert(0, y1, 0, 0, 1, 0, 0, 0, br, bg, bb);
      const q0 = g.vert(c0 * rTop, y1, s0 * rTop, 0, 1, 0, c0 * 2, s0 * 2, br, bg, bb);
      const q1 = g.vert(c1 * rTop, y1, s1 * rTop, 0, 1, 0, c1 * 2, s1 * 2, br, bg, bb);
      g.tri(ct, q1, q0);
    }
    if (rBottom > 1e-4) {
      const cb = g.vert(0, y0, 0, 0, -1, 0, 0, 0, br * kb, bg * kb, bb * kb);
      const q0 = g.vert(c0 * rBottom, y0, s0 * rBottom, 0, -1, 0, c0 * 2, s0 * 2, br * kb, bg * kb, bb * kb);
      const q1 = g.vert(c1 * rBottom, y0, s1 * rBottom, 0, -1, 0, c1 * 2, s1 * 2, br * kb, bg * kb, bb * kb);
      g.tri(cb, q0, q1);
    }
  }
  return g;
}

/** Rotation + translation. Everything authored here is rigid. */
function xf(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, "YXZ")),
    new THREE.Vector3(1, 1, 1),
  );
}

/* ------------------------------------------------------------------------ *
 * Procedural surfaces
 * ------------------------------------------------------------------------ *
 *
 * Four tileable PBR sets baked on a canvas at boot. The albedo is near-white
 * with only micro-variation in it — all the colour comes from the vertex stream
 * and the tint uniforms — so one weave serves every jacket in the match.
 *
 * What the maps carry is what the vertex stream cannot: thread direction,
 * pebbling, seam relief, scratch direction and, above all, ROUGHNESS
 * VARIATION. A character with one roughness value is a plastic action figure no
 * matter how good its albedo is, and forty plastic action figures is how a
 * battle royale ends up looking like a tech demo.
 */

type SurfaceId = "cloth" | "gear" | "skin" | "metal";
const SURFACE_IDS: SurfaceId[] = ["cloth", "gear", "skin", "metal"];

interface SurfaceSpec {
  /** Mean roughness and the ± swing painted into the roughness map. */
  rough: number;
  roughVar: number;
  metalness: number;
  /** Normal map strength. */
  bump: number;
  /** Base greyscale. Vertex colour and tint multiply on top of this. */
  base: number;
}

const SURFACE_SPECS: Record<SurfaceId, SurfaceSpec> = {
  // Cotton drill: tight warp/weft, very rough, a little surface fuzz.
  cloth: { rough: 0.87, roughVar: 0.11, metalness: 0, bump: 0.9, base: 0.84 },
  // Webbing + pebbled hide. Noticeably glossier than the cloth — that contrast
  // is what makes the straps read as a different material at 30 m rather than
  // as a differently-coloured jacket.
  gear: { rough: 0.63, roughVar: 0.17, metalness: 0.02, bump: 1.15, base: 0.8 },
  // Skin: broad mottling, fine pores, and the shallowest roughness swing of
  // the four. Uniform-rough skin looks like a mannequin.
  skin: { rough: 0.52, roughVar: 0.09, metalness: 0, bump: 0.5, base: 0.94 },
  // Brushed metal and hard plastic: directional scratches, a few dents.
  metal: { rough: 0.36, roughVar: 0.26, metalness: 0.72, bump: 0.85, base: 0.78 },
};

interface SurfaceMaps {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

/**
 * Bake one surface. `height` drives the normal map and biases the roughness;
 * `albedo` and `roughBias` add whatever the height field cannot express.
 *
 * All three maps come out of a single pass over the pixel grid so the normal
 * and the roughness agree with the albedo — a normal map that disagrees with
 * its albedo is worse than no normal map, because the eye reads the mismatch
 * as smeared plastic.
 */
function bakeSurface(id: SurfaceId, size: number): SurfaceMaps {
  const spec = SURFACE_SPECS[id];
  const height = new Float32Array(size * size);
  const albedo = new Float32Array(size * size * 3);
  const rough = new Float32Array(size * size);

  const period = 8;
  const at = (x: number, y: number) => ((y % size) + size) % size * size + (((x % size) + size) % size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let h = 0;
      let a = spec.base;
      let r = spec.rough;

      if (id === "cloth") {
        // Warp and weft: two square waves a quarter-phase apart give the
        // over-under of a real weave rather than a checkerboard.
        const threads = 46;
        const warp = Math.sin(u * threads * TAU);
        const weft = Math.sin(v * threads * TAU + Math.PI * 0.5);
        h = (warp * 0.5 + weft * 0.5) * 0.45;
        // Fuzz: high-frequency noise that lifts the roughness without moving
        // the surface. This is the "cotton, not vinyl" term.
        const fuzz = tileFbm(u * 34, v * 34, period * 4, 3, 21);
        h += (fuzz - 0.5) * 0.35;
        a *= 0.94 + fuzz * 0.12;
        r = spec.rough + (fuzz - 0.5) * spec.roughVar * 2;
        // Every eighth thread is a slub — a thicker fibre. Real cloth is not
        // perfectly regular and the irregularity is what sells it.
        const slub = tileNoise(u * 11, v * 11, period, 88);
        if (slub > 0.82) { h += 0.28; a *= 1.05; }
      } else if (id === "gear") {
        // Pebbled hide: broad cells with a rounded profile.
        const cell = tileFbm(u * 13, v * 13, period * 2, 2, 5);
        const fine = tileFbm(u * 41, v * 41, period * 5, 3, 31);
        h = (cell - 0.5) * 1.5 + (fine - 0.5) * 0.4;
        a *= 0.9 + cell * 0.2;
        r = spec.rough + (0.5 - cell) * spec.roughVar * 1.6 + (fine - 0.5) * 0.1;
        // Stitching: two rows of dashes near the tile edges, so a strap cut
        // anywhere across the tile still shows a seam somewhere along it.
        const rows = [0.16, 0.84];
        for (const ry of rows) {
          const d = Math.abs(v - ry);
          if (d < 0.014 && Math.sin(u * 120 * TAU) > 0.15) {
            h -= 0.8;
            a *= 0.7;
            r += 0.12;
          }
        }
      } else if (id === "skin") {
        const pores = tileFbm(u * 62, v * 62, period * 8, 3, 12);
        const mottle = tileFbm(u * 7, v * 7, period, 3, 44);
        h = (pores - 0.5) * 0.5;
        // Mottling is a colour variation, not a height one: blood is under the
        // skin, not on it.
        a *= 0.93 + mottle * 0.14;
        r = spec.rough + (pores - 0.5) * spec.roughVar * 2 - (mottle - 0.5) * 0.08;
      } else {
        // Brushed metal: strongly anisotropic noise, so the scratches run.
        const brush = tileFbm(u * 3, v * 90, period * 8, 3, 7);
        const dents = tileFbm(u * 6, v * 6, period, 2, 61);
        h = (brush - 0.5) * 0.6 + (dents - 0.5) * 0.9;
        a *= 0.88 + brush * 0.2;
        r = spec.rough + (brush - 0.5) * spec.roughVar * 2 + (dents > 0.72 ? 0.22 : 0);
      }

      const i = y * size + x;
      height[i] = h;
      rough[i] = clamp(r, 0.06, 1);
      albedo[i * 3] = a;
      albedo[i * 3 + 1] = a;
      albedo[i * 3 + 2] = a;
    }
  }

  const mapCanvas = document.createElement("canvas");
  mapCanvas.width = mapCanvas.height = size;
  const normCanvas = document.createElement("canvas");
  normCanvas.width = normCanvas.height = size;
  const roughCanvas = document.createElement("canvas");
  roughCanvas.width = roughCanvas.height = size;

  const mapCtx = mapCanvas.getContext("2d");
  const normCtx = normCanvas.getContext("2d");
  const roughCtx = roughCanvas.getContext("2d");
  if (!mapCtx || !normCtx || !roughCtx) throw new Error("bots: 2D canvas unavailable");

  const mapData = mapCtx.createImageData(size, size);
  const normData = normCtx.createImageData(size, size);
  const roughData = roughCtx.createImageData(size, size);

  const strength = spec.bump * size * 0.006;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const o = i * 4;

      mapData.data[o] = clamp(albedo[i * 3], 0, 1) * 255;
      mapData.data[o + 1] = clamp(albedo[i * 3 + 1], 0, 1) * 255;
      mapData.data[o + 2] = clamp(albedo[i * 3 + 2], 0, 1) * 255;
      mapData.data[o + 3] = 255;

      // Sobel on the wrapped height field. Wrapping is what keeps the tile
      // seamless — a clamped edge shows as a hard line at every seam.
      const hl = height[at(x - 1, y)], hr = height[at(x + 1, y)];
      const hd = height[at(x, y - 1)], hu = height[at(x, y + 1)];
      _n.set((hl - hr) * strength, (hd - hu) * strength, 1).normalize();
      normData.data[o] = (_n.x * 0.5 + 0.5) * 255;
      normData.data[o + 1] = (_n.y * 0.5 + 0.5) * 255;
      normData.data[o + 2] = (_n.z * 0.5 + 0.5) * 255;
      normData.data[o + 3] = 255;

      const rr = clamp(rough[i], 0, 1) * 255;
      roughData.data[o] = rr;
      roughData.data[o + 1] = rr;
      roughData.data[o + 2] = rr;
      roughData.data[o + 3] = 255;
    }
  }

  mapCtx.putImageData(mapData, 0, 0);
  normCtx.putImageData(normData, 0, 0);
  roughCtx.putImageData(roughData, 0, 0);

  const finish = (canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };

  return {
    map: finish(mapCanvas, true),
    normalMap: finish(normCanvas, false),
    roughnessMap: finish(roughCanvas, false),
  };
}

/* ------------------------------------------------------------------------ *
 * Tinted surface materials
 * ------------------------------------------------------------------------ */

/**
 * GLSL injected into every rival material. `azone` is a one-hot-ish weight over
 * three tint slots; anything with all three at zero keeps its baked colour, so
 * boot soles, gun metal and belt hardware stay the same on every rival while
 * the jacket, the trousers and the accent all change.
 */
const ZONE_ATTR = /* glsl */ `
attribute vec3 azone;
uniform vec3 uZoneA;
uniform vec3 uZoneB;
uniform vec3 uZoneC;
`;

const ZONE_MIX = /* glsl */ `
{
  float zw = azone.x + azone.y + azone.z;
  vec3 zoneTint = vec3(1.0 - zw) + azone.x * uZoneA + azone.y * uZoneB + azone.z * uZoneC;
  vColor.rgb *= zoneTint;
}
`;

interface TintedMaterial {
  material: THREE.MeshStandardMaterial;
  a: THREE.Color;
  b: THREE.Color;
  c: THREE.Color;
}

/**
 * One material per (rig slot × surface).
 *
 * They all compile to ONE program: the injected source is byte-identical and
 * only the uniform values differ, so `customProgramCacheKey` is a constant and
 * three's program cache hands every clone the same compiled shader. Forty
 * materials is forty uniform uploads, not forty compiles. The textures are the
 * shared per-surface set — a clone per material would be a hundred and twenty
 * Texture objects describing four images.
 */
function makeTintedMaterial(surface: SurfaceId, maps: SurfaceMaps): TintedMaterial {
  const spec = SURFACE_SPECS[surface];
  const a = new THREE.Color(1, 1, 1);
  const b = new THREE.Color(1, 1, 1);
  const c = new THREE.Color(1, 1, 1);

  const material = new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    vertexColors: true,
    roughness: 1,
    metalness: spec.metalness,
    normalScale: new THREE.Vector2(1, 1),
    // Two-sided would double the shadow cost for zero gain: every panel on the
    // rig is a closed solid.
    side: THREE.FrontSide,
    dithering: true,
  });
  material.name = `dz:bot:${surface}`;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uZoneA = { value: a };
    shader.uniforms.uZoneB = { value: b };
    shader.uniforms.uZoneC = { value: c };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${ZONE_ATTR}`)
      .replace("#include <color_vertex>", `#include <color_vertex>\n${ZONE_MIX}`);
  };
  // Constant cache key: every clone shares one compiled program.
  material.customProgramCacheKey = () => "dz-bot-zone";

  return { material, a, b, c };
}

/* ------------------------------------------------------------------------ *
 * Skeleton
 * ------------------------------------------------------------------------ */

const J_HIPS = 0;
const J_SPINE = 1;
const J_CHEST = 2;
const J_NECK = 3;
const J_HEAD = 4;
const J_SHOULDER_R = 5;
const J_ARM_R = 6;
const J_FORE_R = 7;
const J_HAND_R = 8;
const J_SHOULDER_L = 9;
const J_ARM_L = 10;
const J_FORE_L = 11;
const J_HAND_L = 12;
const J_THIGH_R = 13;
const J_SHIN_R = 14;
const J_FOOT_R = 15;
const J_THIGH_L = 16;
const J_SHIN_L = 17;
const J_FOOT_L = 18;
const JOINT_COUNT = 19;

/**
 * Bind pose: parent index and local offset. No rotations anywhere — the bind
 * is a straight A-pose with the arms hanging along -Y, which makes every
 * animation below a simple Euler on a known axis instead of a quaternion
 * puzzle. The character faces -Z (three's forward), so +X is its right.
 */
interface JointDef {
  parent: number;
  x: number;
  y: number;
  z: number;
  name: string;
}

const JOINTS: JointDef[] = [
  { parent: -1, x: 0, y: 1.0, z: 0, name: "hips" },
  { parent: J_HIPS, x: 0, y: 0.14, z: 0, name: "spine" },
  { parent: J_SPINE, x: 0, y: 0.2, z: 0, name: "chest" },
  { parent: J_CHEST, x: 0, y: 0.24, z: 0, name: "neck" },
  { parent: J_NECK, x: 0, y: 0.1, z: 0, name: "head" },

  { parent: J_CHEST, x: 0.155, y: 0.155, z: 0, name: "shoulderR" },
  { parent: J_SHOULDER_R, x: 0.058, y: -0.05, z: 0, name: "armR" },
  { parent: J_ARM_R, x: 0, y: -0.29, z: 0, name: "foreR" },
  { parent: J_FORE_R, x: 0, y: -0.27, z: 0, name: "handR" },

  { parent: J_CHEST, x: -0.155, y: 0.155, z: 0, name: "shoulderL" },
  { parent: J_SHOULDER_L, x: -0.058, y: -0.05, z: 0, name: "armL" },
  { parent: J_ARM_L, x: 0, y: -0.29, z: 0, name: "foreL" },
  { parent: J_FORE_L, x: 0, y: -0.27, z: 0, name: "handL" },

  { parent: J_HIPS, x: 0.105, y: -0.06, z: 0, name: "thighR" },
  { parent: J_THIGH_R, x: 0, y: -0.46, z: 0, name: "shinR" },
  { parent: J_SHIN_R, x: 0, y: -0.44, z: 0, name: "footR" },

  { parent: J_HIPS, x: -0.105, y: -0.06, z: 0, name: "thighL" },
  { parent: J_THIGH_L, x: 0, y: -0.46, z: 0, name: "shinL" },
  { parent: J_SHIN_L, x: 0, y: -0.44, z: 0, name: "footL" },
];

/** Bind-pose world matrices, computed once and shared by every rig slot. */
function computeBindMatrices(): THREE.Matrix4[] {
  const out: THREE.Matrix4[] = [];
  for (let i = 0; i < JOINT_COUNT; i++) {
    const j = JOINTS[i];
    const local = new THREE.Matrix4().makeTranslation(j.x, j.y, j.z);
    out.push(j.parent < 0 ? local : new THREE.Matrix4().multiplyMatrices(out[j.parent], local));
  }
  return out;
}

/** A fresh bone hierarchy in the bind pose. One per rig slot. */
function makeBones(): THREE.Bone[] {
  const bones: THREE.Bone[] = [];
  for (let i = 0; i < JOINT_COUNT; i++) {
    const j = JOINTS[i];
    const bone = new THREE.Bone();
    bone.name = `dz-bot-${j.name}`;
    bone.position.set(j.x, j.y, j.z);
    bone.rotation.order = "YXZ";
    if (j.parent >= 0) bones[j.parent].add(bone);
    bones.push(bone);
  }
  return bones;
}

/* ------------------------------------------------------------------------ *
 * Character authoring
 * ------------------------------------------------------------------------ */

// Neutral bases. Every one of these is multiplied by a per-rival tint at
// render time, so they are chosen for VALUE (how light or dark the panel is)
// rather than for hue — the hue arrives from the outfit palette.
const C_BASE = 0xd8d8d8;
const C_BASE_DARK = 0x9a9a9a;
const C_BASE_LIGHT = 0xf0f0f0;
const C_STRAP = 0x8d8d8d;
const C_SOLE = 0x2e3033;
const C_RUBBER = 0x3a3d42;
const C_METAL = 0x9aa2ad;
const C_METAL_DARK = 0x565c66;
const C_GLASS = 0x1e2a34;
const C_GUN = 0x3c4046;
const C_GUN_LIGHT = 0x656b73;

/** Bins geometry by (surface, bone, zone) so each surface becomes one group. */
class RigBuilder {
  private bins = new Map<SurfaceId, Geo>();

  add(surface: SurfaceId, bone: number, zone: Zone, geo: Geo, m: THREE.Matrix4 | null): void {
    let bin = this.bins.get(surface);
    if (!bin) {
      bin = new Geo();
      this.bins.set(surface, bin);
    }
    bin.append(geo, m, bone, zone);
  }

  get(surface: SurfaceId): Geo | undefined {
    return this.bins.get(surface);
  }
}

interface RigGeometry {
  geometry: THREE.BufferGeometry;
  /** Material index per group, in SURFACE_IDS order. */
  surfaces: SurfaceId[];
  triangles: number;
}

/**
 * Author the rival.
 *
 * Read this as a parts list, not as code. Every entry is one chamfered
 * primitive with a value, an occlusion bias and an edge-wear amount, hung off
 * one bone. The details that are easy to skip — the collar lip, the strap
 * keepers, the sole welt, the knee pad, the pack grommets, the magazine in the
 * rifle — are exactly the ones that stop forty of these reading as forty
 * capsules, so they are all here at `detail: "high"` and stripped at `"low"`.
 *
 * `bindMatrices` transform each part from bone-local space into the bind-pose
 * mesh space the skinning shader expects.
 */
function buildRig(
  detail: "high" | "low",
  bindMatrices: THREE.Matrix4[],
  seg: number,
  rings: number,
): RigGeometry {
  const hi = detail === "high";
  const b = new RigBuilder();
  const bs = hi ? seg : Math.max(5, (seg >> 1) + 1);
  const br = hi ? rings : Math.max(3, (rings >> 1) + 1);

  /** Place a part in bone-local space. */
  const put = (
    surface: SurfaceId, bone: number, zone: Zone, geo: Geo,
    x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0,
  ) => {
    const local = xf(x, y, z, rx, ry, rz);
    b.add(surface, bone, zone, geo, new THREE.Matrix4().multiplyMatrices(bindMatrices[bone], local));
  };

  const box = (
    surface: SurfaceId, bone: number, zone: Zone,
    hx: number, hy: number, hz: number, bev: number, paint: Paint,
    x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0,
  ) => put(surface, bone, zone, bevelBox(hx, hy, hz, bev, paint), x, y, z, rx, ry, rz);

  const sphere = (
    surface: SurfaceId, bone: number, zone: Zone, r: number, paint: Paint,
    x = 0, y = 0, z = 0,
  ) => put(surface, bone, zone, ball(r, bs, br, paint), x, y, z);

  const cyl = (
    surface: SurfaceId, bone: number, zone: Zone,
    rb: number, rt: number, h: number, paint: Paint,
    x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, caps = true,
  ) => put(surface, bone, zone, tube(rb, rt, h, bs, paint, caps), x, y, z, rx, ry, rz);

  // ---- pelvis ------------------------------------------------------------
  box("cloth", J_HIPS, 1, 0.155, 0.095, 0.115, 0.045, { color: C_BASE, ao: 0.34, wear: 0.1 }, 0, -0.035, 0);
  if (hi) {
    // Seat panel — trousers wear across the back, so it is a shade darker.
    box("cloth", J_HIPS, 1, 0.132, 0.06, 0.022, 0.012,
      { color: C_BASE, shade: 0.8, wear: 0.05 }, 0, -0.045, 0.106);
  }

  // ---- lower torso + belt -------------------------------------------------
  box("cloth", J_SPINE, 0, 0.183, 0.115, 0.113, 0.05, { color: C_BASE, ao: 0.3 }, 0, 0.02, 0);
  // Jacket hem, standing proud of the body so it casts a real self-shadow.
  box("cloth", J_SPINE, 0, 0.19, 0.028, 0.12, 0.014, { color: C_BASE_DARK, wear: 0.3 }, 0, -0.085, 0);
  box("gear", J_SPINE, ZONE_NONE, 0.194, 0.042, 0.122, 0.018, { color: C_STRAP, wear: 0.34 }, 0, -0.128, 0);
  box("metal", J_SPINE, ZONE_NONE, 0.05, 0.036, 0.016, 0.008,
    { color: C_METAL, wear: 0.45, ao: 0.1 }, 0, -0.128, -0.126);
  if (hi) {
    // Hip pouch right, magazine loops left. Asymmetry is what makes a
    // silhouette look designed rather than mirrored.
    box("gear", J_SPINE, 2, 0.055, 0.062, 0.045, 0.018, { color: C_BASE, wear: 0.3 }, 0.2, -0.115, 0.03);
    box("gear", J_SPINE, ZONE_NONE, 0.05, 0.012, 0.048, 0.006, { color: C_STRAP, wear: 0.4 }, 0.2, -0.058, 0.03);
    for (let i = 0; i < 3; i++) {
      box("cloth", J_SPINE, 1, 0.016, 0.03, 0.03, 0.008,
        { color: C_BASE_DARK, wear: 0.25 }, -0.2, -0.12, -0.03 + i * 0.035);
    }
  }

  // ---- chest --------------------------------------------------------------
  box("cloth", J_CHEST, 0, 0.213, 0.17, 0.124, 0.05, { color: C_BASE, ao: 0.2 }, 0, 0.06, 0);
  // Yoke across the shoulders, one value lighter, with a visible seam.
  box("cloth", J_CHEST, 0, 0.198, 0.05, 0.127, 0.02,
    { color: C_BASE_LIGHT, shade: 1.05, wear: 0.24 }, 0, 0.17, 0);
  // Collar standing away from the neck, with a darker inner lip.
  box("cloth", J_CHEST, 0, 0.128, 0.045, 0.108, 0.022, { color: C_BASE_DARK, wear: 0.3 }, 0, 0.213, 0);
  box("cloth", J_CHEST, 2, 0.096, 0.03, 0.08, 0.014,
    { color: C_BASE, shade: 0.72, ao: 0.55 }, 0, 0.226, 0);
  if (hi) {
    // Zip ribbon and a pull tab you can actually pick out at 5 m.
    box("metal", J_CHEST, ZONE_NONE, 0.011, 0.152, 0.008, 0.003,
      { color: C_METAL_DARK, wear: 0.5, ao: 0.05 }, 0, 0.06, -0.124);
    box("metal", J_CHEST, ZONE_NONE, 0.012, 0.022, 0.006, 0.003,
      { color: C_METAL, wear: 0.6, ao: 0.05 }, 0, -0.045, -0.128);
    // Chest pockets with flaps and press studs.
    for (const sx of [-1, 1]) {
      box("cloth", J_CHEST, 0, 0.056, 0.05, 0.014, 0.012,
        { color: C_BASE_DARK, wear: 0.28 }, sx * 0.113, 0, -0.126);
      box("gear", J_CHEST, ZONE_NONE, 0.058, 0.016, 0.016, 0.007,
        { color: C_STRAP, wear: 0.4 }, sx * 0.113, 0.048, -0.128);
      box("metal", J_CHEST, ZONE_NONE, 0.008, 0.008, 0.005, 0.002,
        { color: C_METAL, wear: 0.5, ao: 0 }, sx * 0.113, 0.036, -0.134);
    }
    // Chest rig: two mag pouches and the strap that holds them.
    for (const sx of [-1, 1]) {
      box("gear", J_CHEST, 2, 0.05, 0.055, 0.03, 0.014,
        { color: C_BASE, wear: 0.34, ao: 0.3 }, sx * 0.06, 0.02, -0.145);
    }
    box("gear", J_CHEST, ZONE_NONE, 0.135, 0.016, 0.02, 0.007,
      { color: C_STRAP, wear: 0.42 }, 0, 0.082, -0.14);
  }

  // Backpack — the biggest silhouette element after the shoulders, and the
  // main thing that says "rival" at 200 m.
  box("cloth", J_CHEST, 2, 0.152, 0.172, 0.098, 0.05, { color: C_BASE, ao: 0.3, wear: 0.26 }, 0, 0.045, 0.198);
  if (hi) {
    box("cloth", J_CHEST, 2, 0.12, 0.075, 0.05, 0.024,
      { color: C_BASE_LIGHT, shade: 1.06, wear: 0.32 }, 0, -0.03, 0.262);
    box("gear", J_CHEST, ZONE_NONE, 0.128, 0.014, 0.018, 0.006, { color: C_STRAP, wear: 0.44 }, 0, 0.06, 0.276);
    // Shoulder straps, over the top and down the front.
    for (const sx of [-1, 1]) {
      box("gear", J_CHEST, ZONE_NONE, 0.026, 0.11, 0.03, 0.01,
        { color: C_STRAP, wear: 0.38, ao: 0.2 }, sx * 0.1, 0.13, 0.09, -0.5, 0, 0);
      box("gear", J_CHEST, ZONE_NONE, 0.026, 0.13, 0.02, 0.01,
        { color: C_STRAP, wear: 0.38, ao: 0.2 }, sx * 0.11, 0.06, -0.118, 0.13, 0, 0);
      box("metal", J_CHEST, ZONE_NONE, 0.022, 0.014, 0.008, 0.004,
        { color: C_METAL_DARK, wear: 0.55, ao: 0 }, sx * 0.11, -0.03, -0.13);
    }
    // Bedroll lashed across the top: reads as gear even in silhouette.
    cyl("cloth", J_CHEST, 1, 0.045, 0.045, 0.27, { color: C_BASE_DARK, wear: 0.3 },
      0, 0.19, 0.2, 0, 0, Math.PI / 2);
    // Vent grommets — four tiny holes, the sort of detail that only registers
    // subconsciously and whose absence reads as "untextured plastic".
    for (let i = 0; i < 4; i++) {
      cyl("metal", J_CHEST, ZONE_NONE, 0.011, 0.011, 0.012, { color: C_METAL_DARK, wear: 0.5, ao: 0 },
        -0.06 + i * 0.04, -0.09, 0.248, Math.PI / 2, 0, 0);
    }
  }

  // ---- neck + head --------------------------------------------------------
  cyl("skin", J_NECK, 0, 0.062, 0.058, 0.1, { color: C_BASE, ao: 0.5 }, 0, -0.02, 0, 0, 0, 0, false);
  // Skull: a bevelled box, not a sphere. Fortnite heads are boxes with soft
  // corners and that is most of the toy-figure read.
  box("skin", J_HEAD, 0, 0.098, 0.108, 0.098, 0.05, { color: C_BASE, ao: 0.22, wear: 0.06 }, 0, 0.09, 0);
  // Jaw, slightly narrower and set forward.
  box("skin", J_HEAD, 0, 0.082, 0.045, 0.084, 0.032, { color: C_BASE, ao: 0.34, wear: 0.05 }, 0, 0.005, -0.008);
  // Brow ridge: the single most valuable 200 vertices on the character,
  // because it is what puts the eyes in shadow and gives the face a read.
  box("skin", J_HEAD, 0, 0.09, 0.018, 0.02, 0.008, { color: C_BASE, shade: 0.9, ao: 0.1 }, 0, 0.098, -0.093);
  if (hi) {
    // Eyes: dark recesses, not decals. Two tiny boxes set INTO the head.
    for (const sx of [-1, 1]) {
      box("gear", J_HEAD, ZONE_NONE, 0.024, 0.014, 0.01, 0.004,
        { color: 0x1b1f24, shade: 1, ao: 0, wear: 0.1 }, sx * 0.042, 0.072, -0.094);
    }
    // Nose and ears.
    box("skin", J_HEAD, 0, 0.016, 0.028, 0.022, 0.008, { color: C_BASE, shade: 0.98 }, 0, 0.052, -0.1);
    for (const sx of [-1, 1]) {
      box("skin", J_HEAD, 0, 0.012, 0.03, 0.024, 0.01, { color: C_BASE, shade: 0.94, ao: 0.3 }, sx * 0.099, 0.06, 0.005);
    }
  }
  // Hair / cap. Zone B on the skin material carries the hair colour.
  box("skin", J_HEAD, 1, 0.102, 0.052, 0.1, 0.04, { color: C_BASE, ao: 0.15, wear: 0.12 }, 0, 0.165, 0.004);
  if (hi) {
    box("skin", J_HEAD, 1, 0.104, 0.03, 0.05, 0.018, { color: C_BASE, shade: 0.92, ao: 0.2 }, 0, 0.128, 0.06);
    // Cap peak in the accent colour — reads at distance and breaks the
    // head silhouette, which is what stops forty identical eggs.
    box("cloth", J_HEAD, 2, 0.092, 0.012, 0.052, 0.008,
      { color: C_BASE_LIGHT, wear: 0.4, ao: 0.4 }, 0, 0.15, -0.13);
    // Headset: earcup plus the band over the top.
    for (const sx of [-1, 1]) {
      cyl("metal", J_HEAD, ZONE_NONE, 0.032, 0.03, 0.022, { color: C_GUN, wear: 0.4 },
        sx * 0.108, 0.075, 0.01, 0, 0, Math.PI / 2);
    }
    box("metal", J_HEAD, ZONE_NONE, 0.1, 0.012, 0.026, 0.006, { color: C_GUN, wear: 0.35 }, 0, 0.185, 0.02);
  }

  // ---- arms ---------------------------------------------------------------
  for (const side of [0, 1]) {
    const sx = side === 0 ? 1 : -1;
    const jShoulder = side === 0 ? J_SHOULDER_R : J_SHOULDER_L;
    const jArm = side === 0 ? J_ARM_R : J_ARM_L;
    const jFore = side === 0 ? J_FORE_R : J_FORE_L;
    const jHand = side === 0 ? J_HAND_R : J_HAND_L;

    // Deltoid cap — a ball joint at the seam so the shoulder never tears open.
    sphere("cloth", jShoulder, 0, 0.088, { color: C_BASE, ao: 0.28, wear: 0.2 }, 0, -0.01, 0);
    // Upper arm.
    box("cloth", jArm, 0, 0.062, 0.145, 0.064, 0.028, { color: C_BASE, ao: 0.3, wear: 0.16 }, 0, -0.14, 0);
    // Elbow ball, then the forearm in the secondary colour (rolled sleeve).
    sphere("cloth", jFore, 0, 0.062, { color: C_BASE_DARK, ao: 0.3, wear: 0.3 }, 0, 0.01, 0);
    box("cloth", jFore, 1, 0.055, 0.125, 0.056, 0.024, { color: C_BASE, ao: 0.28, wear: 0.2 }, 0, -0.135, 0);
    if (hi) {
      // Rolled cuff — the lip where the sleeve stops.
      cyl("cloth", jFore, 0, 0.066, 0.062, 0.038, { color: C_BASE_DARK, wear: 0.4 }, 0, 0.01, 0, 0, 0, 0, false);
      // Elbow pad, brighter along its chamfers because elbows get scuffed.
      box("gear", jArm, ZONE_NONE, 0.05, 0.055, 0.022, 0.014,
        { color: C_STRAP, wear: 0.55, ao: 0.2 }, 0, -0.24, 0.052);
      // Wrist strap / watch on the right only.
      if (side === 0) {
        cyl("gear", jFore, ZONE_NONE, 0.056, 0.056, 0.024, { color: C_STRAP, wear: 0.4 }, 0, -0.225, 0, 0, 0, 0, false);
        box("metal", jFore, ZONE_NONE, 0.018, 0.016, 0.008, 0.004,
          { color: C_METAL, wear: 0.6, ao: 0 }, 0, -0.225, -0.056);
      }
    }
    // Glove: palm block plus a thumb, so the hand is not a lump.
    box("gear", jHand, ZONE_NONE, 0.05, 0.058, 0.038, 0.02, { color: C_RUBBER, ao: 0.3, wear: 0.34 }, 0, -0.05, 0);
    if (hi) {
      box("gear", jHand, ZONE_NONE, 0.02, 0.03, 0.022, 0.008,
        { color: C_RUBBER, shade: 0.9, wear: 0.3 }, sx * 0.05, -0.03, -0.012);
      box("gear", jHand, 2, 0.05, 0.016, 0.04, 0.008, { color: C_BASE, wear: 0.45 }, 0, 0.008, 0);
    }
  }

  // ---- legs ---------------------------------------------------------------
  for (const side of [0, 1]) {
    const jThigh = side === 0 ? J_THIGH_R : J_THIGH_L;
    const jShin = side === 0 ? J_SHIN_R : J_SHIN_L;
    const jFoot = side === 0 ? J_FOOT_R : J_FOOT_L;

    sphere("cloth", jThigh, 1, 0.095, { color: C_BASE, ao: 0.32, wear: 0.12 }, 0, -0.02, 0);
    box("cloth", jThigh, 1, 0.085, 0.215, 0.09, 0.036, { color: C_BASE, ao: 0.3, wear: 0.14 }, 0, -0.23, 0);
    sphere("cloth", jShin, 1, 0.072, { color: C_BASE, ao: 0.3, wear: 0.2 }, 0, 0.01, 0);
    box("cloth", jShin, 1, 0.072, 0.2, 0.078, 0.03, { color: C_BASE, ao: 0.28, wear: 0.16 }, 0, -0.21, 0);
    if (hi) {
      // Knee pad and thigh pocket: the two details that make trousers read as
      // trousers rather than as painted legs.
      box("gear", jShin, ZONE_NONE, 0.07, 0.062, 0.026, 0.018,
        { color: C_STRAP, wear: 0.5, ao: 0.24 }, 0, -0.06, -0.076);
      box("cloth", jThigh, 1, 0.062, 0.07, 0.016, 0.014,
        { color: C_BASE_DARK, wear: 0.3 }, side === 0 ? 0.078 : -0.078, -0.24, -0.056);
      box("gear", jThigh, ZONE_NONE, 0.064, 0.014, 0.014, 0.005,
        { color: C_STRAP, wear: 0.45 }, side === 0 ? 0.078 : -0.078, -0.176, -0.06);
      // Boot cuff at the top of the ankle.
      cyl("cloth", jShin, 1, 0.084, 0.076, 0.05, { color: C_BASE_DARK, wear: 0.35 }, 0, -0.372, 0, 0, 0, 0, false);
    }

    // Boot: upper, sole, welt, toe cap. The sole is deliberately lighter along
    // its chamfer — that pale line at the ground contact is wear, and wear at
    // contact points is one of the six things that separates this from a demo.
    box("gear", jFoot, ZONE_NONE, 0.078, 0.062, 0.128, 0.028,
      { color: C_STRAP, ao: 0.3, wear: 0.3 }, 0, 0.02, -0.03);
    box("gear", jFoot, ZONE_NONE, 0.082, 0.03, 0.15, 0.016,
      { color: C_SOLE, ao: 0.1, wear: 0.6 }, 0, -0.026, -0.04);
    if (hi) {
      box("gear", jFoot, ZONE_NONE, 0.086, 0.012, 0.154, 0.006,
        { color: C_SOLE, shade: 1.2, wear: 0.8, ao: 0 }, 0, -0.006, -0.04);
      box("gear", jFoot, ZONE_NONE, 0.07, 0.03, 0.03, 0.012,
        { color: C_RUBBER, wear: 0.7, ao: 0 }, 0, 0.006, -0.128);
      // Laces: three cross-over bars.
      for (let i = 0; i < 3; i++) {
        box("gear", jFoot, 2, 0.05, 0.008, 0.008, 0.003,
          { color: C_BASE_LIGHT, wear: 0.4, ao: 0 }, 0, 0.048 + i * 0.012, -0.09 + i * 0.026);
      }
    }
  }

  // ---- the rifle ----------------------------------------------------------
  //
  // Hung off the right hand so it follows the aim for free. It is a prop, not a
  // weapon system: what matters is that the silhouette says "armed" the instant
  // a rival crests a ridge.
  //
  // The pre-rotation is the whole trick. The forearm bone points along -Y, so
  // when the elbow is flexed to ~90° — which is what holding a rifle IS — the
  // hand's local -Y axis is what points forward. Author the gun down -Z and it
  // will point at the sky every time the elbow bends; author it down the
  // rotated frame and the barrel tracks the aim for free, with no counter-
  // rotation on the wrist.
  {
    const gunRoot = xf(0, 0, 0, -Math.PI / 2, 0, 0);
    const gunPut = (
      surface: SurfaceId, zone: Zone, geo: Geo,
      x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0,
    ) => {
      const m = new THREE.Matrix4()
        .multiplyMatrices(bindMatrices[J_HAND_R], gunRoot)
        .multiply(xf(x, y, z, rx, ry, rz));
      b.add(surface, J_HAND_R, zone, geo, m);
    };
    const gbox = (
      surface: SurfaceId, zone: Zone,
      hx: number, hy: number, hz: number, bev: number, paint: Paint,
      x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0,
    ) => gunPut(surface, zone, bevelBox(hx, hy, hz, bev, paint), x, y, z, rx, ry, rz);
    const gcyl = (
      surface: SurfaceId, zone: Zone,
      rb: number, rt: number, h: number, paint: Paint,
      x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0,
    ) => gunPut(surface, zone, tube(rb, rt, h, bs, paint), x, y, z, rx, ry, rz);

    const gunPaint: Paint = { color: C_GUN, wear: 0.4, ao: 0.2 };
    // Origin sits in the palm; the receiver runs forward along -Z of gun space.
    const gy = -0.05;
    const gz = -0.1;
    gbox("metal", ZONE_NONE, 0.026, 0.048, 0.2, 0.012, gunPaint, 0, gy, gz);
    gbox("metal", ZONE_NONE, 0.018, 0.026, 0.16, 0.008,
      { color: C_GUN_LIGHT, wear: 0.5, ao: 0.1 }, 0, gy + 0.05, gz - 0.06);
    // Barrel + muzzle device.
    gcyl("metal", ZONE_NONE, 0.015, 0.013, 0.22, { color: C_GUN, wear: 0.55 },
      0, gy + 0.012, gz - 0.3, Math.PI / 2, 0, 0);
    if (hi) {
      gcyl("metal", ZONE_NONE, 0.02, 0.02, 0.05, { color: C_METAL_DARK, wear: 0.7 },
        0, gy + 0.012, gz - 0.42, Math.PI / 2, 0, 0);
      // Magazine, canted forward the way a curved mag sits.
      gbox("metal", ZONE_NONE, 0.02, 0.075, 0.045, 0.012,
        { color: C_GUN_LIGHT, wear: 0.45 }, 0, gy - 0.09, gz - 0.02, 0.18, 0, 0);
      // Stock and grip.
      gbox("cloth", 2, 0.024, 0.05, 0.1, 0.016,
        { color: C_BASE_DARK, wear: 0.5, ao: 0.2 }, 0, gy - 0.005, gz + 0.24);
      gbox("metal", ZONE_NONE, 0.02, 0.06, 0.03, 0.01,
        { color: C_GUN, wear: 0.5 }, 0, gy - 0.06, gz + 0.09, -0.25, 0, 0);
      // Optic: a body plus a lens that is genuinely a different material.
      gbox("metal", ZONE_NONE, 0.022, 0.03, 0.07, 0.01,
        { color: C_METAL_DARK, wear: 0.4 }, 0, gy + 0.09, gz - 0.02);
      gcyl("metal", ZONE_NONE, 0.018, 0.018, 0.006, { color: C_GLASS, wear: 0.9, ao: 0 },
        0, gy + 0.09, gz - 0.056, Math.PI / 2, 0, 0);
      // Sling loop.
      gbox("gear", ZONE_NONE, 0.008, 0.05, 0.008, 0.003,
        { color: C_STRAP, wear: 0.5 }, 0.024, gy + 0.03, gz + 0.14);
    }
  }

  // ---- assemble -----------------------------------------------------------
  const merged = new Geo();
  const groups: Array<{ start: number; count: number }> = [];
  const surfaces: SurfaceId[] = [];
  for (const id of SURFACE_IDS) {
    const bin = b.get(id);
    if (!bin || bin.empty) continue;
    const start = merged.idx.length;
    const base = merged.vertexCount;
    for (let i = 0; i < bin.pos.length; i++) merged.pos.push(bin.pos[i]);
    for (let i = 0; i < bin.nor.length; i++) merged.nor.push(bin.nor[i]);
    for (let i = 0; i < bin.uv.length; i++) merged.uv.push(bin.uv[i]);
    for (let i = 0; i < bin.col.length; i++) merged.col.push(bin.col[i]);
    for (let i = 0; i < bin.zone.length; i++) merged.zone.push(bin.zone[i]);
    for (let i = 0; i < bin.bone.length; i++) merged.bone.push(bin.bone[i]);
    for (let i = 0; i < bin.idx.length; i++) merged.idx.push(bin.idx[i] + base);
    groups.push({ start, count: merged.idx.length - start });
    surfaces.push(id);
  }

  const count = merged.vertexCount;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    skinIndex[i * 4] = merged.bone[i];
    skinWeight[i * 4] = 1;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(merged.pos, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(merged.nor, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(merged.uv, 2));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(merged.col, 3));
  geometry.setAttribute("azone", new THREE.Float32BufferAttribute(merged.zone, 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
  geometry.setIndex(merged.idx);
  for (let i = 0; i < groups.length; i++) geometry.addGroup(groups[i].start, groups[i].count, i);
  // The bind pose is not the animated pose, so an exact bounding sphere would
  // cull a rival mid-stride. Pad it generously and let the distance LOD do the
  // real culling work.
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) {
    geometry.boundingSphere.center.set(0, 1.0, 0);
    geometry.boundingSphere.radius = 1.6;
  }

  return { geometry, surfaces, triangles: merged.idx.length / 3 };
}

/* ------------------------------------------------------------------------ *
 * Distant proxy (L2)
 * ------------------------------------------------------------------------ */

/**
 * The instanced figure everything beyond `l1Distance` becomes. About 220
 * triangles: still a recognisable human silhouette — head, pack, splayed legs,
 * a rifle stub — with the AO baked into the vertex colour, because at 250 m the
 * only things that read are the silhouette and the value structure.
 *
 * The pose is a mid-stride crouch-lean, which is what most rivals are doing
 * most of the time, and which reads as motion even though the geometry is
 * static.
 */
function buildProxyGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  const m = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => xf(x, y, z, rx, ry, rz);
  const add = (geo: Geo, mat: THREE.Matrix4) => g.append(geo, mat, 0, ZONE_NONE);

  // torso + pack
  add(bevelBox(0.2, 0.3, 0.13, 0.05, { color: 0xffffff, ao: 0.34, wear: 0.14 }), m(0, 1.3, 0, 0.12, 0, 0));
  add(bevelBox(0.15, 0.17, 0.1, 0.05, { color: 0xc8c8c8, ao: 0.3 }), m(0, 1.34, 0.2, 0.12, 0, 0));
  // head
  add(bevelBox(0.1, 0.12, 0.1, 0.045, { color: 0xffffff, ao: 0.24 }), m(0, 1.73, -0.02));
  // arms, one forward on the gun
  add(bevelBox(0.06, 0.2, 0.07, 0.028, { color: 0xdadada, ao: 0.3 }), m(0.22, 1.28, -0.06, -0.5, 0, 0.16));
  add(bevelBox(0.06, 0.2, 0.07, 0.028, { color: 0xdadada, ao: 0.3 }), m(-0.2, 1.26, 0.02, 0.3, 0, -0.2));
  // rifle stub — the thing that makes the silhouette read as armed
  add(bevelBox(0.03, 0.04, 0.28, 0.014, { color: 0x585c62, ao: 0.2, wear: 0.4 }), m(0.16, 1.16, -0.3, 0.1, 0, 0));
  // legs, mid-stride
  add(bevelBox(0.08, 0.24, 0.09, 0.034, { color: 0xe2e2e2, ao: 0.32 }), m(0.11, 0.72, -0.08, 0.42, 0, 0));
  add(bevelBox(0.07, 0.22, 0.08, 0.03, { color: 0xd0d0d0, ao: 0.3 }), m(0.15, 0.3, -0.3, -0.2, 0, 0));
  add(bevelBox(0.08, 0.24, 0.09, 0.034, { color: 0xe2e2e2, ao: 0.32 }), m(-0.11, 0.74, 0.06, -0.34, 0, 0));
  add(bevelBox(0.07, 0.22, 0.08, 0.03, { color: 0xd0d0d0, ao: 0.3 }), m(-0.13, 0.32, 0.22, 0.36, 0, 0));
  // boots
  add(bevelBox(0.08, 0.04, 0.13, 0.018, { color: 0x33363a, ao: 0.1, wear: 0.6 }), m(0.16, 0.05, -0.34));
  add(bevelBox(0.08, 0.04, 0.13, 0.018, { color: 0x33363a, ao: 0.1, wear: 0.6 }), m(-0.14, 0.05, 0.3));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(g.pos, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(g.nor, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(g.uv, 2));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(g.col, 3));
  geometry.setIndex(g.idx);
  geometry.computeBoundingSphere();
  return geometry;
}

/* ------------------------------------------------------------------------ *
 * Outfits + names
 * ------------------------------------------------------------------------ */

interface OutfitScheme {
  name: string;
  /** Jacket / torso. */
  primary: number;
  /** Trousers / sleeves. */
  secondary: number;
  /** Scarf, cap peak, laces, pack trim — the read-at-distance colour. */
  accent: number;
  /** Webbing and pouches. */
  gear: number;
  /** Pouch accent. */
  gearAccent: number;
}

/**
 * Fourteen outfits, then per-rival hue and value jitter on top. The palette is
 * deliberately Fortnite-saturated but value-separated: no two schemes sit at
 * the same lightness, because at 150 m in flat light a hue difference vanishes
 * and only value survives. That is what makes rivals readable against grass.
 */
const OUTFITS: OutfitScheme[] = [
  { name: "recon", primary: 0x2d4a6b, secondary: 0x3a3f47, accent: 0xf07a2c, gear: 0x6b5b45, gearAccent: 0xd8a24a },
  { name: "ranger", primary: 0x3f6b3a, secondary: 0x2e3339, accent: 0xe8d24a, gear: 0x574a38, gearAccent: 0x9ba85a },
  { name: "coral", primary: 0xd1553f, secondary: 0xf0e3cc, accent: 0x2b7f8f, gear: 0x8a6a52, gearAccent: 0xf4b76a },
  { name: "midnight", primary: 0x232a3d, secondary: 0x141922, accent: 0x6ad8f0, gear: 0x3a3f4c, gearAccent: 0x8f9bb0 },
  { name: "sandstorm", primary: 0xc9a86a, secondary: 0x8f7a52, accent: 0x3a4f6b, gear: 0x6e5a3e, gearAccent: 0xe4cf9c },
  { name: "violet", primary: 0x6a4a9c, secondary: 0x2e2740, accent: 0xf2c94c, gear: 0x4a3f60, gearAccent: 0xb59ce0 },
  { name: "medic", primary: 0xe8e4dc, secondary: 0x5a6068, accent: 0xd0322f, gear: 0x8d8f94, gearAccent: 0xe07070 },
  { name: "surf", primary: 0x2f9c8f, secondary: 0xe4dcc8, accent: 0xf25f4c, gear: 0x6f7a70, gearAccent: 0xa8e0d4 },
  { name: "carbon", primary: 0x33383f, secondary: 0x22262b, accent: 0xa8ff5a, gear: 0x4a505a, gearAccent: 0x7f8894 },
  { name: "brick", primary: 0x8f3f2f, secondary: 0x3e3630, accent: 0xe8c07a, gear: 0x6a4f3a, gearAccent: 0xc98f5a },
  { name: "arctic", primary: 0xdfe6ec, secondary: 0x9aa8b4, accent: 0x2e6fb0, gear: 0xb0b8c0, gearAccent: 0x6a7f94 },
  { name: "jungle", primary: 0x4a6b2f, secondary: 0x6b7a3a, accent: 0xd8722c, gear: 0x4f4a34, gearAccent: 0x9cae5c },
  { name: "royal", primary: 0x2b4c9c, secondary: 0xd8d2c4, accent: 0xf0a93b, gear: 0x53585f, gearAccent: 0x8fa8d8 },
  { name: "ember", primary: 0x40272a, secondary: 0x2a1e20, accent: 0xff6a2c, gear: 0x5a3f3a, gearAccent: 0xd88f5a },
];

/** Complexions and hair, kept separate from the outfit so they mix freely. */
const SKIN_TONES = [0xf0c8a0, 0xe0a878, 0xc8895c, 0xa06a46, 0x7a4c32, 0x53301f, 0xfadbc0, 0x8d5a3c];
const HAIR_TONES = [0x2a1c12, 0x120e0c, 0x5a3a20, 0x8a6234, 0xc4a068, 0x6a6a6a, 0xb03a2a, 0xdcdcdc];

const NAME_FIRST = [
  "Vex", "Nova", "Rook", "Zephyr", "Kilo", "Onyx", "Sable", "Drift",
  "Echo", "Talon", "Frost", "Halo", "Ash", "Juno", "Rift", "Comet",
  "Ghost", "Blaze", "Nyx", "Quill", "Sol", "Wren", "Cobalt", "Piper",
  "Ridge", "Sonic", "Havoc", "Lyric", "Volt", "Cinder", "Mako", "Pike",
];
const NAME_SECOND = [
  "Wolf", "Bolt", "Spike", "Fang", "Dash", "Vibe", "Storm", "Byte",
  "Crash", "Hawk", "Prime", "Rush", "Crown", "Verse", "Dive", "Nine",
  "Blitz", "Runner", "Rogue", "Sync", "Ace", "Zero", "Wave", "Grit",
];

/** Deterministic per-index name. Unique across the whole 99. */
function makeName(index: number, rng: () => number): string {
  const a = NAME_FIRST[Math.floor(rng() * NAME_FIRST.length) % NAME_FIRST.length];
  const b = NAME_SECOND[Math.floor(rng() * NAME_SECOND.length) % NAME_SECOND.length];
  // The trailing number is not decoration — it guarantees uniqueness without
  // a rejection loop, and it is exactly what real BR handles look like.
  return `${a}${b}${(index * 7 + 11) % 90 + 10}`;
}

/** Nudge a colour's hue and lightness so two rivals in one scheme differ. */
function jitterColor(hex: number, rng: () => number, hueSwing = 0.05, litSwing = 0.1): THREE.Color {
  const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(
    (hsl.h + (rng() - 0.5) * hueSwing + 1) % 1,
    clamp(hsl.s * (0.85 + rng() * 0.35), 0, 1),
    clamp(hsl.l * (1 + (rng() - 0.5) * litSwing * 2), 0.04, 0.96),
  );
  return c;
}

/* ------------------------------------------------------------------------ *
 * Poses
 * ------------------------------------------------------------------------ *
 *
 * A pose is a flat XYZ Euler per joint. Poses are additive over the bind pose
 * and blend by weighted sum, which is only valid for small-to-moderate angles —
 * true for everything here except the death fall, which is therefore authored
 * as a full replacement rather than an overlay.
 *
 * Everything is procedural: no clips, no keyframes, no importer. That is not a
 * compromise, it is the point — a walk cycle whose stride length is a live
 * function of speed cannot pop or foot-slide the way a fixed clip does.
 */

type Pose = Float32Array;

const makePose = (): Pose => new Float32Array(JOINT_COUNT * 3);

function poseReset(p: Pose): void {
  p.fill(0);
}

function poseAdd(out: Pose, src: Pose, w: number): void {
  if (w === 0) return;
  for (let i = 0; i < out.length; i++) out[i] += src[i] * w;
}

function setJ(p: Pose, j: number, x: number, y = 0, z = 0): void {
  const o = j * 3;
  p[o] = x;
  p[o + 1] = y;
  p[o + 2] = z;
}

/**
 * ## Sign conventions, which are not guessable and are worth stating once
 *
 * Every limb bone in the bind pose points along **-Y** (arms hang, legs drop),
 * and the character faces **-Z**. That fixes every sign in this section:
 *
 *  - **thigh X**: `+` swings the leg forward (hip flexion).
 *  - **shin X**: `-` bends the knee. Knees only go one way, so every shin term
 *    below is negative or zero. A positive shin is a broken leg, and it is the
 *    single most obvious animation bug a viewer can spot.
 *  - **foot X**: `+` lifts the toe (heel strike), `-` points it (toe-off).
 *  - **arm X**: `+` swings the arm forward.
 *  - **forearm X**: `+` closes the elbow. Same rule as the knee, opposite sign,
 *    because the elbow folds toward the front and the knee toward the back.
 *  - **arm Z**: `+` lifts the RIGHT arm away from the body, `-` the left.
 *  - **spine/chest X**: `+` leans back, `-` leans forward.
 *  - **any Y**: `+` turns left (the character's left).
 *
 * One derived fact the aim poses depend on: the rifle is authored down the
 * hand's local -Y (see `buildRig`), and `R_x(π/2)` maps -Y to -Z, so the barrel
 * points dead ahead when `armX + forearmX ≈ π/2` and pitches up by exactly the
 * amount that sum exceeds it. Every aim pose below is built on that identity.
 */

/**
 * Breathing idle, rifle at the low ready. The asymmetry — one shoulder higher,
 * the weight on one hip — is what stops a standing rival reading as a mannequin
 * on a plinth.
 */
function poseIdle(p: Pose, t: number): void {
  poseReset(p);
  const breath = Math.sin(t * 1.6);
  const sway = Math.sin(t * 0.7);
  setJ(p, J_SPINE, -0.02 + breath * 0.012, sway * 0.03, 0.012);
  setJ(p, J_CHEST, -0.03 + breath * 0.02, sway * 0.02, -0.02);
  setJ(p, J_NECK, 0.02 - breath * 0.012, -sway * 0.05, 0);
  setJ(p, J_HEAD, 0, -sway * 0.06, 0.01);
  setJ(p, J_SHOULDER_R, 0, 0, 0.06 + breath * 0.015);
  setJ(p, J_SHOULDER_L, 0, 0, -0.05 - breath * 0.015);
  // Right hand on the grip, left steadying the fore-end, muzzle down.
  setJ(p, J_ARM_R, 0.32, 0.1, 0.18);
  setJ(p, J_FORE_R, 1.16, 0, -0.12);
  setJ(p, J_HAND_R, 0.06, 0, 0);
  setJ(p, J_ARM_L, 0.44, -0.12, -0.3);
  setJ(p, J_FORE_L, 1.34, 0, 0.2);
  setJ(p, J_HAND_L, 0.05, 0, 0);
  // Weight on the left hip: that leg straightens, the right relaxes.
  setJ(p, J_HIPS, 0, 0, 0.02);
  setJ(p, J_THIGH_R, 0.03, 0, -0.03);
  setJ(p, J_THIGH_L, 0.07, 0, 0.05);
  setJ(p, J_SHIN_R, -0.06);
  setJ(p, J_SHIN_L, -0.13);
  setJ(p, J_FOOT_R, 0.03);
  setJ(p, J_FOOT_L, 0.06);
}

/**
 * Walk/run. `run` blends stride length, torso pitch and arm swing between the
 * two; `phase` is the gait cycle in radians, driven by distance travelled so
 * the feet cannot slide.
 */
function poseLocomotion(p: Pose, phase: number, run: number): void {
  poseReset(p);
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const swing = lerp(0.55, 1.05, run);
  const lift = lerp(0.5, 1.3, run);

  const thighR = s * swing;
  const thighL = -s * swing;
  // The knee flexes only on the recovery half of the stride — the support leg
  // stays near-straight, which is what carries the body's weight convincingly.
  const shinR = -(Math.max(0, -s) * lift + 0.13);
  const shinL = -(Math.max(0, s) * lift + 0.13);
  setJ(p, J_THIGH_R, thighR, 0, -0.03);
  setJ(p, J_THIGH_L, thighL, 0, 0.03);
  setJ(p, J_SHIN_R, shinR);
  setJ(p, J_SHIN_L, shinL);
  // Ankles are SOLVED, not authored: keeping the sole roughly parallel to the
  // ground through the whole cycle is what stops the feet skating, and picking
  // the angles by hand never survives a change to the stride length.
  setJ(p, J_FOOT_R, -(thighR + shinR) * 0.82 + 0.04);
  setJ(p, J_FOOT_L, -(thighL + shinL) * 0.82 + 0.04);

  // Pelvis counter-rotation, and a roll at twice the stride rate — one rise per
  // footfall, not one per cycle.
  setJ(p, J_HIPS, 0, -s * 0.13 * swing, c * 0.05 * run);
  setJ(p, J_SPINE, lerp(-0.03, -0.14, run), s * 0.07, 0);
  setJ(p, J_CHEST, lerp(-0.02, -0.09, run), s * 0.11, 0);
  setJ(p, J_NECK, lerp(0.03, 0.16, run), -s * 0.05, 0);
  setJ(p, J_HEAD, lerp(0.01, 0.06, run), 0, 0);

  setJ(p, J_SHOULDER_R, 0, 0, 0.07 + run * 0.05);
  setJ(p, J_SHOULDER_L, 0, 0, -0.08 - run * 0.06);
  // Arms swing opposite the legs. The right arm carries the rifle, so it swings
  // a fraction of the left and stays folded — an arm that swings freely with a
  // gun in it is the fastest way to make an armed character look unarmed.
  setJ(p, J_ARM_R, 0.34 - s * 0.14 * swing, 0.1, 0.2);
  setJ(p, J_FORE_R, 1.2 + run * 0.14, 0, -0.12);
  setJ(p, J_ARM_L, 0.28 + s * 0.6 * swing, -0.1, -0.26);
  setJ(p, J_FORE_L, 1.2 + Math.max(0, s) * 0.6 * run, 0, 0.16);
  setJ(p, J_HAND_R, 0.06, 0, 0);
  setJ(p, J_HAND_L, 0.05, 0, 0);
}

/**
 * Crouch-walk. The pelvis has to drop with it — a bone hierarchy has no IK, so
 * the caller lowers the rig root by `CROUCH_RIG_DROP`, and these angles are
 * chosen so the ankle rises by exactly that much and the soles stay planted.
 */
function poseCrouch(p: Pose, phase: number, move: number): void {
  poseReset(p);
  const s = Math.sin(phase) * move;
  setJ(p, J_HIPS, 0, -s * 0.06, 0);
  setJ(p, J_THIGH_R, 1.0 + s * 0.3, 0, -0.14);
  setJ(p, J_THIGH_L, 1.0 - s * 0.3, 0, 0.14);
  setJ(p, J_SHIN_R, -1.45 - Math.max(0, -s) * 0.35);
  setJ(p, J_SHIN_L, -1.45 - Math.max(0, s) * 0.35);
  setJ(p, J_FOOT_R, 0.45 - s * 0.16);
  setJ(p, J_FOOT_L, 0.45 + s * 0.16);
  setJ(p, J_SPINE, -0.2, 0, 0);
  setJ(p, J_CHEST, -0.14, s * 0.06, 0);
  setJ(p, J_NECK, 0.26, 0, 0);
  setJ(p, J_HEAD, 0.08, 0, 0);
  setJ(p, J_SHOULDER_R, 0, 0, 0.08);
  setJ(p, J_SHOULDER_L, 0, 0, -0.08);
  setJ(p, J_ARM_R, 0.3, 0.1, 0.22);
  setJ(p, J_FORE_R, 1.3, 0, -0.14);
  setJ(p, J_ARM_L, 0.5, -0.12, -0.3);
  setJ(p, J_FORE_L, 1.4, 0, 0.18);
}

/**
 * Aim, layered over whatever locomotion is doing — so these are DELTAS from the
 * carried-rifle pose above, not absolute angles.
 *
 * The `pitch` terms are split across the shoulder and the elbow so their sum is
 * exactly the aim pitch: by the identity in the section header, that is what
 * points the barrel where the bot is actually shooting. Splitting it two ways
 * rather than putting it all in the shoulder is what keeps the elbow looking
 * like an elbow when a rival shoots up at a build.
 */
function poseAim(p: Pose, pitch: number): void {
  poseReset(p);
  setJ(p, J_SPINE, pitch * 0.16, -0.1, 0);
  setJ(p, J_CHEST, pitch * 0.26, -0.22, 0);
  setJ(p, J_NECK, pitch * 0.18 + 0.04, 0.16, 0);
  setJ(p, J_HEAD, pitch * 0.1, 0.08, 0);
  // Right: elbow tucks in behind the stock and lifts to the side.
  setJ(p, J_SHOULDER_R, 0, 0, 0.06);
  setJ(p, J_ARM_R, -0.16 + pitch * 0.45, 0.16, 0.38);
  setJ(p, J_FORE_R, 0.3 + pitch * 0.55, 0, 0.05);
  setJ(p, J_HAND_R, 0.02, 0, 0);
  // Left: reaches across the body to the fore-end.
  setJ(p, J_SHOULDER_L, 0, 0, 0.04);
  setJ(p, J_ARM_L, 0.5 + pitch * 0.5, 0.2, 0.72);
  setJ(p, J_FORE_L, 0.16 + pitch * 0.3, 0, -0.12);
}

/** Recoil, as a decaying impulse on top of the aim. Muzzle rises, chest gives. */
function poseFire(p: Pose, k: number): void {
  poseReset(p);
  setJ(p, J_CHEST, 0.09 * k, 0, 0);
  setJ(p, J_NECK, 0.05 * k, 0, 0);
  setJ(p, J_SHOULDER_R, 0, 0, 0.05 * k);
  setJ(p, J_ARM_R, 0.1 * k, 0, 0.04 * k);
  setJ(p, J_FORE_R, 0.13 * k, 0, 0);
  setJ(p, J_ARM_L, 0.08 * k, 0, 0);
}

/**
 * Hit reaction. `dir` is the impact direction in body space (+1 from the front,
 * -1 from behind), so a rival shot in the chest snaps back and one shot in the
 * back folds forward. Getting this backwards is more noticeable than having no
 * reaction at all.
 */
function poseHit(p: Pose, k: number, dir: number, side: number): void {
  poseReset(p);
  setJ(p, J_SPINE, dir * 0.18 * k, side * 0.1 * k, -side * 0.12 * k);
  setJ(p, J_CHEST, dir * 0.24 * k, side * 0.14 * k, -side * 0.16 * k);
  setJ(p, J_NECK, dir * 0.3 * k, -side * 0.12 * k, 0);
  setJ(p, J_HEAD, dir * 0.2 * k, 0, side * 0.14 * k);
  setJ(p, J_SHOULDER_R, 0, 0, 0.2 * k);
  setJ(p, J_SHOULDER_L, 0, 0, -0.2 * k);
  setJ(p, J_ARM_R, 0.16 * k, 0, 0);
  setJ(p, J_ARM_L, 0.2 * k, 0, 0);
  setJ(p, J_THIGH_R, -dir * 0.1 * k, 0, 0);
  setJ(p, J_THIGH_L, -dir * 0.06 * k, 0, 0);
}

/**
 * Death fall. A replacement, not an overlay: the limbs go slack and the body
 * folds. `t` runs 0 → 1 over the fall; the topple rotation and the drop are
 * applied to the rig root by the caller, because they are not joint work.
 */
function poseDeath(p: Pose, t: number): void {
  poseReset(p);
  const k = smoothstep(t);
  const late = smoothstep(clamp01((t - 0.35) / 0.65));
  setJ(p, J_HIPS, -0.2 * k, 0.14 * k, 0.1 * k);
  setJ(p, J_SPINE, -0.26 * k, 0.1 * k, 0.16 * k);
  setJ(p, J_CHEST, -0.3 * k, -0.12 * k, -0.14 * k);
  // The head goes last and furthest — a body that dies all at once reads as a
  // switch being flipped.
  setJ(p, J_NECK, 0.42 * late, 0.2 * late, 0);
  setJ(p, J_HEAD, 0.26 * late, 0.14 * late, 0.2 * late);
  setJ(p, J_SHOULDER_R, 0, 0, 0.36 * k);
  setJ(p, J_SHOULDER_L, 0, 0, -0.4 * k);
  setJ(p, J_ARM_R, -0.45 * k, 0.3 * k, 0.55 * k);
  setJ(p, J_ARM_L, -0.6 * k, -0.4 * k, -0.62 * k);
  setJ(p, J_FORE_R, 0.5 * k, 0, 0);
  setJ(p, J_FORE_L, 0.35 * k, 0, 0);
  setJ(p, J_THIGH_R, 0.8 * k, 0, -0.3 * k);
  setJ(p, J_THIGH_L, 0.45 * k, 0, 0.36 * k);
  setJ(p, J_SHIN_R, -1.2 * k);
  setJ(p, J_SHIN_L, -0.65 * k);
  setJ(p, J_FOOT_R, -0.35 * k);
  setJ(p, J_FOOT_L, -0.25 * k);
}

/** Head-down dive: arched back, arms swept out and behind, legs trailing. */
function poseDive(p: Pose, t: number): void {
  poseReset(p);
  const flap = Math.sin(t * 5.5) * 0.06;
  setJ(p, J_HIPS, 0.3, 0, 0);
  setJ(p, J_SPINE, 0.16 + flap * 0.4, 0, 0);
  setJ(p, J_CHEST, 0.2, 0, 0);
  setJ(p, J_NECK, 0.34, 0, 0);
  setJ(p, J_HEAD, 0.16, 0, 0);
  setJ(p, J_SHOULDER_R, 0, 0, 0.45);
  setJ(p, J_SHOULDER_L, 0, 0, -0.45);
  setJ(p, J_ARM_R, -0.7 + flap, 0.2, 0.85);
  setJ(p, J_ARM_L, -0.7 - flap, -0.2, -0.85);
  setJ(p, J_FORE_R, 0.55, 0, 0);
  setJ(p, J_FORE_L, 0.55, 0, 0);
  setJ(p, J_THIGH_R, -0.45 + flap, 0, -0.28);
  setJ(p, J_THIGH_L, -0.45 - flap, 0, 0.28);
  setJ(p, J_SHIN_R, -0.75);
  setJ(p, J_SHIN_L, -0.6);
  setJ(p, J_FOOT_R, -0.3);
  setJ(p, J_FOOT_L, -0.3);
}

/** Under canopy: hands up on the risers, legs hanging and swaying. */
function poseGlide(p: Pose, t: number): void {
  poseReset(p);
  const sway = Math.sin(t * 1.3);
  setJ(p, J_HIPS, -0.06, sway * 0.06, sway * 0.05);
  setJ(p, J_SPINE, -0.04, 0, -sway * 0.04);
  setJ(p, J_CHEST, -0.02, 0, 0);
  setJ(p, J_NECK, 0.12, 0, 0);
  setJ(p, J_SHOULDER_R, 0, 0, 0.5);
  setJ(p, J_SHOULDER_L, 0, 0, -0.5);
  setJ(p, J_ARM_R, -2.3, 0.2, 0.5);
  setJ(p, J_ARM_L, -2.3, -0.2, -0.5);
  setJ(p, J_FORE_R, 0.5, 0, 0);
  setJ(p, J_FORE_L, 0.5, 0, 0);
  setJ(p, J_THIGH_R, 0.3 + sway * 0.1, 0, -0.08);
  setJ(p, J_THIGH_L, 0.24 - sway * 0.1, 0, 0.08);
  setJ(p, J_SHIN_R, -0.5);
  setJ(p, J_SHIN_L, -0.45);
  setJ(p, J_FOOT_R, 0.2, 0, 0);
  setJ(p, J_FOOT_L, 0.2, 0, 0);
}

/** Airborne — jump or fall. Legs tuck on the way up and reach on the way down. */
function poseAir(p: Pose, vy: number): void {
  poseReset(p);
  const rise = clamp01(vy / 7);
  const fall = clamp01(-vy / 14);
  setJ(p, J_SPINE, -0.06 + fall * 0.09, 0, 0);
  setJ(p, J_CHEST, -0.04, 0, 0);
  setJ(p, J_SHOULDER_R, 0, 0, 0.2 + fall * 0.25);
  setJ(p, J_SHOULDER_L, 0, 0, -0.22 - fall * 0.25);
  setJ(p, J_ARM_R, 0.3 + rise * 0.3, 0.1, 0.34);
  setJ(p, J_FORE_R, 1.15, 0, -0.12);
  setJ(p, J_ARM_L, 0.2 + rise * 0.7, -0.1, -0.5);
  setJ(p, J_FORE_L, 0.8 + fall * 0.5, 0, 0.2);
  setJ(p, J_THIGH_R, 0.7 * rise + 0.3, 0, -0.06);
  setJ(p, J_THIGH_L, 0.3 * rise + 0.12, 0, 0.06);
  setJ(p, J_SHIN_R, -(0.9 * rise + 0.35));
  setJ(p, J_SHIN_L, -(0.4 * rise + 0.2));
  setJ(p, J_FOOT_R, -0.15, 0, 0);
  setJ(p, J_FOOT_L, -0.12, 0, 0);
}

/**
 * Build swing, layered over locomotion. A big, telegraphed sweep of the free
 * hand: the player has to be able to SEE a rival building from across a field,
 * because reacting to it is the entire interaction.
 */
function poseBuild(p: Pose, t: number): void {
  poseReset(p);
  const k = Math.sin(clamp01(t) * Math.PI);
  setJ(p, J_SPINE, -0.08 * k, -0.16 * k, 0);
  setJ(p, J_CHEST, -0.12 * k, -0.2 * k, 0);
  setJ(p, J_NECK, 0.1 * k, 0.14 * k, 0);
  setJ(p, J_SHOULDER_L, -0.25 * k, 0, -0.3 * k);
  setJ(p, J_ARM_L, 1.6 * k, -0.2 * k, -0.5 * k);
  setJ(p, J_FORE_L, -0.5 * k, 0, 0);
  setJ(p, J_ARM_R, 0.3 * k, 0, 0.2 * k);
  setJ(p, J_FORE_R, -0.25 * k, 0, 0);
  setJ(p, J_THIGH_R, 0.18 * k, 0, 0);
  setJ(p, J_SHIN_R, -0.25 * k);
}

/** Drinking a shield potion: bottle to the mouth, head tipped back. Additive. */
function poseHeal(p: Pose, t: number): void {
  poseReset(p);
  const k = smoothstep(clamp01(t * 3));
  const wobble = Math.sin(t * 9) * 0.03 * k;
  setJ(p, J_SPINE, 0.05 * k, 0, 0);
  setJ(p, J_CHEST, 0.08 * k, 0.06 * k, 0);
  setJ(p, J_NECK, 0.3 * k + wobble, 0, 0);
  setJ(p, J_HEAD, 0.16 * k, 0, 0);
  setJ(p, J_SHOULDER_L, -0.2 * k, 0, -0.2 * k);
  setJ(p, J_ARM_L, 0.35 * k, 0.4 * k, 0.55 * k);
  setJ(p, J_FORE_L, 1.15 * k, 0, -0.3 * k);
  setJ(p, J_HAND_L, 0.3 * k, 0, 0);
  setJ(p, J_ARM_R, -0.1 * k, 0, 0.12 * k);
  setJ(p, J_FORE_R, -0.2 * k, 0, 0);
}

/* ------------------------------------------------------------------------ *
 * Nameplates
 * ------------------------------------------------------------------------ *
 *
 * One draw call for every plate on screen. The names live in a single baked
 * canvas atlas, one row per rival, and the health/shield bars are drawn
 * analytically in the fragment shader from a per-instance vec4. A Sprite per
 * rival would be a draw call each plus a texture each; this is neither.
 */

const PLATE_ROW_H = 40;
const PLATE_ATLAS_W = 256;
/** World-space size of the plate at the reference distance. */
const PLATE_WIDTH = 1.9;
const PLATE_HEIGHT = 0.62;

const PLATE_VERT = /* glsl */ `
attribute vec3 aOffset;
attribute vec4 aData;
attribute float aFade;
uniform float uPlateW;
uniform float uPlateH;
varying vec2 vUv;
varying vec4 vData;
varying float vFade;

void main() {
  vUv = uv;
  vData = aData;
  vFade = aFade;
  vec4 mv = viewMatrix * vec4(aOffset, 1.0);
  // Constant angular size out to 24 m, then a slow shrink so distant plates
  // recede instead of tiling the sky with text.
  float dist = max(-mv.z, 0.001);
  float scale = clamp(dist / 24.0, 1.0, 2.6);
  mv.xy += position.xy * vec2(uPlateW, uPlateH) * scale;
  gl_Position = projectionMatrix * mv;
}
`;

const PLATE_FRAG = /* glsl */ `
precision highp float;
#include <common>
// tonemapping only. three r160 prepends <colorspace_pars_fragment> to every
// non-raw ShaderMaterial (WebGLProgram.js), so including it here declares
// LinearSRGBToLinearDisplayP3 twice and the whole fragment shader fails to
// compile — nameplates then render as nothing at all. The tonemapping include
// IS needed and must stay: this material sets toneMapped:false, so three
// skips that chunk.
#include <tonemapping_pars_fragment>
uniform sampler2D uAtlas;
uniform float uRows;
varying vec2 vUv;
varying vec4 vData;
varying float vFade;

// Signed distance to a rounded box, for the bar capsules and the plate chip.
float sdRound(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

/**
 * One capsule bar: a dark track, a fill clipped to the value, a highlight along
 * the top of the fill so it reads as a solid object rather than a coloured
 * rectangle, and a hot rim when this rival is one the player has hit.
 *
 * Written out as a function called twice rather than a two-iteration loop:
 * GLSL ES 1.00's loop restrictions are enforced inconsistently across drivers
 * and a nameplate is not worth a shader that compiles on three GPUs out of
 * four.
 */
void drawBar(
  inout vec3 col, inout float alpha,
  vec2 p, float cy, float value, vec3 fill, float marked, bool show
) {
  if (!show) return;
  const float barW = 0.44;
  float d = sdRound(vec2(p.x, p.y - cy), vec2(barW, 0.042), 0.03);
  float mask = 1.0 - smoothstep(0.0, 0.012, d);
  if (mask <= 0.001) return;
  vec3 track = vec3(0.05, 0.06, 0.08);
  float filled = step(p.x, -barW + clamp(value, 0.0, 1.0) * barW * 2.0);
  vec3 barCol = mix(track, fill, filled);
  barCol += fill * filled * smoothstep(0.03, 0.055, p.y - cy) * 0.5;
  barCol = mix(barCol, vec3(1.0, 0.5, 0.25), marked * (1.0 - smoothstep(0.0, 0.02, abs(d))) * 0.85);
  col = mix(col, barCol, mask);
  alpha = max(alpha, mask);
}

void main() {
  float fade = vFade;
  if (fade <= 0.004) discard;

  vec3 col = vec3(0.0);
  float alpha = 0.0;

  // ---- name band ---------------------------------------------------------
  float ty = (vUv.y - 0.44) / 0.56;
  if (ty > 0.0 && ty < 1.0) {
    float row = vData.x;
    vec2 auv = vec2(vUv.x, 1.0 - (row + 1.0 - ty) / uRows);
    vec4 tex = texture2D(uAtlas, auv);
    // The atlas stores the glyph in .r and a dilated shadow in .g, so the text
    // reads against both a bright sky and a dark treeline without an outline
    // pass. Flat white text on a busy world is unreadable and it is the single
    // most common nameplate mistake.
    float glyph = tex.r;
    float halo = tex.g;
    vec3 tint = mix(vec3(1.0), vec3(1.0, 0.42, 0.3), vData.w);
    col += vec3(0.02) * halo * (1.0 - glyph);
    col += tint * glyph;
    alpha = max(halo * 0.55, glyph);
  }

  // ---- bars --------------------------------------------------------------
  // Shield above health, which is the order every BR HUD in existence uses.
  vec2 p = vec2(vUv.x - 0.5, vUv.y);
  drawBar(col, alpha, p, 0.30, vData.z, vec3(0.36, 0.72, 1.0), vData.w, vData.z > 0.001);
  drawBar(col, alpha, p, 0.16, vData.y, vec3(0.42, 0.92, 0.36), vData.w, true);

  gl_FragColor = vec4(col, alpha * fade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Bake the name atlas. `.r` is the glyph, `.g` is a dilated copy of it used as
 * a soft dark halo in the shader — cheaper and better-looking than a stroke,
 * because a stroke thickens the letterforms and a halo does not.
 */
function bakeNameAtlas(names: string[]): { texture: THREE.CanvasTexture; rows: number } {
  const rows = Math.max(1, names.length);
  const height = rows * PLATE_ROW_H;
  const canvas = document.createElement("canvas");
  canvas.width = PLATE_ATLAS_W;
  canvas.height = Math.min(height, 4096);
  const c2d = canvas.getContext("2d");
  if (!c2d) throw new Error("bots: nameplate canvas unavailable");

  c2d.clearRect(0, 0, canvas.width, canvas.height);
  c2d.textAlign = "center";
  c2d.textBaseline = "middle";
  c2d.font = `700 ${Math.floor(PLATE_ROW_H * 0.62)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

  // Pass 1: the halo, drawn wide into the green channel by stroking fat.
  c2d.strokeStyle = "rgba(0,255,0,1)";
  c2d.lineJoin = "round";
  c2d.lineWidth = 7;
  for (let i = 0; i < names.length; i++) {
    c2d.strokeText(names[i], canvas.width * 0.5, i * PLATE_ROW_H + PLATE_ROW_H * 0.5, canvas.width - 12);
  }
  // Pass 2: the glyph itself into red. Drawn over the halo so the two channels
  // stay independent — red is the letter, green is the letter plus its skirt.
  c2d.fillStyle = "rgba(255,255,0,1)";
  for (let i = 0; i < names.length; i++) {
    c2d.fillText(names[i], canvas.width * 0.5, i * PLATE_ROW_H + PLATE_ROW_H * 0.5, canvas.width - 12);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return { texture, rows };
}

/* ------------------------------------------------------------------------ *
 * Weapons the rivals carry
 * ------------------------------------------------------------------------ *
 *
 * Deliberately NOT the player's weapon table. Bot weapons are balanced against
 * a bot's aim model, not a human's: they trade a lower per-shot ceiling for a
 * legible rhythm, because what makes an AI fight readable is the PAUSE between
 * bursts — that is the window a player uses to peek, push or build, and a bot
 * that fires continuously removes the whole interaction.
 */
interface BotWeapon {
  id: string;
  name: string;
  sound: string;
  damage: number;
  /** Shots per burst and the gap between bursts. */
  burst: number;
  fireInterval: number;
  burstPause: number;
  /** Beyond this the bot will not open fire. */
  range: number;
  /** Preferred stand-off band — drives where the bot walks in an engagement. */
  preferMin: number;
  preferMax: number;
  /** Base miss cone in degrees at skill 0, halved at skill 1. */
  spreadDeg: number;
  /** Pellets per trigger pull. Shotguns roll their hits individually. */
  pellets: number;
  /** Rounds before a reload, and how long that takes. */
  magazine: number;
  reloadTime: number;
  /** How much the bot leads a moving target, in seconds of prediction. */
  lead: number;
  /** Relative pick weight when a rival is rolled. */
  weight: number;
}

const BOT_WEAPONS: BotWeapon[] = [
  {
    id: "ar", name: "Assault Rifle", sound: "shot-ar",
    damage: 9.5, burst: 5, fireInterval: 0.105, burstPause: 0.66,
    range: 115, preferMin: 18, preferMax: 55, spreadDeg: 4.2, pellets: 1,
    magazine: 30, reloadTime: 2.3, lead: 0.1, weight: 34,
  },
  {
    id: "smg", name: "SMG", sound: "shot-smg",
    damage: 6.4, burst: 9, fireInterval: 0.07, burstPause: 0.58,
    range: 62, preferMin: 6, preferMax: 26, spreadDeg: 6.4, pellets: 1,
    magazine: 32, reloadTime: 2.0, lead: 0.07, weight: 22,
  },
  {
    id: "pump", name: "Pump Shotgun", sound: "shot-pump",
    damage: 8.2, burst: 1, fireInterval: 0.9, burstPause: 0.95,
    range: 26, preferMin: 2, preferMax: 12, spreadDeg: 8.5, pellets: 9,
    magazine: 5, reloadTime: 3.1, lead: 0.03, weight: 16,
  },
  {
    id: "sniper", name: "Bolt Sniper", sound: "shot-sniper",
    damage: 78, burst: 1, fireInterval: 1.8, burstPause: 2.4,
    range: 340, preferMin: 55, preferMax: 190, spreadDeg: 2.6, pellets: 1,
    magazine: 5, reloadTime: 3.4, lead: 0.22, weight: 8,
  },
  {
    id: "pistol", name: "Pistol", sound: "shot-pistol",
    damage: 8.5, burst: 3, fireInterval: 0.18, burstPause: 0.72,
    range: 55, preferMin: 8, preferMax: 30, spreadDeg: 5.5, pellets: 1,
    magazine: 16, reloadTime: 1.7, lead: 0.08, weight: 20,
  },
];

/** Weighted pick from the table above. */
function rollWeapon(rng: () => number): BotWeapon {
  let total = 0;
  for (const w of BOT_WEAPONS) total += w.weight;
  let r = rng() * total;
  for (const w of BOT_WEAPONS) {
    r -= w.weight;
    if (r <= 0) return w;
  }
  return BOT_WEAPONS[0];
}

/* ------------------------------------------------------------------------ *
 * The rival record
 * ------------------------------------------------------------------------ */

type BotState =
  | "bus"
  | "dive"
  | "glide"
  | "loot"
  | "rotate"
  | "engage"
  | "build"
  | "heal"
  | "dead";

interface Bot {
  id: string;
  name: string;
  index: number;
  /** Row in the nameplate atlas. */
  plateRow: number;

  // ---- personality ------------------------------------------------------
  /** 0 = a warm body, 1 = genuinely dangerous. Drives aim, reaction, spread. */
  skill: number;
  /** How willingly it pushes rather than holds. */
  aggression: number;
  /** How readily it builds and retreats. */
  caution: number;
  weapon: BotWeapon;

  // ---- appearance -------------------------------------------------------
  outfit: OutfitScheme;
  tintCloth: [THREE.Color, THREE.Color, THREE.Color];
  tintGear: [THREE.Color, THREE.Color, THREE.Color];
  tintSkin: [THREE.Color, THREE.Color, THREE.Color];
  tintMetal: [THREE.Color, THREE.Color, THREE.Color];
  proxyColor: THREE.Color;

  // ---- physical ---------------------------------------------------------
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Facing, and the aim, which lead the facing when engaging. */
  yaw: number;
  aimYaw: number;
  aimPitch: number;
  grounded: boolean;
  groundY: number;
  crouch: boolean;
  height: number;
  inWater: boolean;

  hp: number;
  shield: number;
  alive: boolean;
  /** Set once the death has been reported, so it is reported exactly once. */
  reported: boolean;

  // ---- brain ------------------------------------------------------------
  state: BotState;
  stateTime: number;
  thinkTimer: number;
  goal: THREE.Vector3;
  /** Loot stops made at the current POI; drives when it moves on. */
  lootStops: number;
  dwell: number;
  poi: Poi | null;
  /** Target of the current engagement. */
  target: DamageTarget | null;
  targetPos: THREE.Vector3;
  targetVel: THREE.Vector3;
  targetIsPlayer: boolean;
  visible: boolean;
  sinceSeen: number;
  reaction: number;
  /** Rounds left in the burst, and the clock that paces them. */
  burstLeft: number;
  fireTimer: number;
  ammo: number;
  reloading: number;
  /** Direction the last damage came from, and how fresh it is. */
  threatDir: THREE.Vector3;
  threatTime: number;
  wallCooldown: number;
  healTimer: number;
  strafe: number;
  strafeTimer: number;

  // ---- drop -------------------------------------------------------------
  jumpT: number;
  dropTarget: THREE.Vector3;

  // ---- anti-stuck -------------------------------------------------------
  lastProgressPos: THREE.Vector3;
  progressTimer: number;
  unstick: number;
  unstickDir: number;
  /**
   * Steering bias from the obstacle whiskers, refreshed at think rate and held
   * between refreshes. Casting three rays per bot per 120 Hz step would be
   * fourteen thousand raycasts a second for nothing — obstacles do not move.
   */
  avoid: THREE.Vector3;
  /** Latched by the whisker pass when a ledge is worth hopping. */
  wantJump: boolean;
  /** Lateral offset on the bus so ninety-nine rivals are not one dot. */
  busOffset: number;

  // ---- animation --------------------------------------------------------
  visPos: THREE.Vector3;
  visYaw: number;
  gaitPhase: number;
  runBlend: number;
  aimBlend: number;
  crouchBlend: number;
  fireKick: number;
  hitKick: number;
  hitDir: number;
  hitSide: number;
  deathT: number;
  deathYaw: number;
  buildT: number;
  animTime: number;
  /** Sub-step accumulator so a strided bot still moves at the right speed. */
  simAccum: number;
  stride: number;
  stridePhase: number;

  // ---- feedback ---------------------------------------------------------
  /** True once the local player has damaged this rival. */
  markedByPlayer: boolean;
  plateFade: number;

  // ---- plumbing ---------------------------------------------------------
  damage: DamageTarget;
  unregister: (() => void) | null;
  info: BotInfo;
  rigSlot: number;
}

/** A rival that exists only as a name and a clock. */
interface Phantom {
  id: string;
  name: string;
  /** Seconds from the drop at which this one dies. */
  at: number;
  dead: boolean;
  /** Who gets credit in the feed. */
  killer: string;
}

/* ------------------------------------------------------------------------ *
 * Bot-built cover
 * ------------------------------------------------------------------------ */

/**
 * Bots build. It is the signature of the genre and an AI that eats a full clip
 * standing in the open is not a rival, it is a target.
 *
 * These are NOT `BuildPiece`s. `BuildService` exposes `place()`, which places
 * at the *player's* preview transform — there is no cross-system placement API,
 * so a bot wall is owned entirely by this module: its own instanced mesh, its
 * own collider, its own HP. See the contract note at the foot of the file.
 */
interface BotWall {
  active: boolean;
  center: THREE.Vector3;
  yaw: number;
  hp: number;
  maxHp: number;
  life: number;
  /** 0 → 1 rise animation, mirroring the player's build-up. */
  build: number;
  box: THREE.Box3;
  remove: (() => void) | null;
  owner: BuildPieceLike;
  ownerId: string;
}

/**
 * The duck-typed owner the collision broadphase hands back on a `RayHit`.
 * It carries the shape of a `BuildPiece` — including a `loc` that keeps
 * `building.ts`'s `damagePiece` from dereferencing undefined if combat routes
 * a hit there — and an `hp` accessor so that a system which decrements the
 * field directly still destroys the wall.
 */
interface BuildPieceLike {
  id: number;
  kind: "wall";
  material: "wood";
  cell: THREE.Vector3;
  rotation: number;
  hp: number;
  maxHp: number;
  complete: boolean;
  owner: string;
  box: THREE.Box3;
  /** Shaped like `building.ts`'s internal `Loc` so `locKey()` is safe on it. */
  loc: { kind: "wall"; a: number; b: number; c: number; rot: number };
}

/** Panel + battens, merged. The trim is what stops it reading as a grey slab. */
function buildWallGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  const put = (geo: Geo, m: THREE.Matrix4) => g.append(geo, m, 0, ZONE_NONE);
  const half = GRID * 0.5;

  // The panel itself, chamfered so its edge catches the key light.
  put(bevelBox(half, half, 0.11, 0.05, { color: 0xb08a56, ao: 0.3, wear: 0.22 }), xf(0, 0, 0));
  // Frame: four battens standing proud of the face, plus a diagonal brace.
  const batten: Paint = { color: 0x8a6a40, ao: 0.2, wear: 0.4 };
  put(bevelBox(half, 0.16, 0.05, 0.03, batten), xf(0, half - 0.16, -0.14));
  put(bevelBox(half, 0.16, 0.05, 0.03, batten), xf(0, -half + 0.16, -0.14));
  put(bevelBox(0.16, half - 0.3, 0.05, 0.03, batten), xf(-half + 0.16, 0, -0.14));
  put(bevelBox(0.16, half - 0.3, 0.05, 0.03, batten), xf(half - 0.16, 0, -0.14));
  put(bevelBox(0.11, half * 1.28, 0.04, 0.025, { color: 0x9a7748, ao: 0.2, wear: 0.5 }),
    xf(0, 0, -0.13, 0, 0, Math.PI * 0.25));
  // Back face gets one horizontal rail — the back of a wall is visible the
  // moment you run past it and a blank back face reads as a cardboard cutout.
  put(bevelBox(half, 0.14, 0.045, 0.025, { color: 0x7d6039, ao: 0.3, wear: 0.35 }), xf(0, 0, 0.14));
  // Corner plates.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      put(bevelBox(0.13, 0.13, 0.03, 0.012, { color: 0x6f7480, ao: 0.1, wear: 0.7 }),
        xf(sx * (half - 0.16), sy * (half - 0.16), -0.18));
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(g.pos, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(g.nor, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(g.uv, 2));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(g.col, 3));
  geometry.setIndex(g.idx);
  geometry.computeBoundingSphere();
  return geometry;
}

/* ------------------------------------------------------------------------ *
 * System
 * ------------------------------------------------------------------------ */

/** Anything that wants deterministic stepping implements this — see core.ts. */
interface FixedSystem extends System {
  fixed(dt: number, ctx: WorldCtx): void;
}

// Scratch. Nothing in the hot path allocates.
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _f = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _eul = new THREE.Euler(0, 0, 0, "YXZ");
const _scale = new THREE.Vector3(1, 1, 1);
const _box = new THREE.Box3();
/**
 * `fireShot` keeps its own eye and direction vectors rather than borrowing the
 * shared scratch. It calls out into damage handling mid-loop, and damage
 * handling touches `_a` — with a nine-pellet shotgun that would silently move
 * the muzzle between pellets. Scratch aliasing across a call boundary is the
 * kind of bug that only shows up as "shotguns are inaccurate sometimes".
 */
const _shotEye = new THREE.Vector3();
const _shotDir = new THREE.Vector3();

const createBots: SystemFactory = (ctx: WorldCtx): FixedSystem => {
  const services = ctx.services as BotServices;
  const tier = TIERS[ctx.quality] ?? TIERS.high;

  /**
   * Our own RNG stream. Drawing from `ctx.rng` directly would make the rival
   * roster depend on how many numbers every other system happened to pull
   * first, and "the same seed gives the same match" is a promise worth keeping.
   */
  const rng = (() => {
    let a = (Math.floor(ctx.rng() * 0xffffffff) ^ 0xb075a1) >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();

  /* ------------------------------------------------------------- state */

  const bots: Bot[] = [];
  const infos: BotInfo[] = [];
  const phantoms: Phantom[] = [];
  const walls: BotWall[] = [];
  let started = false;
  let disposed = false;
  let dropClock = 0;
  let stepCount = 0;
  let losBudget = LOS_BUDGET;
  let stormTick = 0;
  let nextWallId = 1;

  /* ----------------------------------------------------------- service */

  /**
   * Published before a single texture is baked. Every function it points at is
   * either a closure over `bots` (already declared) or a hoisted declaration,
   * so nothing here depends on the expensive work below having succeeded.
   */
  const service: BotsService = {
    get bots() {
      return infos;
    },
    get aliveCount() {
      let n = 0;
      for (const b of bots) if (b.alive) n++;
      return n;
    },
    get totalAlive() {
      let n = 0;
      for (const b of bots) if (b.alive) n++;
      for (const p of phantoms) if (!p.dead) n++;
      return n;
    },
    nearest(point, maxDist) {
      let best: BotInfo | null = null;
      let bestD = maxDist * maxDist;
      for (const b of bots) {
        if (!b.alive) continue;
        const d = b.pos.distanceToSquared(point);
        if (d < bestD) {
          bestD = d;
          best = b.info;
        }
      }
      return best;
    },
    eliminate(id, source) {
      for (const b of bots) {
        if (b.id === id && b.alive) {
          killBot(b, source ?? { by: "world" });
          return;
        }
      }
      for (const p of phantoms) {
        if (p.id === id && !p.dead) {
          killPhantom(p);
          return;
        }
      }
    },
    begin() {
      started = true;
    },
  };
  services.bots = service;

  /* --------------------------------------------------------------- art */

  const root = new THREE.Group();
  root.name = "dz:bots";
  // Nothing is parented under a moving node: every child writes its own world
  // matrix, so the group itself never needs an update.
  root.matrixAutoUpdate = false;
  ctx.scene.add(root);

  /** UV repeat per surface — how tight the weave reads at arm's length. */
  const SURFACE_REPEAT: Record<SurfaceId, number> = {
    cloth: 1.6, gear: 1.9, skin: 2.4, metal: 1.4,
  };

  const surfaceMaps: Partial<Record<SurfaceId, SurfaceMaps>> = {};
  for (const id of SURFACE_IDS) {
    const maps = bakeSurface(id, tier.texSize);
    for (const t of [maps.map, maps.normalMap, maps.roughnessMap]) {
      t.repeat.set(SURFACE_REPEAT[id], SURFACE_REPEAT[id]);
      t.needsUpdate = true;
    }
    surfaceMaps[id] = maps;
  }

  const bindMatrices = computeBindMatrices();
  const boneInverses = bindMatrices.map((m) => m.clone().invert());
  const rigHi = buildRig("high", bindMatrices, tier.ballSeg, tier.ballRing);
  const rigLo = buildRig("low", bindMatrices, tier.ballSeg, tier.ballRing);
  /**
   * Both LODs must present the same material groups in the same order or the
   * geometry swap would repaint a rival's boots with its face. `buildRig` emits
   * groups in `SURFACE_IDS` order and both detail levels use all four, but the
   * assumption is cheap to verify and expensive to debug.
   */
  const lodMatched =
    rigLo.surfaces.length === rigHi.surfaces.length &&
    rigLo.surfaces.every((s, i) => s === rigHi.surfaces[i]);

  interface RigSlot {
    group: THREE.Group;
    mesh: THREE.SkinnedMesh;
    bones: THREE.Bone[];
    skeleton: THREE.Skeleton;
    tints: TintedMaterial[];
    bot: Bot | null;
    lod: 0 | 1;
  }

  const rigSlots: RigSlot[] = [];
  for (let i = 0; i < tier.rigSlots; i++) {
    const group = new THREE.Group();
    group.name = `dz:bot-rig-${i}`;
    group.visible = false;
    group.matrixAutoUpdate = false;

    const bones = makeBones();
    group.add(bones[0]);

    const tints = rigHi.surfaces.map((s) => makeTintedMaterial(s, surfaceMaps[s] as SurfaceMaps));
    const mesh = new THREE.SkinnedMesh(rigHi.geometry, tints.map((t) => t.material));
    mesh.name = `dz:bot-body-${i}`;
    mesh.castShadow = tier.shadows;
    mesh.receiveShadow = true;
    // The rig lives entirely inside a 2 m sphere the LOD manager already
    // distance-culls; leaving the renderer to re-derive that from a skinned
    // bounding sphere every frame buys nothing.
    mesh.frustumCulled = false;
    group.add(mesh);

    const skeleton = new THREE.Skeleton(bones, boneInverses.map((m) => m.clone()));
    mesh.bind(skeleton, new THREE.Matrix4());

    root.add(group);
    rigSlots.push({ group, mesh, bones, skeleton, tints, bot: null, lod: 0 });
  }

  // ---- distant proxies ----------------------------------------------------
  const proxyGeometry = buildProxyGeometry();
  const proxyMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    // Distant rivals never get close enough for a texture to matter, but they
    // must still sit in the same roughness family as everything else or they
    // pop when they cross the LOD line.
    roughness: 0.78,
    metalness: 0.03,
    dithering: true,
  });
  proxyMaterial.name = "dz:bot:proxy";
  const proxyMesh = new THREE.InstancedMesh(proxyGeometry, proxyMaterial, RIVAL_COUNT);
  proxyMesh.name = "dz:bot-proxies";
  proxyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  proxyMesh.frustumCulled = false;
  proxyMesh.castShadow = false;
  proxyMesh.receiveShadow = true;
  proxyMesh.count = 0;
  root.add(proxyMesh);
  // Allocate the colour buffer up front — assigning it lazily mid-frame is a
  // guaranteed one-frame flash of white.
  proxyMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(RIVAL_COUNT * 3), 3);
  proxyMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < RIVAL_COUNT * 3; i++) proxyMesh.instanceColor.array[i] = 1;

  // ---- bot-built walls ----------------------------------------------------
  const wallGeometry = buildWallGeometry();
  const wallMaterial = (() => {
    const shared = services.materials?.get("woodPlank");
    if (shared) {
      // Re-use the world's plank material when it exists: a bot wall that does
      // not match the player's builds is the sort of inconsistency that reads
      // as a bug even when nobody can name it.
      const m = (shared as THREE.MeshStandardMaterial).clone();
      m.vertexColors = true;
      m.name = "dz:bot-wall";
      return m;
    }
    const m = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.86, metalness: 0.02, dithering: true,
    });
    m.name = "dz:bot-wall";
    return m;
  })();
  const wallMesh = new THREE.InstancedMesh(wallGeometry, wallMaterial, tier.wallBudget);
  wallMesh.name = "dz:bot-walls";
  wallMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  wallMesh.frustumCulled = false;
  wallMesh.castShadow = tier.shadows;
  wallMesh.receiveShadow = true;
  wallMesh.count = 0;
  root.add(wallMesh);

  /* --------------------------------------------------------- population */

  const simulated = Math.min(tier.simulated, RIVAL_COUNT);
  const usedNames = new Set<string>();
  const allNames: string[] = [];
  for (let i = 0; i < RIVAL_COUNT; i++) {
    let n = makeName(i, rng);
    let guard = 0;
    while (usedNames.has(n) && guard++ < 8) n = makeName(i + guard * 131, rng);
    usedNames.add(n);
    allNames.push(n);
  }

  const nameAtlas = bakeNameAtlas(allNames.slice(0, simulated));

  // ---- nameplates ---------------------------------------------------------
  const plateGeometry = new THREE.InstancedBufferGeometry();
  {
    // Authored by hand rather than cloned off a PlaneGeometry: the plate's
    // origin has to be its BOTTOM edge so the anchor can sit a fixed distance
    // above a rival's head whatever size the plate ends up being.
    plateGeometry.setAttribute("position", new THREE.Float32BufferAttribute(
      [-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3,
    ));
    plateGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(
      [0, 0, 1, 0, 1, 1, 0, 1], 2,
    ));
    plateGeometry.setIndex([0, 1, 2, 0, 2, 3]);
  }
  const plateOffsets = new THREE.InstancedBufferAttribute(new Float32Array(tier.plates * 3), 3);
  const plateData = new THREE.InstancedBufferAttribute(new Float32Array(tier.plates * 4), 4);
  const plateFades = new THREE.InstancedBufferAttribute(new Float32Array(tier.plates), 1);
  plateOffsets.setUsage(THREE.DynamicDrawUsage);
  plateData.setUsage(THREE.DynamicDrawUsage);
  plateFades.setUsage(THREE.DynamicDrawUsage);
  plateGeometry.setAttribute("aOffset", plateOffsets);
  plateGeometry.setAttribute("aData", plateData);
  plateGeometry.setAttribute("aFade", plateFades);
  plateGeometry.instanceCount = 0;
  plateGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const plateMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: nameAtlas.texture },
      uRows: { value: Math.max(1, nameAtlas.rows) },
      uPlateW: { value: PLATE_WIDTH },
      uPlateH: { value: PLATE_HEIGHT },
    },
    vertexShader: PLATE_VERT,
    fragmentShader: PLATE_FRAG,
    transparent: true,
    depthWrite: false,
    // Depth-TESTED, not depth-ignoring: a nameplate that shines through a
    // mountain tells the player something false, and a battle royale is a game
    // about information.
    depthTest: true,
    // Interface, not world: tone-mapping the plate lets a bright sky wash the
    // health bar's green out to pastel exactly when it matters most.
    toneMapped: false,
  });
  const plateMesh = new THREE.Mesh(plateGeometry, plateMaterial);
  plateMesh.name = "dz:bot-nameplates";
  plateMesh.frustumCulled = false;
  plateMesh.matrixAutoUpdate = false;
  plateMesh.renderOrder = 12;
  root.add(plateMesh);

  /* ------------------------------------------------------------ spawning */

  /** Pick a drop POI, biased toward the named landmarks the way players are. */
  function pickDropPoi(): Poi | null {
    const pois = services.pois;
    if (!pois || pois.length === 0) return null;
    let total = 0;
    for (const p of pois) total += p.tier === "landmark" ? 3 : p.tier === "major" ? 2 : 1;
    let r = rng() * total;
    for (const p of pois) {
      r -= p.tier === "landmark" ? 3 : p.tier === "major" ? 2 : 1;
      if (r <= 0) return p;
    }
    return pois[pois.length - 1];
  }

  function makeBot(index: number): Bot {
    const outfit = OUTFITS[Math.floor(rng() * OUTFITS.length) % OUTFITS.length];
    const skill = clamp01(Math.pow(rng(), 1.35));
    const weapon = rollWeapon(rng);
    const poi = pickDropPoi();

    const pos = new THREE.Vector3();
    const info: BotInfo = {
      id: `bot-${index}`,
      name: allNames[index],
      position: pos,
      hp: BOT_HP,
      shield: 0,
      alive: true,
      state: "bus",
    };

    const damage: DamageTarget = {
      id: info.id,
      // Its own node so `getWorldPosition` is meaningful even when the rival
      // has no rig slot: combat hit registration must not depend on LOD.
      object: new THREE.Object3D(),
      radius: BOT_RADIUS,
      height: BOT_HEIGHT,
      hp: BOT_HP,
      shield: 0,
      headY: BOT_EYE,
      faction: "bot",
      alive: true,
      onDamage(amount, point, source, headshot) {
        applyBotDamage(bot, amount, point, source, headshot);
      },
    };
    damage.object.name = `dz:bot-hit-${index}`;
    damage.object.matrixAutoUpdate = false;

    const bot: Bot = {
      id: info.id,
      name: info.name,
      index,
      plateRow: index,
      skill,
      aggression: clamp01(0.28 + skill * 0.45 + rng() * 0.3),
      caution: clamp01(0.2 + skill * 0.5 + rng() * 0.3),
      weapon,
      outfit,
      tintCloth: [
        jitterColor(outfit.primary, rng),
        jitterColor(outfit.secondary, rng),
        jitterColor(outfit.accent, rng, 0.03, 0.06),
      ],
      tintGear: [
        jitterColor(outfit.gear, rng),
        jitterColor(outfit.gearAccent, rng),
        jitterColor(outfit.accent, rng, 0.03, 0.06),
      ],
      tintSkin: [
        jitterColor(SKIN_TONES[Math.floor(rng() * SKIN_TONES.length) % SKIN_TONES.length], rng, 0.02, 0.08),
        jitterColor(HAIR_TONES[Math.floor(rng() * HAIR_TONES.length) % HAIR_TONES.length], rng, 0.03, 0.12),
        new THREE.Color(1, 1, 1),
      ],
      tintMetal: [
        new THREE.Color(1, 1, 1),
        new THREE.Color(1, 1, 1),
        jitterColor(outfit.accent, rng, 0.02, 0.05),
      ],
      proxyColor: new THREE.Color(),
      pos,
      vel: new THREE.Vector3(),
      yaw: rng() * TAU,
      aimYaw: 0,
      aimPitch: 0,
      grounded: false,
      groundY: 0,
      crouch: false,
      height: BOT_HEIGHT,
      inWater: false,
      hp: BOT_HP,
      shield: 0,
      alive: true,
      reported: false,
      state: "bus",
      stateTime: 0,
      thinkTimer: rng() * THINK_INTERVAL,
      goal: new THREE.Vector3(),
      lootStops: 0,
      dwell: 0,
      poi,
      target: null,
      targetPos: new THREE.Vector3(),
      targetVel: new THREE.Vector3(),
      targetIsPlayer: false,
      visible: false,
      sinceSeen: 99,
      reaction: 0,
      burstLeft: 0,
      fireTimer: 0,
      ammo: weapon.magazine,
      reloading: 0,
      threatDir: new THREE.Vector3(),
      threatTime: 0,
      wallCooldown: 0,
      healTimer: 0,
      strafe: rng() < 0.5 ? -1 : 1,
      strafeTimer: 0,
      jumpT: lerp(BUS_JUMP_MIN, BUS_JUMP_MAX, rng()),
      dropTarget: new THREE.Vector3(),
      lastProgressPos: new THREE.Vector3(),
      progressTimer: 0,
      unstick: 0,
      unstickDir: rng() < 0.5 ? -1 : 1,
      avoid: new THREE.Vector3(),
      wantJump: false,
      busOffset: (rng() - 0.5) * 2,
      visPos: new THREE.Vector3(),
      visYaw: 0,
      gaitPhase: rng() * TAU,
      runBlend: 0,
      aimBlend: 0,
      crouchBlend: 0,
      fireKick: 0,
      hitKick: 0,
      hitDir: 1,
      hitSide: 0,
      deathT: 0,
      deathYaw: 0,
      buildT: 0,
      animTime: rng() * 40,
      simAccum: 0,
      stride: 1,
      stridePhase: index % 8,
      markedByPlayer: false,
      plateFade: 0,
      damage,
      unregister: null,
      info,
      rigSlot: -1,
    };

    // The proxy tint is the jacket colour lifted toward white: at 250 m in
    // aerial haze a dark jacket disappears entirely, and a rival you cannot see
    // is not a stealth mechanic, it is a missing rival.
    bot.proxyColor.copy(bot.tintCloth[0]).lerp(new THREE.Color(1, 1, 1), 0.22);

    // Drop target: somewhere inside the chosen POI, or a random patch of land.
    const terrain = services.terrain;
    const size = terrain?.worldSize ?? 1500;
    if (poi) {
      const a = rng() * TAU;
      const r = Math.sqrt(rng()) * Math.max(8, poi.radius * 0.8);
      bot.dropTarget.set(poi.center.x + Math.cos(a) * r, 0, poi.center.z + Math.sin(a) * r);
    } else {
      bot.dropTarget.set((rng() - 0.5) * size * 1.2, 0, (rng() - 0.5) * size * 1.2);
    }
    bot.dropTarget.y = terrain ? terrain.heightAt(bot.dropTarget.x, bot.dropTarget.z) : 0;
    bot.goal.copy(bot.dropTarget);
    bot.pos.copy(bot.dropTarget).setY(BUS_ALTITUDE);
    bot.visPos.copy(bot.pos);

    return bot;
  }

  for (let i = 0; i < simulated; i++) {
    const bot = makeBot(i);
    bots.push(bot);
    infos.push(bot.info);
  }

  /**
   * The phantom death schedule.
   *
   * Shaped like a real match: a hot spike in the first ninety seconds when
   * everyone lands on the same three POIs, a long thin middle, and a rising
   * tail as the circles get small. `Math.pow` on a uniform is the cheapest way
   * to get that front-loading, and the storm-phase bumps come from the
   * quadratic term.
   */
  {
    const count = RIVAL_COUNT - simulated;
    for (let i = 0; i < count; i++) {
      const u = (i + 0.5) / Math.max(1, count);
      // 0.45 exponent → about a third of them are gone inside the first 20% of
      // the match, which is what the drop actually looks like.
      const t = Math.pow(u, 0.45) * 560 + rng() * 26;
      phantoms.push({
        id: `bot-p${simulated + i}`,
        name: allNames[simulated + i],
        at: t,
        dead: false,
        killer: "",
      });
    }
    phantoms.sort((x, y) => x.at - y.at);
  }

  /* --------------------------------------------------------- registration */

  function registerAll(): void {
    const combat = services.combat;
    if (!combat) return;
    for (const b of bots) {
      if (b.unregister || !b.alive) continue;
      try {
        b.unregister = combat.registerTarget(b.damage);
      } catch {
        b.unregister = null;
      }
    }
  }

  /* --------------------------------------------------------------- damage */

  const _damageHit: RayHit = {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    distance: 0,
  };

  /**
   * The authority on a rival's health. Whether or not `combat` also decremented
   * the mirror fields on the `DamageTarget`, the damage lands exactly once here
   * and the mirror is re-synced afterwards — the same contract `player.ts` uses.
   */
  function applyBotDamage(
    bot: Bot,
    amount: number,
    point: THREE.Vector3 | undefined,
    source: DamageSource,
    headshot: boolean,
  ): void {
    if (!bot.alive || !(amount > 0)) return;

    // Combat owns the headshot multiplier when it routed the hit; when nothing
    // routed it (storm, fall, a bot shooting another bot with combat missing)
    // we apply our own.
    let remaining = amount;
    if (bot.shield > 0) {
      const absorbed = Math.min(bot.shield, remaining);
      bot.shield -= absorbed;
      remaining -= absorbed;
    }
    bot.hp -= remaining;

    if (source.by === "player") {
      bot.markedByPlayer = true;
      // Being shot by the player is the one thing that always makes a rival
      // turn and fight: an AI that ignores you is worse than a hard one.
      bot.threatTime = THREAT_MEMORY;
      const p = services.player;
      if (p) bot.threatDir.copy(p.position).sub(bot.pos).setY(0).normalize();
    } else if (point) {
      bot.threatTime = THREAT_MEMORY;
      bot.threatDir.copy(point).sub(bot.pos).setY(0);
      if (bot.threatDir.lengthSq() > 1e-6) bot.threatDir.normalize();
    }

    // Hit reaction, in body space so a shot in the back folds them forward.
    if (point) {
      _a.copy(point).sub(bot.pos).setY(0);
      if (_a.lengthSq() > 1e-6) {
        _a.normalize();
        const fx = -Math.sin(bot.yaw);
        const fz = -Math.cos(bot.yaw);
        // +1 when the round came from directly in front, -1 from behind. The
        // pose layer reads this to decide whether the body snaps back or folds.
        bot.hitDir = _a.x * fx + _a.z * fz;
        bot.hitSide = _a.x * -fz + _a.z * fx;
      }
    }
    bot.hitKick = Math.min(1, bot.hitKick + clamp(amount / 45, 0.18, 0.85));
    if (headshot) bot.hitKick = Math.min(1, bot.hitKick + 0.2);

    bot.damage.hp = Math.max(0, bot.hp);
    bot.damage.shield = Math.max(0, bot.shield);
    bot.info.hp = bot.damage.hp;
    bot.info.shield = bot.damage.shield;

    if (bot.hp <= 0) {
      killBot(bot, source);
      return;
    }

    // Take the hit seriously: drop whatever it was doing and fight or cover.
    if (bot.state === "loot" || bot.state === "rotate" || bot.state === "heal") {
      bot.state = "engage";
      bot.stateTime = 0;
      bot.thinkTimer = 0;
    }
  }

  function killBot(bot: Bot, source: DamageSource): void {
    if (!bot.alive) return;
    bot.alive = false;
    bot.hp = 0;
    bot.shield = 0;
    bot.state = "dead";
    bot.stateTime = 0;
    bot.deathT = 0;
    bot.deathYaw = bot.yaw;
    bot.vel.set(0, bot.vel.y, 0);
    bot.damage.alive = false;
    bot.damage.hp = 0;
    bot.damage.shield = 0;
    bot.info.alive = false;
    bot.info.hp = 0;
    bot.info.shield = 0;
    bot.info.state = "dead";
    bot.target = null;

    bot.unregister?.();
    bot.unregister = null;

    if (!bot.reported) {
      bot.reported = true;
      services.match?.reportDeath(bot.id, source);
    }

    services.audio?.play("death", { position: bot.pos, volume: 0.5, maxDistance: 90 });
    // Combat owns the feed for anything it routed; a death we resolved
    // ourselves (the storm, a fall, a bot-on-bot trade with combat missing)
    // would otherwise never reach it.
    if (source.by !== "player") {
      ctx.emit("dz:eliminate", {
        victim: bot.id,
        victimName: bot.name,
        by: source.by,
        byName: source.name ?? source.by,
        weapon: source.weapon,
      });
    }
  }

  function killPhantom(p: Phantom): void {
    if (p.dead) return;
    p.dead = true;
    const source: DamageSource = { by: p.killer || "world", name: p.killer || undefined };
    services.match?.reportDeath(p.id, source);
    ctx.emit("dz:eliminate", {
      victim: p.id,
      victimName: p.name,
      by: source.by,
      byName: source.name ?? "the storm",
      weapon: undefined,
    });
  }

  /* ----------------------------------------------------------- geometry Q */

  const terrainY = (x: number, z: number): number => services.terrain?.heightAt(x, z) ?? 0;

  /** Character forward from a yaw. The rig is authored facing -Z. */
  const yawTo = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

  function botEye(bot: Bot, out: THREE.Vector3): THREE.Vector3 {
    return out.set(bot.pos.x, bot.pos.y + (bot.crouch ? BOT_CROUCH_EYE : BOT_EYE), bot.pos.z);
  }

  /**
   * Ray/capsule, the same test `weapons.ts` runs for the player's shots. Bots
   * must hit each other by exactly the rules that govern the player hitting
   * them, or a fight the player watches from a hillside will not match the one
   * they walk into.
   */
  function rayCapsule(
    origin: THREE.Vector3, dir: THREE.Vector3,
    base: THREE.Vector3, radius: number, height: number, limit: number,
  ): number {
    const top = base.y + height - radius;
    const bottom = base.y + radius;
    const ox = origin.x - base.x;
    const oz = origin.z - base.z;
    const a = dir.x * dir.x + dir.z * dir.z;
    const b = 2 * (ox * dir.x + oz * dir.z);
    const c = ox * ox + oz * oz - radius * radius;
    if (a > 1e-9) {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        let t = (-b - sq) / (2 * a);
        if (t < 0) t = (-b + sq) / (2 * a);
        if (t >= 0 && t <= limit) {
          const y = origin.y + dir.y * t;
          if (y >= bottom - radius && y <= top + radius) return t;
        }
      }
    }
    // Missed the barrel — try the cap plane the ray is heading toward.
    if (Math.abs(dir.y) < 1e-9) return -1;
    const planeY = origin.y < bottom ? bottom : top;
    const tc = (planeY - origin.y) / dir.y;
    if (tc < 0 || tc > limit) return -1;
    const cx = origin.x + dir.x * tc - base.x;
    const cz = origin.z + dir.z * tc - base.z;
    return cx * cx + cz * cz <= radius * radius ? tc : -1;
  }

  /** True when nothing solid stands between two points. Costs one raycast. */
  function lineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const collision = services.collision;
    if (!collision) return true;
    _a.copy(to).sub(from);
    const dist = _a.length();
    if (dist < 0.4) return true;
    _a.multiplyScalar(1 / dist);
    let hit: RayHit | null = null;
    try {
      hit = collision.raycast(from, _a, dist);
    } catch {
      return true;
    }
    // A hit within half a metre of the target is the target's own cover, not a
    // wall — without the slack every bot decides it cannot see anyone standing
    // against a building.
    return !hit || hit.distance >= dist - 0.55;
  }

  /* ------------------------------------------------------------ perception */

  /**
   * Detection range. Skill widens it, but not without limit: a rival that
   * notices you at 300 m through a treeline is not "hard", it is broken, and
   * the player has no way to learn the rule.
   */
  function detectRange(bot: Bot): number {
    const base = Math.min(bot.weapon.range, 150);
    return base * (0.62 + bot.skill * 0.45);
  }

  function acquireTarget(bot: Bot): void {
    const player = services.player;
    const range = detectRange(bot);
    let best: DamageTarget | null = null;
    let bestPos: THREE.Vector3 | null = null;
    let bestVel: THREE.Vector3 | null = null;
    let bestIsPlayer = false;
    // Score, not distance: the player is worth pushing past a closer bot, and
    // a rival that already shot us is worth more than one that has not.
    let bestScore = -Infinity;

    if (player && player.state !== "dead" && player.state !== "down") {
      const d = bot.pos.distanceTo(player.position);
      if (d < range) {
        bestScore = (range - d) / range + 0.35;
        best = null;
        bestPos = player.position;
        bestVel = player.velocity;
        bestIsPlayer = true;
      }
    }

    for (const other of bots) {
      if (other === bot || !other.alive) continue;
      const d = bot.pos.distanceTo(other.pos);
      if (d >= range) continue;
      let score = (range - d) / range;
      if (bot.threatTime > 0) {
        _a.copy(other.pos).sub(bot.pos).setY(0);
        if (_a.lengthSq() > 1e-6 && _a.normalize().dot(bot.threatDir) > 0.6) score += 0.4;
      }
      if (score > bestScore) {
        bestScore = score;
        best = other.damage;
        bestPos = other.pos;
        bestVel = other.vel;
        bestIsPlayer = false;
      }
    }

    if (!bestPos) {
      bot.sinceSeen += THINK_INTERVAL;
      if (bot.sinceSeen > LOST_TARGET_TIME) {
        bot.target = null;
        bot.targetIsPlayer = false;
        bot.visible = false;
      }
      return;
    }

    // The LOS raycast is the expensive half of perception, so it is rationed.
    // Losing a check means holding the previous belief for a beat, which is
    // exactly what a person does anyway.
    let visible = bot.visible;
    const wantCheck = losBudget > 0 || bestIsPlayer;
    if (wantCheck) {
      losBudget--;
      botEye(bot, _b);
      _d.copy(bestPos);
      _d.y += BOT_CHEST;
      visible = lineOfSight(_b, _d);
    }

    if (visible) {
      bot.sinceSeen = 0;
      if (!bot.targetIsPlayer && bestIsPlayer) bot.reaction = lerp(REACTION_MAX, REACTION_MIN, bot.skill);
      else if (bot.target !== best) bot.reaction = lerp(REACTION_MAX, REACTION_MIN, bot.skill) * 0.7;
      bot.target = best;
      bot.targetIsPlayer = bestIsPlayer;
      bot.targetPos.copy(bestPos);
      bot.targetVel.copy(bestVel ?? _a.set(0, 0, 0));
      bot.visible = true;
    } else {
      bot.sinceSeen += THINK_INTERVAL;
      bot.visible = false;
      if (bot.sinceSeen > LOST_TARGET_TIME) {
        bot.target = null;
        bot.targetIsPlayer = false;
      } else {
        // Keep walking to where they last were. Bots that instantly forget you
        // the moment you break LOS make every fight a game of peekaboo.
        bot.targetPos.copy(bestPos);
      }
    }
  }

  /* --------------------------------------------------------------- whiskers */

  /**
   * Three probe rays: straight ahead and ±35°. A blocked whisker pushes the
   * steering sideways, hard, and only a genuinely un-walkable surface counts —
   * a ray at chest height hits every uphill slope on the island, and a bot that
   * treats a hill as a wall never leaves the beach.
   */
  function updateWhiskers(bot: Bot): void {
    bot.avoid.set(0, 0, 0);
    bot.wantJump = false;
    const collision = services.collision;
    if (!collision) return;

    _d.set(bot.goal.x - bot.pos.x, 0, bot.goal.z - bot.pos.z);
    if (_d.lengthSq() < 1e-6) return;
    _d.normalize();

    const eyeY = bot.pos.y + 1.15;
    let centreBlocked = 0;

    for (let i = -1; i <= 1; i++) {
      const ang = i * WHISKER_SPREAD;
      const cs = Math.cos(ang), sn = Math.sin(ang);
      _e.set(_d.x * cs - _d.z * sn, 0, _d.x * sn + _d.z * cs).normalize();
      _f.set(bot.pos.x, eyeY, bot.pos.z);
      let hit: RayHit | null = null;
      try {
        hit = collision.raycast(_f, _e, WHISKER_LENGTH);
      } catch {
        hit = null;
      }
      if (!hit) continue;
      // Walkable ground is not an obstacle.
      if (hit.normal.y > BOT_MAX_SLOPE_COS) continue;
      const w = (1 - hit.distance / WHISKER_LENGTH) * AVOID_GAIN;
      // Push perpendicular to the blocked whisker, away from the side it is on.
      // The centre whisker inherits the bot's standing turn preference, which
      // is what keeps a bot from oscillating in a doorway.
      const side = i === 0 ? bot.unstickDir : -Math.sign(i);
      bot.avoid.x += -_e.z * side * w;
      bot.avoid.z += _e.x * side * w;
      if (i === 0) centreBlocked = Math.max(centreBlocked, w);
    }

    // Ledge test: something solid at shin height with clear air above it is a
    // step up, not a wall, and hopping it is much better than walking the long
    // way round a 0.9 m planter.
    if (centreBlocked > 0) {
      _f.set(bot.pos.x, bot.pos.y + 1.55, bot.pos.z);
      let high: RayHit | null = null;
      try {
        high = collision.raycast(_f, _d, 2.0);
      } catch {
        high = null;
      }
      if (!high) bot.wantJump = true;
    }
  }

  /**
   * Rotate a direction away from open water. Bots do not swim in this build —
   * a rival bobbing in the sea reads as broken, and every POI is on land.
   */
  function avoidWater(bot: Bot, dir: THREE.Vector3): void {
    const terrain = services.terrain;
    if (!terrain || dir.lengthSq() < 1e-6) return;
    const probe = 7;
    if (!terrain.isWater(bot.pos.x + dir.x * probe, bot.pos.z + dir.z * probe)) return;
    if (terrain.isWater(bot.goal.x, bot.goal.z)) return;
    for (let k = 1; k <= 6; k++) {
      for (const s of [1, -1]) {
        const ang = s * k * 0.42;
        const cs = Math.cos(ang), sn = Math.sin(ang);
        const nx = dir.x * cs - dir.z * sn;
        const nz = dir.x * sn + dir.z * cs;
        if (!terrain.isWater(bot.pos.x + nx * probe, bot.pos.z + nz * probe)) {
          dir.set(nx, 0, nz).normalize();
          return;
        }
      }
    }
    // Boxed in by water on every heading: walk back the way we came.
    dir.negate();
  }

  /* ------------------------------------------------------------- decisions */

  /** Somewhere worth standing inside the next circle. */
  function pickRotateGoal(bot: Bot, out: THREE.Vector3): void {
    const storm = services.storm;
    const terrain = services.terrain;
    if (!storm) {
      const p = pickDropPoi();
      out.set(p ? p.center.x : 0, 0, p ? p.center.z : 0);
      out.y = terrainY(out.x, out.z);
      return;
    }
    // Aim for a ring inside the next circle rather than its exact centre: a
    // hundred rivals converging on one point is the classic AI tell, and the
    // edge of the zone is where a real player actually rotates to.
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = rng() * TAU;
      const r = storm.nextRadius * lerp(0.25, 0.82, rng());
      const x = storm.nextCenter.x + Math.cos(a) * r;
      const z = storm.nextCenter.z + Math.sin(a) * r;
      if (terrain && terrain.isWater(x, z)) continue;
      out.set(x, terrainY(x, z), z);
      return;
    }
    out.copy(storm.nextCenter);
    out.y = terrainY(out.x, out.z);
  }

  /** The next thing worth walking to inside the current POI. */
  function pickLootGoal(bot: Bot): void {
    const loot = services.loot;
    const terrain = services.terrain;

    // Every other stop, look for something real on the ground. Bots walking to
    // actual loot is the cheapest possible way to make the POI look inhabited.
    if (loot && (bot.lootStops & 1) === 0) {
      try {
        const pickup = loot.nearest(bot.pos, 55);
        if (pickup) {
          bot.goal.copy(pickup.position);
          bot.goal.y = terrainY(bot.goal.x, bot.goal.z);
          return;
        }
      } catch {
        /* loot may be mid-teardown; fall through to the POI wander */
      }
    }

    const poi = bot.poi;
    if (poi) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const a = rng() * TAU;
        const r = Math.sqrt(rng()) * Math.max(10, poi.radius * 0.9);
        const x = poi.center.x + Math.cos(a) * r;
        const z = poi.center.z + Math.sin(a) * r;
        if (terrain && terrain.isWater(x, z)) continue;
        bot.goal.set(x, terrainY(x, z), z);
        return;
      }
    }
    // No POI at all: shuffle around where we stand.
    const a = rng() * TAU;
    const r = 12 + rng() * 24;
    bot.goal.set(bot.pos.x + Math.cos(a) * r, 0, bot.pos.z + Math.sin(a) * r);
    bot.goal.y = terrainY(bot.goal.x, bot.goal.z);
  }

  /** Move on to a different POI — preferably one already inside the zone. */
  function repoi(bot: Bot): void {
    const pois = services.pois;
    const storm = services.storm;
    if (!pois || pois.length === 0) return;
    let best: Poi | null = null;
    let bestScore = -Infinity;
    for (const p of pois) {
      if (p === bot.poi) continue;
      const d = Math.hypot(p.center.x - bot.pos.x, p.center.z - bot.pos.z);
      let score = -d * 0.012;
      if (p.tier === "landmark") score += 0.5;
      else if (p.tier === "major") score += 0.25;
      if (storm) {
        const dz = Math.hypot(p.center.x - storm.nextCenter.x, p.center.z - storm.nextCenter.z);
        // Heavily prefer a POI the circle is not about to eat.
        score += dz < storm.nextRadius ? 1.2 : -1.4;
      }
      score += rng() * 0.4;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best) {
      bot.poi = best;
      bot.lootStops = 0;
    }
  }

  /**
   * How long it would take to walk to safety, versus how long there is. The
   * margin is generous on purpose: a rival caught by the wall because it left
   * ten seconds too late is realistic and also unsatisfying to watch.
   */
  function stormPressure(bot: Bot): number {
    const storm = services.storm;
    if (!storm) return 0;
    if (!storm.isSafe(bot.pos)) return 2;
    const d = Math.hypot(bot.pos.x - storm.nextCenter.x, bot.pos.z - storm.nextCenter.z);
    const travel = Math.max(0, d - storm.nextRadius * 0.7) / BOT_RUN;
    const budget = storm.closing ? storm.timer : storm.timer + 12;
    if (travel > budget * 0.8) return 1.5;
    if (travel > budget * 0.5) return 1;
    return 0;
  }

  function think(bot: Bot): void {
    if (!bot.alive || bot.state === "bus" || bot.state === "dive" || bot.state === "glide") return;

    acquireTarget(bot);
    updateWhiskers(bot);

    const effective = bot.hp + bot.shield;
    const pressure = stormPressure(bot);
    const engaged = bot.target !== null || bot.targetIsPlayer;
    const dist = engaged ? bot.pos.distanceTo(bot.targetPos) : Infinity;

    // ---- heal ------------------------------------------------------------
    if (bot.state === "heal") {
      if (bot.healTimer > 0 && (!bot.visible || dist > 45) && pressure < 1.5) {
        bot.goal.copy(bot.pos);
        return;
      }
      bot.healTimer = 0;
      bot.state = "loot";
    }
    const hurt = effective < BOT_HP * RETREAT_HEALTH;
    if (hurt && bot.healTimer <= 0 && (!bot.visible || dist > 40) && pressure < 1.5 && rng() < bot.caution) {
      bot.state = "heal";
      bot.stateTime = 0;
      bot.healTimer = HEAL_TIME;
      bot.goal.copy(bot.pos);
      return;
    }

    // ---- fight -----------------------------------------------------------
    // A rival still fights while the wall closes if the fight is right in front
    // of it — the alternative is bots turning their backs mid-trade, which
    // looks like a bug even though it is technically correct play.
    if (engaged && dist < bot.weapon.range * 1.15 && (pressure < 1.5 || dist < 30)) {
      if (bot.state !== "engage" && bot.state !== "build") {
        bot.state = "engage";
        bot.stateTime = 0;
      }
      // Hold at the weapon's preferred stand-off, then strafe across it.
      _d.copy(bot.targetPos).sub(bot.pos).setY(0);
      const flat = _d.length();
      if (flat > 1e-3) _d.multiplyScalar(1 / flat);
      const want = clamp(flat, bot.weapon.preferMin, bot.weapon.preferMax);
      // Aggression decides whether it closes the gap or holds the line.
      const target = lerp(want, bot.weapon.preferMin + 2, bot.aggression * 0.6);
      bot.goal.copy(bot.targetPos).addScaledVector(_d, -target);
      bot.goal.y = terrainY(bot.goal.x, bot.goal.z);
      // Sidestep, flipping every couple of seconds. Static bots are free kills.
      if (bot.strafeTimer <= 0) {
        bot.strafeTimer = 1.1 + rng() * 1.6;
        bot.strafe = rng() < 0.5 ? -1 : 1;
      }
      // Under fire, in the open, with a gap to cover: build.
      if (
        bot.threatTime > 0 && bot.wallCooldown <= 0 && bot.visible &&
        flat > 8 && rng() < bot.caution * 0.7
      ) {
        if (placeWall(bot)) {
          bot.state = "build";
          bot.stateTime = 0;
          bot.buildT = 0;
        }
      }
      return;
    }

    if (bot.state === "build" && bot.stateTime < 0.55) return;

    // ---- rotate ----------------------------------------------------------
    if (pressure >= 1 || bot.state === "rotate") {
      const arrived = Math.hypot(bot.goal.x - bot.pos.x, bot.goal.z - bot.pos.z) < 8;
      if (bot.state !== "rotate" || arrived) {
        if (bot.state === "rotate" && arrived && pressure === 0) {
          bot.state = "loot";
          bot.lootStops = 0;
          repoi(bot);
          pickLootGoal(bot);
          return;
        }
        pickRotateGoal(bot, bot.goal);
      }
      bot.state = "rotate";
      return;
    }

    // ---- loot ------------------------------------------------------------
    if (bot.state !== "loot") {
      bot.state = "loot";
      bot.stateTime = 0;
      bot.dwell = 0;
      pickLootGoal(bot);
      return;
    }
    if (bot.dwell > 0) {
      bot.dwell -= THINK_INTERVAL;
      bot.goal.copy(bot.pos);
      return;
    }
    const reached = Math.hypot(bot.goal.x - bot.pos.x, bot.goal.z - bot.pos.z) < 3.2;
    if (reached) {
      // Standing still for a beat at each stop is what makes a looting rival
      // read as looting rather than as patrolling.
      bot.dwell = 1.2 + rng() * 2.4;
      bot.lootStops++;
      if (bot.lootStops > 3 + Math.floor(rng() * 3)) repoi(bot);
      pickLootGoal(bot);
    }
  }

  /* --------------------------------------------------------------- movement */

  function groundStep(bot: Bot, dt: number): void {
    const terrain = services.terrain;
    const collision = services.collision;

    // ---- desired heading --------------------------------------------------
    _d.set(bot.goal.x - bot.pos.x, 0, bot.goal.z - bot.pos.z);
    const toGoal = _d.length();
    if (toGoal > 1e-3) _d.multiplyScalar(1 / toGoal);
    else _d.set(0, 0, 0);

    // Strafe: blend a lateral component in while fighting.
    if (bot.state === "engage" && (bot.target !== null || bot.targetIsPlayer)) {
      bot.strafeTimer -= dt;
      _e.set(-_d.z, 0, _d.x).multiplyScalar(bot.strafe * 0.85);
      _d.add(_e);
      if (_d.lengthSq() > 1e-6) _d.normalize();
    }

    _d.add(bot.avoid);
    if (bot.unstick > 0) {
      // Committed sidestep. Long enough to actually clear whatever it was.
      bot.unstick -= dt;
      _e.set(-_d.z, 0, _d.x).multiplyScalar(bot.unstickDir * 1.5);
      _d.add(_e);
    }
    if (_d.lengthSq() > 1e-6) _d.normalize();
    avoidWater(bot, _d);

    // ---- speed ------------------------------------------------------------
    let speed = BOT_WALK;
    if (bot.state === "rotate") speed = BOT_RUN;
    else if (bot.state === "engage") speed = toGoal > 14 ? BOT_RUN : BOT_WALK * 1.08;
    else if (bot.state === "loot") speed = toGoal > 26 ? BOT_RUN * 0.9 : BOT_WALK;
    if (bot.crouch) speed = BOT_CROUCH_SPEED;
    if (bot.state === "heal" || bot.state === "build") speed = 0;
    if (bot.dwell > 0 && bot.state === "loot") speed = 0;
    // Ease off at the destination instead of stopping dead on the spot.
    if (toGoal < 2.5) speed *= clamp01(toGoal / 2.5);

    // Crouch when sniping from stand-off, never while moving anywhere.
    bot.crouch =
      bot.state === "engage" && bot.weapon.id === "sniper" && bot.visible && toGoal < 2.5;
    bot.height = bot.crouch ? BOT_CROUCH_HEIGHT : BOT_HEIGHT;
    bot.damage.height = bot.height;
    bot.damage.headY = bot.crouch ? BOT_CROUCH_EYE : BOT_EYE;

    // ---- accelerate -------------------------------------------------------
    const wantX = _d.x * speed;
    const wantZ = _d.z * speed;
    const accel = bot.grounded ? BOT_ACCEL : BOT_ACCEL * 0.3;
    bot.vel.x += (wantX - bot.vel.x) * clamp01(accel * dt / Math.max(speed, 1));
    bot.vel.z += (wantZ - bot.vel.z) * clamp01(accel * dt / Math.max(speed, 1));
    if (speed <= 0.01 && bot.grounded) {
      const f = 1 - clamp01(BOT_FRICTION * dt);
      bot.vel.x *= f;
      bot.vel.z *= f;
    }

    // ---- jump -------------------------------------------------------------
    if (bot.wantJump && bot.grounded && bot.vel.y <= 0.01) {
      bot.vel.y = BOT_JUMP;
      bot.grounded = false;
      bot.wantJump = false;
      services.audio?.play("jump", { position: bot.pos, volume: 0.25, maxDistance: 40 });
    }

    // ---- integrate --------------------------------------------------------
    bot.vel.y += BOT_GRAVITY * dt;
    if (bot.vel.y < -70) bot.vel.y = -70;
    bot.pos.addScaledVector(bot.vel, dt);

    // ---- resolve ----------------------------------------------------------
    let groundY = terrain ? terrain.heightAt(bot.pos.x, bot.pos.z) : 0;
    bot.inWater = terrain ? terrain.isWater(bot.pos.x, bot.pos.z) : false;

    // Only bots the player could plausibly interact with pay for a full capsule
    // resolve. Beyond that the heightfield alone is indistinguishable — you
    // cannot see a rival clipping a shed corner at 200 m, and 40 capsule
    // resolves at 120 Hz is a frame you cannot get back.
    if (collision && bot.stride === 1) {
      try {
        const res = collision.resolveCapsule(bot.pos, BOT_RADIUS, bot.height);
        if (res.grounded && res.groundY > groundY) groundY = res.groundY;
        if (res.hit && res.groundNormal.y < BOT_MAX_SLOPE_COS) {
          // Wedged against something un-walkable: commit to a sidestep rather
          // than grinding along it. This is the single fix that stops the
          // "bot vibrating against a wall" failure everyone recognises.
          if (bot.unstick <= 0) {
            bot.unstick = UNSTICK_TIME;
            bot.unstickDir = -bot.unstickDir;
          }
        }
      } catch {
        /* broadphase mid-teardown */
      }
    }

    if (bot.pos.y <= groundY + 0.02) {
      bot.pos.y = groundY;
      if (bot.vel.y < 0) bot.vel.y = 0;
      bot.grounded = true;
    } else {
      bot.grounded = false;
    }
    bot.groundY = groundY;

    // Never let a bot end up under the world or out at sea.
    if (terrain) {
      const size = terrain.worldSize;
      bot.pos.x = clamp(bot.pos.x, -size, size);
      bot.pos.z = clamp(bot.pos.z, -size, size);
    }

    // ---- stuck watchdog ---------------------------------------------------
    bot.progressTimer += dt;
    if (bot.progressTimer >= STUCK_WINDOW) {
      const moved = bot.lastProgressPos.distanceTo(bot.pos);
      const wantsToMove = speed > 0.5;
      if (wantsToMove && moved < STUCK_DISTANCE) {
        bot.unstick = UNSTICK_TIME;
        bot.unstickDir = -bot.unstickDir;
        // Two failed windows in a row and the goal itself is the problem.
        if (moved < STUCK_DISTANCE * 0.35) {
          if (bot.state === "loot") pickLootGoal(bot);
          else if (bot.state === "rotate") pickRotateGoal(bot, bot.goal);
        }
      }
      bot.lastProgressPos.copy(bot.pos);
      bot.progressTimer = 0;
    }

    // ---- facing -----------------------------------------------------------
    const moving = bot.vel.x * bot.vel.x + bot.vel.z * bot.vel.z;
    let faceYaw = bot.yaw;
    if (bot.state === "engage" && (bot.target !== null || bot.targetIsPlayer)) {
      faceYaw = yawTo(bot.targetPos.x - bot.pos.x, bot.targetPos.z - bot.pos.z);
    } else if (moving > 0.25) {
      faceYaw = yawTo(bot.vel.x, bot.vel.z);
    }
    bot.yaw = turnToward(bot.yaw, faceYaw, BOT_TURN_RATE * dt);
  }

  /* ------------------------------------------------------------------ drop */

  function enterDive(bot: Bot): void {
    bot.state = "dive";
    bot.stateTime = 0;
    bot.vel.set(0, -6, 0);
  }

  function landBot(bot: Bot): void {
    bot.state = "loot";
    bot.stateTime = 0;
    bot.vel.set(0, 0, 0);
    bot.pos.y = terrainY(bot.pos.x, bot.pos.z);
    bot.lastProgressPos.copy(bot.pos);
    bot.dwell = 0;
    bot.lootStops = 0;
    pickLootGoal(bot);
    services.audio?.play("land", { position: bot.pos, volume: 0.3, maxDistance: 60 });
  }

  function dropStep(bot: Bot, dt: number): void {
    const match = services.match;

    if (bot.state === "bus") {
      if (match && (match.phase === "bus" || match.phase === "warmup" || match.busT < 1)) {
        _a.copy(match.busFrom).lerp(match.busTo, clamp01(match.busT));
        // Fan the rivals out along and across the route so the bus reads as a
        // bus full of people rather than as one point in the sky.
        _b.copy(match.busTo).sub(match.busFrom).setY(0);
        if (_b.lengthSq() > 1e-6) _b.normalize();
        bot.pos.copy(_a);
        bot.pos.x += -_b.z * bot.busOffset * 3 + _b.x * (bot.index % 7) * 1.6;
        bot.pos.z += _b.x * bot.busOffset * 3 + _b.z * (bot.index % 7) * 1.6;
        bot.yaw = yawTo(_b.x, _b.z);
        if (started && (match.busT >= bot.jumpT || match.phase === "dropping" || match.phase === "live")) {
          enterDive(bot);
        }
        return;
      }
      // No match system, or the bus has already gone: get on with it.
      if (started || dropClock > 2.5) enterDive(bot);
      return;
    }

    const ground = terrainY(bot.pos.x, bot.pos.z);
    _d.set(bot.dropTarget.x - bot.pos.x, 0, bot.dropTarget.z - bot.pos.z);
    const flat = _d.length();
    if (flat > 1e-3) _d.multiplyScalar(1 / flat);

    if (bot.state === "dive") {
      // Head-down: fall fast, steer hard. A rival should visibly cross ground
      // on the way down, because that is what the drop is for.
      bot.vel.y = approach(bot.vel.y, -DIVE_SPEED, 1.4, dt);
      const push = Math.min(flat / Math.max(1, (bot.pos.y - ground) * 0.7), 1) * 46;
      bot.vel.x = approach(bot.vel.x, _d.x * push, 2.2, dt);
      bot.vel.z = approach(bot.vel.z, _d.z * push, 2.2, dt);
      bot.pos.addScaledVector(bot.vel, dt);
      bot.yaw = turnToward(bot.yaw, yawTo(_d.x, _d.z), 3 * dt);
      if (bot.pos.y - ground < DEPLOY_ALTITUDE) {
        bot.state = "glide";
        bot.stateTime = 0;
        services.audio?.play("glider-deploy", { position: bot.pos, volume: 0.3, maxDistance: 140 });
      }
      return;
    }

    // Glide.
    bot.vel.y = approach(bot.vel.y, -GLIDE_SINK, 4, dt);
    const speed = flat > 4 ? GLIDE_SPEED : GLIDE_SPEED * 0.25;
    bot.vel.x = approach(bot.vel.x, _d.x * speed, 2.4, dt);
    bot.vel.z = approach(bot.vel.z, _d.z * speed, 2.4, dt);
    bot.pos.addScaledVector(bot.vel, dt);
    bot.yaw = turnToward(bot.yaw, yawTo(_d.x, _d.z), 2.2 * dt);
    if (bot.pos.y <= ground + 0.08) landBot(bot);
  }

  /* ---------------------------------------------------------------- combat */

  function combatStep(bot: Bot, dt: number): void {
    const weapon = bot.weapon;
    bot.fireTimer -= dt;
    bot.reaction -= dt;
    bot.threatTime -= dt;
    bot.wallCooldown -= dt;
    if (bot.strafeTimer > 0) bot.strafeTimer -= dt;

    if (bot.reloading > 0) {
      bot.reloading -= dt;
      if (bot.reloading <= 0) bot.ammo = weapon.magazine;
      return;
    }
    if (bot.state === "heal" || bot.state === "build") return;
    if (!bot.visible || bot.reaction > 0) return;
    if (!bot.target && !bot.targetIsPlayer) return;

    const dist = bot.pos.distanceTo(bot.targetPos);
    if (dist > weapon.range) return;
    if (bot.ammo <= 0) {
      bot.reloading = weapon.reloadTime;
      return;
    }

    if (bot.burstLeft <= 0) {
      if (bot.fireTimer > 0) return;
      bot.burstLeft = weapon.burst;
    }
    if (bot.fireTimer > 0) return;

    if (fireShot(bot, dist)) {
      bot.burstLeft--;
      bot.ammo--;
      bot.fireKick = 1;
      bot.fireTimer = bot.burstLeft > 0
        ? weapon.fireInterval
        : weapon.burstPause * lerp(1.5, 0.75, bot.skill) * (0.8 + rng() * 0.4);
    } else {
      // Blocked by our own cover — peek instead of emptying a mag into a wall.
      bot.fireTimer = 0.2;
      bot.strafeTimer = 0;
      bot.burstLeft = 0;
    }
  }

  /**
   * One trigger pull.
   *
   * The miss model is the part that matters. A bot does NOT roll a hit
   * probability — it fires a real ray down a cone whose width comes from skill,
   * target speed and its own movement, and then that ray is tested against the
   * world and the target exactly as the player's would be. Two consequences,
   * both worth the extra work: cover genuinely protects you, and the tracers
   * that miss go somewhere believable instead of nowhere.
   */
  function fireShot(bot: Bot, dist: number): boolean {
    const collision = services.collision;
    const vfx = services.vfx;
    const weapon = bot.weapon;

    botEye(bot, _shotEye);

    // Lead the shot. Bots under-lead at low skill, which is the single most
    // legible way for a player to feel they are outplaying one by strafing.
    const leadTime = weapon.lead * lerp(0.35, 1.15, bot.skill);
    _b.copy(bot.targetPos);
    _b.y += BOT_CHEST;
    _b.addScaledVector(bot.targetVel, leadTime);

    _shotDir.copy(_b).sub(_shotEye);
    const aimDist = _shotDir.length();
    if (aimDist < 1e-3) return false;
    _shotDir.multiplyScalar(1 / aimDist);

    bot.aimYaw = yawTo(_shotDir.x, _shotDir.z);
    bot.aimPitch = Math.asin(clamp(_shotDir.y, -1, 1));

    // Cone. Skill halves it; the target's speed and our own widen it.
    const targetSpeed = Math.hypot(bot.targetVel.x, bot.targetVel.z);
    const ownSpeed = Math.hypot(bot.vel.x, bot.vel.z);
    let spread = weapon.spreadDeg * DEG * lerp(1.35, 0.45, bot.skill);
    spread *= 1 + clamp01(targetSpeed / 10) * 0.75;
    spread *= 1 + clamp01(ownSpeed / 9) * 0.6;
    if (bot.crouch) spread *= 0.72;
    // Long shots are harder, and the falloff is quadratic so a sniper at 200 m
    // is threatening without being an instant death sentence.
    spread *= 1 + Math.pow(clamp01(dist / weapon.range), 2) * 0.8;

    const perpX = -_shotDir.z;
    const perpZ = _shotDir.x;
    const perpLen = Math.hypot(perpX, perpZ) || 1;

    let blockedByOwnCover = false;

    for (let pellet = 0; pellet < weapon.pellets; pellet++) {
      // Gaussian-ish: the sum of two uniforms concentrates shots near the
      // centre, which is what a real cone looks like. A flat disc makes every
      // bot feel like it is spraying.
      const ang = rng() * TAU;
      const mag = (rng() + rng()) * 0.5 * spread;
      const ox = Math.cos(ang) * mag;
      const oy = Math.sin(ang) * mag;
      _e.copy(_shotDir);
      _e.x += (perpX / perpLen) * ox;
      _e.z += (perpZ / perpLen) * ox;
      _e.y += oy;
      _e.normalize();

      let world: RayHit | null = null;
      if (collision) {
        try {
          world = collision.raycast(_shotEye, _e, weapon.range);
        } catch {
          world = null;
        }
      }

      // Our own wall in the way: hold fire and reposition.
      if (world && world.tag === "dz:bot-wall" && world.distance < BOT_WALL_DISTANCE + 1.6) {
        blockedByOwnCover = true;
        break;
      }

      const limit = world ? world.distance : weapon.range;
      const capsule = rayCapsule(
        _shotEye, _e, bot.targetPos, BOT_RADIUS + 0.06, BOT_HEIGHT, weapon.range,
      );
      const hitTarget = capsule >= 0 && capsule <= limit + 0.01;

      _f.copy(_shotEye).addScaledVector(_e, hitTarget ? capsule : limit);

      if (hitTarget) {
        applyShotDamage(bot, _f);
      } else if (world) {
        // A bot's round that hits a bot's wall damages it. The player's rounds
        // route through combat, which does not know about these walls — see the
        // contract note at the foot of the file.
        if (world.tag === "dz:bot-wall") damageWallByHit(world, weapon.damage * 1.4);
        if (pellet === 0) vfx?.impact(world.point, world.normal, world.material);
      }

      if (pellet === 0 || rng() < 0.4) {
        // Tracer from the muzzle, not the eye — a tracer that starts at head
        // height and ends at the wall behind you is the classic AI tell.
        _b.set(
          bot.pos.x - Math.sin(bot.yaw) * 0.55,
          bot.pos.y + BOT_CHEST + 0.06,
          bot.pos.z - Math.cos(bot.yaw) * 0.55,
        );
        vfx?.tracer(_b, _f, { width: weapon.id === "sniper" ? 0.05 : 0.03 });
      }
    }

    if (blockedByOwnCover) return false;

    // Muzzle flash at the barrel, oriented down the shot.
    if (vfx) {
      _b.set(
        bot.pos.x - Math.sin(bot.yaw) * 0.62,
        bot.pos.y + BOT_CHEST + 0.06,
        bot.pos.z - Math.cos(bot.yaw) * 0.62,
      );
      _eul.set(bot.aimPitch, bot.aimYaw, 0);
      _q.setFromEuler(_eul);
      _m.compose(_b, _q, _scale);
      vfx.muzzleFlash(_m, weapon.id === "sniper" ? 1.5 : 1);
    }
    services.audio?.play(weapon.sound, {
      position: bot.pos,
      volume: weapon.id === "sniper" ? 0.9 : 0.6,
      rate: 0.94 + rng() * 0.12,
      maxDistance: weapon.id === "sniper" ? 900 : 420,
    });
    return true;
  }

  /** Route a landed shot into whatever it hit. */
  function applyShotDamage(bot: Bot, point: THREE.Vector3): void {
    const weapon = bot.weapon;
    const source: DamageSource = { by: bot.id, name: bot.name, weapon: weapon.id };
    // Headshots are rolled, not geometric: a per-pellet head capsule test would
    // let a low-skill bot land one by accident far too often.
    const headshot = rng() < 0.1 + bot.skill * 0.14;
    const amount = weapon.damage * (headshot ? 1.9 : 1);

    if (bot.targetIsPlayer) {
      const player = services.player;
      if (!player) return;
      player.damage(amount, bot.pos, source);
      return;
    }

    const victim = bot.target;
    if (!victim || !victim.alive) return;
    const combat = services.combat;
    if (combat) {
      _damageHit.point.copy(point);
      _damageHit.normal.copy(bot.pos).sub(point).normalize();
      _damageHit.distance = bot.pos.distanceTo(point);
      _damageHit.material = "flesh";
      _damageHit.target = victim;
      _damageHit.object = victim.object;
      _damageHit.piece = undefined;
      _damageHit.tag = "actor";
      try {
        combat.applyHit(_damageHit, amount, source);
        return;
      } catch {
        /* fall through to the direct path */
      }
    }
    victim.onDamage(amount, point, source, headshot);
  }

  /* ----------------------------------------------------------------- walls */

  const wallById = new Map<number, BotWall>();

  function makeWallSlot(): BotWall {
    const box = new THREE.Box3();
    const wall: BotWall = {
      active: false,
      center: new THREE.Vector3(),
      yaw: 0,
      hp: BOT_WALL_HP,
      maxHp: BOT_WALL_HP,
      life: 0,
      build: 0,
      box,
      remove: null,
      ownerId: "",
      owner: {
        id: 0,
        kind: "wall",
        material: "wood",
        cell: new THREE.Vector3(),
        rotation: 0,
        get hp(): number {
          // Never reports zero. A system that reads this as "dead" and files an
          // elimination would put a wall in the kill feed.
          return Math.max(1, wall.hp);
        },
        set hp(v: number) {
          const dealt = Math.max(1, wall.hp) - v;
          if (dealt > 0) damageWall(wall, dealt);
        },
        maxHp: BOT_WALL_HP,
        complete: true,
        owner: "",
        box,
        // Shaped like building.ts's internal Loc so its `locKey()` is safe to
        // call on this object. It will never match a real piece, so
        // `damagePiece` becomes a no-op instead of a crash.
        loc: { kind: "wall", a: 0, b: 0, c: 0, rot: 0 },
      },
    };
    return wall;
  }

  for (let i = 0; i < tier.wallBudget; i++) walls.push(makeWallSlot());

  function damageWall(wall: BotWall, amount: number): void {
    if (!wall.active || !(amount > 0)) return;
    wall.hp -= amount;
    if (wall.hp <= 0) destroyWall(wall);
  }

  function damageWallByHit(hit: RayHit, amount: number): void {
    const piece = hit.piece as unknown as BuildPieceLike | undefined;
    if (!piece) return;
    const wall = wallById.get(piece.id);
    if (wall) damageWall(wall, amount);
  }

  function destroyWall(wall: BotWall): void {
    if (!wall.active) return;
    wall.active = false;
    wall.remove?.();
    wall.remove = null;
    wallById.delete(wall.owner.id);
    services.vfx?.buildBreak(wall.box, "wood");
    services.audio?.play("build-break", { position: wall.center, volume: 0.5, maxDistance: 120 });
  }

  /**
   * Throw a wall between this rival and whatever is shooting at it.
   *
   * Snapped to the same 4 m grid the player builds on, because a bot wall that
   * does not line up with the player's is immediately, unaccountably wrong.
   */
  function placeWall(bot: Bot): boolean {
    const collision = services.collision;
    if (!collision) return false;

    _d.copy(bot.threatTime > 0 ? bot.threatDir : _a.copy(bot.targetPos).sub(bot.pos)).setY(0);
    if (_d.lengthSq() < 1e-6) return false;
    _d.normalize();

    // Face the wall along whichever cardinal is closest, exactly like a snapped
    // player build.
    const quarter = Math.round(yawTo(_d.x, _d.z) / (Math.PI * 0.5));
    const yaw = quarter * Math.PI * 0.5;
    const alongX = (quarter & 1) === 1;

    let cx = bot.pos.x + _d.x * BOT_WALL_DISTANCE;
    let cz = bot.pos.z + _d.z * BOT_WALL_DISTANCE;
    // Snap the spanning axis to a cell centre and the thin axis to a cell edge.
    if (alongX) {
      cx = Math.round(cx / GRID) * GRID;
      cz = Math.round(cz / GRID - 0.5) * GRID + GRID * 0.5;
    } else {
      cz = Math.round(cz / GRID) * GRID;
      cx = Math.round(cx / GRID - 0.5) * GRID + GRID * 0.5;
    }

    const baseY = terrainY(cx, cz);
    // Refuse a wall that would land in the sea or halfway up a cliff face.
    if (Math.abs(baseY - bot.groundY) > 2.4) return false;
    if (services.terrain?.isWater(cx, cz)) return false;

    const halfSpan = GRID * 0.5;
    const halfThick = 0.18;
    _box.min.set(
      cx - (alongX ? halfThick : halfSpan),
      baseY,
      cz - (alongX ? halfSpan : halfThick),
    );
    _box.max.set(
      cx + (alongX ? halfThick : halfSpan),
      baseY + GRID,
      cz + (alongX ? halfSpan : halfThick),
    );

    // Recycle the oldest slot when the budget is full — a build fight that
    // silently stops producing walls looks like the AI gave up.
    let slot = walls.find((w) => !w.active);
    if (!slot) {
      slot = walls[0];
      for (const w of walls) if (w.life > slot.life) slot = w;
      destroyWall(slot);
    }

    slot.active = true;
    slot.center.set(cx, baseY, cz);
    slot.yaw = yaw;
    slot.hp = BOT_WALL_HP;
    slot.maxHp = BOT_WALL_HP;
    slot.life = 0;
    slot.build = 0;
    slot.box.copy(_box);
    slot.ownerId = bot.id;
    slot.owner.id = nextWallId++;
    slot.owner.owner = bot.id;
    slot.owner.rotation = quarter & 3;
    slot.owner.cell.set(Math.round(cx / GRID), Math.round(baseY / GRID), Math.round(cz / GRID));
    slot.owner.loc.a = slot.owner.cell.x;
    slot.owner.loc.b = slot.owner.cell.y;
    slot.owner.loc.c = slot.owner.cell.z;
    slot.owner.loc.rot = quarter & 3;
    wallById.set(slot.owner.id, slot);

    try {
      slot.remove = collision.addBox(slot.box, {
        material: "wood",
        harvest: "wood",
        built: true,
        tag: "dz:bot-wall",
        owner: slot.owner,
      });
    } catch {
      slot.remove = null;
    }

    bot.wallCooldown = BOT_WALL_COOLDOWN * lerp(1.6, 0.8, bot.skill);
    services.audio?.play("build-place", { position: slot.center, volume: 0.45, maxDistance: 140 });
    return true;
  }

  function updateWalls(dt: number): void {
    let n = 0;
    for (const w of walls) {
      if (!w.active) continue;
      w.life += dt;
      // 0.38 s rise, matching the player's build-up. Any slower and cover
      // arrives after the burst it was meant to stop.
      w.build = clamp01(w.build + dt / 0.38);
      if (w.life > BOT_WALL_LIFE) {
        destroyWall(w);
        continue;
      }
      _eul.set(0, w.yaw, 0);
      _q.setFromEuler(_eul);
      const h = GRID * 0.5 * w.build;
      _a.set(w.center.x, w.center.y + h, w.center.z);
      _b.set(1, w.build, 1);
      _m.compose(_a, _q, _b);
      wallMesh.setMatrixAt(n, _m);
      n++;
    }
    wallMesh.count = n;
    if (n > 0) wallMesh.instanceMatrix.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ storm */

  function stormStep(): void {
    const storm = services.storm;
    if (!storm || storm.dps <= 0) return;
    const source: DamageSource = { by: "storm", name: "the storm" };
    for (const bot of bots) {
      if (!bot.alive || bot.state === "bus" || bot.state === "dive" || bot.state === "glide") continue;
      if (storm.isSafe(bot.pos)) continue;
      applyBotDamage(bot, storm.dps * STORM_TICK, undefined, source, false);
      // Being in the storm overrides everything short of a fight in your face.
      if (bot.alive && bot.state !== "engage") {
        bot.state = "rotate";
        bot.thinkTimer = 0;
      }
    }
  }

  /* ------------------------------------------------------------- simulation */

  function simBot(bot: Bot, dt: number): void {
    bot.stateTime += dt;

    if (!bot.alive) {
      // The body keeps falling until it reaches the ground, then it stays.
      if (bot.deathT < 1) {
        bot.deathT = clamp01(bot.deathT + dt / 1.15);
        bot.vel.y += BOT_GRAVITY * dt;
        bot.pos.y += bot.vel.y * dt;
        const g = terrainY(bot.pos.x, bot.pos.z);
        if (bot.pos.y <= g) {
          bot.pos.y = g;
          bot.vel.y = 0;
        }
      }
      return;
    }

    bot.thinkTimer -= dt;
    if (bot.thinkTimer <= 0) {
      bot.thinkTimer = THINK_INTERVAL * (0.8 + rng() * 0.4);
      think(bot);
    }

    if (bot.state === "bus" || bot.state === "dive" || bot.state === "glide") {
      dropStep(bot, dt);
    } else {
      groundStep(bot, dt);
      combatStep(bot, dt);
      if (bot.state === "heal") {
        bot.healTimer -= dt;
        if (bot.healTimer <= 0) {
          bot.shield = Math.min(BOT_SHIELD_MAX, bot.shield + HEAL_AMOUNT);
          bot.damage.shield = bot.shield;
          bot.info.shield = bot.shield;
          bot.state = "loot";
          bot.thinkTimer = 0;
        }
      }
    }

    // Mirror the fields the rest of the world reads. `object` carries the
    // capsule base, which is what combat's hit registration measures from.
    bot.info.state = bot.state;
    bot.damage.object.position.copy(bot.pos);
    bot.damage.object.updateMatrix();
    bot.damage.object.matrixWorld.copy(bot.damage.object.matrix);
  }

  /* ------------------------------------------------------------- animation */

  const poseBuf = makePose();
  const poseTmp = makePose();

  function animateRig(slot: RigSlot, bot: Bot, dt: number): void {
    bot.animTime += dt;

    const speed = Math.hypot(bot.vel.x, bot.vel.z);
    const airborne = !bot.grounded && bot.state !== "bus";
    const dropping = bot.state === "dive" || bot.state === "glide" || bot.state === "bus";

    // Stride length scales with speed, so the feet never slide.
    const strideLength = lerp(1.55, 2.35, clamp01((speed - BOT_WALK) / (BOT_RUN - BOT_WALK)));
    if (bot.grounded && speed > 0.35) bot.gaitPhase += (speed / strideLength) * TAU * dt;
    bot.runBlend = approach(bot.runBlend, clamp01((speed - BOT_WALK * 0.6) / (BOT_RUN - BOT_WALK * 0.6)), 6, dt);

    const wantAim = bot.state === "engage" && (bot.target !== null || bot.targetIsPlayer) && bot.visible;
    bot.aimBlend = approach(bot.aimBlend, wantAim ? 1 : 0, 7, dt);
    bot.crouchBlend = approach(bot.crouchBlend, bot.crouch && bot.alive ? 1 : 0, 9, dt);
    bot.fireKick = approach(bot.fireKick, 0, 13, dt);
    bot.hitKick = approach(bot.hitKick, 0, 5.5, dt);
    if (bot.state === "build") bot.buildT = clamp01(bot.buildT + dt / 0.55);

    poseReset(poseBuf);

    if (!bot.alive) {
      poseDeath(poseBuf, bot.deathT);
    } else if (bot.state === "bus" || bot.state === "dive") {
      poseDive(poseTmp, bot.animTime);
      poseAdd(poseBuf, poseTmp, 1);
    } else if (bot.state === "glide") {
      poseGlide(poseTmp, bot.animTime);
      poseAdd(poseBuf, poseTmp, 1);
    } else if (airborne) {
      poseAir(poseTmp, bot.vel.y);
      poseAdd(poseBuf, poseTmp, 1);
    } else if (bot.state === "heal") {
      poseIdle(poseTmp, bot.animTime);
      poseAdd(poseBuf, poseTmp, 1);
      poseHeal(poseTmp, 1 - clamp01(bot.healTimer / HEAL_TIME));
      poseAdd(poseBuf, poseTmp, 1);
    } else {
      // Crouch cross-fades against stand rather than switching, because the
      // root drop that goes with it is continuous — a hard swap would pop the
      // whole body 26 cm in one frame.
      const cb = bot.crouchBlend;
      if (cb > 0.001) {
        poseCrouch(poseTmp, bot.gaitPhase, clamp01(speed / BOT_CROUCH_SPEED));
        poseAdd(poseBuf, poseTmp, cb);
      }
      if (cb < 0.999) {
        const moveW = clamp01(speed / (BOT_WALK * 0.6));
        if (moveW < 1) {
          poseIdle(poseTmp, bot.animTime);
          poseAdd(poseBuf, poseTmp, (1 - moveW) * (1 - cb));
        }
        if (moveW > 0) {
          poseLocomotion(poseTmp, bot.gaitPhase, bot.runBlend);
          poseAdd(poseBuf, poseTmp, moveW * (1 - cb));
        }
      }
    }

    if (bot.alive) {
      if (bot.aimBlend > 0.001 && !dropping) {
        poseAim(poseTmp, clamp(bot.aimPitch, -0.9, 0.9));
        poseAdd(poseBuf, poseTmp, bot.aimBlend);
      }
      if (bot.fireKick > 0.001) {
        poseFire(poseTmp, bot.fireKick);
        poseAdd(poseBuf, poseTmp, 1);
      }
      if (bot.state === "build" && bot.buildT < 1) {
        poseBuild(poseTmp, bot.buildT);
        poseAdd(poseBuf, poseTmp, 1);
      }
      if (bot.hitKick > 0.001) {
        poseHit(poseTmp, bot.hitKick, bot.hitDir, bot.hitSide);
        poseAdd(poseBuf, poseTmp, 1);
      }
    }

    const bones = slot.bones;
    for (let j = 0; j < JOINT_COUNT; j++) {
      const o = j * 3;
      bones[j].rotation.set(poseBuf[o], poseBuf[o + 1], poseBuf[o + 2]);
    }

    // Root transform. The vertical bob is at twice the stride rate, which is
    // what a real gait does — one rise per footfall, not per cycle.
    let y = bot.visPos.y;
    if (bot.alive && bot.grounded && speed > 0.4) {
      y += Math.abs(Math.sin(bot.gaitPhase)) * 0.035 * (0.5 + bot.runBlend);
    }
    y -= bot.crouchBlend * CROUCH_RIG_DROP;

    let pitch = 0;
    let roll = 0;
    if (!bot.alive) {
      // Topple in the direction the last round pushed: shot in the chest and
      // they go over backwards, shot in the back and they fall on their face.
      // It settles a hair into the ground so no limb ends up floating.
      const k = smoothstep(bot.deathT);
      pitch = k * 1.5 * (bot.hitDir >= 0 ? 1 : -1);
      roll = k * 0.35 * Math.sign(bot.hitSide || 1);
      y -= k * 0.06;
    } else if (bot.state === "dive") {
      pitch = -1.15;
    } else if (bot.state === "glide") {
      pitch = 0.12;
    } else {
      // Lean into acceleration — a body that runs bolt upright reads as a
      // marionette on rails.
      pitch = clamp(speed / BOT_RUN, 0, 1) * 0.1;
      roll = clamp(-bot.strafe * (bot.state === "engage" ? 0.06 : 0), -0.1, 0.1);
    }

    _a.set(bot.visPos.x, y, bot.visPos.z);
    _eul.set(pitch, bot.visYaw, roll);
    _q.setFromEuler(_eul);
    slot.group.matrix.compose(_a, _q, _scale);
    slot.group.matrixWorldNeedsUpdate = true;
  }

  /* --------------------------------------------------------------- LOD/draw */

  function applyTints(slot: RigSlot, bot: Bot): void {
    for (let i = 0; i < slot.tints.length; i++) {
      const surface = rigHi.surfaces[i];
      const trip =
        surface === "cloth" ? bot.tintCloth
          : surface === "gear" ? bot.tintGear
            : surface === "skin" ? bot.tintSkin
              : bot.tintMetal;
      slot.tints[i].a.copy(trip[0]);
      slot.tints[i].b.copy(trip[1]);
      slot.tints[i].c.copy(trip[2]);
    }
  }

  const rigCandidates: Bot[] = [];
  const plateCandidates: Bot[] = [];
  /**
   * The camera position, in its own vector rather than the shared scratch.
   * `animateRig` writes `_a` when it composes a rig's root matrix, so borrowing
   * `_a` for the camera here would corrupt every distance test after the first
   * rig is posed — and the symptom would be "LOD flickers, but only when
   * someone is nearby", which is a miserable thing to chase.
   */
  const _cam = new THREE.Vector3();

  function updateVisuals(dt: number): void {
    ctx.camera.getWorldPosition(_cam);

    // ---- smooth the render transform --------------------------------------
    // The simulation runs at a stride; the render must not. Exponential
    // smoothing here is what hides a bot that only moved once in eight steps.
    for (const bot of bots) {
      const rate = bot.stride === 1 ? 26 : bot.stride === 3 ? 14 : 7;
      bot.visPos.x = approach(bot.visPos.x, bot.pos.x, rate, dt);
      bot.visPos.y = approach(bot.visPos.y, bot.pos.y, rate, dt);
      bot.visPos.z = approach(bot.visPos.z, bot.pos.z, rate, dt);
      bot.visYaw = turnToward(bot.visYaw, bot.yaw, (bot.stride === 1 ? 12 : 6) * dt);
    }

    // ---- choose who gets a rig --------------------------------------------
    rigCandidates.length = 0;
    for (const bot of bots) {
      if (!bot.alive && bot.deathT >= 1 && bot.stateTime > 6) continue;
      const d = _cam.distanceTo(bot.visPos);
      // Stride is the simulation LOD and rides on the same distance.
      bot.stride = d < 110 ? 1 : d < 260 ? 3 : 8;
      if (bot.state === "bus") bot.stride = 8;
      if (d < tier.l1Distance) rigCandidates.push(bot);
    }
    rigCandidates.sort(
      (x, y) => _cam.distanceToSquared(x.visPos) - _cam.distanceToSquared(y.visPos),
    );
    if (rigCandidates.length > tier.rigSlots) rigCandidates.length = tier.rigSlots;

    for (const slot of rigSlots) {
      if (slot.bot && rigCandidates.indexOf(slot.bot) < 0) {
        slot.bot.rigSlot = -1;
        slot.bot = null;
        slot.group.visible = false;
      }
    }
    for (const bot of rigCandidates) {
      if (bot.rigSlot >= 0) continue;
      const free = rigSlots.findIndex((s) => s.bot === null);
      if (free < 0) break;
      const slot = rigSlots[free];
      slot.bot = bot;
      bot.rigSlot = free;
      slot.group.visible = true;
      applyTints(slot, bot);
      // A newly-assigned rig starts exactly where the bot is, or it visibly
      // slides in from wherever the previous occupant died.
      bot.visPos.copy(bot.pos);
      bot.visYaw = bot.yaw;
    }

    for (const slot of rigSlots) {
      const bot = slot.bot;
      if (!bot) continue;
      const d = _cam.distanceTo(bot.visPos);
      const wantLod: 0 | 1 = d < tier.l0Distance ? 0 : 1;
      if (lodMatched && wantLod !== slot.lod) {
        slot.lod = wantLod;
        slot.mesh.geometry = wantLod === 0 ? rigHi.geometry : rigLo.geometry;
        slot.mesh.castShadow = tier.shadows && wantLod === 0;
      }
      animateRig(slot, bot, dt);
    }

    // ---- everyone else becomes an instance --------------------------------
    let n = 0;
    for (const bot of bots) {
      if (bot.rigSlot >= 0) continue;
      if (!bot.alive && bot.deathT >= 1 && bot.stateTime > 6) continue;
      if (bot.state === "bus") continue;
      const speed = Math.hypot(bot.vel.x, bot.vel.z);
      // The proxy has no skeleton, so the only life it gets is a bob and a
      // lean — which at 250 m is genuinely all you can see anyway.
      const bob = bot.alive && bot.grounded && speed > 0.5
        ? Math.abs(Math.sin(bot.animTime * speed * 1.7)) * 0.05
        : 0;
      _b.set(bot.visPos.x, bot.visPos.y + bob, bot.visPos.z);
      const pitch = !bot.alive ? 1.5 : bot.state === "dive" ? -1.15 : bot.state === "glide" ? 0.12 : 0;
      _eul.set(pitch, bot.visYaw, 0);
      _q.setFromEuler(_eul);
      _m.compose(_b, _q, _scale);
      proxyMesh.setMatrixAt(n, _m);
      proxyMesh.setColorAt(n, bot.proxyColor);
      n++;
    }
    proxyMesh.count = n;
    if (n > 0) {
      proxyMesh.instanceMatrix.needsUpdate = true;
      if (proxyMesh.instanceColor) proxyMesh.instanceColor.needsUpdate = true;
    }

    // ---- nameplates --------------------------------------------------------
    plateCandidates.length = 0;
    for (const bot of bots) {
      if (!bot.alive || bot.state === "bus" || bot.state === "dive") continue;
      const d = _cam.distanceTo(bot.visPos);
      // 78 m: a little past the far side of the biggest POI, which is as far as
      // a plate is legible before the text is one pixel tall.
      const want = d < 78 && bot.plateRow < nameAtlas.rows ? clamp01((78 - d) / 14) : 0;
      bot.plateFade = approach(bot.plateFade, want, 8, dt);
      if (bot.plateFade > 0.01) plateCandidates.push(bot);
    }
    plateCandidates.sort(
      (x, y) => _cam.distanceToSquared(x.visPos) - _cam.distanceToSquared(y.visPos),
    );
    const plateCount = Math.min(plateCandidates.length, tier.plates);
    for (let i = 0; i < plateCount; i++) {
      const bot = plateCandidates[i];
      const o3 = i * 3;
      const o4 = i * 4;
      plateOffsets.array[o3] = bot.visPos.x;
      plateOffsets.array[o3 + 1] = bot.visPos.y + bot.height + 0.42;
      plateOffsets.array[o3 + 2] = bot.visPos.z;
      plateData.array[o4] = bot.plateRow;
      plateData.array[o4 + 1] = clamp01(bot.hp / BOT_HP);
      plateData.array[o4 + 2] = clamp01(bot.shield / BOT_SHIELD_MAX);
      plateData.array[o4 + 3] = bot.markedByPlayer ? 1 : 0;
      plateFades.array[i] = bot.plateFade;
    }
    plateGeometry.instanceCount = plateCount;
    plateMesh.visible = plateCount > 0;
    if (plateCount > 0) {
      plateOffsets.needsUpdate = true;
      plateData.needsUpdate = true;
      plateFades.needsUpdate = true;
    }
  }

  /* ---------------------------------------------------------------- phantoms */

  function updatePhantoms(): void {
    for (const p of phantoms) {
      if (p.dead || p.at > dropClock) continue;
      // Credit a living simulated rival where we can, so the feed reads like a
      // match rather than like a script.
      let killer = "";
      const alive = bots.filter((b) => b.alive);
      if (alive.length > 0 && rng() < 0.72) killer = alive[Math.floor(rng() * alive.length)].name;
      p.killer = killer;
      killPhantom(p);
      // One per tick keeps the feed from dumping six entries in one frame.
      break;
    }
  }

  /* ------------------------------------------------------------------ hooks */

  let registered = false;

  const sys: FixedSystem = {
    name: "bots",

    fixed(dt) {
      if (disposed) return;
      stepCount++;

      const match = services.match;
      if (!started) {
        const phase = match?.phase;
        if (phase === "bus" || phase === "dropping" || phase === "live") started = true;
        else if (!match && ctx.elapsed > 2.5) started = true;
      }
      if (started) dropClock += dt;

      for (const bot of bots) {
        if (bot.stride > 1 && ((stepCount + bot.stridePhase) % bot.stride) !== 0) continue;
        simBot(bot, dt * (bot.stride > 1 ? bot.stride : 1));
      }

      stormTick += dt;
      if (stormTick >= STORM_TICK) {
        stormTick -= STORM_TICK;
        stormStep();
        if (started) updatePhantoms();
      }
    },

    update(dt) {
      if (disposed) return;
      if (!registered && services.combat) {
        registerAll();
        registered = true;
      }
      // Walls are cosmetic-plus-lifetime, not physics: the collider is placed
      // and removed by gameplay code, and re-uploading forty instance matrices
      // at 120 Hz to animate a 0.38 s rise would be pure waste.
      updateWalls(dt);
      updateVisuals(dt);
      // Reset for the next frame's fixed steps, which run before this again.
      losBudget = LOS_BUDGET;
    },

    dispose() {
      disposed = true;
      for (const bot of bots) {
        bot.unregister?.();
        bot.unregister = null;
      }
      for (const w of walls) {
        w.remove?.();
        w.remove = null;
        w.active = false;
      }
      wallById.clear();

      root.removeFromParent();

      for (const slot of rigSlots) {
        slot.skeleton.dispose();
        // Textures belong to the shared per-surface set, disposed once below.
        for (const t of slot.tints) t.material.dispose();
      }
      rigHi.geometry.dispose();
      rigLo.geometry.dispose();
      for (const id of SURFACE_IDS) {
        const maps = surfaceMaps[id];
        if (!maps) continue;
        maps.map.dispose();
        maps.normalMap.dispose();
        maps.roughnessMap.dispose();
      }

      proxyGeometry.dispose();
      proxyMaterial.dispose();
      proxyMesh.dispose();
      wallGeometry.dispose();
      wallMaterial.dispose();
      wallMesh.dispose();
      plateGeometry.dispose();
      plateMaterial.dispose();
      nameAtlas.texture.dispose();

      bots.length = 0;
      infos.length = 0;
      phantoms.length = 0;
      walls.length = 0;
      if (services.bots === service) services.bots = undefined;
    },
  };

  registerAll();
  registered = !!services.combat;

  return sys;
};

/* ------------------------------------------------------------------------ *
 * Contract notes
 * ------------------------------------------------------------------------ *
 *
 * Three places where `types.ts` does not have a seat for what this system
 * needs. Nothing here edits the shared contract — these are the local
 * work-arounds, written down so the next person does not have to rediscover
 * why they exist.
 *
 * 1. **`WorldServices` has no `bots` field.** The service is published through
 *    `ctx.services as BotServices`, a locally-widened view. Consumers can reach
 *    it the same way, or import `BotsService` from here for the type. Adding
 *    `bots?: BotsService` to `WorldServices` would make this unnecessary.
 *
 * 2. **`BuildService` has no third-party placement.** `place()` places at the
 *    *player's* preview transform, so there is no way for a bot to ask the
 *    build system for a wall at a given cell. Bot walls are therefore owned
 *    here: their own instanced mesh, their own collider, their own HP. They
 *    register with `harvest: "wood"`, `built: true` and `tag: "dz:bot-wall"`,
 *    and their collider `owner` is shaped like a `BuildPiece` (including a
 *    `loc` that keeps `building.ts`'s `damagePiece` from dereferencing
 *    undefined, and an `hp` accessor so a system that decrements the field
 *    directly still destroys the wall). Bot rounds damage them through
 *    `damageWallByHit`; whether the *player's* rounds do depends on how
 *    `combat.applyHit` chooses to treat `RayHit.piece`. A
 *    `BuildService.placeAt(cell, kind, rot, material, owner)` would remove all
 *    of this.
 *
 * 3. **`LootService` exposes no chest positions.** `nearest(point, range)` is
 *    the only spatial query, so a looting rival walks to whatever pickup is
 *    within 55 m and otherwise wanders its POI. A `chests` list, or a
 *    `nearestContainer()`, would let bots path between chests properly instead
 *    of approximating it.
 *
 * One deliberate deviation from the brief, for the record: outfit variation is
 * NOT routed through `materials.tinted()`. That returns cached *world*
 * materials whose UV scale, roughness and normal strength are authored for
 * buildings, and it has no way to express the three-zone tint a character
 * needs. Rivals get their own four baked surfaces and a per-slot material with
 * three tint uniforms driven by an `azone` vertex attribute — which is what
 * lets forty rivals share one geometry and still be forty different people.
 */

export default createBots;
