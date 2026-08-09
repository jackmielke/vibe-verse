/**
 * DROP ZERO — the player.
 *
 * One module owns four things that are usually split up, because in a battle
 * royale they are the same thing:
 *
 *  1. **The capsule.** A 0.4 m × 1.85 m capsule pushed through
 *     `CollisionService.resolveCapsule` at a hard 120 Hz, with the terrain
 *     heightfield as the floor of last resort. Fortnite's ground feel is
 *     brisk-but-heavy: high acceleration, short deceleration, a jump that
 *     rises slowly and falls fast.
 *  2. **The drop.** bus → skydive → glide → ground. This is the first ninety
 *     seconds of every match and it is the mode's signature, so it gets real
 *     physics, a real glider mesh and the FOV kick that sells the speed.
 *  3. **The camera.** Third person by default — a spring arm over the right
 *     shoulder with raycast collision, because that is what the genre is and
 *     because the build loop is unreadable from inside your own head.
 *  4. **The body.** A stylised humanoid authored from primitives and animated
 *     procedurally. No clips, no skinning: segmented limbs on a real joint
 *     hierarchy with ball joints at the seams, which is both cheaper and a
 *     better match for the chunky toy-figure read the art direction asks for.
 *
 * Publishes `PlayerService`.
 *
 * ## Why the body is vertex-coloured
 *
 * Every cloth part in the character shares ONE material. The jacket navy, the
 * trouser charcoal, the orange scarf, the ambient occlusion in the armpits and
 * the paler wear along every chamfered edge are all baked into the `color`
 * attribute and multiplied against a single tileable weave. That collapses a
 * twenty-material character into four, keeps the whole player under ~24 draw
 * calls, and — more importantly — it is the only cheap way to get *wear at
 * contact points*, which is one of the six tells that separate a real game
 * from a Three.js demo. Sole edges, knee pads, elbow chamfers and the top of
 * the backpack are all lighter than the surface around them; the crotch, the
 * armpits, the inside of the collar and the underside of every part are
 * darker. Uniform albedo is what plastic looks like.
 *
 * ## SOAKED (`ctx.mode === "water"`)
 *
 * The same capsule, the same drop, the same camera — one seam. In water mode
 * this module additionally owns:
 *
 *  - **Dryness instead of health.** `service.health` *is* dryness and
 *    `service.shield` *is* the poncho; incoming damage is routed through
 *    `applySoak` from `mode/water.ts` instead of the flat shield-then-health
 *    subtraction. Doing it this way rather than adding a parallel pair of
 *    numbers is what lets the storm, combat, the bots and the HUD keep calling
 *    exactly what they called before and still mean the right thing.
 *  - **Drying.** `dryStep` every fixed step, gated on the same conditions the
 *    table describes: no drying in the Downpour, in the sea or in a puddle;
 *    faster sprinting (wind) and faster under a roof.
 *  - **Slipping.** Ground friction is multiplied by
 *    `wetness.frictionAt(x, z)`, so sprinting onto a puddle slides you.
 *  - **Glue.** Strand coupling, the two-body pull, the slow, and the stumble.
 *  - **The wire.** `net.publishPose` every frame, and a wet footprint trail.
 *
 * Nobody is hurt here and nothing dies. At zero dryness you slump, squelch and
 * are out — which is why the beat is called SOAKED and not "eliminated".
 */
import * as THREE from "three";
import type {
  DamageSource,
  DamageTarget,
  ImpactMaterial,
  PlayerService,
  PlayerState,
  System,
  SystemFactory,
  WorldCtx,
} from "../types";
import {
  DOWNPOUR,
  DRYNESS,
  GLUE,
  WATER,
  applySoak,
  downpourSoak,
  drynessBand,
  dryStep,
  glueAccel,
  glueSlow,
  stumbleChance,
  struggleStep,
  type DrynessBand,
  type GlueAnchorKind,
  type GlueBreakReason,
} from "../mode/water";
// Type-only, but it is also what pulls `net` onto `WorldServices` — the
// augmentation lives beside the transport rather than in the shared contract,
// because the shared contract predates multiplayer and ships without it.
import type { NetService } from "../net/types";
/* Type-only. Drop Zero's match service carries the bus route sampler the
   camera needs; the shared `MatchService` on `ctx.services` does not. */
import type { DropZeroMatchService } from "./match";

// ---------------------------------------------------------------- tuning

/** Capsule radius. Matches the value bots and hit registration assume. */
const RADIUS = 0.4;
/** Standing capsule height. Eye sits a little below the top of it. */
const STAND_HEIGHT = 1.85;
/** Crouched capsule. Low enough to clear a 1.4 m gap under a built ramp. */
const CROUCH_HEIGHT = 1.25;

const STAND_EYE = 1.62;
const CROUCH_EYE = 1.02;

/**
 * Ground speeds, m/s. Fortnite's walk is deceptively quick — roughly 5.7 —
 * and the sprint is only ~1.7× it. A bigger multiplier makes walking feel
 * like a punishment and everybody just holds shift forever.
 */
const WALK_SPEED = 5.9;
const SPRINT_SPEED = 9.6;
const CROUCH_SPEED = 3.1;
const SWIM_SPEED = 4.3;
/** Backpedalling is slower than advancing, which is what stops peek-strafing. */
const BACK_SCALE = 0.72;

/**
 * Acceleration is enormous and deceleration is short: you reach full speed in
 * about a tenth of a second and stop in a third of one. That asymmetry is the
 * "snappy" in snappy — symmetric damping reads as ice.
 */
const ACCEL_GROUND = 92;
const ACCEL_AIR = 22;
const FRICTION_STOP = 14;
/** Friction while still holding a direction — enough to turn, not to brake. */
const FRICTION_MOVE = 3.2;

/**
 * Asymmetric gravity. Rising at 22 and falling at 34 gives a jump that hangs
 * at the apex and then *commits*, which is the single cheapest way to make a
 * jump feel good. Real gravity feels floaty on the way down.
 */
const GRAVITY_UP = -22;
const GRAVITY_DOWN = -34;
/** Holding jump keeps the lighter gravity a little longer — variable height. */
const GRAVITY_RELEASE = -40;
const JUMP_SPEED = 7.4;
/** Terminal velocity on foot. Distinct from the skydive terminal below. */
const FALL_TERMINAL = -58;

/** Grace period after walking off a ledge where a jump still counts. */
const COYOTE_TIME = 0.11;
/** Jump pressed this long before landing still fires on touchdown. */
const JUMP_BUFFER = 0.16;

/** Ledges up to here are walked over rather than collided with. */
const STEP_HEIGHT = 0.5;
/** Steeper than this and you slide instead of standing. */
const MAX_SLOPE_COS = Math.cos(THREE.MathUtils.degToRad(48));
/** Downhill acceleration on a slope too steep to stand on. */
const SLIDE_ACCEL = 21;

/** Fall speed below which landing is free. Above it, damage ramps. */
const FALL_SAFE = -22;
const FALL_DAMAGE_PER_MS = 3.6;

// ---- SOAKED -------------------------------------------------------------
// Everything below is water-mode only. Numbers that describe the *rules* live
// in `mode/water.ts` and are imported; the numbers here describe how this
// particular body reacts to them, which is nobody else's business.

/**
 * How much of a puddle's friction loss also costs you acceleration.
 *
 * Friction alone gives you a long slide, but with full acceleration you can
 * still steer out of it instantly and it never reads as slipping. Halving the
 * *authority* as well is what turns a slide into a moment of comedy you have
 * to ride out — and 0.5 rather than 0 is what keeps it recoverable.
 */
const SLIP_ACCEL_SHARE = 0.5;
/** Sliding this fast on wet ground starts throwing spray and a skid sound. */
const SLIP_SPEED = 6.4;

/** Seconds between shelter probes. A raycast per fixed step is 120 Hz of waste. */
const SHELTER_PERIOD = 0.3;
/** How far up we look for a roof. A built floor overhead counts; the sky does not. */
const SHELTER_REACH = 7;

/** Wetness under the feet above which you count as standing in water. */
const PUDDLE_WET = 0.3;

/** Chest height on the capsule — where a glue strand attaches. */
const GLUE_CHEST_Y = 1.15;
/**
 * Fraction of the strand's pull that is allowed to act vertically.
 *
 * A full 3D pull toward someone standing above you yanks you off the ground
 * and the tether turns into a grappling hook, which is a different (and much
 * less funny) game. Mostly-horizontal keeps it a tug-of-war.
 */
const GLUE_VERTICAL_SHARE = 0.25;
/** Beyond this the far end has clearly gone — drop the strand rather than snap it. */
const GLUE_LOST_DIST = 90;

/** Initial tumble speed when you go down. Enough to sell it, not enough to launch. */
const STUMBLE_LAUNCH = 2.6;
const STUMBLE_POP = 2.2;
/** How fast the body spins while face-down, radians/second. */
const STUMBLE_SPIN = 5.5;

/** Simulated seconds between wet-trail prints. `wetness.track` rate-limits too. */
const TRACK_PERIOD = 0.22;

/** Drip pool size. One InstancedMesh, one draw call, hard cap. */
const DRIP_COUNT = 72;
/** Droplets per second shed at fully soaked. Scales down with dryness. */
const DRIP_RATE = 14;
const DRIP_GRAVITY = -18;
/** Droplet dimensions — a stretched teardrop reads as water, a sphere as a pea. */
const DRIP_RADIUS = 0.019;
const DRIP_STRETCH = 2.1;

/**
 * The Downpour fallback window.
 *
 * `storm.applyStormDamage` already calls `player.damage`, and in water mode
 * that lands on `applySoak` — so the rain is normally applied for us. This
 * module only takes over if nothing storm-shaped has soaked us for this long
 * while we are stood outside the wall, which covers a storm build that hands
 * the rate over instead of applying it. Belt and braces, never both at once.
 */
const DOWNPOUR_HANDOFF = DOWNPOUR.tickInterval * 2.5;

// ---- drop sequence ------------------------------------------------------

/** Downward acceleration in freefall. Higher than walking gravity: the drop
 *  should feel like being thrown at the island, not dropped from a chair. */
const DIVE_GRAVITY = -38;
/** Terminal speed head-down. Fortnite's dive tops out around 78 m/s. */
const DIVE_TERMINAL = 79;
/** Terminal speed spread-eagle (no forward input). */
const DIVE_TERMINAL_FLAT = 51;
/** Horizontal steering authority while diving. Very high — you can cross a
 *  POI on the way down, and that is the whole tactical point of the drop. */
const DIVE_STEER = 46;
const DIVE_DRAG = 0.55;

/** Auto-deploy the glider this far above the ground. */
const DEPLOY_ALTITUDE = 112;
/** Steady-state glide descent rate. */
const GLIDE_SINK = -11.5;
const GLIDE_SPEED = 25.5;
const GLIDE_STEER = 15;
/** How fast the glider yaws to follow the camera. Deliberately lazy: wide,
 *  committed turns are what makes gliding feel like flying a wing. */
const GLIDE_TURN_RATE = 1.5;
/** Seconds for the canopy to snap open / fold away. */
const GLIDE_DEPLOY_TIME = 0.42;

// ---- camera -------------------------------------------------------------

/** Third-person spring arm length, hip-fire. */
const ARM_LENGTH = 4.1;
/** Shortened arm while aiming — the over-the-shoulder pose. */
const ARM_LENGTH_AIM = 1.85;
/** Lateral offset of the arm. Positive is the player's right. */
const ARM_SHOULDER = 0.62;
const ARM_SHOULDER_AIM = 0.5;
/** Vertical offset above the pivot, so the arm looks slightly down at you. */
const ARM_RISE = 0.16;
/** Arm length during the dive — pulled way back so the island fills frame. */
const ARM_LENGTH_DIVE = 5.6;
/** Keep the near plane out of walls the arm is hugging. */
const CAMERA_PAD = 0.28;

/** FOV added at full sprint, and removed while aiming. */
const FOV_SPRINT = 6;
const FOV_AIM = -13;
/** FOV added at dive terminal velocity. This kick is most of the drop feel. */
const FOV_DIVE = 30;

const PITCH_LIMIT = Math.PI / 2 - 0.035;

// ---- the bus orbit rig ---------------------------------------------------
//
// Riding the bus is not a first-person moment and it is not a third-person
// moment either: the subject of the shot is the BUS, with the island laid out
// under it. So while `state === "bus"` the arm hangs off the bus rather than
// off the rider's head, and looking around orbits it. Every battle royale
// opens on this shot for a reason — it is the one everybody screenshots.
//
// Before this existed the arm was the ordinary 4.1 m ground rig anchored to a
// rider parked 2.35 m under a 21 m hull, which put the camera inside the
// fuselage for most of the yaw circle. The photo that started this was a
// frame full of blue panelling.

/** Where the orbit pivot sits above the bus's own origin (its rail line).
 *  Roughly the middle of hull + balloon, so both fit the frame with room for
 *  the island underneath. */
const BUS_PIVOT_RISE = 9;
/** Arm limits, metres from the pivot. The minimum is a wide-but-tight shot of
 *  the whole rig; the maximum is the bus as a toy over the island. */
const BUS_ARM_MIN = 26;
const BUS_ARM_MAX = 110;
/** The frame the game opens on: far enough that hull, balloon and a good slab
 *  of island all read at once. */
const BUS_ARM_DEFAULT = 46;
/** Three-quarter rear: this much yaw off "straight behind", toward the side
 *  the rider hangs from, so the bus reads in perspective and you can see
 *  yourself on the rail. */
const BUS_ARM_AZIMUTH = 0.45;
/** Looking down this much at the pivot, which puts the camera above the bus
 *  and the island in the lower half of the frame. */
const BUS_ARM_PITCH = -0.13;
/**
 * The keep-out ellipsoid, in bus-local metres about the pivot: lateral,
 * vertical, and along the route. It has to CONTAIN the whole rig — hull
 * (halfW 3, halfL 10.8, roof 5.45), balloon (radius 11, crown 25 m up) and
 * the rider hanging below — because the arm is only ever allowed to end
 * outside it. Sized from `match.ts`'s own HULL block and balloon profile.
 */
const BUS_KEEPOUT_X = 14;
const BUS_KEEPOUT_Y = 19;
const BUS_KEEPOUT_Z = 17;
/** Clearance outside that surface, so the near plane never grazes the hull. */
const BUS_KEEPOUT_PAD = 3;
/** Per wheel notch / per pinch. Multiplicative, because a fixed step is
 *  glacial at the far end of the range and violent at the near end. */
const BUS_ZOOM_STEP = 0.12;

/**
 * Canopy clearance. The wing sits ~3.6 m over the rig's feet and spans 3.7 m,
 * so a short arm at a steep down-pitch can put the camera inside it. This is
 * the radius the arm has to clear during the dive and the glide.
 */
const SELF_KEEPOUT_R = 2.6;
/** Height of that sphere's centre above the drop pivot. */
const SELF_KEEPOUT_Y = 2.5;

// ---- character ----------------------------------------------------------

/** Hip height in rig space. Every joint offset below is relative to this. */
const HIP_Y = 1.02;

const TAU = Math.PI * 2;

// ---------------------------------------------------------------- helpers

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Frame-rate independent exponential approach. `rate` is roughly 1/seconds. */
const approach = (cur: number, target: number, rate: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));
const smoothstep = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** Signed shortest angular difference, radians. */
function angleDelta(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/**
 * Distance from the centre of an axis-aligned ellipsoid to its surface along
 * the unit direction `(ux, uy, uz)` — i.e. the shortest arm that is provably
 * *outside* the volume in that direction.
 *
 * Solving it rather than testing-and-nudging matters: the test-and-nudge
 * version wobbles as the orbit sweeps, and the whole point of the bus rig is
 * that the arm can never end up inside the hull no matter where it is pointed.
 */
function ellipsoidReach(
  ux: number, uy: number, uz: number,
  rx: number, ry: number, rz: number,
): number {
  const k = Math.hypot(ux / rx, uy / ry, uz / rz);
  return k > 1e-6 ? 1 / k : 0;
}

/**
 * How far the player has zoomed the bus camera, remembered for the session.
 *
 * Module scope on purpose: "remember it" means across matches and across
 * re-entering the world, and a visitor who pulled the camera wide once should
 * not have to do it again on the next drop. It is one number and it is clamped
 * on every read, so nothing downstream can be broken by a stale value.
 */
let busArmSession = BUS_ARM_DEFAULT;

// ---------------------------------------------------------------- geometry
//
// A tiny mesh accumulator. Same shape as the one in world/props.ts but with a
// fourth stream: per-vertex colour. Parts land in plain arrays and only whole
// *joints* ever become a BufferGeometry, because a humanoid is ~60 primitives
// and sixty one-box geometries would be sixty draw calls for one character.

class Geo {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];

  vert(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    u: number, v: number,
    r: number, g: number, b: number,
  ): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(r, g, b);
    return i;
  }

  idx: number[] = [];

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  /**
   * Append another Geo through a matrix. `transformDirection` is right for the
   * normals because every matrix this module builds is rotation + translation;
   * nothing is non-uniformly scaled on the CPU.
   */
  append(src: Geo, m?: THREE.Matrix4): void {
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
    }
    for (let i = 0; i < src.uv.length; i++) this.uv.push(src.uv[i]);
    for (let i = 0; i < src.col.length; i++) this.col.push(src.col[i]);
    for (let i = 0; i < src.idx.length; i++) this.idx.push(src.idx[i] + base);
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Per-part surface description: tint, plus the AO/wear knobs. */
interface Paint {
  /** Base albedo tint, multiplied into the vertex colour. */
  color: number;
  /** How much brighter the chamfers get. Edge wear — rub marks on corners. */
  wear?: number;
  /** Occlusion multiplier applied to the bottom face and fading upward. */
  ao?: number;
  /** Extra flat multiplier, for parts that sit in permanent shadow. */
  shade?: number;
}

const _c = new THREE.Color();

/** Resolve a Paint into linear RGB, since vertex colours are linear-space. */
function paintRgb(p: Paint, extra = 1): [number, number, number] {
  _c.setHex(p.color, THREE.SRGBColorSpace);
  const k = (p.shade ?? 1) * extra;
  return [_c.r * k, _c.g * k, _c.b * k];
}

/**
 * A chamfered box centred on the origin.
 *
 * Hard 90° edges are the third-worst tell in the list — real objects have a
 * radius, and a chamfer wide enough to catch one pixel of the key light is
 * enough to read as one. Every panel on this character goes through here.
 *
 * The chamfer quads are also where the wear tint goes: a lighter rim along
 * every edge is what a jacket elbow, a boot toe and a backpack corner all
 * actually look like after a week.
 */
function bevelBox(hx: number, hy: number, hz: number, bevel: number, paint: Paint): Geo {
  const g = new Geo();
  const h = [hx, hy, hz];
  let b = Math.max(0, Math.min(bevel, hx * 0.45, hy * 0.45, hz * 0.45));
  // Below a centimetre the chamfer is sub-pixel at any distance a player is
  // ever seen from, and it costs four times the vertices. Drop it.
  if (b < 0.008) b = 0;

  const wear = paint.wear ?? 0.18;
  const ao = paint.ao ?? 0.26;
  const [br, bg, bb] = paintRgb(paint);
  // Vertical AO gradient: darkest at the underside, gone by the top.
  const shadeAt = (y: number) => {
    const t = hy > 1e-5 ? clamp01((y + hy) / (2 * hy)) : 1;
    return 1 - ao * (1 - smoothstep(t));
  };

  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, edge: number) => {
    const k = shadeAt(y) * (1 + wear * edge);
    return g.vert(x, y, z, nx, ny, nz, x * 3 + z * 3, y * 3, br * k, bg * k, bb * k);
  };
  /**
   * Emit a quad with whichever winding agrees with the supplied normal.
   *
   * The six faces, twelve chamfers and eight corners below are generated by
   * axis permutation, and half of those permutations come out mirrored. Trying
   * to reason about the parity of each one by hand is how you end up with a
   * character whose left side is invisible from outside and solid from
   * inside — so the winding is derived rather than assumed.
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

  // --- six inset faces ---
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
      const n = [0, 0, 0];
      n[a] = sgn;
      quad(pts[0], pts[1], pts[2], pts[3], n[0], n[1], n[2], 0);
    }
  }
  if (b <= 1e-5) return g;

  // --- twelve edge chamfers ---
  const p = [0, 0, 0], q = [0, 0, 0], r = [0, 0, 0], s = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    for (let bb2 = a + 1; bb2 < 3; bb2++) {
      const c = 3 - a - bb2;
      for (let sa = -1; sa <= 1; sa += 2) {
        for (let sb = -1; sb <= 1; sb += 2) {
          for (let k = 0; k < 3; k++) { p[k] = 0; q[k] = 0; r[k] = 0; s[k] = 0; }
          p[a] = sa * h[a]; p[bb2] = sb * (h[bb2] - b); p[c] = -(h[c] - b);
          q[a] = sa * h[a]; q[bb2] = sb * (h[bb2] - b); q[c] = h[c] - b;
          r[a] = sa * (h[a] - b); r[bb2] = sb * h[bb2]; r[c] = h[c] - b;
          s[a] = sa * (h[a] - b); s[bb2] = sb * h[bb2]; s[c] = -(h[c] - b);
          const n = [0, 0, 0];
          n[a] = sa * Math.SQRT1_2;
          n[bb2] = sb * Math.SQRT1_2;
          quad(p.slice(), q.slice(), r.slice(), s.slice(), n[0], n[1], n[2], 1);
        }
      }
    }
  }

  // --- eight corner triangles ---
  const kk = 1 / Math.sqrt(3);
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        const i0 = push(sx * hx, sy * (hy - b), sz * (hz - b), sx * kk, sy * kk, sz * kk, 1);
        const i1 = push(sx * (hx - b), sy * hy, sz * (hz - b), sx * kk, sy * kk, sz * kk, 1);
        const i2 = push(sx * (hx - b), sy * (hy - b), sz * hz, sx * kk, sy * kk, sz * kk, 1);
        // Four of the eight octants come out mirrored; sx·sy·sz is exactly
        // that parity, so it decides the winding.
        if (sx * sy * sz > 0) g.tri(i0, i1, i2);
        else g.tri(i0, i2, i1);
      }
    }
  }
  return g;
}

/**
 * A faceted sphere used for every ball joint. Flat-shaded per quad on purpose
 * — smooth spheres in a chunky character read as bubblegum, and the facets
 * give the key light something to break on when the limb rotates.
 */
function ball(radius: number, seg: number, rings: number, paint: Paint): Geo {
  const g = new Geo();
  const [br, bg, bb] = paintRgb(paint);
  const ao = paint.ao ?? 0.3;
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
      const quadPts = [p0, p1, p2, p3];
      const ids: number[] = [];
      for (const pp of quadPts) {
        const k = 1 - ao * (1 - clamp01((pp[1] / radius + 1) * 0.5));
        ids.push(g.vert(pp[0], pp[1], pp[2], _n.x, _n.y, _n.z, pp[0] * 3, pp[1] * 3, br * k, bg * k, bb * k));
      }
      g.tri(ids[0], ids[1], ids[2]);
      g.tri(ids[0], ids[2], ids[3]);
    }
  }
  return g;
}

