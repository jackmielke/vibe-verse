/**
 * Vibe Kart — one CPU driver.
 *
 * A pilot is a plan and a pair of hands. The plan is refreshed at the
 * difficulty's reaction rate — where to be across the road, how fast to be
 * going, whether this corner is worth a slide — and the hands run every fixed
 * step, turning that plan into the same four numbers a player's controller
 * produces. Nothing here ever writes a transform: every kart on the grid,
 * including these seven, moves because `physics.setControls` was called.
 *
 * STEERING
 * --------
 * Pure pursuit onto a lookahead point that grows with speed, closed by an
 * inverse of the drive model rather than a hand-tuned gain. The physics turns
 * `steer` into a commanded yaw rate; so the pilot works out the yaw rate it
 * *wants* (speed × the curvature to the aim point, plus a correction on heading
 * error) and divides by the authority it knows it has. That is why a heavy kart
 * and a feather both track the same line instead of one of them weaving.
 *
 * DRIFTING
 * --------
 * The interesting part, because a drift in this game turns tighter than almost
 * any corner on the course. Holding one all the way round a bend would spear
 * the kart at the inside barrier, so the pilot does what a player does: sets up
 * wide, initiates, lets the slide carry it *across* the road to the apex, and
 * releases for the mini-turbo as it arrives.
 *
 * The length of that slide is not a magic number — it is solved. The drift yaws
 * at `rate` more (or less) than the corner needs, so the kart's cross-track
 * offset closes as ½·v·rate·t², and the road still left on that side gives a
 * time directly. Commit only if that time covers a blue tier; then hold it,
 * because releasing under blue pays nothing and has already cost the scrub.
 * Long corners get two or three bursts, which is exactly what the Quarry Bowl
 * should look like.
 *
 * One subtlety worth the comment: the physics latches the drift *direction*
 * from the steering held during the hop, and the hop is a quarter of a second
 * long. Pressing the button on the same frame the wheel starts moving loses the
 * latch about a third of the time — a hop that never becomes a drift. So the
 * pilot turns in first and presses second.
 */
import * as THREE from "three";
import { SURFACES, TUNING, type RacerState, type Rng, type SurfaceKind } from "../types";
import { clamp, clamp01, damp, approach, hash01, wander } from "./math";
import type { RacingLine } from "./line";
import type { DifficultyPreset, Personality } from "./profiles";
import { scanThreats, type FieldNode, type HazardNode, type ThreatQuery } from "./awareness";
import { wantsShortcut } from "./tactics";

/**
 * Mirrors of two physics constants the pilot has to invert. They are
 * implementation detail of another module and cannot be imported, so they are
 * restated here with the same names — if the drive model is retuned, the AI
 * degrades to slightly wrong drift arcs rather than breaking.
 */
const DRIFT_YAW_FALLOFF = 0.42;
const STEER_SPEED_FALLOFF = TUNING.steerSpeedFalloff;

/** Fraction of the nominal inner drift authority a real slide delivers once the
 *  physics' slip-catch has taken its cut. Measured, not derived. */
const DRIFT_CATCH = 0.78;

/** Below this the pilot cannot start a drift (physics: PHYS.driftMinSpeed). */
const DRIFT_MIN_SPEED = 6.5;

/** Seconds of drift needed before releasing is worth anything at all. */
const MIN_DRIFT_PAYOFF = TUNING.miniTurboTimes[0] + 0.08;

/** Curvature below which a bend is not a corner: 1/250 m. */
const CORNER_FLOOR = 0.0034;

/** Metres of road that must be left on the drift's side before committing. */
const DRIFT_ROOM = 5;

/** How close to the edge a live drift is allowed to get before it is banked. */
const DRIFT_EDGE_GUARD = 1.3;

export type PilotRoute = "line" | "shortcut" | "recover";

/**
 * The physics module publishes a strict superset of `RacerState`. `respawning`
 * is one of its additions and is not shared law, so it is read structurally and
 * treated as false when whatever is driving the field does not provide it.
 */
type RacerView = RacerState & { respawning?: boolean };

export interface Pilot {
  id: number;
  name: string;
  profile: Personality;
  rng: Rng;
  /** Steering-rate multiplier, mirrored from the character preset. */
  handling: number;

  // --- navigation --------------------------------------------------------
  /** Arc metres along the centreline. */
  s: number;
  lateral: number;
  /** Monotonic laps + fraction, maintained locally so the AI never depends on
   *  the race system having booted. */
  progress: number;
  place: number;

  // --- plan --------------------------------------------------------------
  planClock: number;
  /** Offset from the racing line the pilot is steering to, metres. */
  bias: number;
  biasTarget: number;
  targetSpeed: number;
  paceScale: number;
  band: number;
  /** Minimum speed the road ahead demands (a gap jump), 0 elsewhere. */
  floor: number;
  slow: number;
  crowded: boolean;
  route: PilotRoute;
  runway: number;

