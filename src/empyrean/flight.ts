/**
 * The body — walking, falling, and the jetpack.
 *
 * This is Vibe City's player, lifted out into a function you can call from a
 * test. Every constant it uses comes from `@/lib/worldPhysics`, which is the
 * whole point: the same 24 m/s² of gravity, the same 7 and 16 on the ground,
 * the same 22 and 34 in the air, the same 11 m/s jump and the same 50 m/s² of
 * thrust that City's Space bar gives you. Somebody who has learned to fly in
 * Vibe City already knows how to fly here, down to the muscle memory of how
 * long to hold to clear a roof.
 *
 * The one number that is local is `THRUST`, and only because City keeps it in
 * its page rather than in the shared module. It is the same 50.
 *
 * Kept free of Three's scene graph and of any DOM so `src/test/empyrean.test.ts`
 * can fly it around and assert on where it ends up — the alternative is that
 * the only way to find out whether the jetpack still works is to open the route
 * and hold the space bar.
 */
import * as THREE from "three";
import {
  FLY_RUN_SPEED,
  FLY_SPEED,
  GRAVITY,
  JUMP_VELOCITY,
  MAX_FALL,
  MAX_RISE,
  RUN_SPEED,
  WALK_SPEED,
} from "@/lib/worldPhysics";

/** Jetpack acceleration, m/s². Net climb is this minus gravity. Same as City. */
export const THRUST = 50;

/** Body radius used against the tower boxes, m. */
export const BODY_R = 0.6;

/** How far above a surface still counts as standing on it. */
export const SNAP = 0.35;

/**
 * How high a step a body can walk up without jumping.
 *
 * The city has kerbs at 16 cm and stairs down to the promenades, and a player
 * who has to jump onto a kerb is a player who is fighting the world. Sixty
 * centimetres takes every step and every kerb in the plan and still stops you
 * strolling up the side of a building.
 *
 * It is only offered when you are on the ground or drifting up slowly. Applied
 * while climbing at nineteen metres a second it would catch you on the
 * underside of every balcony you flew past, which is the exact thing the
 * one-way decks exist to prevent.
 */
export const CLIMB = 0.62;

/** Vertical speed above which the step-up reach is withdrawn. */
const CLIMB_MAX_RISE = 1.5;

/**
 * What `carryAt` fills in: the rigid motion of the deck under the body.
 *
 * `x`/`y`/`z` are the deck's own velocity, `w` its yaw rate, and `px`/`pz`
 * the point that rotation is about. A plain velocity is not enough for
 * anything that turns — see the carry in `stepFlyer`.
 */
export interface CarryVec {
  x: number;
  y: number;
  z: number;
  w: number;
  px: number;
  pz: number;
}

export interface FlyerInput {
  /** -1..1, forward positive. */
  forward: number;
  /** -1..1, right positive. */
  strafe: number;
  run: boolean;
  /** The jetpack, held. */
  jet: boolean;
  /** Camera yaw, radians. Movement is camera-relative, as everywhere else. */
  camYaw: number;
}

export interface FlyerState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Which way the body is facing. Eased toward the direction of travel. */
  yaw: number;
  /** Lean into the run, and forward under thrust. Radians. */
  pitch: number;
  grounded: boolean;
  thrusting: boolean;
  /** 0..1, how hard the jets are burning. Drives the plume and the sound. */
  burn: number;
  /** Set on the frame the body touches down, with the impact speed in m/s. */
  landed: number;
  /**
   * 0..1, decaying. Set by a hard landing and read by whatever wants to
   * squash the body, shake the camera or thump the speakers. An event that
   * only exists for one frame is an event most systems will miss, because
   * most systems do not run every frame.
   */
  impact: number;
  /** Metres climbed by the step-up this frame, for a footfall on stairs. */
  stepped: number;
  /** Metres of clear air directly below. Infinity over the void. */
  drop: number;
  /**
   * True while the body is standing on a deck that is moving under it.
   *
   * Set by the carry below. Nothing in here reads it; it is for the HUD, the
   * audio and anything that wants to know the player is aboard something
   * without having to ask the thing they are aboard.
   */
  carried: boolean;
}