/** A faceted cylinder about +Y. Scarves, bedrolls, riser hardware, ear cups. */
function tube(rBottom: number, rTop: number, height: number, seg: number, paint: Paint, caps = true): Geo {
  const g = new Geo();
  const [br, bg, bb] = paintRgb(paint);
  const ao = paint.ao ?? 0.22;
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
    const kt = 1;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const i0 = g.vert(c0 * rBottom, y0, s0 * rBottom, nx, ny, nz, a0 * rBottom * 3, y0 * 3, br * kb, bg * kb, bb * kb);
    const i1 = g.vert(c1 * rBottom, y0, s1 * rBottom, nx, ny, nz, a1 * rBottom * 3, y0 * 3, br * kb, bg * kb, bb * kb);
    const i2 = g.vert(c1 * rTop, y1, s1 * rTop, nx, ny, nz, a1 * rTop * 3, y1 * 3, br * kt, bg * kt, bb * kt);
    const i3 = g.vert(c0 * rTop, y1, s0 * rTop, nx, ny, nz, a0 * rTop * 3, y1 * 3, br * kt, bg * kt, bb * kt);
    // Wound against the outward normal: walking the ring in +angle and then
    // up gives a left-handed triangle, so the middle two indices swap.
    g.tri(i0, i2, i1);
    g.tri(i0, i3, i2);
    if (!caps) continue;
    if (rTop > 1e-4) {
      const ct = g.vert(0, y1, 0, 0, 1, 0, 0, 0, br, bg, bb);
      const q0 = g.vert(c0 * rTop, y1, s0 * rTop, 0, 1, 0, c0 * rTop * 3, s0 * rTop * 3, br, bg, bb);
      const q1 = g.vert(c1 * rTop, y1, s1 * rTop, 0, 1, 0, c1 * rTop * 3, s1 * rTop * 3, br, bg, bb);
      g.tri(ct, q1, q0);
    }
    if (rBottom > 1e-4) {
      const cb = g.vert(0, y0, 0, 0, -1, 0, 0, 0, br * kb, bg * kb, bb * kb);
      const q0 = g.vert(c0 * rBottom, y0, s0 * rBottom, 0, -1, 0, c0 * 3, s0 * 3, br * kb, bg * kb, bb * kb);
      const q1 = g.vert(c1 * rBottom, y0, s1 * rBottom, 0, -1, 0, c1 * 3, s1 * 3, br * kb, bg * kb, bb * kb);
      g.tri(cb, q0, q1);
    }
  }
  return g;
}

/** Rotation+translation matrix. Everything authored here is rigid. */
function xf(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, "YXZ")),
    new THREE.Vector3(1, 1, 1),
  );
}

// ---------------------------------------------------------------- surfaces
//
// Four tileable PBR sets, baked on a canvas at boot. The albedo is deliberately
// near-white with only micro-variation in it: all the colour comes from the
// vertex stream, so one weave serves the jacket, the trousers, the scarf and
// the glider canopy. What the maps carry is what the vertex stream *cannot* —
// thread direction, pebbling, seam relief, and above all roughness variation.
// A character with one roughness value is a plastic action figure no matter
// how good its albedo is.

type SurfaceId = "cloth" | "leather" | "skin" | "metal";

interface SurfaceSpec {
  /** Base greyscale albedo. Vertex colour multiplies on top. */
  base: number;
  /** Mean roughness and the ± swing painted into the green channel. */
  rough: number;
  roughVar: number;
  metal: number;
  /** Normal map strength. */
  bump: number;
  /** Texels per metre — how tight the weave/pebble reads at arm's length. */
  scale: number;
}

const SURFACES: Record<SurfaceId, SurfaceSpec> = {
  // Cotton drill: tight warp/weft, very rough, a little fuzz.
  cloth: { base: 0.82, rough: 0.88, roughVar: 0.1, metal: 0, bump: 0.9, scale: 26 },
  // Pebbled hide: broad, soft, and noticeably glossier than the cloth. The
  // contrast between the two is what makes the straps read as a different
  // material at 20 m rather than as a differently-coloured jacket.
  leather: { base: 0.78, rough: 0.52, roughVar: 0.16, metal: 0, bump: 1.35, scale: 15 },
  // Skin needs almost no albedo detail and a lot of roughness *variation* —
  // foreheads and noses are shinier than cheeks and that is the whole read.
  skin: { base: 0.88, rough: 0.6, roughVar: 0.14, metal: 0, bump: 0.35, scale: 22 },
  // Brushed metal: anisotropic-looking streaks faked with directional noise.
  metal: { base: 0.86, rough: 0.34, roughVar: 0.18, metal: 1, bump: 0.7, scale: 30 },
};

/** Tileable value noise. Wraps on `period` so nothing seams. */
function wrapNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const h = (a: number, b: number) => {
    const ax = ((a % period) + period) % period;
    const by = ((b % period) + period) % period;
    let n = (ax * 374761393 + by * 668265263 + seed * 2147483647) | 0;
    n = (n ^ (n >> 13)) * 1274126177;
    return (((n ^ (n >> 16)) >>> 0) % 100000) / 100000;
  };
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

function fbm(x: number, y: number, period: number, octaves: number, seed: number): number {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let p = period;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += wrapNoise(x * f, y * f, p, seed + i * 91) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
    p *= 2;
  }
  return sum / norm;
}

interface SurfaceMaps {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  ormMap: THREE.DataTexture;
}

/**
 * Bake one surface family. Writes three DataTextures: albedo (sRGB), a normal
 * map derived by Sobel from the same height field that drives the albedo, and
 * a packed ORM (occlusion / roughness / metalness) so all three ride one
 * sampler. Height and albedo coming from the same field is what makes the
 * relief and the shading agree — separately-authored maps always look wrong.
 */
function bakeSurface(id: SurfaceId, size: number): SurfaceMaps {
  const spec = SURFACES[id];
  const n = size;
  const height = new Float32Array(n * n);
  const gloss = new Float32Array(n * n);
  const tint = new Float32Array(n * n);
  const period = 16;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const u = (x / n) * period;
      const v = (y / n) * period;
      let h = 0;
      let gl = 0;
      let tn = 0;
      switch (id) {
        case "cloth": {
          // Warp and weft as two phase-shifted square-ish waves, plus fibre
          // noise. The cross-hatch is only visible within a metre or two but
          // its low-frequency drift reads as folded cloth from anywhere.
          const warp = Math.sin((x / n) * Math.PI * 2 * 96) * 0.5 + 0.5;
          const weft = Math.sin((y / n) * Math.PI * 2 * 96) * 0.5 + 0.5;
          const fold = fbm(u * 0.28, v * 0.28, 5, 4, 11);
          h = (warp * weft) * 0.35 + fold * 0.65;
          gl = 0.25 + fold * 0.55 + (1 - warp * weft) * 0.2;
          tn = 0.9 + fold * 0.16;
          break;
        }
        case "leather": {
          // Voronoi-ish pebbling: fbm thresholded into cells, with the cell
          // walls pushed down so the grain catches a rim of light.
          const cell = fbm(u * 1.5, v * 1.5, 12, 3, 27);
          const fine = fbm(u * 6, v * 6, 48, 2, 5);
          const wall = smoothstep((Math.abs(cell - 0.5) - 0.06) * 9);
          h = wall * 0.7 + fine * 0.3;
          gl = 0.35 + wall * 0.5 + fine * 0.15;
          tn = 0.86 + cell * 0.2;
          break;
        }
        case "skin": {
          const pores = fbm(u * 9, v * 9, 90, 2, 61);
          const broad = fbm(u * 0.7, v * 0.7, 8, 3, 3);
          h = pores * 0.55 + broad * 0.45;
          gl = 0.3 + broad * 0.5 + pores * 0.2;
          tn = 0.94 + broad * 0.1;
          break;
        }
        default: {
          // Brushed: heavy anisotropy along U, faint mottling across it, plus
          // a sparse scratch layer so the buckles are not showroom-fresh.
          const brush = fbm(u * 0.4, v * 22, 200, 3, 7);
          const mottle = fbm(u * 2, v * 2, 20, 2, 41);
          const scratch = smoothstep((fbm(u * 3, v * 30, 240, 2, 88) - 0.72) * 12);
          h = brush * 0.6 + mottle * 0.25 + scratch * 0.15;
          gl = 0.2 + brush * 0.6 + scratch * 0.4;
          tn = 0.9 + mottle * 0.16 - scratch * 0.12;
          break;
        }
      }
      height[i] = h;
      gloss[i] = clamp01(gl);
      tint[i] = clamp01(tn);
    }
  }

  // --- albedo ---
  const alb = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const c = clamp01(spec.base * tint[i]);
    const s = Math.round(Math.pow(c, 1 / 2.2) * 255);
    alb[i * 4] = s;
    alb[i * 4 + 1] = s;
    alb[i * 4 + 2] = s;
    alb[i * 4 + 3] = 255;
  }

  // --- normal, Sobel over the wrapped height field ---
  const nrm = new Uint8Array(n * n * 4);
  const at = (x: number, y: number) => height[(((y % n) + n) % n) * n + (((x % n) + n) % n)];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      _n.set(-dx * spec.bump, -dy * spec.bump, 1).normalize();
      const i = (y * n + x) * 4;
      nrm[i] = Math.round((_n.x * 0.5 + 0.5) * 255);
      nrm[i + 1] = Math.round((_n.y * 0.5 + 0.5) * 255);
      nrm[i + 2] = Math.round((_n.z * 0.5 + 0.5) * 255);
      nrm[i + 3] = 255;
    }
  }

  // --- ORM: cavity in R, roughness in G, metalness in B ---
  const orm = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      // Cheap cavity: how far below the local mean this texel sits. Baked
      // occlusion in the weave is what stops flat cloth reading as vinyl.
      const local = (at(x - 2, y) + at(x + 2, y) + at(x, y - 2) + at(x, y + 2)) * 0.25;
      const cav = clamp01(0.72 + (height[i] - local) * 1.6);
      const rough = clamp01(spec.rough + (gloss[i] - 0.5) * 2 * spec.roughVar);
      const o = i * 4;
      orm[o] = Math.round(cav * 255);
      orm[o + 1] = Math.round(rough * 255);
      orm[o + 2] = Math.round(spec.metal * 255);
      orm[o + 3] = 255;
    }
  }

  const mk = (data: Uint8Array<ArrayBuffer>, srgb: boolean): THREE.DataTexture => {
    const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    // The whole character is authored in metres and its UVs are position×3,
    // so one repeat is a third of a metre; `scale` converts that into the
    // texels-per-metre the spec asks for.
    t.repeat.set(spec.scale / 12, spec.scale / 12);
    t.needsUpdate = true;
    return t;
  };

  return {
    map: mk(alb, true),
    normalMap: mk(nrm, false),
    ormMap: mk(orm, false),
  };
}

// ---------------------------------------------------------------- skeleton

const J_PELVIS = 0;
const J_SPINE = 1;
const J_CHEST = 2;
const J_NECK = 3;
const J_HEAD = 4;
const J_SHO_L = 5;
const J_ARM_L = 6;
const J_FORE_L = 7;
const J_HAND_L = 8;
const J_SHO_R = 9;
const J_ARM_R = 10;
const J_FORE_R = 11;
const J_HAND_R = 12;
const J_THIGH_L = 13;
const J_SHIN_L = 14;
const J_FOOT_L = 15;
const J_THIGH_R = 16;
const J_SHIN_R = 17;
const J_FOOT_R = 18;
const JOINT_COUNT = 19;

/**
 * Local rest offsets, in metres, each relative to its parent joint. The
 * character faces **−Z** so that `rig.rotation.y = yaw` points it the same way
 * as the camera forward vector `(-sin yaw, 0, -cos yaw)`; every "front" offset
 * below is therefore negative in Z.
 *
 * Proportions are deliberately off-human: the head is about 1/6.5 of the
 * height rather than 1/7.5, the shoulders are wide, the hands and boots are
 * oversized. That is the entire trick behind a readable silhouette at 300 m.
 */
const REST: Array<[number, number, number]> = new Array(JOINT_COUNT).fill(0).map(() => [0, 0, 0]);
REST[J_PELVIS] = [0, HIP_Y, 0];
REST[J_SPINE] = [0, 0.12, 0];
REST[J_CHEST] = [0, 0.16, 0];
REST[J_NECK] = [0, 0.2, 0];
REST[J_HEAD] = [0, 0.06, 0];
REST[J_SHO_L] = [-0.215, 0.14, 0];
REST[J_ARM_L] = [0, 0, 0];
REST[J_FORE_L] = [0, -0.32, 0];
REST[J_HAND_L] = [0, -0.3, 0];
REST[J_SHO_R] = [0.215, 0.14, 0];
REST[J_ARM_R] = [0, 0, 0];
REST[J_FORE_R] = [0, -0.32, 0];
REST[J_HAND_R] = [0, -0.3, 0];
REST[J_THIGH_L] = [-0.105, -0.02, 0];
REST[J_SHIN_L] = [0, -0.46, 0];
REST[J_FOOT_L] = [0, -0.42, 0];
REST[J_THIGH_R] = [0.105, -0.02, 0];
REST[J_SHIN_R] = [0, -0.46, 0];
REST[J_FOOT_R] = [0, -0.42, 0];

const PARENT: number[] = new Array(JOINT_COUNT).fill(-1);
PARENT[J_SPINE] = J_PELVIS;
PARENT[J_CHEST] = J_SPINE;
PARENT[J_NECK] = J_CHEST;
PARENT[J_HEAD] = J_NECK;
PARENT[J_SHO_L] = J_CHEST;
PARENT[J_ARM_L] = J_SHO_L;
PARENT[J_FORE_L] = J_ARM_L;
PARENT[J_HAND_L] = J_FORE_L;
PARENT[J_SHO_R] = J_CHEST;
PARENT[J_ARM_R] = J_SHO_R;
PARENT[J_FORE_R] = J_ARM_R;
PARENT[J_HAND_R] = J_FORE_R;
PARENT[J_THIGH_L] = J_PELVIS;
PARENT[J_SHIN_L] = J_THIGH_L;
PARENT[J_FOOT_L] = J_SHIN_L;
PARENT[J_THIGH_R] = J_PELVIS;
PARENT[J_SHIN_R] = J_THIGH_R;
PARENT[J_FOOT_R] = J_SHIN_R;

// ---------------------------------------------------------------- palette

/**
 * The drop-suit. Colour blocking is doing the silhouette work here: a dark
 * navy body so the orange scarf and the sand-coloured pack read as accents,
 * and a single warm hero colour repeated on the cap, the scarf and the glider
 * so the whole kit reads as one outfit from the bus.
 */
const C_JACKET = 0x2c3a55;
const C_JACKET_DARK = 0x1d2740;
const C_TROUSER = 0x3b4152;
const C_ACCENT = 0xe07a3c;
const C_ACCENT_DEEP = 0xb2542a;
const C_PACK = 0xa8926b;
const C_LEATHER = 0x4a3728;
const C_LEATHER_LIGHT = 0x6d5138;
const C_SKIN = 0xc08a63;
const C_METAL = 0xb9bec7;
const C_METAL_DARK = 0x5c626c;
const C_GLASS = 0x2a3f4d;
const C_CANOPY_A = 0xe8e4dc;
const C_CANOPY_B = 0xe07a3c;
const C_CANOPY_C = 0x2c3a55;

interface CharacterRig {
  /** Feet-level root. The caller sets position + yaw on this. */
  root: THREE.Object3D;
  /** Between root and pelvis — carries bob, crouch drop and lean roll. */
  body: THREE.Object3D;
  joints: THREE.Object3D[];
  /** Everything on the head, so first person can hide it without hiding you. */
  headGroup: THREE.Object3D;
  glider: THREE.Object3D;
  /** Canopy cells, animated individually for the billow. */
  cells: THREE.Object3D[];
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  textures: THREE.Texture[];
}

/** Accumulates authored parts per (joint, surface) so each pair is one mesh. */
class RigBuilder {
  private bins = new Map<string, Geo>();

  add(joint: number, surface: SurfaceId, geo: Geo, m?: THREE.Matrix4): void {
    const key = `${joint}|${surface}`;
    let bin = this.bins.get(key);
    if (!bin) {
      bin = new Geo();
      this.bins.set(key, bin);
    }
    bin.append(geo, m);
  }

  entries(): Array<{ joint: number; surface: SurfaceId; geo: Geo }> {
    const out: Array<{ joint: number; surface: SurfaceId; geo: Geo }> = [];
    for (const [key, geo] of this.bins) {
      if (geo.empty) continue;
      const [j, s] = key.split("|");
      out.push({ joint: Number(j), surface: s as SurfaceId, geo });
    }
    return out;
  }
}

/**
 * Author the whole character.
 *
 * Read this as a parts list, not as code: every entry is one primitive with a
 * chamfer, a tint and an occlusion bias. The details that are easy to skip —
 * the collar lip, the zip pull, the strap keepers, the sole welt, the toe cap,
 * the vent grommets on the pack — are exactly the ones that stop this reading
 * as a Three.js demo, so they are all here.
 */