  // --- drift -------------------------------------------------------------
  drift: boolean;
  driftDir: 0 | 1 | -1;
  driftHold: number;
  driftPlanned: number;
  driftForce: number;
  /** Seconds spent turning in before the drift button is pressed. */
  driftArm: number;
  driftCooldown: number;

  // --- shortcut ----------------------------------------------------------
  onShortcut: boolean;
  shortcutU: number;
  shortcutLap: number;
  shortcutTake: boolean;

  // --- output ------------------------------------------------------------
  accel: number;
  brake: number;
  steer: number;
  wantDrift: boolean;

  // --- recovery ----------------------------------------------------------
  stuckTimer: number;
  reverseTimer: number;

  // --- flavour -----------------------------------------------------------
  mistakeTimer: number;
  mistakeSteer: number;
  mistakeLift: number;
  /** Per-driver phase of the lap-periodic lane weave. */
  phase: number;
}

export interface PilotWorld {
  line: RacingLine;
  lapLength: number;
  field: FieldNode[];
  hazards: HazardNode[];
  difficulty: DifficultyPreset;
  /** True once the lights are out. */
  racing: boolean;
  /** Seconds remaining on the countdown, 0 when there is none. */
  countdown: number;
  paused: boolean;
  /** Reference progress used for rubber banding — the player's. */
  playerProgress: number;
}

export interface PilotControls {
  accel: number;
  brake: number;
  steer: number;
  drift: boolean;
}

export function makePilot(
  id: number,
  name: string,
  profile: Personality,
  rng: Rng,
  stats: { handling: number },
): Pilot {
  return {
    id,
    name,
    profile,
    rng,
    handling: stats.handling,
    s: 0,
    lateral: 0,
    progress: 0,
    place: id + 1,
    planClock: hash01(id * 977) * 0.1,
    bias: profile.lane,
    biasTarget: profile.lane,
    targetSpeed: TUNING.topSpeed,
    paceScale: 1,
    band: 1,
    floor: 0,
    slow: 0,
    crowded: false,
    route: "line",
    runway: 60,
    drift: false,
    driftDir: 0,
    driftHold: 0,
    driftPlanned: 0,
    driftForce: 0,
    driftArm: 0,
    driftCooldown: 0,
    onShortcut: false,
    shortcutU: 0,
    shortcutLap: -1,
    shortcutTake: false,
    accel: 0,
    brake: 0,
    steer: 0,
    wantDrift: false,
    stuckTimer: 0,
    reverseTimer: 0,
    mistakeTimer: 1 + hash01(id * 31337) * 3,
    mistakeSteer: 0,
    mistakeLift: 0,
    phase: hash01(id * 7919 + 13),
  };
}

// ---------------------------------------------------------------------------
// Scratch — the pilot runs 7× per fixed step and must not allocate
// ---------------------------------------------------------------------------
const fwdV = new THREE.Vector3();
const rgtV = new THREE.Vector3();
const aim = new THREE.Vector3();
const out: PilotControls = { accel: 0, brake: 0, steer: 0, drift: false };
const toAim = new THREE.Vector3();
const corridor = { min: -6, max: 6 };
const threatQuery: ThreatQuery = {
  id: 0,
  s: 0,
  lateral: 0,
  speed: 0,
  wanted: 0,
  corridorMin: -6,
  corridorMax: 6,
  lapLength: 1,
  caution: 1,
  aggression: 0.5,
  invincible: false,
};
const FORWARD = new THREE.Vector3(0, 0, -1);
const RIGHT = new THREE.Vector3(1, 0, 0);

/** Surface the pilot considers "off the racing surface". */
function isOffRoad(kind: SurfaceKind): boolean {
  const props = SURFACES[kind];
  return !!props && props.speed < 0.9;
}

/** Metres of same-signed corner in front of `s`, capped. */
function cornerRun(line: RacingLine, s: number, dir: number, floor: number): number {
  const stride = Math.max(1.5, line.ds);
  let run = 0;
  for (let d = 0; d < 150; d += stride) {
    const k = line.cornerAt(s + d);
    if (Math.sign(k) !== dir || Math.abs(k) < floor) break;
    run = d + stride;
  }
  return run;
}

/** Metres of near-straight road in front of `s`. */
function runwayAhead(line: RacingLine, s: number): number {
  const stride = Math.max(2, line.ds * 2);
  let run = 0;
  for (let d = 0; d < 200; d += stride) {
    if (Math.abs(line.cornerAt(s + d)) > 0.006) break;
    run = d + stride;
  }
  return run;
}

// ---------------------------------------------------------------------------
// Planning — runs at the difficulty's reaction rate
// ---------------------------------------------------------------------------