export interface FlyerWorld {
  /**
   * The highest standable surface at (x, z) that is at or below `fromY`.
   *
   * The `fromY` argument is what makes the terraces one-way: approach a deck
   * from underneath and it is not there, so you fly up past it rather than
   * being snapped onto its roof through half a metre of stone.
   */
  supportAt(x: number, z: number, fromY: number): number;
  /** True if a body at (x, z, y) would be inside a building. */
  blockedAt(x: number, z: number, y: number): boolean;
  /**
   * The lateral motion of the surface the body is standing on, if that
   * surface is a moving deck — a tram floor, a barge, a gondola.
   *
   * Optional, because most worlds have nothing that moves under your feet and
   * a test world should not have to say so. `y` is the very number
   * `supportAt` just returned, which is what lets the implementation answer
   * for the *supporting* deck and for nothing else.
   */
  carryAt?(x: number, z: number, y: number, out: CarryVec): boolean;
  /**
   * `blockedAt` against the static world only. See the carry below for why
   * the moving frames have to be left out of that one test.
   */
  blockedStaticAt?(x: number, z: number, y: number): boolean;
  /**
   * If the body is *inside* a moving thing's box, the shortest way out of it.
   *
   * Optional, and only moving frames answer. `blockedAt` refuses a move; it
   * cannot resolve a body that something has closed around, and only a thing
   * that moves can do that.
   */
  pushOutAt?(x: number, z: number, y: number, pad: number, out: CarryVec): boolean;
  /** Below this, you have left the world. */
  killY: number;
  /** Where you come back. */
  spawn: { x: number; y: number; z: number; yaw: number };
}

export function makeFlyer(spawn: FlyerWorld["spawn"]): FlyerState {
  return {
    position: new THREE.Vector3(spawn.x, spawn.y, spawn.z),
    velocity: new THREE.Vector3(),
    yaw: spawn.yaw,
    pitch: 0,
    grounded: true,
    thrusting: false,
    burn: 0,
    landed: 0,
    impact: 0,
    stepped: 0,
    drop: 0,
    carried: false,
  };
}

const _intent = new THREE.Vector3();
/** Scratch for the carry. Module scope, because `stepFlyer` may not allocate. */
const _carry: CarryVec = { x: 0, y: 0, z: 0, w: 0, px: 0, pz: 0 };
/** Scratch for the shove out of a closing door. Module scope, same reason. */
const _push: CarryVec = { x: 0, y: 0, z: 0, w: 0, px: 0, pz: 0 };

/**
 * How fast a moving thing shoves a body out of itself, m/s.
 *
 * Brisk enough to clear a 0.74 m exclusion band inside two frames at any
 * frame rate the engine will produce, slow enough to read as being swept by a
 * door rather than teleported by one.
 */
const PUSH_SPEED = 9;

/**
 * One step. `dt` is expected clamped by the caller; it is clamped again here
 * because a physics function that a background tab can teleport through the
 * floor is a physics function with a bug in it.
 */
