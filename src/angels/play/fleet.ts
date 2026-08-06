/**
 * The flight — you and the five jets flying off your wings.
 *
 * You are number 1. That is the design decision this whole file exists to
 * support: in every other flight game the demo team is scenery you watch, and
 * here the Diamond is *yours*. Two, three and four sit on your wingtips and
 * they will follow you through anything you are willing to fly, including into
 * the lake.
 *
 * Which makes the wingman controller the interesting problem. Real formation
 * pilots do not fly a position over the ground; they fly *the leader*, holding
 * a fixed offset in his body frame and never once looking at the horizon. So
 * the offsets here are in the leader's body frame too, which is why the Diamond
 * Roll comes out right: when you roll, the whole formation sweeps around your
 * roll axis as one rigid object, because that is literally what is being asked
 * for. A world-frame implementation of the same manoeuvre looks wrong in a way
 * that is hard to name and impossible to unsee.
 */
import * as THREE from "three";
import type { AngelsCtx, System, TerrainService, Vec3Like } from "../types";
import { FIXED_DT } from "../types";
import { DEFAULT_JET, aircraft, type AircraftSpec, type JetId } from "../flight/aircraft";
import {
  assistsFor,
  createFlightState,
  greyout,
  neutralControls,
  stepFlight,
  trimLevel,
  type AssistLevel,
  type Assists,
  type Controls,
  type FlightEnvironment,
  type FlightState,
} from "../flight/dynamics";
import { buildJet, createJetMaterial, poseJet, type JetRig } from "../entities/jet";
import type { EnvService } from "../world/sky";
import { LANDMARKS, SHOW_CENTRE, latToZ, lonToX } from "../world/geo";

/** Where the flight can be put. */
export type SpawnPoint = "needle" | "show" | "runway" | "high";

/**
 * How long you watch your own fireball before the jet is handed back.
 *
 * Long enough to see what you did and swear at it, short enough that you are
 * not sitting through a cutscene the third time. The card that comes up counts
 * it down and has a button on it, so nobody who wants to go now has to wait.
 */
const WRECK_SECONDS = 3.6;

/**
 * The Diamond, in the leader's body frame: +X right, +Y up, -Z forward.
 *
 * These are the real numbers. Parade separation is 36 inches wingtip to
 * canopy, which for a Super Hornet's 13.68 m span puts number 2's centreline
 * about 7.2 m off the leader's and 3 m back. The Diamond 360 tightens it to
 * the famous 18 inches, and `tightness` is what does that.
 */
export interface Slot {
  name: string;
  number: number;
  /** Body-frame offset from the leader, metres. */
  offset: THREE.Vector3;
}

export const DIAMOND: Slot[] = [
  { name: "Lead", number: 1, offset: new THREE.Vector3(0, 0, 0) },
  { name: "Right Wing", number: 2, offset: new THREE.Vector3(7.2, -0.6, 3.0) },
  { name: "Left Wing", number: 3, offset: new THREE.Vector3(-7.2, -0.6, 3.0) },
  { name: "Slot", number: 4, offset: new THREE.Vector3(0, -2.5, 8.0) },
  { name: "Lead Solo", number: 5, offset: new THREE.Vector3(14.4, -1.2, 6.0) },
  { name: "Opposing Solo", number: 6, offset: new THREE.Vector3(-14.4, -1.2, 6.0) },
];

export type FormationName = "diamond" | "delta" | "echelon" | "line-abreast" | "trail" | "free";

/** Alternative offsets. Everything is a rearrangement of the same six jets. */
const FORMATIONS: Record<FormationName, THREE.Vector3[]> = {
  diamond: DIAMOND.map((s) => s.offset.clone()),
  delta: [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(7.2, -0.6, 3.0),
    new THREE.Vector3(-7.2, -0.6, 3.0),
    new THREE.Vector3(0, -2.5, 8.0),
    new THREE.Vector3(14.4, -1.2, 6.0),
    new THREE.Vector3(-14.4, -1.2, 6.0),
  ],
  echelon: [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(7.2, -0.6, 3.0),
    new THREE.Vector3(14.4, -1.2, 6.0),
    new THREE.Vector3(21.6, -1.8, 9.0),
    new THREE.Vector3(28.8, -2.4, 12.0),
    new THREE.Vector3(36.0, -3.0, 15.0),
  ],
  "line-abreast": [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(10.8, 0, 0),
    new THREE.Vector3(-10.8, 0, 0),
    new THREE.Vector3(21.6, 0, 0),
    new THREE.Vector3(-21.6, 0, 0),
    new THREE.Vector3(32.4, 0, 0),
  ],
  trail: [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, -3, 24),
    new THREE.Vector3(0, -6, 48),
    new THREE.Vector3(0, -9, 72),
    new THREE.Vector3(0, -12, 96),
    new THREE.Vector3(0, -15, 120),
  ],
  free: [],
};