function plan(pilot: Pilot, racer: RacerState, world: PilotWorld): void {
  const line = world.line;
  const diff = world.difficulty;
  const p = pilot.profile;
  const speed = Math.abs(racer.speed);
  const t = pilot.s / world.lapLength;

  pilot.runway = runwayAhead(line, pilot.s);

  // --- where across the road ---------------------------------------------
  // Personality lane plus a lap-periodic weave, so eight karts occupy eight
  // slightly different lines instead of a single conga. Both shrink with line
  // quality: a 200cc field is nearly on top of the ideal line, a 50cc field
  // wanders.
  const spread = 1 - diff.lineQuality * 0.55;
  let bias = p.lane * spread + wander(t, pilot.phase) * p.wander * spread;
  // Lower line quality also drags the whole line back toward the middle of the
  // road, which is what a mediocre driver actually does.
  bias += -line.offsetAt(pilot.s + 12) * (1 - diff.lineQuality * p.skill) * 0.55;

  // Setting up. On the approach to a corner worth sliding through, move a
  // little further out than the line strictly needs — it buys the width the
  // drift is about to spend, and a field that visibly widens before turn-in is
  // half of what makes a race look like a race.
  {
    const soon = line.cornerAt(pilot.s + 26);
    const here = line.cornerAt(pilot.s + 6);
    if (Math.abs(soon) > 0.005 && Math.abs(here) < Math.abs(soon) * 0.6) {
      bias -= Math.sign(soon) * 2.2 * clamp01(p.driftAppetite * diff.driftSkill);
    }
  }

  const aimS = pilot.s + clamp(6 + speed * 0.7, 8, 30);
  line.corridorAt(aimS, corridor);

  // Boost panels are worth a small detour and nothing more — chasing one across
  // the road costs more than the 0.95 s of boost it pays.
  const pad = line.padAhead(pilot.s, 42);
  if (pad) {
    const want = pad.lateral - line.offsetAt(pad.s);
    if (Math.abs(want - bias) < 5.5) {
      const closeness = clamp01(1 - (pad.s - pilot.s) / 42);
      bias += (want - bias) * (0.35 + 0.5 * closeness) * diff.lineQuality;
    }
  }

  // --- threats ------------------------------------------------------------
  const wantedAbs = clamp(line.offsetAt(aimS) + bias, corridor.min, corridor.max);
  threatQuery.id = pilot.id;
  threatQuery.s = pilot.s;
  threatQuery.lateral = pilot.lateral;
  threatQuery.speed = speed;
  threatQuery.wanted = wantedAbs;
  threatQuery.corridorMin = corridor.min;
  threatQuery.corridorMax = corridor.max;
  threatQuery.lapLength = world.lapLength;
  threatQuery.caution = p.caution * (0.55 + diff.awareness * 0.55);
  threatQuery.aggression = p.aggression;
  threatQuery.invincible = racer.star > 0 || racer.invuln > 0.4;
  const threat = scanThreats(threatQuery, world.field, world.hazards);
  pilot.slow = threat.slow;
  pilot.crowded = threat.crowded;
  bias += threat.lateral;

  pilot.biasTarget = bias;

  // --- rubber banding -----------------------------------------------------
  // Applied to *pace*, never to top speed, and never to the player. A rival in
  // front of the player runs a slightly softer line and lifts a fraction
  // earlier; a rival behind carries a little more into the corners. Over twenty
  // corners that is worth seconds, and it is invisible, because it never once
  // happens on a straight where a speed change would be obvious.
  const gap = (pilot.progress - world.playerProgress) * world.lapLength;
  const behind = clamp01(-gap / 120);
  const ahead = clamp01(gap / 120);
  // The leader is only ever gently reined in: a hard fallback on the front
  // runner is the thing that reads as teleporting.
  const leaderGuard = pilot.place <= 1 ? 0.55 : 1;
  const bandTarget =
    1 + TUNING.aiCatchup * behind * diff.band - TUNING.aiFallback * ahead * diff.band * leaderGuard;
  pilot.band = damp(pilot.band, bandTarget, 0.8, diff.reaction);

  // --- how fast -----------------------------------------------------------
  // Sample the profile a braking distance ahead, not underfoot, so the lift
  // happens before the corner rather than in it.
  const lookBrake = clamp(speed * 0.9 + 8, 12, 55);
  let target = Infinity;
  const stride = Math.max(2, line.ds * 2);
  for (let d = 0; d <= lookBrake; d += stride) {
    const v = line.speedAt(pilot.s + d);
    // What we may be doing now to still be at `v` there, at planning decel.
    const allowed = Math.sqrt(v * v + 2 * 14 * d);
    if (allowed < target) target = allowed;
  }
  pilot.paceScale = diff.pace * p.skill * p.bravery * pilot.band;
  target *= pilot.paceScale;
  if (pilot.route === "shortcut") target = Math.min(target, TUNING.topSpeed * SURFACES.dirt.speed * 1.15);
  if (racer.star > 0) target *= 1.06;
  // The cc class, plus a couple of per-driver percent so the field is not all
  // pinned to the identical number down the Cannery Straight. Rubber banding
  // rides on the cap rather than under it, which is what keeps a catching rival
  // from being held behind an invisible wall.
  target = Math.min(target, TUNING.topSpeed * diff.speedCap * pilot.band * (0.97 + 0.06 * p.skill));
  // The jump's minimum entry speed outranks caution, cc class and rubber band
  // alike. It is not a preference, it is the width of the ravine.
  pilot.floor = line.floorAt(pilot.s + clamp(speed * 0.6, 6, 24));
  if (pilot.floor > 0) target = Math.max(target, pilot.floor);
  pilot.targetSpeed = clamp(target, 6, TUNING.topSpeed * 2.2);

  // --- mistakes -----------------------------------------------------------
  // Not randomness for its own sake: a field that never errs is a field the
  // player can never out-drive, and the errors here are all recoverable ones a
  // human makes — a late lift, a wide entry, a twitch of over-correction.
  pilot.mistakeTimer -= diff.reaction;
  if (pilot.mistakeTimer <= 0) {
    pilot.mistakeTimer = 1.4 + pilot.rng() * 4;
    if (pilot.rng() < diff.mistakeRate * (2 - p.skill) * 6) {
      const roll = pilot.rng();
      if (roll < 0.45) {
        pilot.mistakeSteer = (pilot.rng() - 0.5) * 0.34;
        pilot.mistakeLift = 0;
      } else if (roll < 0.8) {
        pilot.mistakeSteer = 0;
        pilot.mistakeLift = 0.25 + pilot.rng() * 0.35;
      } else {
        // Braked too late: carry more speed than the corner wants and run wide.
        pilot.mistakeSteer = 0;
        pilot.mistakeLift = -0.18;
      }
    }
  }

  // --- drift --------------------------------------------------------------
  planDrift(pilot, racer, world, speed);
}