export function stepFlyer(
  s: FlyerState,
  input: FlyerInput,
  world: FlyerWorld,
  dtRaw: number,
): void {
  const dt = Math.min(Math.max(dtRaw, 0), 0.05);
  s.landed = 0;
  s.stepped = 0;
  s.impact *= Math.pow(0.02, dt);

  /* ---- intent, in camera space ---------------------------------------- */
  const fx = -Math.sin(input.camYaw);
  const fz = -Math.cos(input.camYaw);
  const rx = Math.cos(input.camYaw);
  const rz = -Math.sin(input.camYaw);
  _intent.set(
    fx * input.forward + rx * input.strafe,
    0,
    fz * input.forward + rz * input.strafe,
  );
  if (_intent.lengthSq() > 1) _intent.normalize();

  const running = input.run;
  const thrusting = input.jet;
  s.thrusting = thrusting;
  // The plume lags the input a little in both directions — a jet that snaps
  // on and off looks like a boolean, which is what it is and not what it
  // should look like.
  s.burn += ((thrusting ? 1 : 0) - s.burn) * (1 - Math.pow(thrusting ? 0.002 : 0.02, dt));

  const wasGrounded = s.grounded;

  /* ---- shoved out of something that closed on you ----------------------
   *
   * Before anything else, because a body inside a box cannot walk and cannot
   * fall out: every direction it could step is still inside, all three of the
   * slide tests below fail, and it sits there frozen. Static geometry never
   * puts a body in that state — you can only ever be outside a building — but
   * a tram pulls up beside you and a door shuts on you, and the body's 0.6 m
   * radius turns a 14 cm door into a metre and a half of exclusion.
   *
   * It only ever pushes along the shortest way out of the box that closed,
   * which is out of a doorway into the car, or back from the platform edge
   * onto the platform. Both are places the body was standing a moment ago.
   */
  if (world.pushOutAt && world.pushOutAt(s.position.x, s.position.z, s.position.y, BODY_R, _push)) {
    const d = Math.hypot(_push.x, _push.z);
    const step = Math.min(d, PUSH_SPEED * dt);
    if (d > 1e-6) {
      s.position.x += (_push.x / d) * step;
      s.position.z += (_push.z / d) * step;
    }
  }

  /* ---- horizontal ------------------------------------------------------
   * Exponential easing toward a target velocity, with the ground far firmer
   * than the air. Identical shape and identical constants to City's, which is
   * why a run off the edge of the plaza carries exactly as far as it does
   * off a City rooftop. */
  const targetSpeed = s.grounded
    ? running
      ? RUN_SPEED
      : WALK_SPEED
    : running
      ? FLY_RUN_SPEED
      : FLY_SPEED;
  const k = s.grounded ? 1 - Math.pow(0.0001, dt) : 1 - Math.pow(0.05, dt);
  s.velocity.x += (_intent.x * targetSpeed - s.velocity.x) * k;
  s.velocity.z += (_intent.z * targetSpeed - s.velocity.z) * k;

  /* ---- vertical -------------------------------------------------------- */
  s.velocity.y -= GRAVITY * dt;
  if (thrusting) {
    s.velocity.y += THRUST * dt;
    s.grounded = false;
  }
  s.velocity.y = THREE.MathUtils.clamp(s.velocity.y, -MAX_FALL, MAX_RISE);

  /* ---- integrate, axis-separated -------------------------------------- */
  const prevY = s.position.y;

  const nx = s.position.x + s.velocity.x * dt;
  const nz = s.position.z + s.velocity.z * dt;
  if (!world.blockedAt(nx, nz, prevY)) {
    s.position.x = nx;
    s.position.z = nz;
  } else if (!world.blockedAt(nx, s.position.z, prevY)) {
    // Slide along the wall rather than stopping dead against it.
    s.position.x = nx;
    s.velocity.z = 0;
  } else if (!world.blockedAt(s.position.x, nz, prevY)) {
    s.position.z = nz;
    s.velocity.x = 0;
  } else {
    s.velocity.x = 0;
    s.velocity.z = 0;
  }

  s.position.y += s.velocity.y * dt;

  /* ---- ground ----------------------------------------------------------
   * Support is looked up from where the body *was*, not where it now is, so a
   * deck you passed under going up cannot catch you. The reach is the step-up
   * height on foot and almost nothing while climbing — see CLIMB. */
  const reach = wasGrounded || s.velocity.y < CLIMB_MAX_RISE ? CLIMB : 0.05;
  const support = world.supportAt(s.position.x, s.position.z, prevY + reach);
  if (s.position.y <= support) {
    const impact = -s.velocity.y;
    if (support > prevY + 0.02 && wasGrounded) s.stepped = support - prevY;
    s.position.y = support;
    s.velocity.y = 0;
    s.grounded = true;
    if (!wasGrounded) {
      s.landed = Math.max(0, impact);
      // Anything under a five-metre drop is a step, not a landing.
      s.impact = Math.min(1, Math.max(0, (impact - 9) / 23));
    }
  } else if (s.position.y > support + SNAP) {
    s.grounded = false;
  }
  /* ---- carried by a moving deck ----------------------------------------
   *
   * A rising floor needs nothing from here: support is looked up from
   * `prevY + CLIMB`, so a deck that has come up under the body catches it,
   * and that is the whole of how the spire's lift works. A deck that moves in
   * **XZ** has no such luck, because support is looked up *by* XZ — the floor
   * simply leaves, and the body is left standing in the air where the tram
   * used to be. So the world is asked, once, whether the surface it just
   * reported is moving, and if it is, the body is moved with it.
   *
   * Four things about this, each of which is the difference between a tram
   * and a catapult:
   *
   * - **It is added to the position, never to the velocity.** A tram doing
   *   30 m/s that dumped its speed into the passenger would fire them across
   *   the city the instant they stepped off. Position carry leaves the body's
   *   own velocity meaning what it has always meant: how fast *you* are
   *   walking. Step off and you are walking, at walking pace.
   * - **The condition is "standing on it", not "near it".** `carryAt` is
   *   given the very height `supportAt` returned, so it can only answer for
   *   the deck that is actually holding the body up; and this only runs when
   *   the body settled onto that deck this step. A body on the platform
   *   beside a tram, on the road under it, or in the air over it, is not
   *   carried. Getting that wrong towards "carries more" is what drags a
   *   passenger through a wall.
   * - **Mid-air is not carried, and that is not a bug.** Jump on a moving
   *   tram and you land where physics puts you, which is further back than
   *   you left. That is what a real tram feels like.
   * - **Walk input and carry simply add.** The walk is integrated above in
   *   the world frame; this is another world-frame displacement on top. There
   *   is no "aboard" mode and nothing switches.
   *
   * The static-only block test is the one guard: a rigid translation cannot
   * push a body into the carrier's own walls (they moved too), but it could
   * in principle sweep one through a building, and that is the failure worth
   * refusing. Refusing it costs the passenger one frame of carry — they slide
   * a little way down the car — which is the cheap direction to be wrong in.
   */
  s.carried = false;
  if (
    s.grounded &&
    world.carryAt &&
    s.position.y <= support + 0.02 &&
    world.carryAt(s.position.x, s.position.z, support, _carry)
  ) {
    s.carried = true;
    if (_carry.x !== 0 || _carry.z !== 0 || _carry.w !== 0) {
      /* A rigid motion, not a translation: rotate the body about the deck's
       * own pivot and then slide it. Leaving the rotation out looks fine for
       * ten seconds and walks a passenger standing a metre off the centre
       * line straight out through the side of the tram over a lap, because a
       * ring is a turn and a turn moves the far side of a car further than
       * the near one. */
      const a = _carry.w * dt;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      /* The step the deck is about to take, from the step it has just taken.
       *
       * The offset and the translation are rotated *together*, and that is
       * the whole of it: a deck on an arc turns its own displacement vector
       * by the same angle it turns itself, so a carry that rotates the body
       * about the pivot but adds last step's chord unrotated is short by
       * v·dt·dtheta every frame. That is 1.1 mm at 30 m/s on a 218 m ring,
       * which is nothing, and it is also seven centimetres a second, which
       * walks a passenger out of the side of a tram inside a minute. It was
       * measured doing exactly that.
       */
      const rx = s.position.x - _carry.px + _carry.x * dt;
      const rz = s.position.z - _carry.pz + _carry.z * dt;
      const cx = _carry.px + rx * ca + rz * sa;
      const cz = _carry.pz - rx * sa + rz * ca;
      if (!world.blockedStaticAt || !world.blockedStaticAt(cx, cz, s.position.y)) {
        s.position.x = cx;
        s.position.z = cz;
        /* And turn with it. A passenger keeps facing the same way *in the
         * carriage*, which is what a person does; the alternative is standing
         * in a tram slowly rotating on the spot. The facing easing above only
         * runs when the body is actually moving under its own steam, so this
         * is not fighting it. */
        s.yaw += a;
      }
    }
  }

  s.drop = Math.max(0, s.position.y - support);
  if (!Number.isFinite(support)) s.drop = Infinity;

  /* ---- fell out of the world ------------------------------------------ */
  if (s.position.y < world.killY) {
    s.position.set(world.spawn.x, world.spawn.y, world.spawn.z);
    s.velocity.set(0, 0, 0);
    s.yaw = world.spawn.yaw;
    s.grounded = true;
  }

  /* ---- facing ----------------------------------------------------------
   * Turn toward where you are actually going, not where the stick points:
   * under thrust with no stick you keep drifting, and the body should keep
   * facing the drift rather than snapping back to the camera. */
  const speed = Math.hypot(s.velocity.x, s.velocity.z);
  if (speed > 0.8) {
    const target = Math.atan2(s.velocity.x, s.velocity.z);
    let dy = target - s.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    s.yaw += dy * Math.min(1, dt * 9);
  }

  // Lean: into the run on the ground, and much harder in the air, where the
  // body is being pushed by a rocket rather than by its own legs.
  const targetPitch = s.grounded
    ? Math.min(speed / RUN_SPEED, 1) * 0.10
    : Math.min(speed / FLY_RUN_SPEED, 1) * 0.42 - (thrusting ? 0.10 : 0);
  s.pitch += (targetPitch - s.pitch) * Math.min(1, dt * 5);
}

/**
 * The parkour jump, for a tap of Space on the ground.
 *
 * Kept out of the step function because it is edge-triggered and the step
 * function is not.
 */
export function jump(s: FlyerState): void {
  if (!s.grounded) return;
  s.velocity.y = JUMP_VELOCITY;
  s.grounded = false;
}