function buildCharacter(ctx: WorldCtx): CharacterRig {
  const lowDetail = ctx.quality === "low";
  const texSize = ctx.quality === "ultra" ? 512 : ctx.quality === "low" ? 128 : 256;
  const seg = lowDetail ? 6 : 10;
  const rings = lowDetail ? 4 : 6;

  const b = new RigBuilder();

  // ---- helper shorthands ------------------------------------------------
  const box = (
    joint: number, surface: SurfaceId,
    hx: number, hy: number, hz: number, bev: number,
    paint: Paint,
    x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0,
  ) => b.add(joint, surface, bevelBox(hx, hy, hz, bev, paint), xf(x, y, z, rx, ry, rz));

  const sphere = (
    joint: number, surface: SurfaceId, r: number, paint: Paint,
    x = 0, y = 0, z = 0,
  ) => b.add(joint, surface, ball(r, seg, rings, paint), xf(x, y, z));

  const cyl = (
    joint: number, surface: SurfaceId,
    rb: number, rt: number, h: number, paint: Paint,
    x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, caps = true,
  ) => b.add(joint, surface, tube(rb, rt, h, seg, paint, caps), xf(x, y, z, rx, ry, rz));

  // ---- pelvis -----------------------------------------------------------
  box(J_PELVIS, "cloth", 0.155, 0.09, 0.115, 0.045, { color: C_TROUSER, ao: 0.34, wear: 0.1 }, 0, -0.03, 0);
  // Seat panel: a darker patch across the back, because trousers wear there.
  box(J_PELVIS, "cloth", 0.135, 0.06, 0.02, 0.012, { color: C_TROUSER, shade: 0.82, wear: 0.05 }, 0, -0.04, 0.108);

  // ---- lower torso + belt ----------------------------------------------
  box(J_SPINE, "cloth", 0.185, 0.115, 0.115, 0.05, { color: C_JACKET, ao: 0.3 }, 0, 0.02, 0);
  // Hem of the jacket, sitting proud of the body so it casts a real shadow.
  box(J_SPINE, "cloth", 0.192, 0.028, 0.122, 0.014, { color: C_JACKET_DARK, wear: 0.3 }, 0, -0.085, 0);
  box(J_SPINE, "leather", 0.196, 0.042, 0.124, 0.018, { color: C_LEATHER, wear: 0.34 }, 0, -0.128, 0);
  box(J_SPINE, "metal", 0.05, 0.036, 0.016, 0.008, { color: C_METAL, wear: 0.45, ao: 0.1 }, 0, -0.128, -0.128);
  // Hip pouch on the right, magazine loops on the left. Asymmetry is what
  // makes a silhouette look designed rather than mirrored.
  box(J_SPINE, "leather", 0.055, 0.062, 0.045, 0.018, { color: C_LEATHER_LIGHT, wear: 0.3 }, 0.2, -0.115, 0.03);
  box(J_SPINE, "leather", 0.05, 0.012, 0.048, 0.006, { color: C_LEATHER, wear: 0.4 }, 0.2, -0.058, 0.03);
  for (let i = 0; i < 3; i++) {
    box(J_SPINE, "cloth", 0.016, 0.03, 0.03, 0.008, { color: C_JACKET_DARK, wear: 0.25 }, -0.2, -0.12, -0.03 + i * 0.035);
  }

  // ---- chest ------------------------------------------------------------
  box(J_CHEST, "cloth", 0.215, 0.17, 0.125, 0.05, { color: C_JACKET, ao: 0.2 }, 0, 0.06, 0);
  // Chest yoke: a seamed panel across the shoulders, one shade lighter.
  box(J_CHEST, "cloth", 0.2, 0.05, 0.128, 0.02, { color: C_JACKET, shade: 1.12, wear: 0.24 }, 0, 0.17, 0);
  // Collar, standing away from the neck with a darker inner lip.
  box(J_CHEST, "cloth", 0.13, 0.045, 0.11, 0.022, { color: C_JACKET_DARK, wear: 0.3 }, 0, 0.215, 0);
  box(J_CHEST, "cloth", 0.098, 0.03, 0.082, 0.014, { color: C_ACCENT_DEEP, shade: 0.75, ao: 0.55 }, 0, 0.228, 0);
  // Zip: a metal ribbon down the front plus a pull tab you can actually see.
  box(J_CHEST, "metal", 0.011, 0.155, 0.008, 0.003, { color: C_METAL_DARK, wear: 0.5, ao: 0.05 }, 0, 0.06, -0.126);
  box(J_CHEST, "metal", 0.012, 0.022, 0.006, 0.003, { color: C_METAL, wear: 0.6, ao: 0.05 }, 0, -0.045, -0.13);
  // Chest pockets with flaps and press studs.
  for (const sx of [-1, 1]) {
    box(J_CHEST, "cloth", 0.058, 0.05, 0.014, 0.012, { color: C_JACKET_DARK, wear: 0.28 }, sx * 0.115, 0.0, -0.128);
    box(J_CHEST, "leather", 0.06, 0.016, 0.016, 0.007, { color: C_LEATHER, wear: 0.4 }, sx * 0.115, 0.048, -0.13);
    box(J_CHEST, "metal", 0.008, 0.008, 0.005, 0.002, { color: C_METAL, wear: 0.5, ao: 0 }, sx * 0.115, 0.036, -0.136);
  }
  // Backpack: the single biggest silhouette element after the shoulders.
  box(J_CHEST, "cloth", 0.155, 0.175, 0.1, 0.05, { color: C_PACK, ao: 0.3, wear: 0.26 }, 0, 0.045, 0.2);
  box(J_CHEST, "cloth", 0.148, 0.055, 0.024, 0.018, { color: C_PACK, shade: 0.88, wear: 0.34 }, 0, 0.125, 0.29);
  box(J_CHEST, "leather", 0.02, 0.07, 0.014, 0.006, { color: C_LEATHER, wear: 0.42 }, 0, 0.085, 0.3);
  box(J_CHEST, "metal", 0.024, 0.02, 0.01, 0.004, { color: C_METAL, wear: 0.55, ao: 0.05 }, 0, 0.045, 0.303);
  // Bedroll lashed under the pack — lies across the body, so it is a cylinder
  // rotated about Z, and it breaks the pack's box silhouette from the side.
  cyl(J_CHEST, "cloth", 0.058, 0.058, 0.3, { color: C_ACCENT_DEEP, ao: 0.3, wear: 0.2 }, 0, -0.075, 0.235, 0, 0, Math.PI / 2);
  for (const sx of [-1, 1]) {
    box(J_CHEST, "leather", 0.012, 0.02, 0.07, 0.005, { color: C_LEATHER, wear: 0.45 }, sx * 0.085, -0.075, 0.235);
  }
  // Shoulder straps running over the chest, with keepers and buckles.
  for (const sx of [-1, 1]) {
    box(J_CHEST, "leather", 0.028, 0.15, 0.014, 0.006, { color: C_LEATHER, wear: 0.35 }, sx * 0.105, 0.075, -0.128, 0.14);
    box(J_CHEST, "metal", 0.03, 0.016, 0.012, 0.004, { color: C_METAL_DARK, wear: 0.5, ao: 0.05 }, sx * 0.105, 0.005, -0.134);
    box(J_CHEST, "cloth", 0.032, 0.014, 0.016, 0.005, { color: C_JACKET_DARK, wear: 0.3 }, sx * 0.105, 0.11, -0.132);
  }
  // Vent grommets on the pack sides. Tiny, but "no small-scale detail" is one
  // of the six tells and four grommets cost 200 triangles.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      cyl(J_CHEST, "metal", 0.011, 0.011, 0.008, { color: C_METAL_DARK, wear: 0.5, ao: 0.1 },
        sx * 0.156, 0.02 + i * 0.06, 0.2, 0, 0, Math.PI / 2);
    }
  }

  // ---- neck + head ------------------------------------------------------
  cyl(J_NECK, "skin", 0.062, 0.058, 0.08, { color: C_SKIN, ao: 0.6 }, 0, 0.01, 0, 0, 0, 0, false);
  // Scarf: a ring that overlaps the collar, plus a tail hanging down the back.
  cyl(J_NECK, "cloth", 0.115, 0.108, 0.075, { color: C_ACCENT, ao: 0.35, wear: 0.28 }, 0, -0.005, 0, 0, 0, 0, false);
  box(J_NECK, "cloth", 0.055, 0.11, 0.02, 0.012, { color: C_ACCENT, shade: 0.88, wear: 0.3 }, 0.045, -0.075, 0.095, -0.25);

  // Skull: a chunky rounded box, wider than deep, with a distinct jaw.
  box(J_HEAD, "skin", 0.152, 0.14, 0.142, 0.055, { color: C_SKIN, ao: 0.22 }, 0, 0.155, 0);
  box(J_HEAD, "skin", 0.118, 0.05, 0.12, 0.035, { color: C_SKIN, shade: 0.94, ao: 0.4 }, 0, 0.045, -0.012);
  // Ears.
  for (const sx of [-1, 1]) {
    cyl(J_HEAD, "skin", 0.036, 0.03, 0.022, { color: C_SKIN, shade: 0.9, ao: 0.3 }, sx * 0.155, 0.15, 0.01, 0, 0, Math.PI / 2);
  }
  // Goggles band with a metal rim and two dark lenses. This is the face: it
  // reads instantly at range and costs nothing next to painting one.
  box(J_HEAD, "leather", 0.162, 0.05, 0.15, 0.02, { color: C_LEATHER, ao: 0.3, wear: 0.35 }, 0, 0.185, 0);
  for (const sx of [-1, 1]) {
    box(J_HEAD, "metal", 0.05, 0.038, 0.022, 0.012, { color: C_METAL_DARK, wear: 0.55, ao: 0.15 }, sx * 0.072, 0.185, -0.142);
    box(J_HEAD, "metal", 0.042, 0.03, 0.012, 0.006, { color: C_GLASS, shade: 1.0, wear: 0.7, ao: 0 }, sx * 0.072, 0.185, -0.155);
  }
  // Strap keeper at the back of the band, where a real strap would join.
  box(J_HEAD, "leather", 0.03, 0.036, 0.02, 0.008, { color: C_LEATHER_LIGHT, wear: 0.4 }, 0, 0.185, 0.15);
  // Cap with a brim, sitting slightly back off the brow.
  box(J_HEAD, "cloth", 0.158, 0.06, 0.15, 0.05, { color: C_ACCENT, ao: 0.2, wear: 0.3 }, 0, 0.29, 0.006);
  box(J_HEAD, "cloth", 0.135, 0.016, 0.08, 0.01, { color: C_ACCENT_DEEP, wear: 0.35 }, 0, 0.264, -0.19, -0.12);
  box(J_HEAD, "cloth", 0.02, 0.02, 0.02, 0.008, { color: C_ACCENT_DEEP, wear: 0.4 }, 0, 0.345, 0.006);

  // ---- arms -------------------------------------------------------------
  for (const side of [-1, 1]) {
    const sho = side < 0 ? J_SHO_L : J_SHO_R;
    const arm = side < 0 ? J_ARM_L : J_ARM_R;
    const fore = side < 0 ? J_FORE_L : J_FORE_R;
    const hand = side < 0 ? J_HAND_L : J_HAND_R;

    // Shoulder pad, proud of the sleeve so the joint never shows a gap.
    sphere(sho, "cloth", 0.078, { color: C_JACKET, ao: 0.28 });
    box(sho, "cloth", 0.072, 0.055, 0.09, 0.03, { color: C_JACKET, shade: 1.08, wear: 0.3 }, side * 0.02, 0.035, 0);
    // Rank tab on the outside of the shoulder — a two-triangle detail that
    // makes the character look like it belongs to something.
    box(sho, "cloth", 0.008, 0.02, 0.03, 0.003, { color: C_ACCENT, wear: 0.4, ao: 0 }, side * 0.088, 0.035, -0.02);

    box(arm, "cloth", 0.062, 0.16, 0.066, 0.03, { color: C_JACKET, ao: 0.3 }, 0, -0.16, 0);
    // Sleeve seam ring, and a padded elbow one shade darker.
    box(arm, "cloth", 0.066, 0.012, 0.07, 0.005, { color: C_JACKET_DARK, wear: 0.35 }, 0, -0.24, 0);
    box(arm, "leather", 0.06, 0.05, 0.064, 0.026, { color: C_LEATHER, wear: 0.45, ao: 0.2 }, 0, -0.295, 0.008);
    sphere(fore, "cloth", 0.058, { color: C_JACKET_DARK, ao: 0.3 });

    box(fore, "cloth", 0.055, 0.145, 0.058, 0.028, { color: C_JACKET, ao: 0.3 }, 0, -0.15, 0);
    box(fore, "leather", 0.058, 0.03, 0.061, 0.014, { color: C_LEATHER_LIGHT, wear: 0.4 }, 0, -0.275, 0);
    // Watch / wrist unit on the left arm only.
    if (side < 0) {
      box(fore, "metal", 0.02, 0.026, 0.03, 0.008, { color: C_METAL_DARK, wear: 0.5, ao: 0.1 }, -0.05, -0.22, 0);
      box(fore, "metal", 0.014, 0.018, 0.004, 0.003, { color: C_GLASS, wear: 0.7, ao: 0 }, -0.062, -0.22, 0);
    }

    // Glove: palm block, a thumb, and a metal knuckle plate.
    box(hand, "leather", 0.05, 0.058, 0.062, 0.024, { color: C_LEATHER, ao: 0.3, wear: 0.4 }, 0, -0.055, 0);
    box(hand, "leather", 0.02, 0.03, 0.03, 0.012, { color: C_LEATHER, wear: 0.45 }, side * 0.05, -0.04, -0.02);
    box(hand, "metal", 0.04, 0.03, 0.012, 0.006, { color: C_METAL_DARK, wear: 0.6, ao: 0.1 }, 0, -0.05, -0.058);
    box(hand, "cloth", 0.052, 0.016, 0.062, 0.008, { color: C_JACKET_DARK, wear: 0.35 }, 0, 0.0, 0);
  }

  // ---- legs -------------------------------------------------------------
  for (const side of [-1, 1]) {
    const thigh = side < 0 ? J_THIGH_L : J_THIGH_R;
    const shin = side < 0 ? J_SHIN_L : J_SHIN_R;
    const foot = side < 0 ? J_FOOT_L : J_FOOT_R;

    box(thigh, "cloth", 0.084, 0.225, 0.09, 0.04, { color: C_TROUSER, ao: 0.3 }, 0, -0.23, 0);
    // Cargo pocket on the outside of each thigh, with a flap and a stud.
    box(thigh, "cloth", 0.024, 0.06, 0.055, 0.016, { color: C_TROUSER, shade: 1.1, wear: 0.3 }, side * 0.085, -0.24, 0.01);
    box(thigh, "cloth", 0.026, 0.014, 0.058, 0.006, { color: C_TROUSER, shade: 0.85, wear: 0.4 }, side * 0.085, -0.2, 0.01);
    // Knee pad, strapped: the wear rim on its chamfer is the point.
    box(thigh, "leather", 0.082, 0.058, 0.05, 0.024, { color: C_LEATHER, wear: 0.5, ao: 0.2 }, 0, -0.415, -0.055);
    box(thigh, "leather", 0.086, 0.016, 0.09, 0.007, { color: C_LEATHER_LIGHT, wear: 0.45 }, 0, -0.44, 0);
    sphere(shin, "cloth", 0.08, { color: C_TROUSER, ao: 0.32 });

    box(shin, "cloth", 0.073, 0.2, 0.08, 0.035, { color: C_TROUSER, ao: 0.3 }, 0, -0.2, 0);
    // Trouser blouse over the boot — the fold is what stops the leg reading
    // as one straight tube.
    box(shin, "cloth", 0.082, 0.04, 0.088, 0.018, { color: C_TROUSER, shade: 0.88, wear: 0.35 }, 0, -0.375, 0);

    // Boot: shaft, foot, a welt, a sole with a toe cap and a heel.
    box(foot, "leather", 0.077, 0.075, 0.085, 0.028, { color: C_LEATHER, ao: 0.25, wear: 0.4 }, 0, -0.03, 0.01);
    box(foot, "leather", 0.079, 0.055, 0.135, 0.03, { color: C_LEATHER, ao: 0.3, wear: 0.45 }, 0, -0.085, -0.03);
    box(foot, "leather", 0.084, 0.014, 0.142, 0.006, { color: C_LEATHER_LIGHT, wear: 0.6 }, 0, -0.122, -0.032);
    // Sole: the darkest, most-worn thing on the character, as it should be.
    box(foot, "leather", 0.082, 0.018, 0.145, 0.008, { color: 0x24201c, wear: 0.55, ao: 0.1 }, 0, -0.139, -0.032);
    box(foot, "leather", 0.078, 0.016, 0.04, 0.007, { color: 0x24201c, wear: 0.5, ao: 0.1 }, 0, -0.152, 0.06);
    box(foot, "metal", 0.06, 0.016, 0.03, 0.008, { color: C_METAL_DARK, wear: 0.7, ao: 0.1 }, 0, -0.115, -0.145);
    // Laces: three crossed bands up the tongue.
    for (let i = 0; i < 3; i++) {
      box(foot, "leather", 0.05, 0.008, 0.01, 0.003,
        { color: C_LEATHER_LIGHT, wear: 0.5, ao: 0 }, 0, -0.055 + i * 0.032, -0.078 + i * 0.012);
    }
  }

  // ---- build the object graph ------------------------------------------
  const textures: THREE.Texture[] = [];
  const materials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const matById = new Map<SurfaceId, THREE.MeshStandardMaterial>();
  const env = ctx.services.materials?.env ?? null;

  const surfaceMaterial = (id: SurfaceId): THREE.MeshStandardMaterial => {
    let m = matById.get(id);
    if (m) return m;
    const maps = bakeSurface(id, texSize);
    textures.push(maps.map, maps.normalMap, maps.ormMap);
    // aoMap defaults to the uv1 channel in r155+; this geometry only has one
    // UV set, so say channel 0 out loud or every AO sample reads garbage.
    maps.ormMap.channel = 0;
    const spec = SURFACES[id];
    m = new THREE.MeshStandardMaterial({
      map: maps.map,
      normalMap: maps.normalMap,
      normalScale: new THREE.Vector2(1, 1),
      aoMap: maps.ormMap,
      roughnessMap: maps.ormMap,
      metalnessMap: maps.ormMap,
      // Pinned to 1 so the packed map is the only authority. A second scalar
      // on top of it is just a way to flatten the variation we painted.
      roughness: 1,
      metalness: 1,
      vertexColors: true,
      envMap: env,
      envMapIntensity: spec.metal > 0.5 ? 1.15 : 0.55,
      aoMapIntensity: 0.9,
      dithering: true,
    });
    matById.set(id, m);
    materials.push(m);
    return m;
  };

  const root = new THREE.Object3D();
  root.name = "dz-player";
  const body = new THREE.Object3D();
  root.add(body);

  const joints: THREE.Object3D[] = [];
  for (let i = 0; i < JOINT_COUNT; i++) {
    const o = new THREE.Object3D();
    o.position.set(REST[i][0], REST[i][1], REST[i][2]);
    o.rotation.order = "YXZ";
    joints.push(o);
  }
  for (let i = 0; i < JOINT_COUNT; i++) {
    const p = PARENT[i];
    (p < 0 ? body : joints[p]).add(joints[i]);
  }

  for (const part of b.entries()) {
    const g = part.geo.toGeometry();
    geometries.push(g);
    const mesh = new THREE.Mesh(g, surfaceMaterial(part.surface));
    mesh.castShadow = true;
    // Self-receive: without it the underside of the jacket and the inside of
    // the legs stay lit from below and the whole figure floats.
    mesh.receiveShadow = true;
    // The character is always near the camera and its bounds change every
    // frame; culling per-mesh costs more than it saves.
    mesh.frustumCulled = false;
    joints[part.joint].add(mesh);
  }

  const glider = buildGlider(ctx, surfaceMaterial, geometries);
  glider.visible = false;
  // Parented to the yaw root rather than to `body`: the body carries the
  // dive's 68° nose-down pitch, and a canopy that inherited it would fly
  // edge-on through the whole dive→glide cross-fade.
  root.add(glider);

  const cells: THREE.Object3D[] = [];
  for (const child of glider.children) if (child.userData.cell) cells.push(child);

  return {
    root,
    body,
    joints,
    headGroup: joints[J_HEAD],
    glider,
    cells,
    geometries,
    materials,
    textures,
  };
}

/** Matrix that maps a +Y-aligned unit segment onto the line a→b. */
function segmentMatrix(a: THREE.Vector3, b: THREE.Vector3): THREE.Matrix4 {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length() || 1e-5;
  dir.divideScalar(len);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  return new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1));
}

/**
 * One ram-air cell: a real airfoil prism, blunt at the nose, thin at the
 * trailing edge, flat-ish underneath. Built per cell rather than as one wing
 * so the canopy can billow — each cell breathes on its own phase, which is
 * what a parafoil actually does and what makes a static wing look like a kite.
 */
function airfoilCell(halfSpan: number, chord: number, thick: number, paint: Paint, stations: number): Geo {
  const g = new Geo();
  const [br, bg, bb] = paintRgb(paint);
  const wear = paint.wear ?? 0.12;

  const t = (s: number) => thick * (0.3 + 0.7 * Math.sin(Math.PI * Math.pow(s, 0.6))) * (1 - s * 0.85);
  const zAt = (s: number) => -chord * 0.5 + s * chord;

  const grid: number[][][] = [];
  for (let i = 0; i <= stations; i++) {
    const s = i / stations;
    const th = t(s);
    grid.push([
      [-halfSpan, th, zAt(s)],
      [halfSpan, th, zAt(s)],
      [-halfSpan, -th * 0.32, zAt(s)],
      [halfSpan, -th * 0.32, zAt(s)],
    ]);
  }

  const quad = (p0: number[], p1: number[], p2: number[], p3: number[], shade: number) => {
    _v.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    _n.set(p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]).cross(_v).normalize();
    const k = shade;
    const i0 = g.vert(p0[0], p0[1], p0[2], _n.x, _n.y, _n.z, p0[0] * 2, p0[2] * 2, br * k, bg * k, bb * k);
    const i1 = g.vert(p1[0], p1[1], p1[2], _n.x, _n.y, _n.z, p1[0] * 2, p1[2] * 2, br * k, bg * k, bb * k);
    const i2 = g.vert(p2[0], p2[1], p2[2], _n.x, _n.y, _n.z, p2[0] * 2, p2[2] * 2, br * k, bg * k, bb * k);
    const i3 = g.vert(p3[0], p3[1], p3[2], _n.x, _n.y, _n.z, p3[0] * 2, p3[2] * 2, br * k, bg * k, bb * k);
    // `_n` above is (p3−p0)×(p1−p0), i.e. the opposite handedness to the
    // naive fan, so the fan is reversed to match it.
    g.tri(i0, i2, i1);
    g.tri(i0, i3, i2);
  };

  for (let i = 0; i < stations; i++) {
    const a = grid[i];
    const b2 = grid[i + 1];
    // Upper surface catches the sun, lower surface is in the wing's own
    // shadow all day — bake that in rather than hoping the light finds it.
    quad(a[0], a[1], b2[1], b2[0], 1 + wear * (1 - i / stations) * 0.5);
    quad(b2[2], b2[3], a[3], a[2], 0.52);
  }
  // Ribs at both ends of the cell. Doubling as the visible cell divider is
  // why the cells are spaced with a gap rather than butted together.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < stations; i++) {
      const a = grid[i];
      const b2 = grid[i + 1];
      const ui = sx < 0 ? 0 : 1;
      const li = sx < 0 ? 2 : 3;
      const p0 = a[ui], p1 = b2[ui], p2 = b2[li], p3 = a[li];
      if (sx < 0) quad(p3, p2, p1, p0, 0.7);
      else quad(p0, p1, p2, p3, 0.7);
    }
  }
  // Open nose: a dark inset face so the cell reads as inflated, not solid.
  const nose = grid[0];
  quad(nose[2], nose[3], nose[1], nose[0], 0.22);
  return g;
}

/**
 * The glider. A seven-cell parafoil on an anhedral arc, with real risers of
 * real thickness running down to a harness spreader at the shoulders.
 *
 * Everything here is oversized against a real wing by roughly 25% — the same
 * exaggeration the character carries — because a correctly-scaled canopy above
 * a stylised figure reads as a bedsheet.
 */