/**
 * Decide whether to start a slide, and how long it can possibly last.
 *
 * `window` is the honest answer to "how long before this drift puts me in the
 * inside barrier": with the drift yawing `dYaw` faster than the corner needs,
 * the kart's cross-track offset closes as ½·v·dYaw·t², so the room to the
 * inside gives a time directly. If that time cannot cover a blue mini-turbo,
 * the slide is not worth the scrub and the pilot stays on the grip.
 */
function planDrift(pilot: Pilot, racer: RacerState, world: PilotWorld, speed: number): void {
  const line = world.line;
  const diff = world.difficulty;
  const p = pilot.profile;

  if (pilot.drift) return; // release is decided every step, in drive()

  pilot.wantDrift = false;
  if (
    !world.racing ||
    world.paused ||
    !racer.grounded ||
    racer.stun > 0 ||
    racer.finished ||
    pilot.driftCooldown > 0 ||
    pilot.route !== "line" ||
    pilot.slow > 0.08 ||
    speed < DRIFT_MIN_SPEED + 3 ||
    isOffRoad(racer.surface)
  ) {
    return;
  }

  const k = line.cornerAt(pilot.s + 8);
  const dir: 1 | -1 = k > 0 ? 1 : -1;
  const strength = Math.abs(k);
  if (strength < CORNER_FLOOR) return;

  const run = cornerRun(line, pilot.s + 4, dir, 0.0035);
  if (run < 20) return;

  const speedFrac = clamp01(speed / TUNING.topSpeed);
  // `driftCatch` is the physics easing its own yaw command off once the slip
  // runs past the drift's target — a fully counter-steered slide never quite
  // delivers the nominal inner authority, and assuming it does makes the pilot
  // refuse slides it could comfortably hold.
  const driftYaw =
    TUNING.driftSteerInner * pilot.handling * (1 - DRIFT_YAW_FALLOFF * speedFrac) * DRIFT_CATCH;
  const neededYaw = speed * strength;
  const dYaw = driftYaw - neededYaw;
  // Which way the slide will carry the kart. A drift that out-turns the corner
  // walks it to the inside; one that under-turns it — the hairpin, where even
  // full counter-steer is not enough — runs it wide. Both are useful, and both
  // are only useful while there is road left on that side.
  const trend = dYaw > 0 ? dir : -dir;
  const rate = Math.abs(dYaw);

  line.corridorAt(pilot.s + 10, corridor);
  // Plus the kerb, which is painted precisely so a drift may use it.
  const room = (trend > 0 ? corridor.max - pilot.lateral : pilot.lateral - corridor.min) + 1.4;
  if (room < DRIFT_ROOM) return;
  // Cross-track offset closes as ½·v·rate·t², so the room gives a time directly.
  const window = rate < 0.03 ? 3 : Math.sqrt((2 * room) / Math.max(0.05, speed * rate));
  if (window < MIN_DRIFT_PAYOFF) return;

  // How long they will actually hold: the tier their personality wants, capped
  // by the road and by the corner. Higher difficulty is more willing to sit in
  // a slide for the orange and purple tiers.
  const appetite = clamp01(p.driftAppetite * (0.45 + diff.driftSkill * 0.75));
  const wantTier = appetite > 0.8 ? p.driftTier : appetite > 0.5 ? Math.min(2, p.driftTier) : 1;
  const wantTime = TUNING.miniTurboTimes[wantTier - 1] + 0.2;
  const hold = Math.min(wantTime, window, run / Math.max(6, speed));
  if (hold < MIN_DRIFT_PAYOFF) return;
  // Even keen drivers pass on a marginal slide sometimes; it is what stops the
  // field from looking metronomic through a sequence of similar corners.
  if (pilot.rng() > 0.35 + appetite * 0.75) return;

  pilot.wantDrift = true;
  pilot.driftDir = dir;
  pilot.driftPlanned = hold;
}