export interface Aircraft {
  index: number;
  spec: AircraftSpec;
  state: FlightState;
  controls: Controls;
  rig: JetRig;
  /** 1..6. */
  number: number;
  callsign: string;
  isPlayer: boolean;
  /** Smoke on, tracked separately from the control so the AI can mirror it. */
  smoke: boolean;
  /** How hard this wingman is currently working to hold its slot, 0..1. */
  strain: number;
  /** Set when the wingman has lost the formation and is rejoining. */
  detached: boolean;
}

export interface FleetService {
  player: Aircraft;
  all: Aircraft[];
  wingmen: Aircraft[];
  formation: FormationName;
  setFormation(f: FormationName): void;
  /** 0 = parade, 1 = the Diamond 360's eighteen inches. */
  tightness: number;
  setTightness(t: number): void;
  assist: AssistLevel;
  setAssist(level: AssistLevel): void;
  jet: JetId;
  /** Swap the whole team onto a different airframe. */
  setJet(id: JetId): void;
  /** Number of wingmen actually in the air. */
  wingmanCount: number;
  setWingmanCount(n: number): void;
  /** Put the player back somewhere sensible. Defaults to wherever you started. */
  respawn(where?: SpawnPoint): void;
  /** Where the last respawn put the flight. `R` and the crash reset reuse it. */
  readonly spawnPoint: SpawnPoint;
  /**
   * The state of the smoking hole, if there is one.
   *
   * `active` is true from the moment of the crash until the jet is handed
   * back; `timer` counts up toward `WRECK_SECONDS`. The UI reads it to draw
   * the card, the camera reads it to go and watch, and the fleet itself reads
   * it to know not to fly a jet that is in several pieces.
   */
  readonly wreck: {
    active: boolean;
    timer: number;
    duration: number;
    /** What you hit, in words. */
    cause: string;
    speed: number;
    position: THREE.Vector3;
  };
  /** Skip the countdown and go now. */
  restart(): void;
  /** Roll upright and fly to the horizon for a couple of seconds. */
  levelOut(): void;
  /** Seconds of recovery left, for the HUD to show it is doing something. */
  readonly levelling: number;
  /**
   * Put the whole flight on a run-in of your choosing, in formation.
   * Heading is degrees true, speed m/s.
   */
  place(position: Vec3Like, headingDeg: number, speed: number): void;
  greyout: { grey: number; red: number };
  /** Metres of separation to the nearest other jet. */
  nearestSeparation: number;
}

const CALLSIGNS = ["Boss", "Right Wing", "Left Wing", "Slot", "Lead Solo", "Opposing Solo"];

