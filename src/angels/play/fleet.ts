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
import { SHOW_CENTRE, latToZ, lonToX } from "../world/geo";

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
  /** Put the player back somewhere sensible. */
  respawn(where?: "show" | "runway" | "high"): void;
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

  function respawn(where: "show" | "runway" | "high" = "show"): void {
    const spec = aircraft(jetId);
    let pos: THREE.Vector3;
    let heading: number;
    let speed: number;

    if (where === "runway") {
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

  respawn("show");

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
      respawn("show");
      ctx.emit("angels:jet", id);
    },
    get wingmanCount() {
      return wingmanCount;
    },
    setWingmanCount(n) {
      wingmanCount = THREE.MathUtils.clamp(Math.round(n), 0, Math.max(0, all.length - 1));
    },
    respawn,
    place,
    greyout: { grey: 0, red: 0 },
    nearestSeparation: Infinity,
  };
  ctx.services.fleet = service;

  return {
    fixedUpdate(dt) {
      const player = all[0];
      const input = ctx.input;

      // The player's controls come straight off the input service; the flight
      // model's own fly-by-wire is what makes them flyable.
      player.controls.pitch = input.pitch;
      player.controls.roll = input.roll;
      player.controls.yaw = input.yaw;
      player.controls.throttle = input.throttle;
      player.controls.brake = input.brake;
      player.controls.wheelBrake = input.wheelBrake;

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
    },

    update(dt, c) {
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
      if (c.input.resetPressed) respawn("show");
    },

    lateUpdate(_dt, c) {
      for (let i = 0; i < all.length; i++) {
        const a = all[i];
        if (i > wingmanCount && i > 0) {
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