// ---------------------------------------------------------------------------
// Driving — every fixed step
// ---------------------------------------------------------------------------

export function stepPilot(pilot: Pilot, racer: RacerState, world: PilotWorld, dt: number): PilotControls {
  const line = world.line;
  const diff = world.difficulty;
  const p = pilot.profile;

  // Body frame from the quaternion — the AI reads the same orientation the
  // renderer draws, which matters on the banked bowl and the vertical plating.
  fwdV.copy(FORWARD).applyQuaternion(racer.quaternion);
  rgtV.copy(RIGHT).applyQuaternion(racer.quaternion);

  const speed = racer.speed;
  const absSpeed = Math.abs(speed);
  const speedFrac = clamp01(absSpeed / TUNING.topSpeed);
  const offRoad = racer.grounded && isOffRoad(racer.surface);

  // --- plan ticker --------------------------------------------------------
  pilot.planClock -= dt;
  if (pilot.planClock <= 0) {
    pilot.planClock += Math.max(1 / 60, diff.reaction);
    updateRoute(pilot, racer, world);
    plan(pilot, racer, world);
  }

  // Mistake decay.
  if (pilot.mistakeSteer !== 0) pilot.mistakeSteer = damp(pilot.mistakeSteer, 0, 2.2, dt);
  if (pilot.mistakeLift !== 0) pilot.mistakeLift = damp(pilot.mistakeLift, 0, 1.6, dt);

  // --- frozen states ------------------------------------------------------
  if ((racer as RacerView).respawning || (racer.stun > 0 && racer.stunKind !== "bump")) {
    releaseDrift(pilot, 0.35);
    pilot.accel = damp(pilot.accel, racer.stun > 0 ? 1 : 0, 6, dt);
    pilot.brake = 0;
    pilot.steer = damp(pilot.steer, 0, 8, dt);
    return write(pilot, false);
  }

  if (!world.racing) {
    // The rocket start. Roll onto the throttle in the last moment of the
    // countdown, at a per-driver instant, so the grid does not launch as one
    // machine and the good ones get the start boost.
    const trigger = 0.62 - p.skill * 0.12 - hash01(pilot.id * 5171) * 0.22;
    const on = world.countdown > 0 && world.countdown < trigger;
    pilot.accel = damp(pilot.accel, on ? 1 : 0, 12, dt);
    pilot.brake = 0;
    pilot.steer = damp(pilot.steer, 0, 10, dt);
    releaseDrift(pilot, 0);
    return write(pilot, false);
  }

  // Past the flag they keep driving — a kart that stops dead on the pit straight
  // while the rest of the field is still racing looks broken — but they stop
  // sliding, stop fighting for the line, and cruise it home.
  if (racer.finished) releaseDrift(pilot, 0);

  // --- the aim point ------------------------------------------------------
  // Smooth the lateral intent rather than the steering: moving the *target*
  // gives a driver easing into a lane change, moving the steering gives a
  // servo hunting for one.
  pilot.bias = damp(pilot.bias, pilot.biasTarget, 3.4, dt);

  const lookahead = clamp(5.5 + absSpeed * (0.58 + diff.lineQuality * 0.12), 7.5, 30);
  let alpha: number;

  if (pilot.route === "shortcut" && line.shortcut) {
    alpha = aimAtShortcut(pilot, racer, line, lookahead);
  } else {
    const aimS = pilot.s + lookahead;
    line.corridorAt(aimS, corridor);
    const lat = clamp(line.offsetAt(aimS) + pilot.bias, corridor.min, corridor.max);
    line.point(aimS, lat, 0.35, aim);
    toAim.subVectors(aim, racer.position);
    alpha = Math.atan2(toAim.dot(rgtV), Math.max(0.2, toAim.dot(fwdV)));
  }
  alpha += pilot.mistakeSteer;

  // --- off-road and stuck recovery ---------------------------------------
  let recovering = false;
  if (offRoad && pilot.route !== "shortcut") {
    // Nothing else matters: get back on tarmac, on the throttle, and do not
    // try to drift on grass.
    recovering = true;
    releaseDrift(pilot, 0.4);
  }

  if (absSpeed < 1.2 && !racer.finished && racer.stun <= 0 && !world.paused) {
    pilot.stuckTimer += dt;
  } else {
    pilot.stuckTimer = 0;
  }
  if (pilot.stuckTimer > 1.1 && pilot.reverseTimer <= 0) {
    pilot.reverseTimer = 0.85;
    pilot.stuckTimer = 0;
    releaseDrift(pilot, 0.5);
  }
  if (pilot.reverseTimer > 0) {
    pilot.reverseTimer -= dt;
    pilot.accel = 0;
    pilot.brake = 1;
    // Reverse out the way we came in — steering the same way while going
    // backwards would only wedge the kart harder against the barrier.
    pilot.steer = approach(pilot.steer, clamp(-alpha * 1.4, -1, 1), dt * 8);
    return write(pilot, false);
  }

  // --- drift state machine ------------------------------------------------
  if (pilot.driftCooldown > 0) pilot.driftCooldown = Math.max(0, pilot.driftCooldown - dt);

  if (pilot.drift) {
    pilot.driftHold += dt;
    pilot.driftForce = Math.max(0, pilot.driftForce - dt);
    if (shouldReleaseDrift(pilot, racer, world, absSpeed, recovering)) {
      // Cooldown short enough that a long corner is a *sequence* of slides —
      // release, bank the turbo, hop straight back in. That rhythm is the
      // single most recognisable thing about a Mario Kart field.
      releaseDrift(pilot, 0.28 + pilot.rng() * 0.2);
    }
  } else if (pilot.wantDrift && !recovering && racer.grounded && absSpeed > DRIFT_MIN_SPEED) {
    // Arm before hopping. The physics latches the drift direction from the
    // *steering held during the hop*, and the hop is a quarter of a second
    // long; press the button on the same frame the wheel starts moving and the
    // lock window can close before the steering has ramped past the threshold,
    // which is a hop that never becomes a drift. So: turn in first, and only
    // press once the wheel is genuinely over.
    pilot.driftArm += dt;
    if (pilot.driftArm > 0.06 && Math.sign(pilot.steer) === pilot.driftDir && Math.abs(pilot.steer) > 0.3) {
      pilot.drift = true;
      pilot.driftHold = 0;
      pilot.driftForce = 0.34;
      pilot.driftArm = 0;
      pilot.wantDrift = false;
    } else if (pilot.driftArm > 0.5) {
      // The corner never arrived, or the kart is being pushed the other way.
      pilot.driftArm = 0;
      pilot.wantDrift = false;
    }
  } else {
    pilot.driftArm = 0;
  }

  // --- steering -----------------------------------------------------------
  const desiredTurn = Math.max(3, absSpeed) * ((2 * Math.sin(alpha)) / lookahead);
  const currentTurn = -racer.yawRate;
  let steer: number;

  if (racer.drifting && racer.driftDir !== 0) {
    // Invert the drift model: yaw authority runs from `driftSteerInner` at full
    // counter-steer to `driftSteerOuter` at full lock into the slide, so the
    // wheel position that produces the arc we want is solvable rather than
    // guessed at.
    const dir = racer.driftDir;
    const fall = 1 - DRIFT_YAW_FALLOFF * speedFrac;
    const inner = TUNING.driftSteerInner * pilot.handling * fall;
    const outer = TUNING.driftSteerOuter * pilot.handling * fall;
    const needed = desiredTurn * dir;
    let k = (needed - inner) / Math.max(0.2, outer - inner);
    k += alpha * dir * 1.8;
    steer = clamp((2 * clamp01(k) - 1) * dir, -1, 1);
  } else if (pilot.driftArm > 0 || (pilot.driftForce > 0 && pilot.drift)) {
    // Arming, or mid-hop: hold real lock in the planned direction. Anything
    // under ~0.22 is invisible to the drive model's drift latch.
    const want = clamp(desiredTurn / Math.max(0.4, TUNING.steerRate * pilot.handling), -1, 1);
    steer = pilot.driftDir * Math.max(0.62, Math.abs(want));
  } else {
    const authority = Math.max(0.35, TUNING.steerRate * pilot.handling * (1 - STEER_SPEED_FALLOFF * speedFrac));
    // Feedforward on the arc we want, plus proportional heading correction and
    // a little damping on the yaw error. All three are rates, so the whole sum
    // divides cleanly by the authority.
    const cmd = desiredTurn + alpha * 1.9 + (desiredTurn - currentTurn) * 0.3;
    steer = clamp(cmd / authority, -1, 1);
  }

  if (!racer.grounded) steer *= 0.55; // barely any air authority; do not flail
  // The wheel moves faster when committing to a slide than when trimming a line.
  pilot.steer = approach(pilot.steer, steer, dt * (pilot.driftArm > 0 || pilot.driftForce > 0 ? 16 : 9));

  // --- throttle and brake -------------------------------------------------
  let accel = diff.throttleCap;
  let brake = 0;

  if (recovering) {
    accel = 1;
  } else if (pilot.floor > 0 && absSpeed < pilot.floor) {
    // Charging the kicker. Throttle ceilings and lifted-for-traffic are both
    // suspended: there is no version of this where arriving slowly is correct.
    accel = 1;
  } else {
    const over = absSpeed - pilot.targetSpeed;
    if (over > 0.3) {
      // Lift first. An arcade kart that stands on the brakes for every corner
      // looks like a driving simulator; one that breathes the throttle looks
      // like a kart.
      accel = clamp01(1 - over / 2.4) * diff.throttleCap;
      brake = clamp01((over - 2.0) / 5.5) * (0.5 + p.bravery * 0.35);
    }
    accel *= 1 - pilot.slow * 0.8;
    brake = Math.max(brake, pilot.slow * 0.35);
    accel *= 1 - clamp01(pilot.mistakeLift);
  }

  // A drift dies at brake > 0.55, and a drift that dies halfway to orange has
  // wasted the whole corner.
  if (racer.drifting || pilot.drift) brake = Math.min(brake, 0.45);
  if (!racer.grounded) brake = 0;
  if (racer.finished) {
    accel = 0.5;
    brake = 0;
  }

  pilot.accel = approach(pilot.accel, clamp01(accel), dt * 7);
  pilot.brake = approach(pilot.brake, clamp01(brake), dt * 9);

  return write(pilot, pilot.drift);
}