export function createFleet(ctx: AngelsCtx): System {
  const env = ctx.services.env as EnvService | undefined;
  const terrain = ctx.services.terrain as TerrainService | undefined;
  const material = createJetMaterial(
    env ? (env.uniforms as unknown as Record<string, THREE.IUniform>) : {},
  );

  const group = new THREE.Group();
  group.name = "fleet";
  ctx.scene.add(group);

  const flightEnv: FlightEnvironment = {
    terrainHeight: (x, z) => terrain?.surfaceAt(x, z) ?? 0,
    isWater: (x, z) => terrain?.isWater(x, z) ?? false,
    wind: (p, out) => {
      // A light north-westerly off the Sound, plus thermals over the city on
      // an August afternoon. Small, but it is the difference between air you
      // fly through and a vacuum.
      const t = ctx.elapsed;
      const gust = Math.sin(p.x * 0.0007 + t * 0.21) * Math.cos(p.z * 0.0006 - t * 0.17);
      const shear = Math.min(1, p.y / 900);
      return out
        .set(2.4 + gust * 1.6, gust * 0.5 * (1 - shear), 1.6 - gust * 1.2)
        .multiplyScalar(0.5 + shear * 0.9);
    },
  };

  let jetId: JetId = DEFAULT_JET;
  let assistLevel: AssistLevel = "angel";
  let assists: Assists = assistsFor(assistLevel);
  let formation: FormationName = "diamond";
  let tightness = 0;
  let wingmanCount = 5;
  let spawnPoint: SpawnPoint = "needle";

  // Declared up here rather than beside the rest of the crash code because the
  // initial `respawn()` at the bottom of this factory clears it, and a `const`
  // below that call is still in its temporal dead zone when it runs — which
  // took the whole fleet system down at boot, and with it the game, the
  // effects and the explosion that depend on it.
  const wreck = {
    active: false,
    timer: 0,
    duration: WRECK_SECONDS,
    cause: "",
    speed: 0,
    position: new THREE.Vector3(),
  };

  const all: Aircraft[] = [];

  function makeAircraft(index: number, spec: AircraftSpec): Aircraft {
    const rig = buildJet(spec, material, { number: DIAMOND[index].number });
    group.add(rig.root);
    return {
      index,
      spec,
      state: createFlightState(spec),
      controls: neutralControls(),
      rig,
      number: DIAMOND[index].number,
      callsign: CALLSIGNS[index],
      isPlayer: index === 0,
      smoke: false,
      strain: 0,
      detached: false,
    };
  }

  function buildFleet(id: JetId): void {
    const spec = aircraft(id);
    for (const a of all) {
      group.remove(a.rig.root);
      a.rig.dispose();
    }
    all.length = 0;
    // Fat Albert flies alone; nothing else in the hangar can hold its wing.
    const seats = spec.teamSize === 1 ? 1 : 6;
    for (let i = 0; i < seats; i++) all.push(makeAircraft(i, spec));
  }

  buildFleet(jetId);

  const _v = new THREE.Vector3();
  const _target = new THREE.Vector3();
  const _err = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _inv = new THREE.Quaternion();
  const _local = new THREE.Vector3();
  const _rel = new THREE.Vector3();
  const _spawnQuat = new THREE.Quaternion();
  const _spawnEuler = new THREE.Euler(0, 0, 0, "YXZ");
  const _where = new THREE.Vector3();
  const _euler = new THREE.Euler(0, 0, 0, "YXZ");
  const BODY_FWD = new THREE.Vector3(0, 0, -1);
  const BODY_RIGHT = new THREE.Vector3(1, 0, 0);
  const BODY_UP = new THREE.Vector3(0, 1, 0);

  function respawn(where: SpawnPoint = spawnPoint): void {
    spawnPoint = where;
    const spec = aircraft(jetId);
    let pos: THREE.Vector3;
    let heading: number;
    let speed: number;

    if (where === "needle") {
      // Two and a half kilometres north-north-west of the Space Needle, over
      // Interbay, pointed straight at it and low enough that it is already the
      // biggest thing in the windscreen. Thirteen seconds later you are over
      // the saucer with the whole of downtown opening up behind it — which is
      // a better first ten seconds than any amount of straight-and-level over
      // open water, and it is the reason this is the default.
      //
      // 152° is the bearing from here to the Needle and on over Columbia
      // Center; 470 m clears the spire by nearly a thousand feet, which is
      // close enough to feel and far enough that arriving is not an accident.
      heading = (152 * Math.PI) / 180;
      const needle = LANDMARKS.find((l) => l.id === "needle")!;
      const nx = lonToX(needle.at[1]);
      const nz = latToZ(needle.at[0]);
      const range = 2500;
      pos = new THREE.Vector3(
        nx - Math.sin(heading) * range,
        470,
        nz + Math.cos(heading) * range,
      );
      speed = 195;
    } else if (where === "runway") {
      // Lined up on Boeing Field 14R, which is where the team actually parks.
      pos = new THREE.Vector3(lonToX(-122.309), 8, latToZ(47.5429));
      heading = (159.6 * Math.PI) / 180;
      speed = 0;
    } else if (where === "high") {
      pos = new THREE.Vector3(lonToX(-122.29), 4200, latToZ(47.66));
      heading = (160 * Math.PI) / 180;
      speed = 240;
    } else {
      // Run-in from the north over Lake Washington, southbound down the show
      // line at 1,500 feet — the way the demo actually starts. Close enough
      // in that you are over the crowd inside twenty seconds; the first draft
      // put the flight 5 km out and the demo opened with half a minute of
      // straight and level.
      pos = new THREE.Vector3(lonToX(SHOW_CENTRE[1]) + 300, 460, latToZ(SHOW_CENTRE[0]) - 3400);
      heading = (340 * Math.PI) / 180 + Math.PI;
      speed = 205;
    }

    // The body-frame slot offsets have to be rotated by the aircraft's actual
    // orientation, which for a compass heading is a yaw of (pi - heading). The
    // first version rotated by -heading, which is a different angle by exactly
    // pi — so the Diamond spawned mirrored, number 2 sat where number 3
    // belonged, and every wingman began by flying across the formation to swap
    // sides. It converged, eventually, and looked ragged the whole way.
    _spawnQuat.setFromEuler(_spawnEuler.set(0, -heading, 0, "YXZ"));

    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      _v.copy(slotOffset(i)).applyQuaternion(_spawnQuat).add(pos);
      trimLevel(a.state, spec, _v, heading, speed);
      a.state.gearPos = where === "runway" ? 1 : 0;
      a.controls = neutralControls();
      a.controls.throttle = where === "runway" ? 0 : 0.78;
      a.controls.gear = where === "runway";
      a.state.fuel = spec.mass * 0.18;
      a.detached = false;
      a.smoke = false;
    }
    wreck.active = false;
    wreck.timer = 0;
    // Clearing the cause matters as much as clearing the flag: anything that
    // reads it without checking `active` first — a test, a HUD, a later
    // version of this file — otherwise gets told you flew into the Space
    // Needle every flight after the one where you did.
    wreck.cause = "";
    wreck.speed = 0;
    ctx.emit("angels:respawn", where);
  }

  /**
   * Place the whole flight, already in formation, on a given run-in.
   *
   * Shared by every spawn: the difference between "respawn at the show" and
   * "start this ring course over Elliott Bay" is three numbers, and getting
   * the slot geometry right is fiddly enough that it should only exist once.
   */
  function place(position: Vec3Like, headingDeg: number, speed: number): void {
    const spec = aircraft(jetId);
    const heading = (headingDeg * Math.PI) / 180;
    _spawnQuat.setFromEuler(_spawnEuler.set(0, -heading, 0, "YXZ"));
    _where.set(position.x, position.y, position.z);
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      _v.copy(slotOffset(i)).applyQuaternion(_spawnQuat).add(_where);
      trimLevel(a.state, spec, _v, heading, speed);
      a.state.gearPos = 0;
      a.controls = neutralControls();
      a.controls.throttle = 0.78;
      a.state.fuel = spec.mass * 0.18;
      a.detached = false;
    }
  }

  function slotOffset(index: number): THREE.Vector3 {
    const list = FORMATIONS[formation];
    const base = list[index] ?? DIAMOND[index]?.offset ?? new THREE.Vector3();
    // Tightening pulls the wingmen in toward the leader's centreline; the
    // Diamond 360 is flown at about 96% of parade spacing.
    return _v.copy(base).multiplyScalar(1 - tightness * 0.04);
  }

  respawn("needle");

  /**
   * One wingman's control inputs for this step.
   *
   * Three loops, in the order a pilot flies them: match the leader's attitude,
   * correct the position error inside his frame, and trim the throttle to hold
   * the fore-and-aft. The position gains are deliberately soft — a stiff
   * formation controller snaps into place and looks like a rigid-body
   * constraint, which it is not.
   */
  function flyFormation(a: Aircraft, leader: Aircraft, index: number): void {
    const s = a.state;
    const ls = leader.state;

    _fwd.copy(BODY_FWD).applyQuaternion(s.orientation);
    _right.copy(BODY_RIGHT).applyQuaternion(s.orientation);
    _up.copy(BODY_UP).applyQuaternion(s.orientation);

    // Where this jet is supposed to be, in the world, right now.
    _target.copy(slotOffset(index)).applyQuaternion(ls.orientation).add(ls.position);
    _err.copy(_target).sub(s.position);

    const distance = _err.length();
    // Too far out to fly formation on: rejoin first, using a much longer lead.
    if (distance > 700) a.detached = true;
    else if (distance < 90) a.detached = false;

    // Express the error, and how fast it is changing, in the leader's frame —
    // which is the frame the pilot is actually working in. Both terms matter:
    // proportional alone is an oscillator, and a formation that oscillates is
    // the difference between the Blue Angels and a flock of pigeons.
    _inv.copy(ls.orientation).invert();
    _local.copy(_err).applyQuaternion(_inv);
    _rel.copy(s.velocity).sub(ls.velocity).applyQuaternion(_inv);

    const leaderBank = bankOf(ls.orientation);
    const myBank = bankOf(s.orientation);

    // ---- roll ----------------------------------------------------------
    // Command a bank *angle*, not a roll rate. Closing a two-metre lateral
    // error is worth about a degree of bank, and asking for it as a rate makes
    // the jet snap-roll at 200 degrees a second for a fifteenth of a second,
    // which looks exactly as bad as it sounds.
    // Gains chosen for a critically-ish damped second order response, not by
    // feel: bank commands lateral acceleration g·tan(phi), so a proportional
    // gain k on the position error gives omega = sqrt(g·k) and the rate gain
    // has to be about 2·zeta·omega/g to go with it. At k = 0.030 that is
    // omega ≈ 0.54 rad/s and zeta ≈ 0.68 — settled in eight seconds with no
    // visible hunting, which is what a wingman looks like.
    const bankWanted =
      leaderBank + THREE.MathUtils.clamp(_local.x * 0.030 - _rel.x * 0.075, -0.35, 0.35);
    let roll = (bankWanted - myBank) * 3.0 - s.rollRate * 0.34;

    // ---- pitch ---------------------------------------------------------
    // Match the leader's flight path, then trim out the vertical error.
    let pitch = (ls.gamma - s.gamma) * 2.4;
    pitch += THREE.MathUtils.clamp(_local.y * 0.13 - _rel.y * 0.24, -0.7, 0.7);
    pitch -= s.pitchRate * 0.28;
    // Bank compensation, so a banked wingman does not slide out the bottom.
    pitch += (1 / Math.max(0.25, Math.abs(_up.y)) - 1) * 0.16;

    // ---- throttle ------------------------------------------------------
    // _local.z positive means the slot is behind me — ease off. The derivative
    // term is what stops the classic wingman surge, where a jet closes on its
    // slot at ten knots of overtake and sails straight past it.
    const speedErr = ls.airspeed - s.airspeed;
    let throttle =
      leader.controls.throttle + speedErr * 0.014 - _local.z * 0.026 - _rel.z * 0.035;

    if (a.detached) {
      // Rejoining: point at the slot and use everything you have.
      _err.normalize();
      pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(_err.dot(_up), -1, 1)) * 1.8, -1, 1);
      const lateral = _err.dot(_right);
      roll = THREE.MathUtils.clamp(lateral * 2.4 - myBank * 0.4, -1, 1);
      throttle = distance > 1500 ? 1 : 0.9;
    }

    a.controls.roll = THREE.MathUtils.clamp(roll, -1, 1);
    a.controls.pitch = THREE.MathUtils.clamp(pitch, -1, 1);
    a.controls.yaw = 0;
    a.controls.throttle = THREE.MathUtils.clamp(throttle, 0, 1);
    a.controls.brake = _local.z < -14 ? THREE.MathUtils.clamp(-_local.z / 40, 0, 1) : 0;
    a.controls.gear = leader.controls.gear;
    a.controls.wheelBrake = leader.controls.wheelBrake;
    a.controls.smoke = leader.controls.smoke;
    a.smoke = leader.smoke;

    // Strain drives the HUD's formation-quality readout and the radio chatter.
    a.strain = THREE.MathUtils.clamp(distance / 22, 0, 1);

    // A wingman who has flown into the ground is not a wingman. This is the
    // one place the AI is allowed to cheat, because a lake full of crashed
    // teammates every time the player does something silly is not a demo.
    const ground = flightEnv.terrainHeight(s.position.x, s.position.z);
    if (s.position.y - ground < 45 && s.climb < 0 && !leader.state.onGround) {
      a.controls.pitch = Math.max(a.controls.pitch, 0.5);
      a.controls.roll = THREE.MathUtils.clamp(-myBank * 1.5, -1, 1);
      a.controls.throttle = 1;
    }
  }

  function bankOf(q: THREE.Quaternion): number {
    _euler.setFromQuaternion(q, "YXZ");
    return -_euler.z;
  }

  // ---- flying it without thinking about a stick -----------------------------

  const _want = new THREE.Vector3();
  const _vel = new THREE.Vector3();
  const _camFwd = new THREE.Vector3();
  const _camRight = new THREE.Vector3();
  const _camUp = new THREE.Vector3();

  /**
   * Bank angle, measured off the body axes rather than off an Euler triple.
   *
   * `state.bank` comes out of a YXZ decomposition and is fine for an instrument
   * — but at exactly inverted the decomposition is degenerate and reports a
   * bank of *zero*, which is the one attitude where the recovery most needs to
   * know better. Two dot products have no such opinion: how far the right wing
   * is above the horizon and how far the canopy is, and the arctangent of the
   * pair is the bank, continuous all the way round through ±180°.
   */
  function trueBank(a: Aircraft): number {
    _right.copy(BODY_RIGHT).applyQuaternion(a.state.orientation);
    _up.copy(BODY_UP).applyQuaternion(a.state.orientation);
    return -Math.atan2(_right.y, _up.y);
  }

  /**
   * Fly toward a point on the screen.
   *
   * This is the whole of the "pursuit" control scheme, and it is a different
   * *kind* of control from the stick: the pilot names an outcome — that place,
   * out there — and this picks the bank angle and the pull that get there. It
   * is what a real pilot does without narrating it to themselves, and it is
   * why "how do I pull up" stops being a question. You put the ring above the
   * horizon.
   *
   * Two numbers do the work. The aim direction is resolved in the aircraft's
   * *body* frame, giving how far off it is to the right (`lat`) and how far
   * above the canopy (`vert`):
   *
   *  - **Roll** is `atan2(lat, vert)` — how far you would have to roll to put
   *    the target directly above your head, which is where a wing wants it
   *    before it pulls. That is a *relative* angle, so it is commanded
   *    directly: the control law takes a roll rate, and a rate proportional to
   *    an angle error is already a position loop. Damped by the measured roll
   *    rate so it arrives rather than swinging past.
   *  - **Pitch** is just `vert`. Once the roll is right the target is above
   *    you, so pulling is the only thing left to do — and if it is below you
   *    and dead ahead, `vert` is negative and the same expression pushes.
   *
   * `Math.max(vert, 0)` in the roll term is what stops it rolling inverted to
   * chase something below the nose. Aerobatically that would be correct; for
   * somebody who just wants to go down, it is the game turning upside down for
   * no reason they can see.
   *
   * The last term is the one that makes it *feel* right rather than merely
   * work: as the ring closes on the middle there is nothing left to roll
   * toward, so the command blends into rolling wings level. Without it the jet
   * happily flies straight ahead in a thirty-degree bank, which is correct —
   * it is going where you pointed — and looks like the controls are stuck.
   */
  function flyToAim(a: Aircraft, aim: { x: number; y: number; limit: number }): void {
    const s = a.state;
    const cam = ctx.camera;

    _camFwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _camRight.set(1, 0, 0).applyQuaternion(cam.quaternion);
    _camUp.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const halfV = Math.tan((cam.fov * Math.PI) / 360);
    const halfH = halfV * cam.aspect;

    // Where the jet is actually going — the velocity vector, which is the
    // winged circle on the HUD.
    const speed = s.velocity.length();
    _vel.copy(speed > 1 ? s.velocity : _camFwd).normalize();
    const vf = Math.max(0.25, _vel.dot(_camFwd));

    // The ring is an offset from *that*, not from the middle of the screen.
    //
    // This is the fix for the single worst thing about the first version: the
    // law drove the *nose* onto the ring, so with the ring centred it flew the
    // nose to where the camera was looking — which meant unloading to zero G,
    // because level flight needs the nose a few degrees above the flight path
    // and this was busy removing exactly those few degrees. Let go and the jet
    // sank at twenty-four metres a second. Measuring the error from the
    // velocity vector instead makes "ring centred" mean "carry on as you are",
    // which is what anybody would expect it to mean, and it also makes the
    // dashed line the HUD draws between the two literally the thing being
    // closed.
    const tx = _vel.dot(_camRight) / vf + aim.x * halfH;
    const ty = _vel.dot(_camUp) / vf + aim.y * halfV;
    _want.copy(_camFwd).addScaledVector(_camRight, tx).addScaledVector(_camUp, ty).normalize();

    _right.copy(BODY_RIGHT).applyQuaternion(s.orientation);
    _up.copy(BODY_UP).applyQuaternion(s.orientation);
    const lat = _want.dot(_right) - _vel.dot(_right);
    const vert = _want.dot(_up) - _vel.dot(_up);

    // The floor on the denominator is not cosmetic. At exactly zero, a target
    // a hair below the flight path and a hair to the right gives
    // `atan2(tiny, 0)` = ninety degrees, so the jet would snap into a
    // knife-edge over a lateral error of nothing.
    const toAim = THREE.MathUtils.clamp(Math.atan2(lat, Math.max(vert, 0.12)), -1.3, 1.3);

    // Weight the pursuit by how much pointing error there actually is.
    //
    // `atan2` answers "which way round" without caring "by how much", so a two
    // degree error earns a ninety degree roll command exactly as loudly as a
    // real one does — and the jet hunts, rolling hard to fix an error the roll
    // itself created. Below a couple of degrees the command is pure "settle
    // down": wings level and back to level flight.
    const err = Math.hypot(lat, vert);
    const pursuit = THREE.MathUtils.clamp((err - 0.03) / 0.16, 0, 1);

    const bank = trueBank(a);
    let wantRoll = toAim * pursuit + -bank * (1 - pursuit);
    // A soft wall at the scheme's bank limit. Past it the only thing the roll
    // axis is asked to do is come back inside, which caps the turn rate — and
    // capping the turn rate is the whole point of an easy mode.
    const over = Math.abs(bank) - aim.limit;
    if (over > 0) wantRoll = -Math.sign(bank) * over * 2.6;
    a.controls.roll = THREE.MathUtils.clamp(wantRoll * 1.6 - s.rollRate * 0.38, -1, 1);

    // Hands off is *level*, not "whatever attitude you left it in". Holding the
    // last flight path would be defensible and is not what anybody means by
    // letting go of the controls.
    // Asymmetric on purpose: coming back down to level should be a gentle
    // unload, not a bunt. Letting this reach -0.6 pushed to zero G, which is
    // the sensation of the floor dropping away and is not what "let go of the
    // controls" should feel like.
    const settle = THREE.MathUtils.clamp(-s.gamma * 2.2, -0.45, 0.9);
    a.controls.pitch = THREE.MathUtils.clamp(
      (vert * 2.6) * pursuit + settle * (1 - pursuit) - s.pitchRate * 0.10,
      -1,
      1,
    );
  }

  /**
   * The panic button: roll upright, come back to the horizon, and if you are
   * low, climb.
   *
   * Three seconds of it, cancelled the moment the pilot touches
   * anything, because the point is to hand the aeroplane back rather than to
   * fly it for them. The pitch term is scaled by how upright the jet is, so an
   * inverted dive rolls level *first* and only then pulls — pulling while
   * inverted is how you make a recovery into an impact.
   */
  let levelTimer = 0;
  /**
   * A ceiling, not a duration.
   *
   * The recovery ends when the jet is *level*, not when a stopwatch says so.
   * Running it for a fixed three seconds meant a steep dive got three seconds
   * of pull and then had the aeroplane handed back still pointed at the
   * ground, which is the one outcome this control exists to prevent. The cap
   * is only there so a jet that cannot recover — no speed, no wing — does not
   * fly itself for ever.
   */
  const LEVEL_MAX_SECONDS = 8;

  function flyLevel(a: Aircraft): void {
    const s = a.state;
    const bank = trueBank(a);
    _up.copy(BODY_UP).applyQuaternion(s.orientation);
    const upright = THREE.MathUtils.clamp(_up.y, 0, 1);
    // Down low, level is not enough — get some air underneath first.
    //
    // Flown on the *flight path*, not the attitude. Levelling the nose of a
    // jet that is already descending at ninety metres a second leaves it
    // descending at ninety metres a second with the nose level, because the
    // wing is at a positive angle of attack and the aeroplane is going where
    // the air says, not where the nose points. Driving gamma to zero is the
    // difference between looking recovered and being recovered.
    const wantGamma = s.radarAltitude < 400 ? 0.16 : 0;
    a.controls.roll = THREE.MathUtils.clamp(-bank * 1.9 - s.rollRate * 0.34, -1, 1);
    a.controls.pitch = THREE.MathUtils.clamp(
      (wantGamma - s.gamma) * 2.4 * upright - s.pitchRate * 0.22,
      -1,
      1,
    );
    a.controls.yaw = 0;
  }

  // ---- crashing ------------------------------------------------------------

  /**
   * The one piece of hard geometry in the world, and it is the one you are
   * pointed at when the game starts.
   *
   * Eleven thousand fill buildings are scenery you fly through; the two dozen
   * hand-built landmarks are not. That asymmetry is deliberate and it is the
   * right one — the fill has no identity, so passing through it reads as
   * nothing happening, while passing through the Space Needle reads as the
   * game being broken. Twenty-odd cylinder tests a frame is a rounding error.
   *
   * Player only. A wingman who clips a tower every time you take the flight
   * down Fifth Avenue is a lake full of dead teammates, and the formation
   * controller already cheats to stay out of the ground for the same reason.
   */
  function landmarkStrike(s: FlightState, spec: AircraftSpec): string | null {
    const marks = ctx.services.landmarks as
      | Array<{ name: string; position: THREE.Vector3; base: number; top: number; hull: number }>
      | undefined;
    if (!marks) return null;
    const half = spec.wingspan * 0.5;
    for (const m of marks) {
      if (m.hull <= 0) continue;
      if (s.position.y < m.base || s.position.y > m.top + half) continue;
      const dx = s.position.x - m.position.x;
      const dz = s.position.z - m.position.z;
      const r = m.hull + half;
      if (dx * dx + dz * dz < r * r) return m.name;
    }
    return null;
  }

  function crash(cause: string, landmark: string | null = null): void {
    if (wreck.active) return;
    const s = all[0].state;
    wreck.active = true;
    wreck.timer = 0;
    wreck.cause = cause;
    wreck.speed = s.airspeed;
    wreck.position.copy(s.position);
    // Stop it dead. A fireball that keeps flying its last heading through the
    // ground for three seconds is funny exactly once.
    s.velocity.set(0, 0, 0);
    s.angular.set(0, 0, 0);
    all[0].controls = neutralControls();
    all[0].controls.throttle = 0;
    all[0].smoke = false;
    // Stretch the moment. At four hundred knots an impact is over in about a
    // tenth of a second, which is roughly how long it takes to notice one
    // started — this buys enough real time to actually watch the aeroplane
    // come apart, and then ramps back.
    ctx.slowMotion(0.28, 0.85);

    ctx.emit("angels:crash", {
      position: { x: wreck.position.x, y: wreck.position.y, z: wreck.position.z },
      speed: wreck.speed,
      cause,
      landmark,
    });
  }

  const service: FleetService = {
    get player() {
      return all[0];
    },
    all,
    get wingmen() {
      return all.slice(1, 1 + wingmanCount);
    },
    get formation() {
      return formation;
    },
    setFormation(f) {
      formation = f;
      ctx.emit("angels:formation", f);
    },
    get tightness() {
      return tightness;
    },
    setTightness(t) {
      tightness = THREE.MathUtils.clamp(t, 0, 1);
    },
    get assist() {
      return assistLevel;
    },
    setAssist(level) {
      assistLevel = level;
      assists = assistsFor(level);
      ctx.emit("angels:assist", level);
    },
    get jet() {
      return jetId;
    },
    setJet(id) {
      if (id === jetId) return;
      jetId = id;
      buildFleet(id);
      respawn();
      ctx.emit("angels:jet", id);
    },
    get wingmanCount() {
      return wingmanCount;
    },
    setWingmanCount(n) {
      wingmanCount = THREE.MathUtils.clamp(Math.round(n), 0, Math.max(0, all.length - 1));
    },
    respawn,
    get spawnPoint() {
      return spawnPoint;
    },
    wreck,
    restart() {
      if (wreck.active) respawn();
    },
    levelOut() {
      levelTimer = LEVEL_MAX_SECONDS;
    },
    get levelling() {
      return Math.max(0, levelTimer);
    },
    place,
    greyout: { grey: 0, red: 0 },
    nearestSeparation: Infinity,
  };
  ctx.services.fleet = service;

  /** True while the hydroplane race owns the world. */
  const racing = () => (ctx.services.hydro as { active: boolean } | undefined)?.active === true;

  return {
    fixedUpdate(dt) {
      // The race swaps the vehicle. Leaving six jets flying themselves round
      // Seattle underneath it is six jets that will eventually fly into
      // something and fire a crash event at a player who is in a boat.
      if (racing()) return;
      const player = all[0];
      const input = ctx.input;

      if (wreck.active) {
        wreck.timer += dt;
        // The wingmen break away rather than continuing to fly formation on a
        // hole in the ground. Four jets converging on their leader's fireball
        // is not a thing the Blue Angels do, and it looked exactly as bad as
        // it sounds.
        for (let i = 1; i <= wingmanCount && i < all.length; i++) {
          const a = all[i];
          a.controls.pitch = 0.32;
          a.controls.roll = i % 2 ? 0.42 : -0.42;
          a.controls.yaw = 0;
          a.controls.throttle = 0.95;
          a.controls.brake = 0;
          a.controls.smoke = false;
          a.smoke = false;
          stepFlight(a.state, a.spec, a.controls, assistsFor("rookie"), flightEnv, dt);
        }
        if (wreck.timer >= wreck.duration) respawn();
        return;
      }

      // The player's controls come straight off the input service; the flight
      // model's own fly-by-wire is what makes them flyable.
      player.controls.pitch = input.pitch;
      player.controls.roll = input.roll;
      player.controls.yaw = input.yaw;
      player.controls.throttle = input.throttle;
      player.controls.brake = input.brake;
      player.controls.wheelBrake = input.wheelBrake;

      // Then the two things that fly it *for* you, in the order they should
      // win: pursuit first, and the recovery on top of it, because the whole
      // value of the recovery is that it overrides whatever got you here.
      const in$ = ctx.services.input as
        | { aim: { x: number; y: number; active: boolean; limit: number } }
        | undefined;
      if (in$?.aim.active && !player.state.onGround) flyToAim(player, in$.aim);

      // Any real input cancels the recovery — it hands the jet back the
      // instant you want it, which is the difference between an assist and a
      // cutscene.
      if (levelTimer > 0 && (Math.abs(input.pitch) > 0.3 || Math.abs(input.roll) > 0.3)) {
        levelTimer = 0;
      }
      if (levelTimer > 0) {
        levelTimer -= dt;
        flyLevel(player);
        // Done when it is actually level and climbing again, rather than when
        // the clock says so. The half-second floor stops it declaring victory
        // on the frame it started, before anything has moved.
        const s = player.state;
        const settled =
          Math.abs(trueBank(player)) < 0.1 && s.gamma > -0.02 && s.radarAltitude > 120;
        if (settled && levelTimer < LEVEL_MAX_SECONDS - 0.5) levelTimer = 0;
      }

      for (let i = 0; i < all.length; i++) {
        const a = all[i];
        if (i > 0) {
          if (i > wingmanCount) {
            // Parked wingmen still get stepped so they do not fall out of the
            // sky while the player is flying solo — they just hold station
            // far enough out to be scenery.
            a.state.position.copy(player.state.position);
            a.state.position.y += 4000;
            continue;
          }
          flyFormation(a, player, i);
        }
        // Wingmen always fly with full assists. They are professionals.
        stepFlight(a.state, a.spec, a.controls, i === 0 ? assists : assistsFor("rookie"), flightEnv, dt);
      }

      // Separation, for the "you are flying too close" readout and the scoring.
      let nearest = Infinity;
      for (let i = 1; i <= wingmanCount && i < all.length; i++) {
        nearest = Math.min(nearest, all[i].state.position.distanceTo(player.state.position));
      }
      service.nearestSeparation = nearest;

      const g = greyout(player.state.gStrain);
      service.greyout.grey = g.grey;
      service.greyout.red = g.red;

      if (player.state.impact > 0) ctx.emit("angels:impact", player.state.impact);

      // Two ways to write one off, and the order matters: a jet that flew into
      // the Space Needle should be told it flew into the Space Needle, not
      // that it hit the ground a quarter of a second later.
      const struck = landmarkStrike(player.state, player.spec);
      if (struck) crash(`the ${struck}`, struck);
      else if (player.state.crashed) {
        const water = terrain?.isWater(player.state.position.x, player.state.position.z) ?? false;
        crash(water ? "the water" : "the ground");
      }
    },

    update(dt, c) {
      if (racing()) return;
      // Nothing on the jet answers while it is a fireball, except the one key
      // that means "get me back in the air".
      if (wreck.active) {
        if (c.input.resetPressed) respawn();
        return;
      }
      // Edge-triggered inputs the fleet owns.
      if (c.input.gearToggle) {
        all[0].controls.gear = !all[0].controls.gear;
        ctx.emit("angels:gear", all[0].controls.gear);
      }
      if (c.input.smokeToggle) {
        all[0].smoke = !all[0].smoke;
        all[0].controls.smoke = all[0].smoke;
        ctx.emit("angels:smoke", all[0].smoke);
      }
      if (c.input.levelPressed) levelTimer = LEVEL_MAX_SECONDS;
      // R puts you back where you started, not back at the show line — the
      // start point is a choice the pilot made and a reset should not quietly
      // overrule it.
      if (c.input.resetPressed) respawn();
    },

    lateUpdate(_dt, c) {
      if (racing()) {
        group.visible = false;
        return;
      }
      group.visible = true;
      for (let i = 0; i < all.length; i++) {
        const a = all[i];
        if ((i > wingmanCount && i > 0) || (i === 0 && wreck.active)) {
          // A wrecked jet is not drawn: the blast system is showing what is
          // left of it, and a pristine Super Hornet parked inside its own
          // fireball undoes the whole effect.
          a.rig.root.visible = false;
          continue;
        }
        a.rig.root.visible = true;
        a.rig.root.position.copy(a.state.position);
        a.rig.root.quaternion.copy(a.state.orientation);
        const burner = Math.max(0, a.state.power - 1);
        poseJet(a.rig, a.controls, a.state.gearPos, burner, c.elapsed);
      }
    },

    dispose() {
      ctx.scene.remove(group);
      for (const a of all) a.rig.dispose();
      all.length = 0;
      material.dispose();
      if (ctx.services.fleet === service) delete ctx.services.fleet;
    },
  };
}

export { FIXED_DT };
