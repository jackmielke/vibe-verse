/**
 * Landmarks — the Space Needle, the Empire State Building and the Eiffel
 * Tower, standing in Vibe City's district.
 *
 * ## Where they stand
 *
 * Each one owns real blocks. `LANDMARK_RESERVE` is handed to `buildDistrict`,
 * which leaves those blocks empty (and keeps the rest of the city exactly as
 * it was; see `reserve` there). The Empire State is in the tall core north
 * west of the plaza, the Needle east of it in a park, and the Eiffel Tower
 * straddles the crossroads south of the plaza with a leg in each of four
 * blocks and the traffic going under its arches.
 *
 * ## What you can do there
 *
 * Walk up to anything with a prompt and press E (or tap the pill):
 *
 *  - ride an elevator. The Needle's two glass cars run up the outside of the
 *    core; the Eiffel's lifts climb a leg to the second platform, and the
 *    central lift goes on to the summit; the Empire State's express elevator
 *    is drawn by the HUD, with the brass floor dial, because its shaft is
 *    inside a solid tower.
 *  - look through the coin binoculars on each deck. The camera goes to the
 *    eyepiece, zoomed, and dragging looks around. Each set is pointed at one
 *    of the other landmarks.
 *  - stand on the Loupe at the top of the Needle, which turns.
 *
 * ## How the player is moved
 *
 * There are no moving collision boxes in this world, so a rider is not
 * carried by physics. `update()` returns a position; the city puts the
 * player's feet there after its own physics step every frame and zeroes
 * their velocity. A ride ends by returning the exit point once.
 */
import * as THREE from "three";
import type { WorldBox } from "@/components/city/cardboardIsland";
import type { Elevator, LandmarkKey, Station, Viewer } from "./common";
import { buildEmpireState } from "./empireState";
import { buildSpaceNeedle } from "./spaceNeedle";
import { buildEiffel } from "./eiffel";

export type { LandmarkKey } from "./common";

/** Grid cells the landmarks take (9×9 district, plaza at 4,4). */
export const LANDMARK_RESERVE: Array<{ gx: number; gz: number; ground: "park" | "pave"; trees: boolean }> = [
  { gx: 3, gz: 2, ground: "pave", trees: false }, // Empire State
  { gx: 6, gz: 3, ground: "park", trees: true }, // Space Needle
  { gx: 4, gz: 6, ground: "park", trees: true }, // Eiffel Tower, four blocks
  { gx: 5, gz: 6, ground: "park", trees: true },
  { gx: 4, gz: 7, ground: "park", trees: true },
  { gx: 5, gz: 7, ground: "park", trees: true },
];

export interface LandmarkUi {
  prompt: { emoji: string; label: string } | null;
  /** Up an elevator: which landmark, and how high you are. */
  ride: { name: string; altitude: number; up: boolean } | null;
  /** The Empire State's express elevator, which the HUD draws. */
  express: { up: boolean; progress: number } | null;
  viewing: boolean;
}

export interface LandmarkEvent {
  type: "depart" | "arrive";
  key: LandmarkKey;
  title?: string;
  description?: string;
}

export interface LandmarkSite {
  key: LandmarkKey;
  name: string;
  /** At the foot, for "take me to the Eiffel Tower". */
  entrance: THREE.Vector3;
  deck: THREE.Vector3;
  aliases: string[];
}

export interface Landmarks {
  group: THREE.Group;
  sites: LandmarkSite[];
  /**
   * Advance everything. Returns where the player's feet must be this frame,
   * or null to leave them to physics.
   */
  update(dt: number, now: number, ctx: { player: THREE.Vector3; grounded: boolean; busy: boolean }): THREE.Vector3 | null;
  /** E pressed. Returns true if it did something. */
  act(): boolean;
  ui(): LandmarkUi;
  /** Inside the Empire State lobby, where the chase camera must come in close. */
  indoors(p: THREE.Vector3): boolean;
  /** Riding or looking: the camera, if the landmarks want it. */
  cameraShot(camYaw: number, camPitch: number): { eye: THREE.Vector3; look: THREE.Vector3; fov: number } | null;
  setDay(day: boolean): void;
  onEvent(cb: (e: LandmarkEvent) => void): void;
  /** Surfaces the snow can settle on. */
  snowMaterials: THREE.Material[];
  /** Dev: the spots a screenshot script needs. */
  devSites(): unknown[];
  /** Dev: hold the camera on a scripted shot (null to release). */
  devShot(shot: { eye: number[]; look: number[]; fov?: number } | null): void;
  dispose(): void;
}