function write(pilot: Pilot, drift: boolean): PilotControls {
  out.accel = clamp01(pilot.accel);
  out.brake = clamp01(pilot.brake);
  out.steer = clamp(pilot.steer, -1, 1);
  out.drift = drift;
  return out;
}

function releaseDrift(pilot: Pilot, cooldown: number): void {
  if (pilot.drift) pilot.driftCooldown = Math.max(pilot.driftCooldown, cooldown);
  pilot.drift = false;
  pilot.driftForce = 0;
  pilot.driftArm = 0;
  pilot.driftHold = 0;
  pilot.wantDrift = false;
}

/**
 * When to let go. In priority order: the slide is no longer physically viable,
 * the corner has run out, the apex has arrived, or the planned charge is banked.
 */
function shouldReleaseDrift(
  pilot: Pilot,
  racer: RacerState,
  world: PilotWorld,
  speed: number,
  recovering: boolean,
): boolean {
  if (recovering || racer.stun > 0 || racer.finished) return true;
  if (speed < DRIFT_MIN_SPEED) return true;
  // Traffic: bank whatever has been charged rather than slide into someone.
  if (pilot.crowded && pilot.driftHold > MIN_DRIFT_PAYOFF) return true;
  // Give the hop a moment to become a drift before judging it.
  if (!racer.drifting) return pilot.driftHold > 0.75;

  const line = world.line;
  const dir = racer.driftDir;
  if (dir === 0) return false;

  // Out of road on whichever side the slide is walking the kart toward. The
  // same arithmetic that licensed the drift now ends it, so a slide can never
  // be committed to and then abandoned on its first step.
  const k = line.cornerAt(pilot.s + 6);
  const speedFrac = clamp01(speed / TUNING.topSpeed);
  const driftYaw =
    TUNING.driftSteerInner * pilot.handling * (1 - DRIFT_YAW_FALLOFF * speedFrac) * DRIFT_CATCH;
  const trend = driftYaw - speed * Math.abs(k) > 0 ? dir : -dir;
  line.corridorAt(pilot.s + 4, corridor);
  const room = (trend > 0 ? corridor.max - pilot.lateral : pilot.lateral - corridor.min) + 1.4;
  if (room < DRIFT_EDGE_GUARD) return true;

  // Commitment. Releasing under the blue tier pays exactly nothing and has
  // already cost the scrub, so short of running out of road the pilot sees it
  // through — which is also what stops a wobble in the curvature reading from
  // cancelling a slide a tenth of a second after starting it.
  if (pilot.driftHold < MIN_DRIFT_PAYOFF) return false;

  // The corner has stopped being this corner.
  if (Math.sign(k) !== dir || Math.abs(k) < 0.002) return true;

  // Arrived at the apex: the slide has done what it was started for, and every
  // further metre of it is scrub.
  const target = line.offsetAt(pilot.s + 4);
  const crossed = trend > 0 ? pilot.lateral - target : target - pilot.lateral;
  if (crossed > 1.4) return true;

  // Charge banked: hold until the planned tier lands, then cash it in.
  if (pilot.driftHold >= pilot.driftPlanned && racer.driftTier >= 1) return true;
  // Long stop-loss so a drift can never be held forever by a bad prediction.
  return pilot.driftHold > 3.6;
}