function buildGlider(
  ctx: WorldCtx,
  surfaceMaterial: (id: SurfaceId) => THREE.MeshStandardMaterial,
  geometries: THREE.BufferGeometry[],
): THREE.Object3D {
  const group = new THREE.Object3D();
  group.name = "dz-glider";

  const low = ctx.quality === "low";
  const cellCount = low ? 5 : 7;
  const stations = low ? 5 : 8;
  const arcR = 3.4;
  const halfArc = 0.58;
  const chord = 1.55;
  const thick = 0.19;
  const cellHalf = (halfArc * 2 * arcR) / cellCount / 2 - 0.02;

  const cloth = surfaceMaterial("cloth");
  const leather = surfaceMaterial("leather");
  const metal = surfaceMaterial("metal");

  const tipAnchors: THREE.Vector3[] = [];

  for (let i = 0; i < cellCount; i++) {
    const a = -halfArc + ((i + 0.5) / cellCount) * halfArc * 2;
    // Alternating panel colours with the hero orange on the outer cells, so
    // the wing reads as this player's kit from a kilometre up.
    const edge = Math.abs(i - (cellCount - 1) / 2) / ((cellCount - 1) / 2);
    const color = edge > 0.7 ? C_CANOPY_B : i % 2 === 0 ? C_CANOPY_A : C_CANOPY_C;
    // Tips are shorter in chord: an elliptical planform, not a rectangle.
    const taper = 1 - 0.22 * edge * edge;
    const geo = airfoilCell(cellHalf * taper, chord * taper, thick * taper, {
      color,
      ao: 0.18,
      wear: 0.2,
    }, stations);
    const g = geo.toGeometry();
    geometries.push(g);
    const mesh = new THREE.Mesh(g, cloth);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    // Rotating about Z by −a puts the cell's local up along the arc radius,
    // which is what gives the canopy its dished cross-section.
    const cell = new THREE.Object3D();
    cell.position.set(Math.sin(a) * arcR, Math.cos(a) * arcR - arcR, 0);
    cell.rotation.z = -a;
    // Sweep: the tips trail behind the centre, the way a real wing does.
    cell.position.z += edge * edge * 0.28;
    cell.userData.cell = true;
    cell.userData.phase = i * 0.7;
    cell.add(mesh);
    group.add(cell);

    tipAnchors.push(new THREE.Vector3(cell.position.x, cell.position.y - thick * 0.5, cell.position.z));
  }

  // ---- risers ------------------------------------------------------------
  // Two cascades per side: front risers to the quarter chord, rear risers to
  // three-quarter. Thin *boxes*, not lines — a zero-thickness line does not
  // catch light and it is one of the six tells.
  const harnessL = new THREE.Vector3(-0.19, -2.42, 0.06);
  const harnessR = new THREE.Vector3(0.19, -2.42, 0.06);
  const riserGeo = new Geo();
  for (let i = 0; i < cellCount; i++) {
    const anchor = tipAnchors[i];
    const harness = anchor.x < 0 ? harnessL : harnessR;
    for (const zOff of [-chord * 0.22, chord * 0.24]) {
      const a = new THREE.Vector3(anchor.x, anchor.y, anchor.z + zOff);
      const len = a.distanceTo(harness);
      const line = bevelBox(0.014, len * 0.5, 0.014, 0.005, {
        color: 0x2b2f36,
        wear: 0.5,
        ao: 0.15,
      });
      riserGeo.append(line, segmentMatrix(a, harness));
    }
  }
  {
    const g = riserGeo.toGeometry();
    geometries.push(g);
    const mesh = new THREE.Mesh(g, leather);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  // ---- harness spreader + hardware ---------------------------------------
  const hw = new Geo();
  for (const h of [harnessL, harnessR]) {
    hw.append(bevelBox(0.045, 0.06, 0.03, 0.012, { color: C_METAL_DARK, wear: 0.6, ao: 0.1 }),
      xf(h.x, h.y, h.z));
    hw.append(bevelBox(0.02, 0.028, 0.018, 0.006, { color: C_METAL, wear: 0.7, ao: 0.05 }),
      xf(h.x, h.y - 0.07, h.z));
  }
  hw.append(bevelBox(0.2, 0.018, 0.026, 0.008, { color: C_METAL_DARK, wear: 0.5, ao: 0.1 }),
    xf(0, harnessL.y + 0.02, harnessL.z));
  {
    const g = hw.toGeometry();
    geometries.push(g);
    const mesh = new THREE.Mesh(g, metal);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  // The wing rides above and slightly ahead of the pilot.
  group.position.set(0, 3.62, -0.12);
  return group;
}

// ---------------------------------------------------------------- poses
//
// Procedural animation, no clips. Each pose function fills a scratch buffer of
// Euler triples; the animator blends several of them by weight and applies the
// result. Blending Eulers is wrong in general — but every angle here is well
// inside ±90° on a single dominant axis per joint, which is exactly the regime
// where the linear blend and the slerp are indistinguishable, and it costs a
// twentieth of the quaternion bookkeeping.

interface Pose {
  rot: Float32Array;
  /** [posX, posY, posZ, pitch, yaw, roll] applied to the body node. */
  root: Float32Array;
}

const makePose = (): Pose => ({ rot: new Float32Array(JOINT_COUNT * 3), root: new Float32Array(6) });

function poseReset(p: Pose): void {
  p.rot.fill(0);
  p.root.fill(0);
}

function poseAdd(out: Pose, src: Pose, w: number): void {
  if (w <= 0) return;
  for (let i = 0; i < out.rot.length; i++) out.rot[i] += src.rot[i] * w;
  for (let i = 0; i < out.root.length; i++) out.root[i] += src.root[i] * w;
}

function setJ(p: Pose, j: number, x: number, y = 0, z = 0): void {
  p.rot[j * 3] = x;
  p.rot[j * 3 + 1] = y;
  p.rot[j * 3 + 2] = z;
}

/**
 * Idle. Breathing on a slow sine, a weight shift on a slower one, and hands
 * held slightly forward and away from the hips. A character that is perfectly
 * still between inputs reads as paused, not alive.
 */
function poseIdle(p: Pose, t: number): void {
  poseReset(p);
  const breath = Math.sin(t * 1.35);
  const shift = Math.sin(t * 0.47);
  setJ(p, J_PELVIS, -0.02, shift * 0.05, shift * 0.035);
  setJ(p, J_SPINE, 0.03 + breath * 0.016, -shift * 0.03, 0);
  setJ(p, J_CHEST, 0.02 + breath * 0.02, -shift * 0.02, 0);
  setJ(p, J_NECK, -0.05 - breath * 0.012, 0, 0);

  for (const side of [-1, 1]) {
    const sho = side < 0 ? J_SHO_L : J_SHO_R;
    const arm = side < 0 ? J_ARM_L : J_ARM_R;
    const fore = side < 0 ? J_FORE_L : J_FORE_R;
    const hand = side < 0 ? J_HAND_L : J_HAND_R;
    setJ(p, sho, breath * 0.02, 0, side * 0.03);
    // The arms hang with a deliberate gap at the elbow so the silhouette has
    // daylight through it — a body with arms welded to its sides is a blob.
    setJ(p, arm, -0.1 + breath * 0.03, 0, side * 0.17);
    setJ(p, fore, 0.34, 0, side * -0.06);
    setJ(p, hand, 0.05, 0, side * 0.1);
  }
  for (const side of [-1, 1]) {
    const thigh = side < 0 ? J_THIGH_L : J_THIGH_R;
    const shin = side < 0 ? J_SHIN_L : J_SHIN_R;
    const foot = side < 0 ? J_FOOT_L : J_FOOT_R;
    setJ(p, thigh, 0.02, side * 0.05, side * 0.03 + shift * 0.02);
    setJ(p, shin, -0.06, 0, 0);
    setJ(p, foot, 0.04, side * 0.06, 0);
  }
  p.root[1] = breath * 0.006;
}

/**
 * The walk/run continuum. `run` is 0 at a walk and 1 at a full sprint and
 * interpolates every amplitude, so there is no blend pop at the transition.
 *
 * Phase is driven by distance travelled, never by time — that is the entire
 * fix for foot-slide, and it is why a player pushed by a slope or slowed by a
 * ramp still plants correctly.
 */
function poseLocomotion(p: Pose, phase: number, run: number): void {
  poseReset(p);
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const s2 = Math.sin(phase * 2);

  const thighAmp = lerp(0.52, 0.86, run);
  const kneeAmp = lerp(0.72, 1.35, run);
  const armAmp = lerp(0.45, 0.95, run);
  const lean = lerp(0.06, 0.3, run);

  // Torso: lean into the run, counter-rotate the shoulders against the hips.
  setJ(p, J_PELVIS, -lean * 0.25, s * lerp(0.08, 0.16, run), -s * lerp(0.05, 0.09, run));
  setJ(p, J_SPINE, lean * 0.45, -s * lerp(0.06, 0.13, run), s * 0.03);
  setJ(p, J_CHEST, lean * 0.45, -s * lerp(0.05, 0.12, run), 0);
  setJ(p, J_NECK, -lean * 0.8, 0, 0);

  for (const side of [-1, 1]) {
    const sign = side < 0 ? 1 : -1;
    const ph = phase + (sign > 0 ? 0 : Math.PI);
    const sp = Math.sin(ph);
    const thigh = side < 0 ? J_THIGH_L : J_THIGH_R;
    const shin = side < 0 ? J_SHIN_L : J_SHIN_R;
    const foot = side < 0 ? J_FOOT_L : J_FOOT_R;

    // Knee flexes hard through the swing and only slightly through stance,
    // which is the difference between a walk and a march.
    const swing = Math.max(0, Math.sin(ph - 0.7));
    const stance = Math.max(0, -Math.sin(ph - 0.4));
    setJ(p, thigh, sp * thighAmp, side * 0.04, side * 0.03);
    setJ(p, shin, -(swing * kneeAmp + stance * lerp(0.1, 0.28, run)), 0, 0);
    // Toe-off then heel-strike: the ankle leads the foot at both ends.
    setJ(p, foot, -sp * 0.28 + swing * 0.3 - stance * 0.12, side * 0.05, 0);

    const arm = side < 0 ? J_ARM_L : J_ARM_R;
    const fore = side < 0 ? J_FORE_L : J_FORE_R;
    const hand = side < 0 ? J_HAND_L : J_HAND_R;
    const sho = side < 0 ? J_SHO_L : J_SHO_R;
    // Counter-swing: the arm opposes its own-side leg.
    setJ(p, sho, -sp * 0.06, 0, side * (0.03 + run * 0.05));
    setJ(p, arm, -sp * armAmp, 0, side * lerp(0.13, 0.2, run));
    setJ(p, fore, lerp(0.35, 0.85, run) + Math.max(0, -sp) * lerp(0.25, 0.6, run), 0, side * -0.05);
    setJ(p, hand, 0.05, 0, side * 0.08);
  }

  // Two bobs and one sway per stride, plus a small forward pitch under load.
  p.root[1] = -lerp(0.02, 0.075, run) * (0.5 - 0.5 * Math.cos(phase * 2)) - lerp(0.005, 0.03, run);
  p.root[0] = c * lerp(0.018, 0.035, run);
  p.root[5] = -s2 * lerp(0.012, 0.03, run);
}

/** Crouch-walk: hips dropped, stride short and flat, torso folded forward. */
function poseCrouchWalk(p: Pose, phase: number, move: number): void {
  poseReset(p);
  const s = Math.sin(phase) * move;
  setJ(p, J_PELVIS, 0.34, s * 0.05, 0);
  setJ(p, J_SPINE, 0.18, -s * 0.05, 0);
  setJ(p, J_CHEST, 0.1, -s * 0.04, 0);
  setJ(p, J_NECK, -0.4, 0, 0);
  for (const side of [-1, 1]) {
    const sign = side < 0 ? 1 : -1;
    const ph = phase + (sign > 0 ? 0 : Math.PI);
    const sp = Math.sin(ph) * move;
    setJ(p, side < 0 ? J_THIGH_L : J_THIGH_R, 1.12 + sp * 0.34, side * 0.14, side * 0.1);
    setJ(p, side < 0 ? J_SHIN_L : J_SHIN_R, -1.5 - Math.max(0, sp) * 0.4, 0, 0);
    setJ(p, side < 0 ? J_FOOT_L : J_FOOT_R, 0.42 - sp * 0.16, side * 0.08, 0);
    setJ(p, side < 0 ? J_ARM_L : J_ARM_R, -0.28 - sp * 0.3, 0, side * 0.2);
    setJ(p, side < 0 ? J_FORE_L : J_FORE_R, 0.9, 0, side * -0.08);
    setJ(p, side < 0 ? J_HAND_L : J_HAND_R, 0.06, 0, 0);
  }
  // The whole rig drops; the capsule shrinks by the same amount in fixed().
  p.root[1] = -0.42;
}

/**
 * Airborne. Rising and falling are different poses: on the way up the legs
 * tuck and the arms come in, on the way down they reach for the ground.
 * Interpolating on vertical velocity means a long fall settles into the
 * landing-ready shape all by itself.
 */
function poseAir(p: Pose, vy: number): void {
  poseReset(p);
  const rise = clamp01(vy / 7);
  const fall = clamp01(-vy / 14);
  setJ(p, J_PELVIS, lerp(0.16, -0.06, fall), 0, 0);
  setJ(p, J_SPINE, lerp(0.2, 0.06, fall), 0, 0);
  setJ(p, J_CHEST, 0.06, 0, 0);
  setJ(p, J_NECK, -0.12 - fall * 0.1, 0, 0);
  for (const side of [-1, 1]) {
    setJ(p, side < 0 ? J_SHO_L : J_SHO_R, -0.1 - rise * 0.15, 0, side * 0.06);
    setJ(p, side < 0 ? J_ARM_L : J_ARM_R, lerp(-0.5, -1.15, fall) - rise * 0.4, 0, side * lerp(0.3, 0.62, fall));
    setJ(p, side < 0 ? J_FORE_L : J_FORE_R, lerp(1.1, 0.55, fall), 0, side * -0.12);
    setJ(p, side < 0 ? J_HAND_L : J_HAND_R, 0.1, 0, side * 0.12);
    // Trailing leg tucked, leading leg reaching — asymmetry stops the jump
    // reading as a frog hop.
    const bias = side < 0 ? 1 : -1;
    setJ(p, side < 0 ? J_THIGH_L : J_THIGH_R, lerp(0.7, 0.22, fall) + bias * 0.16, side * 0.08, side * 0.08);
    setJ(p, side < 0 ? J_SHIN_L : J_SHIN_R, lerp(-1.25, -0.4, fall) - bias * 0.2, 0, 0);
    setJ(p, side < 0 ? J_FOOT_L : J_FOOT_R, lerp(0.3, -0.18, fall), 0, 0);
  }
}

/**
 * The dive. Belly-down, arms swept back along the body, knees bent, back
 * arched — the shape everybody recognises from the first ten seconds of a BR
 * match. `steer` is the horizontal input, and it banks and yaws the whole
 * body so the dive looks flown rather than dropped.
 */
function poseDive(p: Pose, steer: number, pitchIn: number, t: number): void {
  poseReset(p);
  const flap = Math.sin(t * 11) * 0.03;
  setJ(p, J_PELVIS, -0.22, 0, -steer * 0.12);
  setJ(p, J_SPINE, -0.18, steer * 0.1, -steer * 0.15);
  setJ(p, J_CHEST, -0.16 + pitchIn * 0.1, steer * 0.12, -steer * 0.12);
  setJ(p, J_NECK, -0.55, steer * 0.14, 0);
  for (const side of [-1, 1]) {
    setJ(p, side < 0 ? J_SHO_L : J_SHO_R, -0.3, 0, side * 0.12);
    // Arms raked back and out, the way a tracking suit actually flies.
    setJ(p, side < 0 ? J_ARM_L : J_ARM_R, -2.15 + flap - side * steer * 0.25, side * 0.2, side * (0.5 + flap));
    setJ(p, side < 0 ? J_FORE_L : J_FORE_R, 0.42, 0, side * -0.18);
    setJ(p, side < 0 ? J_HAND_L : J_HAND_R, -0.2, 0, side * 0.2);
    setJ(p, side < 0 ? J_THIGH_L : J_THIGH_R, -0.34 + side * steer * 0.18, side * 0.14, side * 0.26);
    setJ(p, side < 0 ? J_SHIN_L : J_SHIN_R, -1.15 - flap * 2, 0, 0);
    setJ(p, side < 0 ? J_FOOT_L : J_FOOT_R, -0.35, 0, 0);
  }
  // Face-down. Not quite vertical: a real tracking dive is 60–75° nose down,
  // and a fully vertical body has no silhouette from the ground.
  p.root[3] = -1.18;
  p.root[4] = steer * 0.18;
  p.root[5] = -steer * 0.42;
}

/** Under canopy: seated in the harness, hands up on the risers, legs loose. */
function poseGlide(p: Pose, steer: number, t: number): void {
  poseReset(p);
  const sway = Math.sin(t * 0.9) * 0.05;
  setJ(p, J_PELVIS, 0.42, 0, -steer * 0.1);
  setJ(p, J_SPINE, -0.14, steer * 0.06, -steer * 0.08);
  setJ(p, J_CHEST, -0.08, steer * 0.08, 0);
  setJ(p, J_NECK, -0.16, steer * 0.1, 0);
  for (const side of [-1, 1]) {
    const pull = side * steer > 0 ? 0.3 : 0;
    setJ(p, side < 0 ? J_SHO_L : J_SHO_R, 0.2, 0, side * 0.24);
    // Hands overhead on the risers; the inside hand pulls down in a turn.
    setJ(p, side < 0 ? J_ARM_L : J_ARM_R, 2.5 - pull + sway, 0, side * 0.52);
    setJ(p, side < 0 ? J_FORE_L : J_FORE_R, 0.34 + pull * 0.5, 0, side * -0.2);
    setJ(p, side < 0 ? J_HAND_L : J_HAND_R, -0.15, 0, side * 0.15);
    setJ(p, side < 0 ? J_THIGH_L : J_THIGH_R, 0.62 + sway * 0.5, side * 0.12, side * 0.18);
    setJ(p, side < 0 ? J_SHIN_L : J_SHIN_R, -0.72 - sway, 0, 0);
    setJ(p, side < 0 ? J_FOOT_L : J_FOOT_R, 0.16, 0, 0);
  }
  p.root[1] = -0.16;
  p.root[3] = -0.16;
  p.root[5] = -steer * 0.3;
}

/** Front crawl. Alternating strokes and a flutter kick, body near horizontal. */
function poseSwim(p: Pose, phase: number, t: number): void {
  poseReset(p);
  setJ(p, J_PELVIS, -0.1, 0, Math.sin(phase) * 0.12);
  setJ(p, J_SPINE, -0.1, Math.sin(phase) * 0.12, 0);
  setJ(p, J_CHEST, -0.12, Math.sin(phase) * 0.14, 0);
  setJ(p, J_NECK, -0.45, 0, 0);
  for (const side of [-1, 1]) {
    const ph = phase + (side < 0 ? 0 : Math.PI);
    const stroke = Math.sin(ph);
    setJ(p, side < 0 ? J_ARM_L : J_ARM_R, 1.2 + stroke * 1.6, 0, side * 0.35);
    setJ(p, side < 0 ? J_FORE_L : J_FORE_R, 0.5 + Math.max(0, -stroke) * 0.7, 0, 0);
    setJ(p, side < 0 ? J_HAND_L : J_HAND_R, 0.1, 0, 0);
    const kick = Math.sin(t * 7 + (side < 0 ? 0 : Math.PI));
    setJ(p, side < 0 ? J_THIGH_L : J_THIGH_R, kick * 0.34 - 0.1, side * 0.08, side * 0.1);
    setJ(p, side < 0 ? J_SHIN_L : J_SHIN_R, -0.3 - Math.max(0, kick) * 0.5, 0, 0);
    setJ(p, side < 0 ? J_FOOT_L : J_FOOT_R, -0.3, 0, 0);
  }
  // Near-horizontal, head up just enough to see where you are going.
  p.root[3] = -1.32;
  p.root[1] = -0.55;
}

/** Hanging from the bus handle: one arm up, body slack, legs dangling. */
function poseHang(p: Pose, t: number): void {
  poseReset(p);
  const swing = Math.sin(t * 1.1);
  setJ(p, J_PELVIS, 0.1, swing * 0.08, swing * 0.06);
  setJ(p, J_SPINE, 0.06, -swing * 0.05, 0);
  setJ(p, J_CHEST, 0.04, 0, 0);
  setJ(p, J_NECK, -0.2, swing * 0.1, 0);
  for (const side of [-1, 1]) {
    setJ(p, side < 0 ? J_SHO_L : J_SHO_R, 0.3, 0, side * 0.2);
    setJ(p, side < 0 ? J_ARM_L : J_ARM_R, 2.75, 0, side * 0.18);
    setJ(p, side < 0 ? J_FORE_L : J_FORE_R, 0.22, 0, 0);
    setJ(p, side < 0 ? J_HAND_L : J_HAND_R, -0.35, 0, 0);
    setJ(p, side < 0 ? J_THIGH_L : J_THIGH_R, 0.18 + swing * 0.06, side * 0.06, side * 0.08);
    setJ(p, side < 0 ? J_SHIN_L : J_SHIN_R, -0.5 - swing * 0.08, 0, 0);
    setJ(p, side < 0 ? J_FOOT_L : J_FOOT_R, 0.25, 0, 0);
  }
}

/** Downed: on one knee, folded over, one arm braced on the ground. */
function poseDown(p: Pose, t: number): void {
  poseReset(p);
  const heave = Math.sin(t * 2.2) * 0.05;
  setJ(p, J_PELVIS, 0.5, 0.2, 0.1);
  setJ(p, J_SPINE, 0.55 + heave, 0.12, 0.06);
  setJ(p, J_CHEST, 0.3 + heave, 0.1, 0);
  setJ(p, J_NECK, -0.45, -0.1, 0);
  setJ(p, J_ARM_L, -0.85, 0.2, -0.4);
  setJ(p, J_FORE_L, 0.5, 0, 0);
  setJ(p, J_HAND_L, 0.6, 0, 0);
  setJ(p, J_ARM_R, 0.6, 0, 0.5);
  setJ(p, J_FORE_R, 1.5, 0, -0.3);
  setJ(p, J_HAND_R, 0.2, 0, 0);
  setJ(p, J_THIGH_L, 1.7, 0.15, 0.2);
  setJ(p, J_SHIN_L, -1.9, 0, 0);
  setJ(p, J_FOOT_L, 0.4, 0, 0);
  setJ(p, J_THIGH_R, 0.9, -0.1, -0.1);
  setJ(p, J_SHIN_R, -1.6, 0, 0);
  setJ(p, J_FOOT_R, 0.5, 0, 0);
  p.root[1] = -0.62;
  p.root[3] = 0.1;
}

// ---------------------------------------------------------------- footsteps

/**
 * One sound name per surface family. The audio system synthesises these; if it
 * does not know a name it is expected to fall back, so a missing bank costs
 * variety rather than silence.
 */
const FOOTSTEP: Record<ImpactMaterial, { name: string; vol: number; rate: number }> = {
  grass: { name: "step-grass", vol: 0.34, rate: 1.0 },
  dirt: { name: "step-dirt", vol: 0.38, rate: 0.95 },
  sand: { name: "step-sand", vol: 0.3, rate: 0.88 },
  concrete: { name: "step-concrete", vol: 0.46, rate: 1.08 },
  metal: { name: "step-metal", vol: 0.52, rate: 1.22 },
  wood: { name: "step-wood", vol: 0.44, rate: 1.05 },
  glass: { name: "step-glass", vol: 0.5, rate: 1.3 },
  water: { name: "step-water", vol: 0.42, rate: 1.0 },
  flesh: { name: "step-dirt", vol: 0.3, rate: 0.9 },
};

/** What the HUD reads. One object, mutated in place, never reallocated. */
interface HudPayload {
  health: number;
  maxHealth: number;
  shield: number;
  maxShield: number;
  state: PlayerState;
  down: number;
  speed: number;
  altitude: number;
  grounded: boolean;
  aiming: boolean;
  crouched: boolean;
  sprinting: boolean;
  firstPerson: boolean;
  glider: boolean;
  busT: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;

  // ---- SOAKED. Present in both modes; meaningless (and inert) in classic,
  // so a HUD can read them unconditionally and branch on `water`.
  /** True when this is SOAKED and the fields below mean something. */
  water: boolean;
  /** 0..100. The same number as `health`, named for what it is. */
  dryness: number;
  /** 0..100. The same number as `shield`. */
  poncho: number;
  /** Band key for the bar colour and the callout label. */
  band: DrynessBand;
  /** 0..1 how wet you look — drives drips, gloss and the shiver. */
  wet: number;
  /** Ground friction multiplier underfoot, 0..1. Below 1 you are on water. */
  slip: number;
  /** True while at least one glue strand is attached to us. */
  glued: boolean;
  /** Who the nearest strand is stuck to, for "GLUED TO {name}". */
  gluedTo: string | null;
  /** 0..1 struggle progress; at 1 the strand peels off. */
  struggle: number;
  /** True while face-down from a stumble. */
  stumbling: boolean;
  /** True once dryness has hit zero. */
  soaked: boolean;
  /** True while stood outside the Downpour's safe zone. */
  inDownpour: boolean;
  /** True while something is actually drying us off. */
  drying: boolean;
}

// ---------------------------------------------------------------- system

/**
 * Our service: the shared `PlayerService` plus one documented escape hatch out
 * of the drop machine. Anyone reading `ctx.services.player` as a plain
 * `PlayerService` is unaffected.
 */
export interface DropZeroPlayerService extends PlayerService {
  /**
   * DEBUG / PHOTO ENTRY POINT: stand the player on the ground at `p`, and
   * cancel whatever the drop machine was doing to get there.
   *
   * `teleport` deliberately does *not* do this, and cannot. While `dropStage`
   * is `bus`, `skydive` or `glide` the position is derived every fixed step —
   * from the bus route, or by integrating the dive — so an outside write to
   * `position` is overwritten within 8 ms and the caller sees a teleport that
   * silently did nothing. That is precisely how the capture harness spent six
   * runs photographing the underside of the battle bus while pinning the
   * player 800 m away a hundred and twenty times a second.
   *
   * `match.skipToLive` calls this. Call it directly if you want to inspect a
   * ground-level system without flying the ninety-second drop first.
   */
  placeOnGround(p: THREE.Vector3): void;

  // ------------------------------------------------------------- SOAKED
  // These exist in both modes. In `classic` they read off health/shield and
  // the mutators are no-ops, so a caller never has to ask what mode it is.

  /** 0..100. Aliases `health`, because in SOAKED that is what health is. */
  readonly dryness: number;
  /** 0..100. Aliases `shield`. */
  readonly poncho: number;
  readonly maxDryness: number;
  readonly maxPoncho: number;
  /** Coarse band, for callouts and bar colour. */
  readonly drynessBand: DrynessBand;
  /** 0..1 — 1 is dripping. What the drips, gloss and shiver are driven from. */
  readonly wetness: number;
  /** True once dryness has reached zero. Out, not dead. */
  readonly soakedOut: boolean;
  /** True while any glue strand is attached. */
  readonly glued: boolean;
  /** True while face-down mid-stumble — no firing, no building. */
  readonly stumbling: boolean;
  /** Squad id published with every pose. Same string = do not soak each other. */
  team: string | null;

  /**
   * Take water. Routed through `WATER.dryness`'s poncho maths, so a poncho
   * eats it at a discount and a little always bleeds through. No-op in
   * classic — call `damage` there.
   */
  soak(amount: number, from?: THREE.Vector3, source?: DamageSource): void;
  /** Towel off. `dryness`/`poncho` are amounts to add, each clamped to its max. */
  dryOff(dryness: number, poncho: number): void;
  /**
   * Glue this player to something. `id` is a net peer id, a bot's
   * `DamageTarget.id`, or anything for a world anchor; `point` is where the
   * blob landed. Both ends of a player-to-player strand are expected to call
   * this on their own client — the pull is symmetric and nobody arbitrates.
   */
  glueTo(id: string | null, kind: GlueAnchorKind, point: THREE.Vector3, duration?: number): void;
  /** Release a strand by far-end id, or every strand when `id` is omitted. */
  unglue(id?: string | null, reason?: GlueBreakReason): void;
}

const createPlayer: SystemFactory = (ctx: WorldCtx): System => {
  const camera = ctx.camera;
  const BASE_FOV = camera.fov;

  /**
   * The seam. Read once: the mode cannot change inside a match, and a hundred
   * string comparisons a second in the hot path is a hundred too many.
   */
  const water = ctx.mode === "water";

  const position = new THREE.Vector3(0, 200, 0);
  const velocity = new THREE.Vector3();
  let yaw = 0;
  let pitch = 0;

  // ---- service, published first ------------------------------------------
  // Everything below this line is expensive (a whole character bake) and the
  // systems that boot after us must be able to find us even if that bake
  // throws — a player with no mesh is recoverable, a null service is not.
  const rigRoot = new THREE.Object3D();
  rigRoot.name = "dz-player-rig";

  const _eye = new THREE.Vector3();
  const _look = new THREE.Vector3();

  const service: DropZeroPlayerService = {
    position,
    velocity,
    yaw: 0,
    pitch: 0,
    camera,
    health: 100,
    maxHealth: 100,
    shield: 100,
    maxShield: 100,
    state: "ground",
    rig: rigRoot,
    eye(out) {
      const o = out ?? _eye;
      if (firstPerson) return o.copy(camera.position);
      /**
       * Third person: bullets must originate somewhere *on the aim ray*, or
       * they never converge on the crosshair — a fixed muzzle offset produces
       * a constant miss at every range, which is the classic third-person
       * shooter bug. So the origin is the camera pushed forward along its own
       * forward vector until it is roughly at the character's chest. It looks
       * like it came from the body and it hits exactly where you aimed.
       */
      service.look(_look);
      return o.copy(camera.position).addScaledVector(_look, armCurrent + 0.15);
    },
    look(out) {
      const o = out ?? _look;
      const cp = Math.cos(pitch);
      return o.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
    },
    damage(amount, from, source) {
      applyDamage(amount, from, source);
    },
    heal(hp, shieldAmt) {
      if (service.state === "dead") return;
      if (hp > 0) service.health = Math.min(service.maxHealth, service.health + hp);
      if (shieldAmt > 0) service.shield = Math.min(service.maxShield, service.shield + shieldAmt);
      ctx.emit("dz:heal", { hp, shield: shieldAmt });
    },
    /**
     * Move the body. Honoured on the ground, in the air and in water — but
     * NOT during `bus`, `skydive` or `glide`, where the position is derived
     * every fixed step from the bus route or from integrating the dive, and
     * an outside write survives at most one step. Use `placeOnGround` for
     * those; it ends the drop first, then places.
     */
    teleport(p) {
      position.copy(p);
      velocity.set(0, 0, 0);
      landingDip = 0;
    },
    placeOnGround(p) {
      placeOnGround(p);
    },
    get controllable() {
      if (!ctx.input.locked) return false;
      if (service.state === "dead") return false;
      // Face-down in a puddle is not a state you drive, shoot or build from.
      // Look still works (that is gated separately, on `locked`), so the
      // camera keeps running and you watch yourself get up.
      if (stumbleTimer > 0) return false;
      const phase = ctx.services.match?.phase;
      if (!phase) return true; // standalone / match failed to boot — let them play
      return phase === "warmup" || phase === "bus" || phase === "dropping" || phase === "live";
    },

    // ---------------------------------------------------------- SOAKED
    get dryness() {
      return service.health;
    },
    get poncho() {
      return service.shield;
    },
    get maxDryness() {
      return service.maxHealth;
    },
    get maxPoncho() {
      return service.maxShield;
    },
    get drynessBand() {
      return drynessBand(service.health).key;
    },
    get wetness() {
      return clamp01(1 - service.health / Math.max(1e-3, service.maxHealth));
    },
    get soakedOut() {
      return water && service.health <= 0;
    },
    get glued() {
      return activeStrands() > 0;
    },
    get stumbling() {
      return stumbleTimer > 0;
    },
    get team() {
      return team;
    },
    set team(t: string | null) {
      team = t || null;
    },
    soak(amount, from, source) {
      if (!water) return;
      applyDamage(amount, from, source);
    },
    dryOff(dry, pon) {
      if (service.state === "dead") return;
      if (dry > 0) {
        service.health = Math.min(service.maxHealth, service.health + dry);
        // A towel is a soak of its own kind: it resets the drying delay so a
        // player cannot chain "towel, wait one second, free natural drying".
        sinceSoak = 0;
      }
      if (pon > 0) service.shield = Math.min(service.maxShield, service.shield + pon);
      ctx.emit("dz:heal", { hp: dry, shield: pon });
    },
    glueTo(id, kind, point, duration) {
      linkGlue(id, kind, point, duration ?? GLUE.duration);
    },
    unglue(id, reason) {
      breakGlue(id ?? null, reason ?? "expired");
    },
  };
  ctx.services.player = service;

  if (water) {
    // Dryness and poncho are the same two numbers under different names, so
    // their ceilings come from the water table rather than from 100/100
    // happening to agree with it.
    service.maxHealth = DRYNESS.max;
    service.health = DRYNESS.max;
    service.maxShield = DRYNESS.ponchoMax;
    // You start with no poncho: it is a looted item, and starting behind the
    // blue bar is what makes finding one feel like finding something.
    service.shield = 0;
  }

  // ---- movement state ----------------------------------------------------
  let grounded = false;
  let wasGrounded = false;
  let coyote = 0;
  let jumpBuffered = 0;
  let jumpHeld = false;
  let crouching = false;
  let capsuleHeight = STAND_HEIGHT;
  let eyeHeight = STAND_EYE;
  let sliding = false;
  let landingDip = 0;
  let stepDistance = 0;
  let stepToggle = 0;
  let groundY = 0;
  let inWater = false;
  let spawnResolved = false;
  let sinceLanding = 99;

  // ---- drop state --------------------------------------------------------
  type DropStage = "none" | "bus" | "skydive" | "glide" | "landed";
  let dropStage: DropStage = "none";
  let glideT = 0;
  let diveTime = 0;
  let steerSmooth = 0;
  let glideYaw = 0;
  let windLevel = 0;

  // ---- camera state ------------------------------------------------------
  let firstPerson = false;
  let armCurrent = ARM_LENGTH;
  let shoulderCurrent = ARM_SHOULDER;
  let fovCurrent = BASE_FOV;
  let fireKick = 0;
  let fireKickPitch = 0;
  const camPivot = new THREE.Vector3(0, 200, 0);
  const camGoal = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  let camInit = false;
  /** Set when the rig has moved somewhere the smoothing must not travel to —
   *  boarding the bus, and stepping off it. Without it the arm spends a second
   *  flying between the bus and the diver, through the hull. */
  let camSnap = false;
  /** True while the arm is orbiting the bus rather than tracking the player. */
  let onBus = false;
  /**
   * Two-finger pinch zoom, as a multiplier consumed once per frame.
   *
   * The reader was written before the writer and this was never declared, so
   * `pinchScale` referred to nothing: three lines below reference it, and the
   * one that runs on EVERY frame — `pinchScale = 1` after the bus block — is an
   * assignment to an undeclared name. Under a module (`"use strict"`, which
   * every ESM file is) that throws a ReferenceError, which means the frame loop
   * died on its first tick and the world was a black screen.
   *
   * It typechecks and runs now, and holds 1 until something writes a pinch into
   * it — so the wheel path is unaffected and touch zoom is a producer away
   * rather than a rewrite.
   */
  let pinchScale = 1;
  const busPivot = new THREE.Vector3();
  const busDir = new THREE.Vector3();
  const busRight = new THREE.Vector3();

  // ---- animation state ---------------------------------------------------
  let bodyYaw = 0;
  let gaitPhase = 0;
  let runBlend = 0;
  let leanRoll = 0;
  let lastYaw = 0;

  // ---- health ------------------------------------------------------------
  let downTimer = 0;
  const DOWN_TIME = 45;

  // ---- SOAKED state ------------------------------------------------------

  /** Squad id. Published with every pose; peers on it are not soakable. */
  let team: string | null = null;
  /** Simulated seconds since the last drop of water landed on us. */
  let sinceSoak = DRYNESS.dryDelay;
  /** `ctx.elapsed` of the last storm-sourced soak — the Downpour handoff check. */
  let lastStormSoak = -Infinity;
  /** Ground friction multiplier under the feet, from `wetness.frictionAt`. */
  let slip = 1;
  /** Cached shelter answer, refreshed every `SHELTER_PERIOD` simulated seconds. */
  let sheltered = false;
  let shelterTimer = 0;
  /** True while stood outside the safe zone. Blocks all drying. */
  let inDownpour = false;
  /** True while something (air, a blower, a towel) is actually drying us. */
  let drying = false;
  /** Smoothed 0..1 look-wetness — drives gloss, drips and the shiver. */
  let wetLook = 0;
  /** Simulated-second accumulators for the trail and the drips. */
  let trackTimer = 0;
  let dripAccum = 0;
  /** Set once we hit zero dryness, so the SOAKED beat fires exactly once. */
  let soakedOut = false;

  /** Face-down timer and its immunity window, both in simulated seconds. */
  let stumbleTimer = 0;
  let stumbleCooldown = 0;
  /** Body roll accumulated through the tumble, radians. */
  let stumbleRoll = 0;
  /**
   * Struggle input, buffered in `update` and consumed by the next fixed step.
   * `input.pressed` is refilled per frame and a frame may run six steps, so
   * reading it inside `fixed` would count one press up to six times.
   */
  let strugglePressed = false;
  /** Cooldown on the skid cue, so a wet floor does not squeal every step. */
  let skidTimer = 0;

  /**
   * One glue strand, from our chest to something else.
   *
   * Both ends of a player-to-player strand run one of these on their own
   * client and neither is authoritative — the pull is symmetric by
   * construction, which is what makes deliberately dragging a glued teammate
   * out of the Downpour work without a single packet of negotiation.
   */
  interface GlueLink {
    /** Far-end id: a net peer id, a `DamageTarget.id`, or "" for a world anchor. */
    id: string;
    kind: GlueAnchorKind;
    /** World anchor, for ground/build strands and as the last known player point. */
    point: THREE.Vector3;
    /** Resolved actor for a bot far end, when combat could find one. */
    target: DamageTarget | null;
    /** Simulated seconds left before it lets go on its own. */
    life: number;
    /** Seconds spent stretched past `maxLength`. */
    over: number;
    /** 0..1 struggle progress. */
    struggle: number;
    active: boolean;
  }

  const strands: GlueLink[] = [];
  for (let i = 0; i < GLUE.maxStrands; i++) {
    strands.push({
      id: "",
      kind: "ground",
      point: new THREE.Vector3(),
      target: null,
      life: 0,
      over: 0,
      struggle: 0,
      active: false,
    });
  }
  const activeStrands = (): number => {
    let n = 0;
    for (const s of strands) if (s.active) n++;
    return n;
  };

  // ---- scratch -----------------------------------------------------------
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const wish = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const probeDir = new THREE.Vector3(0, -1, 0);
  /** Surface normal under the feet, refreshed by every integrate(). */
  const groundNormal = new THREE.Vector3(0, 1, 0);

  const poseOut = makePose();
  const poseScratch = makePose();

  const hud: HudPayload = {
    health: 100,
    maxHealth: 100,
    shield: 100,
    maxShield: 100,
    state: "ground",
    down: 0,
    speed: 0,
    altitude: 0,
    grounded: false,
    aiming: false,
    crouched: false,
    sprinting: false,
    firstPerson: false,
    glider: false,
    busT: 0,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    water,
    dryness: 100,
    poncho: 0,
    band: "bone-dry",
    wet: 0,
    slip: 1,
    glued: false,
    gluedTo: null,
    struggle: 0,
    stumbling: false,
    soaked: false,
    inDownpour: false,
    drying: false,
  };

  // ---- character ---------------------------------------------------------
  let rig: CharacterRig | null = null;
  try {
    rig = buildCharacter(ctx);
    rigRoot.add(rig.root);
  } catch (err) {
    // A character that fails to author should cost you the model, not the
    // game — movement, camera and combat all work without a mesh.
    console.error("[Drop Zero] player character failed to build:", err);
  }
  ctx.scene.add(rigRoot);

  // ---- damage ------------------------------------------------------------

  const hitPayload = { angle: 0, amount: 0, shield: false, lethal: false };

  function applyDamage(amount: number, from: THREE.Vector3 | undefined, source?: DamageSource): void {
    if (amount <= 0 || service.state === "dead") return;

    let remaining = amount;
    let tookShield = false;

    if (water) {
      /**
       * SOAKED: the poncho eats water at a discount and a little always bleeds
       * through, so a fully-ponchoed player still visibly gets wetter. All of
       * that lives in `applySoak` — this is the one place that calls it, which
       * is why every other system can keep calling plain `damage()`.
       */
      sinceSoak = 0;
      if (source?.by === "storm" || source?.weapon === "storm") lastStormSoak = ctx.elapsed;
      if (service.state === "down") {
        downTimer = Math.max(0, downTimer - amount * 0.6);
        remaining = 0;
      } else {
        const r = applySoak(service.health, service.shield, amount);
        tookShield = r.absorbedByPoncho > 0.001;
        remaining = r.toDryness;
        service.health = r.dryness;
        service.shield = r.poncho;
      }
    } else {
      if (service.shield > 0) {
        const absorbed = Math.min(service.shield, remaining);
        service.shield -= absorbed;
        remaining -= absorbed;
        tookShield = true;
      }
      if (service.state === "down") {
        // While downed there is no shield and the bleed-out clock takes the hit
        // directly — finishing someone should be fast.
        downTimer = Math.max(0, downTimer - amount * 0.6);
        remaining = 0;
      } else if (remaining > 0) {
        service.health = Math.max(0, service.health - remaining);
      }
    }

    // Directional indicator: the bearing to the shooter, expressed relative to
    // where the player is looking, so the HUD can just rotate a wedge by it.
    if (from) {
      tmp.subVectors(from, position);
      hitPayload.angle = angleDelta(yaw, Math.atan2(-tmp.x, -tmp.z));
    } else {
      hitPayload.angle = 0;
    }
    hitPayload.amount = amount;
    hitPayload.shield = tookShield;
    hitPayload.lethal = service.health <= 0;
    ctx.emit("dz:hit", hitPayload);

    if (water) {
      // Nothing here hurts. A hit is a splat on a poncho or a faceful of cold
      // water, and the cue is the same one the world uses for water landing on
      // anything else — that consistency is most of why the mode reads as play.
      ctx.services.audio?.play(tookShield && remaining <= 0.5 ? "poncho-splat" : "splash-body", {
        volume: clamp(0.3 + amount / 120, 0.3, 0.9),
        position,
      });
      // A drenching leaves standing water where you were standing.
      ctx.services.wetness?.splash(position, clamp(0.5 + amount * 0.012, 0.5, 1.8), amount * 0.08);
    } else {
      ctx.services.audio?.play(tookShield && remaining <= 0 ? "shield-hit" : "hurt", {
        volume: clamp(0.3 + amount / 120, 0.3, 0.9),
      });
    }
    // A hit shoves the view: small, fast, and it decays inside a third of a
    // second. Any bigger and it fights the player's aim instead of informing.
    fireKickPitch += clamp(amount * 0.0016, 0, 0.05);
    fireKick += clamp(amount * 0.004, 0, 0.14);

    if (service.health <= 0 && service.state !== "down") enterDown(source);
  }

  function enterDown(source?: DamageSource): void {
    // Solo BR has no revives, but the down state is what gives an elimination
    // its beat — the camera keeps running and the killfeed lands while you are
    // still on the ground, instead of cutting to black mid-firefight.
    service.state = "down";
    downTimer = DOWN_TIME;
    velocity.set(0, velocity.y, 0);
    if (water) enterSoaked(source);
    else {
      ctx.emit("dz:down", { by: source?.name ?? source?.by ?? "the storm" });
      ctx.services.audio?.play("down", { volume: 0.8 });
    }
  }

  /**
   * Zero dryness. Not a death — a slump and a squelch.
   *
   * Everything about this beat is comedy: the strands all let go at once, a
   * bucket of standing water arrives under you, the body flops into the down
   * pose and the squelch plays. The `down` state underneath is the same one
   * classic uses, so a squadmate towelling you off is the existing revive path
   * and not a second machine.
   */
  function enterSoaked(source?: DamageSource): void {
    if (soakedOut) return;
    soakedOut = true;
    service.health = 0;
    const by = source?.name ?? source?.by ?? WATER.strings.stormName;

    // Whoever you were glued to is free — nobody stays tethered to a puddle.
    breakGlue(null, "eliminated");

    ctx.services.audio?.play("squelch", { volume: 0.85, position });
    ctx.services.audio?.play(WATER.balloon.soundBurst, { volume: 0.5, position });
    // A generous puddle exactly where you went down, so the spot reads from
    // across the street and anyone who walks through it slips.
    ctx.services.wetness?.splash(position, 2.4, 14);
    ctx.services.vfx?.impact(position, up, "water");

    // Kept on `dz:down` so the HUD's existing knock/revive plumbing fires;
    // `dz:soaked` is the one the water HUD reads for the banner.
    ctx.emit("dz:down", { by, soaked: true });
    ctx.emit("dz:soaked", { by, x: position.x, y: position.y, z: position.z });
    ctx.services.net?.send("soaked", { by, x: position.x, y: position.y, z: position.z });
  }

  function enterDead(source?: DamageSource): void {
    if (service.state === "dead") return;
    service.state = "dead";
    service.health = 0;
    service.shield = 0;
    velocity.set(0, 0, 0);
    ctx.services.match?.reportDeath("player", source ?? { by: "world" });
    ctx.emit("dz:death", { by: source?.name ?? source?.by ?? "the storm" });
    ctx.services.audio?.play("death", { volume: 0.9 });
  }

  // ---- combat registration ----------------------------------------------
  let unregisterTarget: (() => void) | null = null;
  const damageTarget: DamageTarget = {
    id: "player",
    object: rigRoot,
    radius: RADIUS,
    height: STAND_HEIGHT,
    hp: 100,
    shield: 100,
    headY: STAND_EYE,
    faction: "player",
    alive: true,
    onDamage(amount, point, source, headshot) {
      // Combat owns the headshot multiplier and has already applied it.
      void headshot;
      applyDamage(amount, point, source);
      // Re-sync AFTER applying: whether or not combat also decremented these
      // fields itself, the authority is this module and the damage lands once.
      damageTarget.hp = service.health;
      damageTarget.shield = service.shield;
      damageTarget.alive = service.state !== "dead";
    },
  };

  // ---- world queries -----------------------------------------------------

  const terrainY = (x: number, z: number): number => ctx.services.terrain?.heightAt(x, z) ?? 0;
  const seaLevel = (): number => ctx.services.terrain?.seaLevel ?? -1e9;

  /**
   * First frame with a collision service, find a spot that is not inside a
   * building. POIs are dense and the origin is not guaranteed to be clear;
   * a widening spiral keeps the player near the intended start instead of
   * teleporting them across the island.
   */
  function findSpawn(): void {
    const collision = ctx.services.collision;
    const terrain = ctx.services.terrain;
    if (!collision || !terrain) return;
    spawnResolved = true;

    const probe = new THREE.Vector3();
    // "Clear" means roomy, not merely non-overlapping — a capsule swept at 3×
    // the player radius asks for elbow room, which in practice means a street
    // or a field rather than the gap between two sheds.
    const settle = (x: number, z: number): boolean => {
      probe.set(x, terrain.heightAt(x, z) + 1.2, z);
      if (terrain.isWater(x, z)) return false;
      return !collision.resolveCapsule(probe, RADIUS * 3, STAND_HEIGHT).hit;
    };

    if (settle(position.x, position.z)) {
      position.y = terrain.heightAt(position.x, position.z) + 0.05;
      return;
    }
    for (let r = 6; r <= 260; r += 10) {
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * TAU + r * 0.31;
        const x = position.x + Math.cos(a) * r;
        const z = position.z + Math.sin(a) * r;
        if (settle(x, z)) {
          position.set(x, terrain.heightAt(x, z) + 0.05, z);
          return;
        }
      }
    }
    position.y = terrain.heightAt(position.x, position.z) + 0.05;
  }

  /**
   * Integrate and push the capsule out of the world.
   *
   * `resolveCapsule` keys its continuous-collision history off the identity of
   * the vector handed to it, so this must always be the same `position` — a
   * scratch copy would give the substepper a stale previous position and let
   * a sprinting player tunnel a built wall.
   */
  function integrate(dt: number, height: number): void {
    const collision = ctx.services.collision;
    position.addScaledVector(velocity, dt);

    if (collision) {
      const res = collision.resolveCapsule(position, RADIUS, height);
      grounded = res.grounded && velocity.y <= 0.01;
      if (res.grounded) {
        groundY = res.groundY;
        // Snap down onto the support. Without this the capsule floats a
        // millimetre above a built floor and the ground probe flickers.
        if (position.y < groundY) position.y = groundY;
        else if (position.y - groundY < 0.06 && velocity.y <= 0) position.y = groundY;
        groundNormal.copy(res.groundNormal);
      } else {
        // Airborne: `groundY` still has to mean "the surface below me", because
        // the drop sequence reads `position.y - groundY` as its altitude and
        // deploys the glider off it. Reporting the capsule's own Y here made
        // the altitude zero and popped the canopy at bus height.
        groundY = terrainY(position.x, position.z);
        groundNormal.set(0, 1, 0);
      }
    } else {
      // No collision service: the heightfield alone is still a playable floor.
      const gy = terrainY(position.x, position.z);
      groundY = gy;
      grounded = position.y <= gy + 0.02 && velocity.y <= 0.01;
      if (position.y < gy) position.y = gy;
      if (ctx.services.terrain) ctx.services.terrain.normalAt(position.x, position.z, groundNormal);
      else groundNormal.set(0, 1, 0);
    }

    // The island bowl is the hard bound. Terrain owns the real extent; a
    // little slack past it lets the storm push you into the sea, which is
    // where it should be able to push you.
    const limit = (ctx.services.terrain?.worldSize ?? 1500) * 1.15;
    position.x = clamp(position.x, -limit, limit);
    position.z = clamp(position.z, -limit, limit);
  }

  /** Lift the capsule over a ledge no taller than STEP_HEIGHT before moving. */
  function stepUp(): void {
    const collision = ctx.services.collision;
    if (!collision || !grounded) return;
    const sp = Math.hypot(velocity.x, velocity.z);
    if (sp < 0.6) return;
    tmp.set(velocity.x / sp, 0, velocity.z / sp);
    tmp2.copy(position).addScaledVector(tmp, RADIUS + 0.24);
    tmp2.y = position.y + STEP_HEIGHT + 0.06;
    const hit = collision.raycast(tmp2, probeDir, STEP_HEIGHT + 0.3);
    if (!hit) return;
    // Only walkable tops count: a sloped roof edge should stop you, not
    // escalator you up the side of a building.
    if (hit.normal.y < 0.7) return;
    const lift = hit.point.y - position.y;
    if (lift > 0.06 && lift <= STEP_HEIGHT) {
      position.y = hit.point.y + 0.015;
      if (velocity.y < 0) velocity.y = 0;
    }
  }

  function footstep(scale: number): void {
    // A soaked player prints a trail. This runs before the audio bail-out on
    // purpose: the trail is gameplay — bots hunt on it — and losing it because
    // the audio system failed to boot would be a silent, unfindable bug.
    if (water) printTrack();

    const audio = ctx.services.audio;
    if (!audio) return;
    // Standing water under the boot sounds like water whatever the terrain
    // underneath it says — that splat is how you hear someone crossing a
    // puddle before you see them.
    const onPuddle = water && slip < 0.86;
    const mat =
      inWater || onPuddle
        ? "water"
        : ctx.services.terrain?.materialAt(position.x, position.z) ?? "dirt";
    const def = FOOTSTEP[mat] ?? FOOTSTEP.dirt;
    stepToggle ^= 1;
    audio.play(def.name, {
      position,
      volume: def.vol * scale,
      // Alternate feet get slightly different pitch, and every step gets a
      // little jitter — identical repeated samples are the fastest way to
      // make footsteps sound like a metronome.
      rate: def.rate * (stepToggle ? 1.0 : 0.94) * (0.96 + Math.random() * 0.08),
      maxDistance: 24,
    });
  }

  // ---- SOAKED: dryness, slip, tracks -------------------------------------

  /** Stable id for anything that identifies this player over the wire. */
  const selfId = (): string => ctx.services.net?.selfId ?? "player";

  /**
   * Print a wet footprint. `wetness.track` rate-limits per stride internally
   * and ignores anything below its own threshold, so a dry player calling this
   * every step costs a compare and nothing else.
   */
  function printTrack(): void {
    const w = ctx.services.wetness;
    if (!w) return;
    w.track(selfId(), position, service.wetness);
  }

  /** Is there a roof over us? One ray, cached — see `SHELTER_PERIOD`. */
  function refreshShelter(): void {
    const collision = ctx.services.collision;
    if (!collision) {
      sheltered = false;
      return;
    }
    tmp.set(position.x, position.y + eyeHeight, position.z);
    tmp2.set(0, 1, 0);
    sheltered = !!collision.raycast(tmp, tmp2, SHELTER_REACH);
  }

  /**
   * One step of the water body: friction underfoot, the Downpour, drying.
   *
   * Called from `fixed` before anything reads `slip`, and unconditionally —
   * dryness keeps ticking on the bus, in the dive and while downed, because a
   * timer that stops in some states is a timer players cannot reason about.
   */
  function waterStepBegin(dt: number): void {
    sinceSoak += dt;
    if (stumbleCooldown > 0) stumbleCooldown = Math.max(0, stumbleCooldown - dt);
    // The stumble clock lives here rather than in the locomotion branch so it
    // cannot be frozen by walking into the sea mid-tumble and taking the swim
    // path, which returns long before the ground code runs.
    if (stumbleTimer > 0) {
      stumbleTimer = Math.max(0, stumbleTimer - dt);
      if (stumbleTimer === 0) {
        ctx.emit("dz:stumble-up", null);
        ctx.services.audio?.play("land", { volume: 0.4, position });
      }
    }

    // --- friction underfoot -------------------------------------------------
    const wet = ctx.services.wetness;
    slip = wet ? clamp(wet.frictionAt(position.x, position.z), 0.05, 1) : 1;

    // --- the Downpour -------------------------------------------------------
    const storm = ctx.services.storm;
    const airborne = dropStage === "bus" || dropStage === "skydive" || dropStage === "glide";
    inDownpour = !!storm && !airborne && !storm.isSafe(position);
    if (inDownpour && service.state !== "dead" && service.state !== "down") {
      /**
       * The storm normally applies this for us — `storm.applyStormDamage`
       * calls `player.damage`, which in water mode is `applySoak`. This branch
       * only fires when nothing storm-shaped has landed on us for a couple of
       * ticks, i.e. when the storm has handed the rate over rather than
       * applying it. Never both: `applyDamage` stamps `lastStormSoak`.
       */
      if (ctx.elapsed - lastStormSoak > DOWNPOUR_HANDOFF) {
        const circle = storm.circle || 1;
        applyDamage(downpourSoak(circle) * dt, undefined, {
          by: "storm",
          name: WATER.strings.stormName,
          weapon: "storm",
        });
      }
      // Wind in the wall. Small — it is a nudge that tells you which way out
      // is downwind, not a shove that takes the rotation out of your hands.
      tmp.subVectors(storm!.center, position);
      tmp.y = 0;
      if (tmp.lengthSq() > 1e-6) {
        tmp.normalize();
        velocity.x -= tmp.x * DOWNPOUR.wind * dt;
        velocity.z -= tmp.z * DOWNPOUR.wind * dt;
      }
    }

    // Nothing dries a body that is already out. Without this the natural dry
    // rate would tick a downed player back over zero five seconds after they
    // went down and stand them straight back up, which is not a revive — it is
    // the down state failing to mean anything.
    if (service.state === "dead" || service.state === "down") return;

    // --- drying -------------------------------------------------------------
    shelterTimer -= dt;
    if (shelterTimer <= 0) {
      shelterTimer = SHELTER_PERIOD;
      refreshShelter();
    }
    const standingInWater =
      inWater || slip < 1 - PUDDLE_WET || !!ctx.services.terrain?.isWater(position.x, position.z);
    const before = service.health;
    service.health = dryStep(
      service.health,
      {
        sinceSoak,
        inRain: inDownpour || standingInWater,
        sprinting: runBlend > 0.5,
        sheltered,
      },
      dt,
    );
    // A drying station beats the weather: it is contested ground and it has to
    // be worth crossing the map for, so its rate is added on top rather than
    // folded into the multiplier stack.
    const station = ctx.services.wetness?.dryingRateAt(position) ?? 0;
    if (station > 0 && !inDownpour) {
      service.health = Math.min(DRYNESS.dryCap, service.health + station * dt);
    }
    drying = service.health > before + 1e-6;

    // Catch-all: dryness can reach zero without a `damage()` call ever having
    // been made (a Downpour tick the storm owns, a scripted soak). `down` and
    // `dead` already returned above, so this can only fire on a live body.
    if (service.health <= 0 && !soakedOut) enterDown();
  }

  // ---- SOAKED: glue ------------------------------------------------------

  /**
   * Attach a strand. Called for BOTH ends of a player-to-player link — once
   * locally when our own glue gun sticks, once from the wire when somebody
   * else's sticks to us — which is what makes the pull symmetric without a
   * single line of negotiation.
   */
  function linkGlue(
    id: string | null,
    kind: GlueAnchorKind,
    point: THREE.Vector3,
    duration = GLUE.duration,
  ): void {
    // Nothing sticks to a puddle. A soaked or dead body drops every strand and
    // refuses new ones, which is also what stops a strand outliving its owner.
    if (!water || service.state === "dead" || service.state === "down") return;
    const key = id ?? "";
    // Re-gluing the same pair refreshes the strand rather than stacking two.
    let link = strands.find((s) => s.active && s.id === key && s.kind === kind);
    if (!link) link = strands.find((s) => !s.active);
    if (!link) {
      // Past `maxStrands` the oldest gives way. A player wrapped in six ropes
      // is not stuck, they are deleted, and this mode never removes control.
      link = strands.reduce((a, b) => (b.life < a.life ? b : a), strands[0]);
    }
    link.id = key;
    link.kind = kind;
    link.point.copy(point);
    link.target = null;
    link.life = clamp(duration, 0.2, 60);
    link.over = 0;
    link.struggle = 0;
    link.active = true;

    // Bots and ghosts are `DamageTarget`s; resolving one now means the strand
    // tracks a moving body instead of the spot the blob happened to land.
    if (kind === "player" && key) {
      const found = ctx.services.combat?.queryTargets(point, 6) ?? [];
      for (const t of found) {
        if (t.id === key) {
          link.target = t;
          break;
        }
      }
    }
    ctx.emit("dz:glued", { to: key || null, kind, duration: link.life });
    ctx.services.audio?.play(GLUE.soundStick, { position: point, volume: 0.7, maxDistance: 120 });
  }

  /** Release one strand (by far-end id) or all of them. */
  function breakGlue(id: string | null, reason: GlueBreakReason): void {
    let any = false;
    for (const s of strands) {
      if (!s.active) continue;
      if (id !== null && s.id !== id) continue;
      s.active = false;
      s.target = null;
      s.struggle = 0;
      any = true;
      ctx.emit("dz:glue-break", { from: selfId(), to: s.id || null, reason });
      ctx.services.net?.send("glue", { from: selfId(), to: s.id || undefined, broken: true });
    }
    if (any && reason !== "eliminated") {
      ctx.services.audio?.play(GLUE.soundSnap, { volume: 0.55, position });
    }
  }

  const _glueEnd = new THREE.Vector3();
  const _glueChest = new THREE.Vector3();
  const _gluePull = new THREE.Vector3();

  /** Where the far end of a strand is right now. False when it is gone. */
  function resolveGlueEnd(link: GlueLink, out: THREE.Vector3): boolean {
    if (link.kind !== "player") {
      out.copy(link.point);
      return true;
    }
    // A live actor (a bot, or a ghost registered with combat) wins: the strand
    // should track the body, not the spot the blob landed on it.
    if (link.target) {
      if (!link.target.alive) return false;
      link.target.object.getWorldPosition(out);
      out.y += link.target.height * 0.55;
      link.point.copy(out);
      return true;
    }
    const peer = ctx.services.net?.peers.get(link.id);
    if (peer) {
      if (!peer.posed || peer.dry <= 0) return false;
      out.set(peer.x, peer.y + GLUE_CHEST_Y, peer.z);
      link.point.copy(out);
      return true;
    }
    // Neither resolved this step. Coast on the last known point — a peer whose
    // packet is late must not snap the strand — but give up once the gap is
    // absurd, which is what a peer that quietly left looks like.
    out.copy(link.point);
    return true;
  }

  /**
   * Simulate every strand and return the movement multiplier they impose.
   *
   * The pull is applied to OUR velocity only. The other end applies its own,
   * from its own client, off its own copy of this function — that is the whole
   * protocol, and it is why dragging a glued teammate out of the Downpour
   * works: they feel the same acceleration toward you that you feel toward
   * them, and the two of you sort out who is stronger by running.
   */
  function glueFixed(dt: number, pressed: boolean): number {
    let slow = 1;
    const speed = Math.hypot(velocity.x, velocity.z);

    for (const link of strands) {
      if (!link.active) continue;
      link.life -= dt;
      if (link.life <= 0) {
        breakGlue(link.id, "expired");
        continue;
      }
      if (!resolveGlueEnd(link, _glueEnd)) {
        breakGlue(link.id, "eliminated");
        continue;
      }

      _glueChest.set(position.x, position.y + GLUE_CHEST_Y, position.z);
      _gluePull.subVectors(_glueEnd, _glueChest);
      const dist = _gluePull.length();
      if (dist > GLUE_LOST_DIST) {
        breakGlue(link.id, "stretched");
        continue;
      }

      if (link.kind === "player") {
        slow = Math.min(slow, glueSlow(dist));

        const accel = glueAccel(dist);
        if (accel > 0 && dist > 1e-4) {
          _gluePull.divideScalar(dist);
          velocity.x += _gluePull.x * accel * dt;
          velocity.z += _gluePull.z * accel * dt;
          // Mostly horizontal on purpose: a full 3D pull toward somebody on a
          // roof turns the glue gun into a grappling hook.
          velocity.y += _gluePull.y * accel * GLUE_VERTICAL_SHARE * dt;
        }

        // Past max length the strand is on borrowed time.
        if (dist > GLUE.maxLength) {
          link.over += dt;
          if (link.over >= GLUE.snapHold) {
            breakGlue(link.id, "stretched");
            continue;
          }
        } else {
          link.over = 0;
        }

        // Move fast while stretched and you go over. Poisson-ish, off simulated
        // dt, so the same tether feels the same at 30 fps and at 240.
        if (grounded && stumbleTimer <= 0 && stumbleCooldown <= 0) {
          if (ctx.rng() < stumbleChance(speed, dist, dt)) enterStumble();
        }
      } else {
        // Ground/build anchor: no pull, just a leash you can walk the radius of.
        if (dist > GLUE.anchorRadius) {
          const pullBack = Math.min(GLUE.maxPull, (dist - GLUE.anchorRadius) * GLUE.pullPerMetre);
          _gluePull.divideScalar(dist || 1);
          velocity.x += _gluePull.x * pullBack * dt;
          velocity.z += _gluePull.z * pullBack * dt;
        }
        slow = Math.min(slow, GLUE.anchorSlow);
      }

      link.struggle = struggleStep(link.struggle, pressed, dt);
      if (link.struggle >= 1) {
        breakGlue(link.id, "struggled");
        continue;
      }
    }
    return slow;
  }

  // ---- SOAKED: the stumble -----------------------------------------------

  /**
   * Go down. A real tumble you get up from — never a stun.
   *
   * `controllable` is false for `GLUE.fallTime`, which is what takes firing and
   * building away; movement input stops with it, the body flops into the down
   * pose and rolls, and then you stand back up with a cooldown so a single
   * strand cannot chain-stumble you into oblivion.
   */
  function enterStumble(): void {
    if (stumbleTimer > 0) return;
    stumbleTimer = GLUE.fallTime;
    stumbleCooldown = GLUE.fallTime + GLUE.fallCooldown;
    stumbleRoll = 0;

    // Keep the momentum that put you here, add a small pop, and let the tumble
    // carry you a metre or two — stopping dead reads as a hitch, not a fall.
    const sp = Math.hypot(velocity.x, velocity.z);
    if (sp > 1e-3) {
      velocity.x = (velocity.x / sp) * Math.min(sp, STUMBLE_LAUNCH);
      velocity.z = (velocity.z / sp) * Math.min(sp, STUMBLE_LAUNCH);
    }
    velocity.y = Math.max(velocity.y, STUMBLE_POP);

    applyDamage(GLUE.fallSoak, undefined, { by: "world", name: WATER.strings.stumbled });
    ctx.services.audio?.play(GLUE.soundStumble, { volume: 0.75, position });
    ctx.services.wetness?.splash(position, 1.1, 3);
    ctx.emit("dz:stumble", { x: position.x, y: position.y, z: position.z });
  }

  // ---- SOAKED: the wire --------------------------------------------------

  /**
   * What we call our movement state on the wire.
   *
   * `NetPose.state` is a plain string precisely so this can say things the
   * engine's `PlayerState` union has never heard of. `service.state` stays a
   * legal `PlayerState` for every local consumer.
   */
  function netState(): string {
    if (service.state === "dead") return "soaked";
    if (soakedOut || service.state === "down") return "soaked";
    if (stumbleTimer > 0) return "stumble";
    if (activeStrands() > 0) return "glued";
    return service.state;
  }

  function publishPose(): void {
    const net = ctx.services.net as NetService | undefined;
    if (!net) return;
    // The transport rate-limits and change-gates; calling it every frame is
    // the documented usage and is cheaper than us keeping a second clock.
    net.publishPose({
      x: position.x,
      y: position.y,
      z: position.z,
      yaw,
      pitch,
      state: netState(),
      dry: service.health,
      team: team ?? undefined,
    });
  }

  /**
   * Inbound glue. Two shapes reach us:
   *
   *  - `dz:glue`, emitted locally by our own weapon when its blob sticks. We
   *    are the near end, so we feel the pull too.
   *  - net `glue`, from a peer whose blob stuck to US.
   *
   * Both are parsed with the same tolerance the ghost renderer uses, because
   * the payload shape lives in the weapon module and is not ours to pin down.
   */
  interface GlueWire {
    from?: unknown;
    to?: unknown;
    target?: unknown;
    id?: unknown;
    anchor?: unknown;
    x?: number;
    y?: number;
    z?: number;
    duration?: number;
    broken?: boolean;
  }

  const _glueAt = new THREE.Vector3();

  function asId(v: unknown): string | null {
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  /** Nearest peer to a point, within `range`. Null when nobody is close. */
  function peerNear(point: THREE.Vector3, range: number): string | null {
    const peers = ctx.services.net?.peers;
    if (!peers) return null;
    let best: string | null = null;
    let bestSq = range * range;
    for (const [id, pr] of peers) {
      if (!pr.posed) continue;
      const dx = pr.x - point.x;
      const dy = pr.y + GLUE_CHEST_Y - point.y;
      const dz = pr.z - point.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestSq) {
        bestSq = d2;
        best = id;
      }
    }
    return best;
  }

  function onGlueEvent(payload: unknown, fromWire: string | null): void {
    if (!water) return;
    const p = (payload ?? {}) as GlueWire;
    const me = selfId();
    const from = asId(p.from) ?? fromWire;
    let to = asId(p.to) ?? asId(p.target) ?? asId(p.id);

    const hasPoint = Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
    if (hasPoint) _glueAt.set(p.x as number, p.y as number, p.z as number);

    /**
     * Fill in a far end the shooter could not name.
     *
     * A glue blob that sticks to a remote player resolves to a `DamageTarget`
     * only if something registered one for that peer — and nothing is required
     * to. Rather than let the strand silently not exist, fall back to geometry:
     * a blob that landed within a body's width of somebody landed *on* them.
     * The radius is deliberately tight, so gluing the floor beside a player
     * still reads as gluing the floor.
     */
    const STICK_RADIUS = RADIUS + 0.6;
    if (!to && hasPoint && from !== me) {
      _glueChest.set(position.x, position.y + GLUE_CHEST_Y, position.z);
      if (_glueChest.distanceTo(_glueAt) <= STICK_RADIUS) to = me;
    }
    if (!to && hasPoint && from === me) to = peerNear(_glueAt, STICK_RADIUS);

    // Which end are we? Our own gun fired it (`from === me`) → the far end is
    // `to`. Somebody glued us (`to === me` or the local target id) → the far
    // end is them.
    let other: string | null = null;
    if (from === me) other = to;
    else if (to === me || to === damageTarget.id) other = from;
    else return;

    if (p.broken) {
      breakGlue(other ?? "", "expired");
      return;
    }
    // A named far end is always a body, whatever the sender called the anchor:
    // the sender says "ground" when *it* could not resolve a target, and we may
    // have resolved one it could not see.
    const kind: GlueAnchorKind = other ? "player" : p.anchor === "build" ? "build" : "ground";
    _glueAt.set(
      Number.isFinite(p.x) ? (p.x as number) : position.x,
      Number.isFinite(p.y) ? (p.y as number) : position.y + GLUE_CHEST_Y,
      Number.isFinite(p.z) ? (p.z as number) : position.z,
    );
    if (kind !== "player") {
      /**
       * A static anchor is a leash of `anchorRadius`, so it only makes sense
       * within arm's reach. Honouring one that landed fifty metres away would
       * reel the player across the map — a grappling hook, which is exactly
       * the thing this weapon is tuned never to be.
       */
      _glueChest.set(position.x, position.y + GLUE_CHEST_Y, position.z);
      if (_glueChest.distanceTo(_glueAt) > GLUE.maxLength) return;
    }
    linkGlue(other, kind, _glueAt, Number.isFinite(p.duration) ? (p.duration as number) : GLUE.duration);
  }

  /**
   * Knockback from a soaking. `weapons` says how hard and in which direction;
   * whoever owns the movement — us — decides what that does to a body. Getting
   * shoved off your own ramp tower by a Firehose is the best thing in the mode
   * and it lives in these six lines.
   */
  function onSoakPush(payload: unknown): void {
    // Deliberately NOT gated on `controllable`: being shoved further along the
    // floor while you are already face-down is the funniest possible outcome
    // and there is no reason to protect anyone from it.
    if (!water || service.state === "dead") return;
    const p = (payload ?? {}) as { id?: string; px?: number; py?: number; pz?: number };
    if (p.id !== damageTarget.id) return;
    if (Number.isFinite(p.px)) velocity.x += p.px as number;
    if (Number.isFinite(p.py)) velocity.y += p.py as number;
    if (Number.isFinite(p.pz)) velocity.z += p.pz as number;
  }

  // ---- SOAKED: drips ------------------------------------------------------

  /**
   * Water shed off a soaked body.
   *
   * One `InstancedMesh` of stretched droplets, one draw call, a hard cap of
   * `DRIP_COUNT`. They are transparent and nearly smooth so the environment map
   * does the sparkling, they fall under real gravity, and they hand their water
   * to the wetness field when they land — so standing around dripping actually
   * makes the floor under you slippery.
   */
  interface Drip {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    life: number;
  }

  let dripMesh: THREE.InstancedMesh | null = null;
  let dripGeo: THREE.BufferGeometry | null = null;
  let dripMat: THREE.MeshStandardMaterial | null = null;
  const drips: Drip[] = [];
  let dripCursor = 0;
  const _dripM = new THREE.Matrix4();
  const _dripQ = new THREE.Quaternion();
  const _dripP = new THREE.Vector3();
  const _dripS = new THREE.Vector3();
  const _dripUp = new THREE.Vector3(0, 1, 0);
  const _dripDir = new THREE.Vector3();

  function ensureDrips(): boolean {
    if (dripMesh) return true;
    if (!water) return false;
    try {
      dripGeo = new THREE.SphereGeometry(DRIP_RADIUS, 6, 4);
      dripMat = new THREE.MeshStandardMaterial({
        color: 0xdff4ff,
        // Water reads through gloss and refraction, never through blue paint:
        // a near-zero roughness with the sky probe behind it is what makes a
        // droplet catch the sun instead of looking like a painted bead.
        roughness: 0.04,
        metalness: 0,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        envMap: ctx.services.materials?.env ?? null,
        envMapIntensity: 2.2,
      });
      dripMesh = new THREE.InstancedMesh(dripGeo, dripMat, DRIP_COUNT);
      dripMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      dripMesh.frustumCulled = false;
      dripMesh.castShadow = false;
      dripMesh.receiveShadow = false;
      dripMesh.renderOrder = 3;
      for (let i = 0; i < DRIP_COUNT; i++) {
        drips.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0 });
        // Park unused instances at zero scale rather than at the origin, where
        // they would render as a permanent puddle of beads under the map.
        _dripM.makeScale(0, 0, 0);
        dripMesh.setMatrixAt(i, _dripM);
      }
      ctx.scene.add(dripMesh);
      return true;
    } catch (err) {
      console.warn("[SOAKED] drip pool failed to build:", err);
      dripMesh = null;
      return false;
    }
  }

  function spawnDrip(): void {
    if (!dripMesh) return;
    const d = drips[dripCursor];
    dripCursor = (dripCursor + 1) % DRIP_COUNT;
    // `Math.random`, not `ctx.rng`: the shared stream is the one worldgen and
    // the stumble roll draw from, and burning fifteen draws a second on
    // cosmetics would make every gameplay roll downstream of how wet you look.
    const a = Math.random() * TAU;
    const r = 0.16 + Math.random() * 0.24;
    // Shed from anywhere on the silhouette: hem, cuffs, the brim of the head.
    d.x = position.x + Math.cos(a) * r;
    d.z = position.z + Math.sin(a) * r;
    d.y = position.y + 0.35 + Math.random() * 1.35;
    d.vx = velocity.x * 0.25 + (Math.random() - 0.5) * 0.4;
    d.vz = velocity.z * 0.25 + (Math.random() - 0.5) * 0.4;
    d.vy = -0.3 - Math.random() * 0.6;
    d.life = 1.6;
  }

  function updateDrips(dt: number): void {
    if (!dripMesh) return;
    let live = false;
    for (let i = 0; i < DRIP_COUNT; i++) {
      const d = drips[i];
      if (d.life <= 0) continue;
      live = true;
      d.life -= dt;
      d.vy += DRIP_GRAVITY * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;

      const floor = terrainY(d.x, d.z);
      if (d.y <= floor + 0.01 || d.life <= 0) {
        d.life = 0;
        // The water has to go somewhere, and where it goes is the floor.
        ctx.services.wetness?.splash(_dripP.set(d.x, floor, d.z), 0.3, 0.12);
        _dripM.makeScale(0, 0, 0);
        dripMesh.setMatrixAt(i, _dripM);
        continue;
      }
      // Stretch along the direction of travel: a falling droplet is a streak,
      // and a sphere at this size just reads as a floating dot.
      _dripDir.set(d.vx, d.vy, d.vz);
      const sp = _dripDir.length();
      if (sp > 1e-4) _dripDir.divideScalar(sp);
      else _dripDir.set(0, -1, 0);
      _dripQ.setFromUnitVectors(_dripUp, _dripDir);
      const stretch = 1 + Math.min(DRIP_STRETCH, sp * 0.09);
      _dripS.set(1, stretch, 1);
      _dripP.set(d.x, d.y, d.z);
      _dripM.compose(_dripP, _dripQ, _dripS);
      dripMesh.setMatrixAt(i, _dripM);
    }
    dripMesh.visible = live;
    if (live) dripMesh.instanceMatrix.needsUpdate = true;
  }

  // ---- drop sequence -----------------------------------------------------

  function enterSkydive(): void {
    const match = ctx.services.match;
    dropStage = "skydive";
    service.state = "skydive";
    diveTime = 0;
    if (match) {
      // Leave with the bus's momentum, plus a shove downward so the first
      // half-second is unmistakably a jump and not a step off a kerb.
      tmp.subVectors(match.busTo, match.busFrom);
      tmp.y = 0;
      if (tmp.lengthSq() > 1e-6) tmp.normalize();
      velocity.set(tmp.x * 16, -5, tmp.z * 16);
    } else {
      velocity.set(0, -5, 0);
    }
    ctx.emit("dz:skydive", null);
    ctx.services.audio?.play("dive-out", { volume: 0.7 });
  }

  function enterGlide(): void {
    dropStage = "glide";
    service.state = "glide";
    glideYaw = yaw;
    // Kill most of the vertical speed instantly — the canopy grabbing air is
    // supposed to be a jolt, and a smooth deceleration reads as a bug.
    velocity.y = Math.max(velocity.y, -18);
    ctx.emit("dz:glide", null);
    ctx.services.audio?.play("glider-deploy", { volume: 0.85 });
  }

  /** See the doc comment on `DropZeroPlayerService.placeOnGround`. */
  function placeOnGround(p: THREE.Vector3): void {
    // End the drop FIRST. Everything below is a write to state that the bus /
    // dive / glide steps would otherwise recompute from scratch.
    dropStage = "landed";
    service.state = "ground";
    glideT = 0;
    diveTime = 0;
    windLevel = 0;
    ctx.services.audio?.ambience("wind", false);

    position.copy(p);
    // Land on what is actually under the requested point rather than on the
    // caller's guess at a height: a photo vantage is authored in plan view and
    // the terrain here is anything but flat.
    const floor = terrainY(position.x, position.z);
    if (position.y < floor + 0.05) position.y = floor + 0.05;
    // Then push out of any building the point landed inside. POI interiors are
    // dense and "the centre of the plaza" is often the centre of a shed.
    ctx.services.collision?.resolveCapsule(position, RADIUS, STAND_HEIGHT);

    velocity.set(0, 0, 0);
    grounded = true;
    groundNormal.set(0, 1, 0);
    groundY = position.y;
    crouching = false;
    capsuleHeight = STAND_HEIGHT;
    eyeHeight = STAND_EYE;
    inWater = false;
    // This is a placement, not an arrival: no landing dip, no fall damage
    // accumulator, and no "just landed" window for the animation to play.
    landingDip = 0;
    sinceLanding = 99;
    spawnResolved = true;
    // The spring arm damps toward the pivot; from wherever the camera was it
    // would otherwise fly across the island for several visible seconds.
    camInit = false;
  }

  function landFromDrop(): void {
    dropStage = "landed";
    service.state = "ground";
    sinceLanding = 0;
    landingDip = 0.34;
    ctx.emit("dz:landed", { x: position.x, y: position.y, z: position.z });
    ctx.services.audio?.play("land", { volume: 0.55, position });
    ctx.services.audio?.ambience("wind", false);
    windLevel = 0;
  }

  // ---- fixed step --------------------------------------------------------

  function fixed(dt: number): void {
    const input = ctx.input;
    const match = ctx.services.match;
    const terrain = ctx.services.terrain;
    const active = service.controllable;

    if (!spawnResolved) findSpawn();

    // Late binding, once: combat may have failed to boot, and if it did we
    // simply take no bot damage rather than crashing every step.
    if (!unregisterTarget && ctx.services.combat) {
      try {
        unregisterTarget = ctx.services.combat.registerTarget(damageTarget);
      } catch {
        unregisterTarget = () => {};
      }
    }
    damageTarget.hp = service.health;
    damageTarget.shield = service.shield;
    damageTarget.alive = service.state !== "dead";
    damageTarget.height = capsuleHeight;
    damageTarget.headY = eyeHeight;

    sinceLanding += dt;
    jumpBuffered = Math.max(0, jumpBuffered - dt);

    // --- SOAKED: dryness, slip, the Downpour --------------------------------
    // Unconditional and first: `slip` is read by the friction below, and a
    // drying clock that stops in some states is one players cannot reason
    // about. Costs one branch in classic.
    if (water) waterStepBegin(dt);

    // --- dead: the body stays put and the camera keeps running -------------
    if (service.state === "dead") {
      velocity.multiplyScalar(Math.exp(-4 * dt));
      velocity.y += GRAVITY_DOWN * dt;
      integrate(dt, CROUCH_HEIGHT);
      if (grounded) velocity.set(0, 0, 0);
      return;
    }

    // --- downed: bleed out unless something heals ---------------------------
    if (service.state === "down") {
      downTimer -= dt;
      velocity.x *= Math.exp(-9 * dt);
      velocity.z *= Math.exp(-9 * dt);
      velocity.y += GRAVITY_DOWN * dt;
      integrate(dt, CROUCH_HEIGHT);
      if (grounded) velocity.y = 0;
      if (service.health > 0) {
        // Healed back up (a teammate, a rift, a script) — stand up. In SOAKED
        // that is a towel: clear the out-flag so the wire stops calling us
        // soaked and the strands can attach again.
        service.state = "ground";
        soakedOut = false;
      } else if (downTimer <= 0) {
        enterDead();
      }
      return;
    }

    // --- drop stage machine ------------------------------------------------
    if (dropStage === "none" || dropStage === "landed") {
      if (match && match.phase === "bus") {
        dropStage = "bus";
        service.state = "bus";
      } else {
        dropStage = "landed";
      }
    }

    /**
     * The bus can leave without us, and until this existed we kept holding the
     * rail anyway. Two ways it happens: the end-of-the-line forced jump, which
     * flips the match to `dropping` from inside the match's own step without
     * routing through `requestJump`; and `match.skipToLive`, which jumps
     * straight to `live`. In both cases `dropStage` stayed `bus`, `busFixed`
     * kept re-deriving the position from a route the bus had finished flying,
     * and the player rode the clamped end of the line for the rest of the
     * match. That is the bug behind every capture that came back as a view
     * from the battle bus.
     */
    if (dropStage === "bus" && match && match.phase !== "bus" && match.phase !== "warmup") {
      if (match.phase === "dropping") enterSkydive();
      else landFromDrop();
    }

    if (dropStage === "bus" && match) {
      busFixed(dt, match.busFrom, match.busTo, match.busT, active);
      return;
    }
    if (dropStage === "skydive") {
      diveFixed(dt, active);
      return;
    }
    if (dropStage === "glide") {
      glideFixed(dt, active);
      return;
    }

    // --- grounded / airborne locomotion ------------------------------------
    const sea = seaLevel();
    inWater = !!terrain && position.y < sea - 0.85;

    // Look direction on the horizontal plane. Movement is camera-relative,
    // which is non-negotiable in third person — the character turning is a
    // *presentation* of the input, never a filter on it.
    forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const mx = active ? input.moveX : 0;
    const mz = active ? input.moveZ : 0;
    wish.set(0, 0, 0).addScaledVector(forward, mz).addScaledVector(right, mx);
    const wishLen = Math.min(1, wish.length());
    if (wishLen > 1e-4) wish.divideScalar(wish.length() || 1);

    // --- crouch -------------------------------------------------------------
    // A stumble forces the crouched capsule: face-down on the ground is a low
    // silhouette, and it means you cannot be shot at standing height while you
    // are down there. `active` is already false, so nothing else is needed to
    // take control away.
    const wantCrouch = stumbleTimer > 0 || (active && input.crouch && !inWater);
    if (crouching && !wantCrouch && !canStand()) {
      // Blocked overhead — stay down rather than clipping through a floor.
    } else {
      crouching = wantCrouch;
    }
    const targetHeight = crouching ? CROUCH_HEIGHT : STAND_HEIGHT;
    capsuleHeight = approach(capsuleHeight, targetHeight, 16, dt);
    eyeHeight = approach(eyeHeight, crouching ? CROUCH_EYE : STAND_EYE, 16, dt);

    const sprinting =
      active && input.sprint && !crouching && !inWater && mz > 0.25 && !input.aim;
    runBlend = approach(runBlend, sprinting ? 1 : 0, 9, dt);

    if (inWater) {
      swimFixed(dt, wishLen, active);
      return;
    }

    // --- speed target -------------------------------------------------------
    let speed = crouching ? CROUCH_SPEED : sprinting ? SPRINT_SPEED : WALK_SPEED;
    if (mz < -0.2) speed *= BACK_SCALE;
    if (input.aim && !sprinting) speed *= 0.62;

    // --- SOAKED: glue coupling ----------------------------------------------
    // Before the friction block, because the strand's pull is an acceleration
    // and has to be damped by the same friction everything else is.
    if (water) {
      const pressed = strugglePressed;
      strugglePressed = false;
      if (activeStrands() > 0) speed *= glueFixed(dt, pressed);
    }

    // --- slope --------------------------------------------------------------
    const slopeCos = groundNormal.lengthSq() > 0 ? groundNormal.y : 1;
    sliding = grounded && slopeCos < MAX_SLOPE_COS;

    if (grounded && !sliding) {
      /**
       * Friction: hard when there is no input, light while steering. Symmetric
       * damping is what makes a controller feel like it is on ice.
       *
       * In SOAKED, `slip` (from `wetness.frictionAt`) scales it, and a matched
       * share comes off the acceleration too — friction alone gives you a long
       * glide you can still steer out of instantly, which does not read as
       * slipping at all. Both together are the hilarious, recoverable skid.
       */
      const sp = Math.hypot(velocity.x, velocity.z);
      if (sp > 1e-3) {
        const f = (wishLen > 0.1 ? FRICTION_MOVE : FRICTION_STOP) * (water ? slip : 1);
        const drop = Math.max(sp, 3.5) * f * dt;
        const scale = Math.max(0, sp - drop) / sp;
        velocity.x *= scale;
        velocity.z *= scale;
      }
      const groundAccel = water ? ACCEL_GROUND * lerp(slip, 1, 1 - SLIP_ACCEL_SHARE) : ACCEL_GROUND;
      // Skid feedback: fast across wet ground throws spray and squeals. Only
      // while there is real speed, or every puddle chirps at you.
      if (water && slip < 0.85 && sp > SLIP_SPEED) {
        skidTimer -= dt;
        if (skidTimer <= 0) {
          skidTimer = 0.28;
          ctx.services.audio?.play("skid", { volume: clamp(sp * 0.05, 0.2, 0.6), position });
          ctx.services.vfx?.impact(position, groundNormal, "water");
        }
      }
      accelerate(wish, speed * wishLen, groundAccel, dt);
      // A small downward bias keeps the capsule pinned to slopes instead of
      // launching off every crest.
      velocity.y = Math.max(velocity.y, -2.5);
      coyote = COYOTE_TIME;
    } else if (grounded && sliding) {
      // Too steep to stand: accelerate downhill, keep a little steering.
      tmp.copy(groundNormal).projectOnPlane(up);
      if (tmp.lengthSq() > 1e-6) {
        tmp.normalize();
        velocity.x += tmp.x * SLIDE_ACCEL * dt;
        velocity.z += tmp.z * SLIDE_ACCEL * dt;
      }
      accelerate(wish, speed * wishLen * 0.5, ACCEL_AIR, dt);
      velocity.y += GRAVITY_DOWN * dt;
      coyote = 0;
    } else {
      accelerate(wish, speed * wishLen, ACCEL_AIR, dt);
      const g = velocity.y > 0 ? (jumpHeld ? GRAVITY_UP : GRAVITY_RELEASE) : GRAVITY_DOWN;
      velocity.y += g * dt;
      if (velocity.y < FALL_TERMINAL) velocity.y = FALL_TERMINAL;
      coyote = Math.max(0, coyote - dt);
    }

    // --- jump ---------------------------------------------------------------
    if (jumpBuffered > 0 && coyote > 0 && !sliding && active) {
      velocity.y = JUMP_SPEED * (crouching ? 0.82 : 1);
      grounded = false;
      coyote = 0;
      jumpBuffered = 0;
      ctx.services.audio?.play("jump", { volume: 0.4, position });
    }

    stepUp();
    wasGrounded = grounded;
    const fallSpeed = velocity.y;
    integrate(dt, capsuleHeight);

    // --- landing ------------------------------------------------------------
    if (grounded && !wasGrounded) {
      const impact = -fallSpeed;
      landingDip = clamp(impact * 0.016, 0, 0.42);
      if (impact > 3) {
        ctx.services.audio?.play("land", {
          volume: clamp(0.2 + impact * 0.016, 0.2, 0.75),
          position,
        });
      }
      if (fallSpeed < FALL_SAFE && sinceLanding > 0.4) {
        applyDamage((FALL_SAFE - fallSpeed) * FALL_DAMAGE_PER_MS, undefined, {
          by: "world",
          name: "gravity",
        });
      }
      sinceLanding = 0;
      velocity.y = 0;
    }

    // --- footsteps ----------------------------------------------------------
    if (grounded && !sliding) {
      const sp = Math.hypot(velocity.x, velocity.z);
      stepDistance += sp * dt;
      const stride = crouching ? 1.25 : lerp(1.55, 2.4, runBlend);
      if (sp > 0.7 && stepDistance >= stride) {
        stepDistance = 0;
        footstep(crouching ? 0.45 : lerp(0.8, 1.15, runBlend));
      }
    } else {
      stepDistance = Math.min(stepDistance, 1.0);
    }

    // A soaked player standing still still drips a trail. Footsteps print on
    // stride; this covers the case where there is no stride to print on.
    if (water && grounded) {
      trackTimer -= dt;
      if (trackTimer <= 0) {
        trackTimer = TRACK_PERIOD;
        printTrack();
      }
    }

    service.state = crouching
      ? "crouch"
      : !grounded
        ? "air"
        : runBlend > 0.5
          ? "sprint"
          : "ground";
  }

  /** Quaked-style directional acceleration, so air-strafing behaves. */
  function accelerate(dir: THREE.Vector3, wishSpeed: number, accel: number, dt: number): void {
    if (wishSpeed <= 0) return;
    const current = velocity.x * dir.x + velocity.z * dir.z;
    const add = wishSpeed - current;
    if (add <= 0) return;
    const amount = Math.min(accel * dt * Math.max(wishSpeed, 1), add);
    velocity.x += dir.x * amount;
    velocity.z += dir.z * amount;
  }

  /** Is there room to stand back up? One short ray beats a second resolve. */
  function canStand(): boolean {
    const collision = ctx.services.collision;
    if (!collision) return true;
    tmp.set(position.x, position.y + CROUCH_HEIGHT, position.z);
    tmp2.set(0, 1, 0);
    const hit = collision.raycast(tmp, tmp2, STAND_HEIGHT - CROUCH_HEIGHT + 0.12);
    return !hit;
  }

  // ---- water --------------------------------------------------------------

  function swimFixed(dt: number, wishLen: number, active: boolean): void {
    const input = ctx.input;
    const sea = seaLevel();
    service.state = "swim";
    crouching = false;
    capsuleHeight = approach(capsuleHeight, STAND_HEIGHT, 12, dt);
    eyeHeight = approach(eyeHeight, STAND_EYE, 12, dt);

    accelerate(wish, SWIM_SPEED * wishLen, 30, dt);
    // Buoyancy pulls toward a float line just under the surface; the jump key
    // climbs, crouch dives. Damping is high because water is not air.
    const floatY = sea - 0.55;
    const rise = clamp((floatY - position.y) * 2.4, -4, 4);
    const drive = active ? (input.jump ? 4.6 : input.crouch ? -4.2 : 0) : 0;
    velocity.y = approach(velocity.y, rise + drive, 5, dt);
    velocity.x *= Math.exp(-2.6 * dt);
    velocity.z *= Math.exp(-2.6 * dt);
    integrate(dt, capsuleHeight);

    stepDistance += Math.hypot(velocity.x, velocity.z) * dt;
    if (stepDistance > 2.2) {
      stepDistance = 0;
      footstep(0.5);
    }
    // Leaving the water on a beach hands control straight back to the ground
    // path on the next step, so no explicit exit transition is needed.
    if (position.y > sea - 0.3 && grounded) inWater = false;
  }

  // ---- bus ----------------------------------------------------------------

  function busFixed(
    dt: number,
    from: THREE.Vector3,
    to: THREE.Vector3,
    t: number,
    active: boolean,
  ): void {
    service.state = "bus";
    crouching = false;
    capsuleHeight = STAND_HEIGHT;
    eyeHeight = STAND_EYE;
    grounded = false;
    velocity.set(0, 0, 0);

    tmp.subVectors(to, from);
    tmp.y = 0;
    if (tmp.lengthSq() > 1e-6) tmp.normalize();
    // Hang under and a little to the side of the bus so the player can see it
    // above them — a rider inside the fuselage sees nothing but sky.
    position.lerpVectors(from, to, clamp01(t));
    position.x += -tmp.z * 1.5;
    position.z += tmp.x * 1.5;
    position.y -= 2.35;
    // A slow sway so the hold is not a freeze-frame.
    position.y += Math.sin(ctx.elapsed * 0.9) * 0.08;

    if (active && jumpBuffered > 0) {
      jumpBuffered = 0;
      ctx.services.match?.jump();
      enterSkydive();
    }
  }

  // ---- skydive ------------------------------------------------------------

  function diveFixed(dt: number, active: boolean): void {
    const input = ctx.input;
    service.state = "skydive";
    diveTime += dt;
    capsuleHeight = STAND_HEIGHT;
    eyeHeight = STAND_EYE;

    forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const mx = active ? input.moveX : 0;
    const mz = active ? input.moveZ : 0;
    wish.set(0, 0, 0).addScaledVector(forward, mz).addScaledVector(right, mx);
    const wl = Math.min(1, wish.length());
    if (wl > 1e-4) wish.divideScalar(wish.length() || 1);
    steerSmooth = approach(steerSmooth, mx, 6, dt);

    // Terminal velocity is a function of body attitude: nose down and pushing
    // forward you fall fastest, flared back you fall slowest. That trade —
    // altitude for ground covered — IS the drop minigame.
    const attitude = clamp01(0.5 + mz * 0.42 + (-pitch) * 0.3);
    const terminal = lerp(DIVE_TERMINAL_FLAT, DIVE_TERMINAL, attitude);

    velocity.x += wish.x * DIVE_STEER * wl * dt;
    velocity.z += wish.z * DIVE_STEER * wl * dt;
    const hs = Math.hypot(velocity.x, velocity.z);
    const hsMax = lerp(18, 38, attitude);
    if (hs > hsMax) {
      const k = hsMax / hs;
      velocity.x *= k;
      velocity.z *= k;
    } else if (wl < 0.1) {
      velocity.x *= Math.exp(-DIVE_DRAG * dt);
      velocity.z *= Math.exp(-DIVE_DRAG * dt);
    }

    velocity.y += DIVE_GRAVITY * dt;
    if (velocity.y < -terminal) velocity.y = approach(velocity.y, -terminal, 3.5, dt);

    integrate(dt, capsuleHeight);

    const altitude = position.y - groundY;
    if (grounded || altitude < 1.2) {
      // Hitting the ground in freefall should never happen (the auto-deploy is
      // 112 m up) but a dive straight into a tower can outrun it. Survive it.
      landFromDrop();
      landingDip = 0.5;
      return;
    }
    if (altitude < DEPLOY_ALTITUDE || (active && jumpBuffered > 0)) {
      jumpBuffered = 0;
      enterGlide();
    }
  }

  // ---- glide --------------------------------------------------------------

  function glideFixed(dt: number, active: boolean): void {
    const input = ctx.input;
    service.state = "glide";
    glideT = Math.min(1, glideT + dt / GLIDE_DEPLOY_TIME);
    capsuleHeight = STAND_HEIGHT;
    eyeHeight = STAND_EYE;

    const mx = active ? input.moveX : 0;
    const mz = active ? input.moveZ : 0;
    steerSmooth = approach(steerSmooth, mx, 4.5, dt);

    // The wing follows the camera lazily. Wide, committed turns are the whole
    // character of a canopy; a glider that snaps to the crosshair feels like a
    // drone, and the lag is what makes lining up a landing a skill.
    const dy = angleDelta(glideYaw, yaw);
    glideYaw += clamp(dy, -GLIDE_TURN_RATE * dt, GLIDE_TURN_RATE * dt);
    forward.set(-Math.sin(glideYaw), 0, -Math.cos(glideYaw));
    right.set(Math.cos(glideYaw), 0, -Math.sin(glideYaw));

    // Speed to fly: pushing forward trades sink for ground speed, pulling back
    // flares and slows the descent to a crawl.
    const trim = clamp(mz, -1, 1);
    const target = GLIDE_SPEED * (1 + trim * 0.22);
    tmp.copy(forward).multiplyScalar(target).addScaledVector(right, mx * GLIDE_STEER * 0.45);
    velocity.x = approach(velocity.x, tmp.x, 2.4, dt);
    velocity.z = approach(velocity.z, tmp.z, 2.4, dt);

    // Sink rate: worse in a hard turn, better in a flare. `Math.abs(dy)` is
    // the bank angle proxy — a banked wing loses lift, same as the real thing.
    const bank = clamp01(Math.abs(dy) / 0.9);
    const sink = GLIDE_SINK * (1 + bank * 0.4 - trim * 0.18) * (glideT * 0.7 + 0.3);
    velocity.y = approach(velocity.y, sink, 3.2, dt);

    integrate(dt, capsuleHeight);

    if (grounded || position.y - groundY < 0.15) {
      landFromDrop();
      // Under canopy you touch down softly no matter how far you fell.
      landingDip = 0.2;
      velocity.y = 0;
    }
  }

  // ---- camera -------------------------------------------------------------

  let bobPhase = 0;
  let airBlend = 0;
  let crouchBlend = 0;
  let camRoll = 0;

  function updateCamera(dt: number): void {
    const input = ctx.input;
    const collision = ctx.services.collision;
    /* Drop Zero's own service, not the shared `MatchService` — the bus camera
       samples the route through `busAt`, which is on the extended interface.
       `ctx.services.match` is typed as the shared contract, so without this
       the call below did not compile. */
    const match = ctx.services.match as DropZeroMatchService | undefined;

    // --- what is the subject of this shot? ---------------------------------
    // On the bus it is the BUS. The arm hangs off the vehicle and the look
    // input orbits it; everywhere else the arm hangs off the player and the
    // look input turns their head. See the note by the BUS_ constants.
    const wasOnBus = onBus;
    onBus = dropStage === "bus" && !!match;
    if (onBus && match) {
      // Sample the route rather than reading `match.busPosition`: the bus mesh
      // is placed from `busAt(busT)` in the MATCH's update and the player
      // system updates first, so `busPosition` is a frame stale — which at the
      // bus's 100 m/s is seven metres, a third of the hull, of framing error.
      // `busT` is written in `fixed`, so this agrees with the mesh exactly.
      match.busAt(match.busT, busPivot);
      busPivot.y += BUS_PIVOT_RISE;
      busDir.subVectors(match.busTo, match.busFrom);
      busDir.y = 0;
      if (busDir.lengthSq() > 1e-6) busDir.normalize();
      else busDir.set(0, 0, -1);
      // The hull's own right-hand side, which is the side the rider hangs off.
      busRight.set(-busDir.z, 0, busDir.x);

      if (!wasOnBus) {
        // The frame the game opens on. Composed, not incidental: three-quarter
        // rear, slightly high, hull and balloon against the sky with the
        // island under them. `+BUS_ARM_AZIMUTH` on the route heading swings the
        // arm around to the bus's right, so the rider is in shot too.
        yaw = Math.atan2(-busDir.x, -busDir.z) + BUS_ARM_AZIMUTH;
        if (yaw > Math.PI) yaw -= TAU;
        pitch = BUS_ARM_PITCH;
        service.yaw = yaw;
        service.pitch = pitch;
        armCurrent = clamp(busArmSession, BUS_ARM_MIN, BUS_ARM_MAX);
        camSnap = true;
      }

      // Zoom. The wheel is the desktop control and a two-finger pinch is the
      // touch one; both drive the same remembered number. Multiplicative,
      // because one metre per notch is nothing at 110 m and a lurch at 26.
      if (input.wheel !== 0) {
        busArmSession = clamp(
          busArmSession * (1 + input.wheel * BUS_ZOOM_STEP),
          BUS_ARM_MIN,
          BUS_ARM_MAX,
        );
      }
      if (pinchScale !== 1) {
        busArmSession = clamp(busArmSession * pinchScale, BUS_ARM_MIN, BUS_ARM_MAX);
      }
    } else if (wasOnBus) {
      // Stepping off: the subject changes from the bus to the diver, tens of
      // metres away. Smoothing across that gap flies the lens through the hull.
      camSnap = true;
    }
    pinchScale = 1;

    // Pivot. X/Z track exactly — lag there reads as input latency — but Y is
    // smoothed, which is what hides stair steps and the step-up lift.
    const pivotY = position.y + (dropStage === "skydive" || dropStage === "glide" ? 1.1 : eyeHeight);
    if (!camInit) {
      camPivot.set(position.x, pivotY, position.z);
      camInit = true;
    }
    if (onBus) {
      camPivot.copy(busPivot);
    } else {
      camPivot.x = position.x;
      camPivot.z = position.z;
      camPivot.y = approach(camPivot.y, pivotY, dropStage === "landed" ? 16 : 8, dt);
    }

    const speed = Math.hypot(velocity.x, velocity.z);
    const aiming = input.aim && service.controllable && dropStage === "landed";

    // Arm length + shoulder offset per situation. The dive pulls the camera
    // way back so the island fills frame; aiming pulls it in tight over the
    // shoulder, which is the only way iron sights read in third person.
    let armTarget = ARM_LENGTH;
    let shoulderTarget = ARM_SHOULDER;
    if (onBus) {
      armTarget = clamp(busArmSession, BUS_ARM_MIN, BUS_ARM_MAX);
      // No shoulder offset: the bus is the subject and it belongs centred.
      shoulderTarget = 0;
    } else if (dropStage === "skydive") {
      armTarget = ARM_LENGTH_DIVE;
      shoulderTarget = 0.1;
    } else if (dropStage === "glide") {
      armTarget = ARM_LENGTH + 1.4;
      shoulderTarget = 0.2;
    } else if (aiming) {
      armTarget = ARM_LENGTH_AIM;
      shoulderTarget = ARM_SHOULDER_AIM;
    } else if (crouching) {
      armTarget = ARM_LENGTH * 0.86;
    }
    armCurrent = approach(armCurrent, armTarget, aiming ? 16 : 9, dt);
    shoulderCurrent = approach(shoulderCurrent, shoulderTarget, 10, dt);

    // Look basis.
    const cp = Math.cos(pitch);
    tmp.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp).normalize();
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));

    landingDip = approach(landingDip, 0, 9, dt);
    fireKick = approach(fireKick, 0, 14, dt);
    fireKickPitch = approach(fireKickPitch, 0, 12, dt);

    // Run bob. Small in third person (the body already sells the gait) and
    // pronounced in first, where it is the only motion cue there is.
    if (grounded && speed > 0.6 && dropStage === "landed") {
      bobPhase += dt * clamp(speed * 1.5, 0, 22);
    }
    const bobAmp = (firstPerson ? 0.055 : 0.016) * clamp01(speed / SPRINT_SPEED) * (grounded ? 1 : 0);

    // --- keep the lens out of solid things it is looking AT -----------------
    // The world raycast below handles walls. This handles the two objects the
    // arm is orbiting, which no world collider knows about: the bus, and our
    // own canopy. Both are solved for the shortest arm that is provably
    // outside the volume, along the look axis, so the subject stays centred
    // while the arm grows — a sideways nudge would swing the framing instead.
    let armMin = 0;
    if (onBus) {
      // Direction pivot → camera, resolved into the bus's own axes.
      const ax = -(tmp.x * busRight.x + tmp.z * busRight.z);
      const ay = -tmp.y;
      const az = -(tmp.x * busDir.x + tmp.z * busDir.z);
      armMin =
        ellipsoidReach(ax, ay, az, BUS_KEEPOUT_X, BUS_KEEPOUT_Y, BUS_KEEPOUT_Z) + BUS_KEEPOUT_PAD;
    } else if (dropStage === "skydive" || dropStage === "glide") {
      // Our own wing, as a sphere over the drop pivot. Solving it rather than
      // trusting the tuned arm means a later change to ARM_LENGTH_DIVE cannot
      // quietly park the lens inside the cloth.
      const h = SELF_KEEPOUT_Y;
      const disc = h * h * tmp.y * tmp.y - h * h + SELF_KEEPOUT_R * SELF_KEEPOUT_R;
      if (disc > 0) armMin = Math.max(0, -h * tmp.y + Math.sqrt(disc));
    }
    const armUsed = Math.max(armCurrent, armMin);

    if (firstPerson && !onBus) {
      camPos.set(
        camPivot.x + right.x * bobAmp * 0.6 * Math.cos(bobPhase),
        camPivot.y + Math.sin(bobPhase * 2) * bobAmp - landingDip - fireKick * 0.3,
        camPivot.z + right.z * bobAmp * 0.6 * Math.cos(bobPhase),
      );
    } else {
      camGoal.copy(camPivot)
        .addScaledVector(right, shoulderCurrent)
        .addScaledVector(up, ARM_RISE + Math.sin(bobPhase * 2) * bobAmp)
        .addScaledVector(tmp, -armUsed - fireKick * 0.9);
      camGoal.y -= landingDip;

      // Spring-arm collision. One ray from the pivot to the goal; if it hits,
      // pull the camera in short of the surface. Without this every wall you
      // back into puts the camera inside the geometry and you see the sky
      // through the world — the single most obvious third-person bug there is.
      // Skipped on the bus: the only thing within 600 m is the bus itself, and
      // the ellipsoid above is what keeps us off it.
      if (collision && !onBus) {
        tmp2.subVectors(camGoal, camPivot);
        const dist = tmp2.length();
        if (dist > 1e-3) {
          tmp2.divideScalar(dist);
          const hit = collision.raycast(camPivot, tmp2, dist + CAMERA_PAD);
          if (hit && hit.distance < dist + CAMERA_PAD) {
            camGoal.copy(camPivot).addScaledVector(tmp2, Math.max(0.25, hit.distance - CAMERA_PAD));
          }
        }
      }
      if (camSnap) {
        // Boarding or leaving the bus. There is no path between the two rigs
        // that is not through the hull, so this one is a cut, not a move.
        camPos.copy(camGoal);
      } else {
        // Pull in fast, ease out slow: snapping in avoids a frame of clipping,
        // easing out avoids the camera lurching every time you clear a corner.
        const pullIn = camPos.distanceToSquared(camPivot) > camGoal.distanceToSquared(camPivot);
        camPos.lerp(camGoal, 1 - Math.exp(-(pullIn ? 26 : 11) * dt));
      }
    }
    camSnap = false;

    camera.position.copy(camPos);

    // Roll: lean into hard turns and into the glider's bank. Tiny — a couple
    // of degrees is felt, ten is nausea.
    const rollTarget =
      dropStage === "glide"
        ? -steerSmooth * 0.16
        : dropStage === "skydive"
          ? -steerSmooth * 0.1
          : -leanRoll * 0.35;
    camRoll = approach(camRoll, rollTarget, 6, dt);
    camera.rotation.set(pitch + fireKickPitch, yaw, camRoll, "YXZ");

    // --- FOV ---------------------------------------------------------------
    let fovTarget = BASE_FOV;
    if (dropStage === "skydive") {
      // The whole reason the dive feels fast. Speed → FOV, and the snap back
      // when the canopy opens is the release that makes the fall register.
      fovTarget += FOV_DIVE * clamp01((-velocity.y - 20) / (DIVE_TERMINAL - 20));
    } else if (dropStage === "glide") {
      fovTarget += 5 * clamp01(Math.hypot(velocity.x, velocity.z) / GLIDE_SPEED);
    } else {
      if (aiming) fovTarget += FOV_AIM;
      else fovTarget += FOV_SPRINT * clamp01((speed - WALK_SPEED) / (SPRINT_SPEED - WALK_SPEED));
    }
    // Opening fast, closing faster: the widen should feel like acceleration
    // and the return should feel like a brake.
    const fovRate = fovTarget > fovCurrent ? 4.5 : 9;
    fovCurrent = approach(fovCurrent, fovTarget, fovRate, dt);
    if (Math.abs(camera.fov - fovCurrent) > 0.005) {
      camera.fov = fovCurrent;
      camera.updateProjectionMatrix();
    }
  }

  // ---- animation ----------------------------------------------------------

  function updateAnimation(dt: number): void {
    if (!rig) return;
    const speed = Math.hypot(velocity.x, velocity.z);
    const input = ctx.input;

    // --- body yaw ----------------------------------------------------------
    // The character faces where it is *going*, except when the player is
    // aiming or building, when it faces where they are *looking*. Everything
    // else is the upper body twisting to make up the difference.
    let yawTarget = bodyYaw;
    let turnRate = 7;
    if (dropStage === "glide") {
      yawTarget = glideYaw;
      turnRate = 6;
    } else if (dropStage === "skydive" || dropStage === "bus" || service.state === "swim") {
      yawTarget = yaw;
      turnRate = 6;
    } else if (input.aim || input.fire || ctx.services.build?.selected) {
      yawTarget = yaw;
      turnRate = 14;
    } else if (speed > 0.9) {
      yawTarget = Math.atan2(-velocity.x, -velocity.z);
      turnRate = 11;
    } else {
      // Idle: only turn the feet once the twist gets uncomfortable, then
      // commit. That deadzone is why an idle character does not swivel with
      // every mouse twitch.
      const d = angleDelta(bodyYaw, yaw);
      if (Math.abs(d) > 1.15) yawTarget = yaw;
      turnRate = 4.5;
    }
    const delta = angleDelta(bodyYaw, yawTarget);
    bodyYaw += delta * (1 - Math.exp(-turnRate * dt));
    // Never let the twist exceed what a spine can do.
    const overTwist = angleDelta(bodyYaw, yaw);
    if (Math.abs(overTwist) > 1.75) bodyYaw = yaw - Math.sign(overTwist) * 1.75;

    // Lean into the turn, scaled by speed.
    const yawRate = angleDelta(lastYaw, bodyYaw) / Math.max(dt, 1e-4);
    lastYaw = bodyYaw;
    leanRoll = approach(leanRoll, clamp(yawRate * 0.06, -0.5, 0.5) * clamp01(speed / SPRINT_SPEED), 7, dt);

    // --- gait phase --------------------------------------------------------
    const stride = crouching ? 1.25 : lerp(1.55, 2.4, runBlend);
    if (grounded && dropStage === "landed" && service.state !== "swim") {
      gaitPhase += (speed * dt) / Math.max(stride * 2, 0.4) * TAU;
    } else if (service.state === "swim") {
      gaitPhase += dt * 3.4;
    }
    if (gaitPhase > TAU * 1024) gaitPhase -= TAU * 1024;

    airBlend = approach(airBlend, grounded || dropStage !== "landed" ? 0 : 1, 12, dt);
    crouchBlend = approach(crouchBlend, crouching ? 1 : 0, 12, dt);

    // --- pose blend --------------------------------------------------------
    poseReset(poseOut);
    let total = 0;
    const add = (fill: (p: Pose) => void, w: number) => {
      if (w <= 1e-3) return;
      fill(poseScratch);
      poseAdd(poseOut, poseScratch, w);
      total += w;
    };

    const t = ctx.elapsed;
    if (service.state === "dead" || service.state === "down") {
      add((p) => poseDown(p, t), 1);
    } else if (water && stumbleTimer > 0) {
      // Face down. The same slumped pose the down state uses, but rolled
      // through `stumbleRoll` below so it reads as a tumble you took rather
      // than a body that was switched off.
      add((p) => poseDown(p, t), 1);
    } else if (dropStage === "bus") {
      add((p) => poseHang(p, t), 1);
    } else if (dropStage === "skydive") {
      add((p) => poseDive(p, steerSmooth, clamp(ctx.input.moveZ, -1, 1), t), 1);
    } else if (dropStage === "glide") {
      // Cross-fade out of the dive while the canopy inflates, so the pose
      // change and the mesh appearing are the same event.
      const g = smoothstep(glideT);
      add((p) => poseGlide(p, steerSmooth, t), g);
      add((p) => poseDive(p, steerSmooth, 0, t), 1 - g);
    } else if (service.state === "swim") {
      add((p) => poseSwim(p, gaitPhase, t), 1);
    } else {
      const moveAmt = clamp01(speed / (WALK_SPEED * 0.75));
      const ground = 1 - airBlend;
      add((p) => poseCrouchWalk(p, gaitPhase, moveAmt), ground * crouchBlend);
      const upright = ground * (1 - crouchBlend);
      add((p) => poseLocomotion(p, gaitPhase, runBlend), upright * moveAmt);
      add((p) => poseIdle(p, t), upright * (1 - moveAmt));
      add((p) => poseAir(p, velocity.y), airBlend);
    }
    if (total > 1e-4 && Math.abs(total - 1) > 1e-4) {
      const k = 1 / total;
      for (let i = 0; i < poseOut.rot.length; i++) poseOut.rot[i] *= k;
      for (let i = 0; i < poseOut.root.length; i++) poseOut.root[i] *= k;
    }

    // --- aim offset --------------------------------------------------------
    // The residual between where the feet point and where the player looks is
    // spread up the spine, and the head takes most of the pitch. This is what
    // stops the character staring at the horizon while you aim at the floor.
    const twist = angleDelta(bodyYaw, yaw);
    const lookPitch = dropStage === "landed" && service.state !== "swim" ? clamp(pitch, -0.9, 0.7) : 0;
    poseOut.rot[J_SPINE * 3 + 1] += twist * 0.22;
    poseOut.rot[J_CHEST * 3 + 1] += twist * 0.42;
    poseOut.rot[J_NECK * 3 + 1] += twist * 0.24;
    poseOut.rot[J_HEAD * 3 + 1] += twist * 0.12;
    poseOut.rot[J_CHEST * 3] += lookPitch * 0.18;
    poseOut.rot[J_NECK * 3] += lookPitch * 0.34;
    poseOut.rot[J_HEAD * 3] += lookPitch * 0.3;

    // A hit or a shot shoves the upper body, not just the camera.
    poseOut.rot[J_CHEST * 3] -= fireKick * 1.2;

    // --- SOAKED: the shiver --------------------------------------------------
    // A drenched player standing still has the shakes. Fast, tiny, and it fades
    // out as soon as they are moving, because a shiver on a sprinting character
    // reads as a broken animation rather than as being cold.
    if (water && wetLook > 0.25) {
      const still = 1 - clamp01(speed / (WALK_SPEED * 0.6));
      const amp = (wetLook - 0.25) * 0.055 * still;
      if (amp > 1e-4) {
        const sh = Math.sin(t * 41) * amp;
        poseOut.rot[J_CHEST * 3 + 2] += sh;
        poseOut.rot[J_SHO_L * 3 + 2] += sh * 1.6;
        poseOut.rot[J_SHO_R * 3 + 2] -= sh * 1.6;
        poseOut.rot[J_HEAD * 3 + 2] += Math.sin(t * 37.3) * amp * 0.8;
      }
    }

    // --- apply -------------------------------------------------------------
    for (let j = 0; j < JOINT_COUNT; j++) {
      rig.joints[j].rotation.set(poseOut.rot[j * 3], poseOut.rot[j * 3 + 1], poseOut.rot[j * 3 + 2]);
    }
    // The tumble: the body keeps rolling for the first half of the fall, then
    // holds while you scramble up. Decayed rather than cut so the recovery is
    // a movement and not a snap back to upright.
    if (water) {
      if (stumbleTimer > 0) stumbleRoll += dt * STUMBLE_SPIN * clamp01(stumbleTimer / GLUE.fallTime);
      else stumbleRoll = approach(stumbleRoll, 0, 6, dt);
    }
    rig.body.position.set(poseOut.root[0], poseOut.root[1] - landingDip * 0.5, poseOut.root[2]);
    rig.body.rotation.set(
      poseOut.root[3],
      poseOut.root[4],
      poseOut.root[5] + leanRoll * 0.5 + Math.sin(stumbleRoll) * 0.55,
    );

    rig.root.position.set(0, 0, 0);
    rigRoot.position.copy(position);
    rigRoot.rotation.y = bodyYaw;

    // In first person the head would fill the screen, so it goes — but the
    // body stays, because looking down and seeing your own boots is free.
    rig.headGroup.visible = !firstPerson;

    // --- glider ------------------------------------------------------------
    if (dropStage !== "glide" && glideT > 0) glideT = Math.max(0, glideT - dt / 0.3);
    const gv = glideT > 0.001;
    rig.glider.visible = gv;
    if (gv) {
      // Overshoot on deploy: the canopy snaps past full size and settles. A
      // linear scale-in reads as a mesh being switched on.
      const s = smoothstep(glideT);
      const pop = 1 + Math.sin(clamp01(glideT) * Math.PI) * 0.12;
      rig.glider.scale.setScalar(Math.max(0.02, s * pop));
      rig.glider.rotation.set(-0.1 - steerSmooth * 0.02, angleDelta(bodyYaw, glideYaw), -steerSmooth * 0.3);
      rig.glider.position.set(steerSmooth * 0.25, 3.62 * s, -0.12);
      // Per-cell billow: each cell breathes on its own phase so the canopy
      // is never a rigid plate.
      for (let i = 0; i < rig.cells.length; i++) {
        const cell = rig.cells[i];
        const ph = ctx.elapsed * 2.3 + (cell.userData.phase as number);
        cell.scale.set(1, 1 + Math.sin(ph) * 0.05 * s, 1 + Math.cos(ph * 0.7) * 0.02 * s);
      }
    }
  }

  // ---- SOAKED: the wet look -----------------------------------------------

  /** Base albedo tint of each body material, captured once so we can restore it. */
  const dryTint: THREE.Color[] = [];
  const dryEnv: number[] = [];
  let wetLookApplied = -1;

  /**
   * Make being wet visible on your own body.
   *
   * Water reads through gloss and refraction, never through blue paint — so
   * the albedo goes DARKER and neutral (a wet shirt is a dark shirt), the
   * roughness comes down so the sun and the sky probe start showing up in the
   * surface, and the environment contribution comes up to meet it. Nothing is
   * tinted toward cyan; the only blue on a soaked player is the sky reflected
   * in them, which is the honest version of the effect and the readable one.
   */
  function updateWetLook(dt: number): void {
    const targetWet = service.wetness;
    // Getting wet is instant; drying off is slow. Matching the rates would
    // make a faceful of water fade in over a second and land on nothing.
    wetLook = approach(wetLook, targetWet, targetWet > wetLook ? 14 : 1.2, dt);

    if (rig) {
      if (dryTint.length === 0) {
        for (const m of rig.materials) {
          const std = m as THREE.MeshStandardMaterial;
          dryTint.push(std.color ? std.color.clone() : new THREE.Color(1, 1, 1));
          dryEnv.push(typeof std.envMapIntensity === "number" ? std.envMapIntensity : 1);
        }
      }
      // Uniform writes are cheap but not free, and this changes slowly.
      if (Math.abs(wetLook - wetLookApplied) > 0.01) {
        wetLookApplied = wetLook;
        for (let i = 0; i < rig.materials.length; i++) {
          const std = rig.materials[i] as THREE.MeshStandardMaterial;
          if (!std.color) continue;
          // 0.55 at fully soaked: dark enough to read across a street, light
          // enough that the vertex-colour wear detail survives it.
          const k = 1 - wetLook * 0.45;
          std.color.copy(dryTint[i]).multiplyScalar(k);
          // `roughness` multiplies the baked roughness map, so this is a
          // proportional polish of whatever the surface already was.
          std.roughness = 1 - wetLook * 0.62;
          std.envMapIntensity = dryEnv[i] * (1 + wetLook * 1.4);
        }
      }
    }

    // --- drips ---------------------------------------------------------------
    if (wetLook > 0.08 && service.state !== "dead") {
      if (ensureDrips()) {
        // Shedding scales with how wet you are and doubles while you are
        // actually moving — a run should throw water off you.
        const moving = clamp01(Math.hypot(velocity.x, velocity.z) / SPRINT_SPEED);
        dripAccum += DRIP_RATE * wetLook * (0.5 + moving) * dt;
        let budget = 4;
        while (dripAccum >= 1 && budget-- > 0) {
          dripAccum -= 1;
          spawnDrip();
        }
        dripAccum = Math.min(dripAccum, 1);
      }
    }
    updateDrips(dt);
  }

  // ---- per-frame ----------------------------------------------------------

  const offRecoil: Array<() => void> = [];
  for (const evt of ["dz:fire", "dz:shot", "dz:recoil"]) {
    offRecoil.push(
      ctx.on(evt, (payload) => {
        // Weapons own the recoil curve; all this needs is a magnitude. An
        // unknown payload still gets a default kick so the feedback never
        // silently disappears if the weapons module changes its shape.
        const p = payload as { recoil?: number; kick?: number } | undefined;
        const mag = typeof p?.recoil === "number" ? p.recoil : typeof p?.kick === "number" ? p.kick : 1;
        fireKick += clamp(mag * 0.05, 0, 0.22);
        fireKickPitch += clamp(mag * 0.012, 0, 0.05);
      }),
    );
  }

  // --- SOAKED wiring --------------------------------------------------------
  // Local events first: `dz:glue` fires when OUR gun sticks (we are the near
  // end and feel the pull too), `dz:soak` carries the knockback weapons asked
  // for. Both are no-ops outside water mode.
  if (water) {
    offRecoil.push(ctx.on("dz:glue", (p) => onGlueEvent(p, null)));
    offRecoil.push(
      ctx.on("dz:glue-break", (p) => {
        const g = (p ?? {}) as { to?: string; from?: string; reason?: string };
        // Ours already broke locally; this catches a break announced by the
        // module that owns the strand's rendering.
        if (g.from === selfId() && g.to) breakGlue(g.to, "expired");
      }),
    );
    offRecoil.push(ctx.on("dz:soak", onSoakPush));
    // Squad id, set by the lobby. Same string = teammates = do not soak.
    offRecoil.push(
      ctx.on("soaked:team", (p) => {
        const t = (p ?? {}) as { team?: string };
        team = typeof t.team === "string" && t.team ? t.team : null;
      }),
    );
  }

  /**
   * Net subscriptions are late-bound: `net` boots after us in some orders and
   * may never boot at all. Retried from `update` until it takes, then never
   * again.
   */
  const netOff: Array<() => void> = [];
  function ensureNetBound(): void {
    if (!water || netOff.length > 0) return;
    const net = ctx.services.net;
    if (!net) return;
    netOff.push(net.on("glue", (from, payload) => onGlueEvent(payload, from)));
  }

  let audioBound = false;

  function update(dt: number): void {
    const input = ctx.input;

    // --- look ---------------------------------------------------------------
    // Deliberately NOT in fixed(): look deltas accumulate once per frame and
    // are cleared by the engine afterwards, so applying them inside a step
    // that may run six times would multiply the sensitivity by six.
    if (input.locked && service.state !== "dead" && service.state !== "down") {
      yaw += input.lookX;
      pitch = clamp(pitch + input.lookY, -PITCH_LIMIT, PITCH_LIMIT);
      if (yaw > Math.PI) yaw -= TAU;
      else if (yaw < -Math.PI) yaw += TAU;
    }
    service.yaw = yaw;
    service.pitch = pitch;

    // --- edge-triggered input ----------------------------------------------
    // `pressed` is refilled by the browser between frames and cleared after
    // update(), so buffering it here and consuming it in fixed() is both the
    // correct place to read it and the standard one-frame jump buffer.
    if (input.pressed.has("Space") && service.controllable) jumpBuffered = JUMP_BUFFER;
    jumpHeld = input.jump;
    // Mashing to peel off glue and hopping are the same key on purpose: the
    // instinctive reaction to being stuck is to jump, and rewarding it is
    // better than teaching a second binding nobody will read.
    if (water && input.pressed.has(GLUE.struggleKey)) strugglePressed = true;
    if (input.pressed.has("KeyF") && input.locked) {
      firstPerson = !firstPerson;
      camInit = false;
      ctx.emit("dz:camera", { firstPerson });
    }

    if (!audioBound && ctx.services.audio) {
      audioBound = true;
      ctx.services.audio.setListener(camera);
    }

    // --- wind bed ------------------------------------------------------------
    const wantWind =
      dropStage === "skydive"
        ? clamp01((-velocity.y - 12) / 60)
        : dropStage === "glide"
          ? 0.34
          : 0;
    if (Math.abs(wantWind - windLevel) > 0.02) {
      windLevel = approach(windLevel, wantWind, 4, dt);
      const audio = ctx.services.audio;
      if (audio) {
        if (windLevel > 0.02) audio.ambience("wind", true, windLevel);
        else audio.ambience("wind", false);
      }
    }

    // --- SOAKED: the wire and the wet look -----------------------------------
    // Before the animation, because `wetLook` is what the shiver reads.
    if (water) {
      ensureNetBound();
      publishPose();
      updateWetLook(dt);
    }

    updateAnimation(dt);
    updateCamera(dt);

    // Keep the shadow cascade centred on us — a player standing outside the
    // cascade gets no contact shadow and instantly looks pasted onto the world.
    ctx.services.sky?.focus(position);

    // --- HUD -----------------------------------------------------------------
    hud.health = service.health;
    hud.maxHealth = service.maxHealth;
    hud.shield = service.shield;
    hud.maxShield = service.maxShield;
    hud.state = service.state;
    hud.down = service.state === "down" ? downTimer : 0;
    hud.speed = Math.hypot(velocity.x, velocity.z);
    hud.altitude = position.y - groundY;
    hud.grounded = grounded;
    hud.aiming = input.aim;
    hud.crouched = crouching;
    hud.sprinting = runBlend > 0.5;
    hud.firstPerson = firstPerson;
    hud.glider = dropStage === "glide";
    hud.busT = ctx.services.match?.busT ?? 0;
    hud.x = position.x;
    hud.y = position.y;
    hud.z = position.z;
    hud.yaw = yaw;
    hud.pitch = pitch;
    if (water) {
      hud.dryness = service.health;
      hud.poncho = service.shield;
      hud.band = drynessBand(service.health).key;
      hud.wet = wetLook;
      hud.slip = slip;
      hud.struggle = 0;
      hud.gluedTo = null;
      let glued = false;
      for (const s of strands) {
        if (!s.active) continue;
        glued = true;
        // Report the strand you are closest to peeling off, so the meter the
        // HUD draws is the one the mashing is actually moving.
        if (s.struggle >= hud.struggle) {
          hud.struggle = s.struggle;
          hud.gluedTo = s.id || null;
        }
      }
      hud.glued = glued;
      hud.stumbling = stumbleTimer > 0;
      hud.soaked = soakedOut;
      hud.inDownpour = inDownpour;
      hud.drying = drying;
    }
    ctx.emit("dz:hud", hud);
  }

  // ---- system -------------------------------------------------------------

  interface FixedSystem extends System {
    fixed(dt: number, ctx: WorldCtx): void;
  }

  const sys: FixedSystem = {
    name: "player",
    fixed(dt) {
      fixed(dt);
    },
    update(dt) {
      update(dt);
    },
    dispose() {
      for (const off of offRecoil) off();
      for (const off of netOff) off();
      netOff.length = 0;
      unregisterTarget?.();
      unregisterTarget = null;
      ctx.services.audio?.ambience("wind", false);
      if (ctx.services.player === service) ctx.services.player = undefined;

      // The drip pool is ours: one InstancedMesh, one geometry, one material.
      // A leaked WebGL resource here breaks the NEXT world a visitor opens.
      if (dripMesh) {
        dripMesh.removeFromParent();
        dripMesh.dispose();
        dripMesh = null;
      }
      dripGeo?.dispose();
      dripGeo = null;
      dripMat?.dispose();
      dripMat = null;
      drips.length = 0;

      rigRoot.removeFromParent();
      if (rig) {
        for (const g of rig.geometries) g.dispose();
        for (const m of rig.materials) m.dispose();
        // Materials do not own these — they were baked here, so they are
        // disposed here. A leaked DataTexture per world visit is how a
        // browser ends up refusing the next WebGL context.
        for (const t of rig.textures) t.dispose();
        rig = null;
      }
      camera.fov = BASE_FOV;
      camera.updateProjectionMatrix();
    },
  };

  return sys;
};

export default createPlayer;