type Ride =
  | { kind: "lift"; e: Elevator; key: LandmarkKey; name: string; up: boolean }
  | { kind: "express"; up: boolean; t: number; dur: number; hold: THREE.Vector3; exit: THREE.Vector3 }
  | { kind: "view"; v: Viewer; hold: THREE.Vector3; yaw0: number | null; pitch0: number };

export function buildLandmarks(opts: { boxes: WorldBox[]; pitch: number; lowDetail: boolean }): Landmarks {
  const { boxes, pitch } = opts;
  const cell = (g: number) => (g - 4) * pitch;
  const group = new THREE.Group();
  group.name = "landmarks";

  const ES = { x: cell(3), z: cell(2) };
  const SN = { x: cell(6), z: cell(3) };
  const EF = { x: (cell(4) + cell(5)) / 2, z: (cell(6) + cell(7)) / 2 };
  const ang = (from: { x: number; z: number }, to: { x: number; z: number }) => Math.atan2(to.z - from.z, to.x - from.x);
  const PLAZA = { x: 0, z: 0 };
  const ISLAND = { x: 330, z: -30 };

  const empire = buildEmpireState({ boxes, cx: ES.x, cz: ES.z, lowDetail: opts.lowDetail });
  const needle = buildSpaceNeedle({
    boxes,
    cx: SN.x,
    cz: SN.z,
    lowDetail: opts.lowDetail,
    faceAngle: ang(SN, PLAZA),
    lookAt: [ang(SN, ES), ang(SN, EF), ang(SN, ISLAND)],
  });
  const eiffel = buildEiffel({
    boxes,
    cx: EF.x,
    cz: EF.z,
    lowDetail: opts.lowDetail,
    lookAt: [ang(EF, ES), ang(EF, SN), Math.PI / 2],
  });
  group.add(empire.group, needle.group, eiffel.group);

  const listeners: Array<(e: LandmarkEvent) => void> = [];
  const emit = (e: LandmarkEvent) => listeners.forEach((l) => l(e));

  let ride: Ride | null = null;
  /** A position to put the player at once, at the end of a ride. */
  let release: THREE.Vector3 | null = null;
  let devShot: { eye: THREE.Vector3; look: THREE.Vector3; fov: number } | null = null;
  const player = new THREE.Vector3();
  let busy = false;

  // ---- Elevators -----------------------------------------------------------
  type Lift = { e: Elevator; key: LandmarkKey; name: string; up: string; down: string; arriveTop?: () => LandmarkEvent; arriveBottom?: () => LandmarkEvent };
  const lifts: Lift[] = [
    ...needle.elevators.map<Lift>((e) => ({
      e,
      key: "needle",
      name: "Space Needle",
      up: "Ride the glass elevator up",
      down: "Ride down to the street",
      arriveTop: () => ({
        type: "arrive",
        key: "needle",
        title: "🚀 Space Needle · 104 m",
        description: "Step onto the Loupe: the glass floor turns. Binoculars are out on the open-air deck.",
      }),
    })),
    ...eiffel.elevators.map<Lift>((e) =>
      e === eiffel.central
        ? {
            e,
            key: "eiffel",
            name: "Tour Eiffel",
            up: "Central lift to the summit",
            down: "Lift down to the 2nd floor",
            arriveTop: () => {
              eiffel.sparkle();
              return {
                type: "arrive",
                key: "eiffel",
                title: "🥂 Le Sommet · 111 m",
                description: "Champagne bar inside, binoculars outside. After dark the whole tower sparkles.",
              };
            },
          }
        : {
            e,
            key: "eiffel",
            name: "Tour Eiffel",
            up: "Ride the lift up the leg",
            down: "Ride down to the ground",
            arriveTop: () => ({
              type: "arrive",
              key: "eiffel",
              title: "🗼 Deuxième étage · 46 m",
              description: "Cross the little bridge to the central lift for the summit.",
            }),
          },
    ),
  ];
  for (const l of lifts) {
    l.e.onArrive = (top, rider) => {
      if (!rider || ride?.kind !== "lift" || ride.e !== l.e) return;
      release = l.e.exits[top ? 1 : 0].clone();
      ride = null;
      const ev = top ? l.arriveTop?.() : l.arriveBottom?.();
      emit(ev ?? { type: "arrive", key: l.key });
    };
  }

  /** The two landings of every lift as stations. */
  const stations: Station[] = [];
  for (const l of lifts) {
    for (const end of [0, 1] as const) {
      const pos = l.e.pointAt(end === 0 ? 0 : l.e.total, new THREE.Vector3()).add(l.e.origin);
      const here = () => l.e.at === end && !l.e.moving;
      stations.push({
        id: `${l.e.id}-${end}`,
        get label() {
          if (l.e.moving) return "Elevator on its way…";
          return here() ? (end === 0 ? l.up : l.down) : "Call the elevator";
        },
        emoji: "🛗",
        pos,
        radius: 1.5,
        height: 2.5,
        act() {
          if (l.e.moving) return;
          if (here()) {
            ride = { kind: "lift", e: l.e, key: l.key, name: l.name, up: end === 0 };
            l.e.go(true);
            emit({ type: "depart", key: l.key });
          } else {
            l.e.go(false);
          }
        },
      });
    }
  }

  // The Empire State express elevator.
  const EXPRESS_S = 7.5;
  stations.push(
    {
      id: "empire-express-up",
      label: "Express elevator to the 86th floor",
      emoji: "🛗",
      pos: empire.lift.bottom,
      radius: 1.8,
      height: 2.5,
      act() {
        ride = { kind: "express", up: true, t: 0, dur: EXPRESS_S, hold: empire.lift.bottom.clone(), exit: empire.lift.topExit.clone() };
        emit({ type: "depart", key: "empire" });
      },
    },
    {
      id: "empire-express-down",
      label: "Elevator down to the lobby",
      emoji: "🛗",
      pos: empire.lift.top,
      radius: 1.6,
      height: 2.5,
      act() {
        ride = { kind: "express", up: false, t: 0, dur: EXPRESS_S * 0.8, hold: empire.lift.top.clone(), exit: empire.lift.bottomExit.clone() };
        emit({ type: "depart", key: "empire" });
      },
    },
  );

  // Binoculars.
  const viewers = [...empire.viewers, ...needle.viewers, ...eiffel.viewers];
  for (const v of viewers) {
    v.station.act = () => {
      ride = { kind: "view", v, hold: v.station.pos.clone().setY(v.station.pos.y + 0.05), yaw0: null, pitch0: 0 };
    };
    stations.push(v.station);
  }

  const nearest = (): Station | null => {
    if (busy) return null;
    let best: Station | null = null;
    let bestD = Infinity;
    for (const s of stations) {
      const dy = player.y - s.pos.y;
      if (dy < -0.8 || dy > (s.height ?? 2.5)) continue;
      const d = Math.hypot(player.x - s.pos.x, player.z - s.pos.z);
      if (d < s.radius && d < bestD && (s.available?.() ?? true)) {
        best = s;
        bestD = d;
      }
    }
    return best;
  };

  const altitude = () => {
    if (ride?.kind !== "lift") return 0;
    return Math.round(ride.e.floor.y);
  };

  const exitView = () => {
    if (ride?.kind === "view") {
      release = ride.hold.clone();
      ride = null;
    }
  };

  const FAR = new THREE.Vector3(1e9, 0, 1e9);
  const tmpEye = new THREE.Vector3();
  const tmpLook = new THREE.Vector3();

  return {
    group,
    sites: [
      {
        key: "empire",
        name: "Empire State Building",
        entrance: new THREE.Vector3(ES.x, 0, ES.z + 14),
        deck: empire.lift.topExit.clone(),
        aliases: ["empire state", "empire state building", "esb", "new york", "86th floor"],
      },
      {
        key: "needle",
        name: "Space Needle",
        entrance: needle.elevators[0].exits[0].clone(),
        deck: needle.elevators[0].exits[1].clone(),
        aliases: ["space needle", "needle", "seattle", "the loupe"],
      },
      {
        key: "eiffel",
        name: "Eiffel Tower",
        entrance: eiffel.elevators[0].exits[0].clone(),
        deck: eiffel.central.exits[1].clone(),
        aliases: ["eiffel", "eiffel tower", "tour eiffel", "paris"],
      },
    ],
    update(dt, now, ctx) {
      player.copy(ctx.player);
      busy = ctx.busy;
      for (const l of lifts) l.e.update(dt);
      empire.update(dt, now, player);
      eiffel.update(dt, now);
      // The Loupe turns whoever is on it, unless they are locked to something.
      needle.update(dt, now, ride || busy ? FAR : ctx.player, !ride && !busy && ctx.grounded);

      if (release) {
        const r = release;
        release = null;
        return r;
      }
      if (!ride) return null;
      if (ride.kind === "lift") return ride.e.floor;
      if (ride.kind === "express") {
        ride.t += dt;
        if (ride.t >= ride.dur) {
          const exit = ride.exit;
          const up = ride.up;
          ride = null;
          emit(
            up
              ? {
                  type: "arrive",
                  key: "empire",
                  title: "🏙️ 86th Floor Observatory",
                  description: "Walk the terrace all the way round. The blue binoculars at the corners look out over the city.",
                }
              : { type: "arrive", key: "empire" },
          );
          return exit;
        }
        return ride.hold;
      }
      return ride.hold;
    },
    act() {
      if (ride?.kind === "view") {
        exitView();
        return true;
      }
      if (ride) return false;
      const s = nearest();
      if (!s) return false;
      s.act();
      return true;
    },
    ui() {
      const s = ride ? null : nearest();
      return {
        prompt: ride?.kind === "view" ? { emoji: "👣", label: "Step back" } : s ? { emoji: s.emoji, label: s.label } : null,
        ride: ride?.kind === "lift" ? { name: ride.name, altitude: altitude(), up: ride.up } : null,
        express: ride?.kind === "express" ? { up: ride.up, progress: Math.min(1, ride.t / ride.dur) } : null,
        viewing: ride?.kind === "view",
      };
    },
    indoors(p) {
      return empire.indoors(p) || eiffel.indoors(p);
    },
    cameraShot(camYaw, camPitch) {
      if (devShot) return devShot;
      if (ride?.kind !== "view") return null;
      if (ride.yaw0 === null) {
        ride.yaw0 = camYaw;
        ride.pitch0 = camPitch;
      }
      const yaw = ride.v.yaw + (camYaw - ride.yaw0);
      const pitch = THREE.MathUtils.clamp(-0.1 - (camPitch - ride.pitch0) * 0.8, -0.7, 0.45);
      tmpEye.copy(ride.v.eye);
      // The chase camera looks along -(sin yaw, cos yaw); keep that meaning.
      tmpLook.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).add(tmpEye);
      return { eye: tmpEye, look: tmpLook, fov: 22 };
    },
    setDay(day) {
      empire.setNight(!day);
      needle.setNight(!day);
      eiffel.setNight(!day);
    },
    onEvent(cb) {
      listeners.push(cb);
    },
    snowMaterials: [...empire.roofs, ...needle.roofs, ...eiffel.roofs],
    devSites() {
      const v = (p: THREE.Vector3) => [p.x, p.y, p.z];
      return [
        {
          key: "empire",
          street: [ES.x + 30, 0.2, ES.z + 60],
          lobby: v(empire.lift.bottomExit.clone().add(new THREE.Vector3(0, 0, 8))),
          car: v(empire.lift.bottom),
          binoculars: v(empire.viewers[0].station.pos),
          eye: [ES.x + 95, 30, ES.z + 150],
          look: [ES.x, 85, ES.z],
        },
        {
          key: "needle",
          street: v(needle.elevators[0].exits[0]),
          car: v(needle.elevators[0].floor),
          binoculars: v(needle.viewers[0].station.pos),
          eye: [SN.x - 110, 25, SN.z + 90],
          look: [SN.x, 62, SN.z],
        },
        {
          key: "eiffel",
          street: v(eiffel.elevators[0].exits[0]),
          car: v(eiffel.elevators[0].floor),
          central: v(eiffel.central.exits[0]),
          binoculars: v(eiffel.viewers[0].station.pos),
          eye: [EF.x - 105, 18, EF.z - 115],
          look: [EF.x, 55, EF.z],
        },
      ];
    },
    devShot(shot) {
      devShot = shot
        ? { eye: new THREE.Vector3(...(shot.eye as [number, number, number])), look: new THREE.Vector3(...(shot.look as [number, number, number])), fov: shot.fov ?? 50 }
        : null;
    },
    dispose() {
      empire.dispose();
      needle.dispose();
      eiffel.dispose();
      listeners.length = 0;
    },
  };
}