// ---------------------------------------------------------------------------
// Route selection — main line versus the dirt cut
// ---------------------------------------------------------------------------

function updateRoute(pilot: Pilot, racer: RacerState, world: PilotWorld): void {
  const sc = world.line.shortcut;
  if (!sc) {
    pilot.route = "line";
    pilot.onShortcut = false;
    return;
  }

  if (pilot.onShortcut) {
    // Bail out if the cut has been lost — a spin-out on the dirt leaves the
    // kart nowhere near the polyline, and chasing it then is how an AI ends up
    // driving into scenery.
    const d = shortcutDistance(sc, racer.position);
    if (pilot.shortcutU > sc.length - 4 || d > 9) {
      pilot.onShortcut = false;
      pilot.route = "line";
    }
    return;
  }

  const entryS = sc.entryT * world.lapLength;
  let toEntry = (entryS - pilot.s) % world.lapLength;
  if (toEntry < -world.lapLength * 0.5) toEntry += world.lapLength;
  else if (toEntry > world.lapLength * 0.5) toEntry -= world.lapLength;

  if (toEntry > 60 || toEntry < -6) {
    pilot.route = "line";
    return;
  }

  // Decide once per lap, at the same place, so a rival does not dither on the
  // entry kerb changing its mind every plan tick.
  const lap = Math.floor(pilot.progress);
  if (pilot.shortcutLap !== lap) {
    pilot.shortcutLap = lap;
    const mush = racer.item === "mushroom" || racer.item === "tripleMushroom";
    const behindBy = Math.max(0, (world.playerProgress - pilot.progress) * world.lapLength);
    pilot.shortcutTake = wantsShortcut(
      sc.gain,
      sc.gainBoosted,
      mush,
      behindBy,
      pilot.profile,
      world.difficulty.lineQuality,
      pilot.rng(),
    );
  }

  if (pilot.shortcutTake && toEntry < 8) {
    pilot.onShortcut = true;
    pilot.route = "shortcut";
    pilot.shortcutU = 0;
    releaseDrift(pilot, 0.3);
  } else {
    pilot.route = "line";
  }
}

/** Nearest distance from a world point to the cut, and the arc along it. */
function shortcutDistance(sc: NonNullable<RacingLine["shortcut"]>, pos: THREE.Vector3): number {
  let best = Infinity;
  for (let i = 0; i < sc.count - 1; i++) {
    const ax = sc.pos[i * 3];
    const ay = sc.pos[i * 3 + 1];
    const az = sc.pos[i * 3 + 2];
    const vx = sc.pos[(i + 1) * 3] - ax;
    const vy = sc.pos[(i + 1) * 3 + 1] - ay;
    const vz = sc.pos[(i + 1) * 3 + 2] - az;
    const len2 = vx * vx + vy * vy + vz * vz || 1e-9;
    const f = clamp01(((pos.x - ax) * vx + (pos.y - ay) * vy + (pos.z - az) * vz) / len2);
    const dx = pos.x - (ax + vx * f);
    const dy = pos.y - (ay + vy * f);
    const dz = pos.z - (az + vz * f);
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Steer along the dirt cut; returns the pure-pursuit angle. */
function aimAtShortcut(pilot: Pilot, racer: RacerState, line: RacingLine, lookahead: number): number {
  const sc = line.shortcut;
  if (!sc) return 0;
  // Project onto the polyline for the arc position, then look ahead along it.
  let best = Infinity;
  let bestU = 0;
  for (let i = 0; i < sc.count - 1; i++) {
    const ax = sc.pos[i * 3];
    const ay = sc.pos[i * 3 + 1];
    const az = sc.pos[i * 3 + 2];
    const vx = sc.pos[(i + 1) * 3] - ax;
    const vy = sc.pos[(i + 1) * 3 + 1] - ay;
    const vz = sc.pos[(i + 1) * 3 + 2] - az;
    const len2 = vx * vx + vy * vy + vz * vz || 1e-9;
    const f = clamp01(((racer.position.x - ax) * vx + (racer.position.y - ay) * vy + (racer.position.z - az) * vz) / len2);
    const dx = racer.position.x - (ax + vx * f);
    const dy = racer.position.y - (ay + vy * f);
    const dz = racer.position.z - (az + vz * f);
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) {
      best = d;
      bestU = sc.cum[i] + Math.sqrt(len2) * f;
    }
  }
  pilot.shortcutU = bestU;

  const targetU = Math.min(sc.length - 0.01, bestU + lookahead);
  let i = 0;
  while (i < sc.count - 2 && sc.cum[i + 1] < targetU) i++;
  const span = Math.max(1e-4, sc.cum[i + 1] - sc.cum[i]);
  const f = clamp01((targetU - sc.cum[i]) / span);
  aim.set(
    sc.pos[i * 3] + (sc.pos[(i + 1) * 3] - sc.pos[i * 3]) * f,
    sc.pos[i * 3 + 1] + (sc.pos[(i + 1) * 3 + 1] - sc.pos[i * 3 + 1]) * f,
    sc.pos[i * 3 + 2] + (sc.pos[(i + 1) * 3 + 2] - sc.pos[i * 3 + 2]) * f,
  );
  toAim.subVectors(aim, racer.position);
  return Math.atan2(toAim.dot(rgtV), Math.max(0.2, toAim.dot(fwdV)));
}
