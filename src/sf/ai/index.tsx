/**
 * ai/index.tsx — the living city, one component.
 *
 *   import CityAI from "@/sf/ai";
 *   …
 *   <CityAI />          // anywhere inside the Canvas, after the streets
 *
 * That is the whole integration. Mounting it populates San Francisco with
 * pedestrians, traffic, police and the opposition, wires the wanted system to
 * the store, and registers the AI with the weapon stack so that bullets hit
 * people and people notice bullets.
 *
 * Ordering inside the frame is deliberate and load-bearing:
 *
 *   1. perception clock       — everything downstream stamps against it
 *   2. avoidance field reset  — agents re-register every frame; stale entries
 *                               are worse than none
 *   3. traffic                — vehicles are obstacles for the crowd, so they
 *                               move first
 *   4. pedestrians            — they read vehicle positions from step 3
 *   5. the opposition         — they read both, and they shoot the player
 *   6. heat                   — consumes this frame's sightings
 *   7. police                 — reads the heat level decided in step 6
 *   8. streaming              — spawns and culls against the settled world
 *   9. instance upload        — one begin/push/commit across all writers
 *
 * Doing heat before police, and police after the enemies have perceived, is
 * what makes the response feel like it is reacting to something rather than
 * to a timer.
 *
 * Public API
 * ----------
 *   <CityAI />                       the whole thing
 *   sfAi                             the cross-system seam (hijack, noise, damage)
 *   everything re-exported below
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { QUALITY } from "../config";
import { frame, useSfStore } from "../state/store";
import {
  hitboxProvider,
  setHitboxProvider,
  setWeaponDamageSink,
  type Hitbox,
  type HitboxProvider,
} from "../weapons";
import Pedestrians from "./Pedestrians";
import Traffic, { headlightFactor } from "./Traffic";
import { enemyForce, type Enemy } from "./enemies";
import { heat, type CrimeKind } from "./heat";
import { avoidance, navGraph, resetNavigation } from "./navigation";
import { pedestrians } from "./pedestrians";
import {
  clearPerception,
  emitExplosion,
  emitGunshot,
  emitNoise,
  perceptionTick,
} from "./perception";
import { police } from "./police";
import { spawner } from "./spawner";
import { characterBatch, disposeStage, helicopterBatch, vehicleBatch } from "./stage";
import { trafficSim } from "./traffic";
import { PLAYER_ENTITY_ID, resetEntityIds, type HijackSnapshot } from "./types";

/* ================================================================== *
 * The cross-system seam
 * ================================================================== *
 * Other subsystems (weapons, vehicles, missions, audio) need to tell the AI
 * things and ask it for things. They should not have to import seven modules
 * to do it, and they must not break if the AI is not mounted — so everything
 * crosses here, and every entry point is safe to call at any time.
 */
export const sfAi = {
  /** A shot was fired. Everyone within earshot reacts inside two seconds. */
  reportGunshot(x: number, y: number, z: number, byPlayer = true, loud = 1): void {
    emitGunshot(x, y, z, byPlayer ? "player" : "cartel", byPlayer ? PLAYER_ENTITY_ID : 0, loud);
    if (byPlayer) heat.reportCrime("gunfire", x, z, witnessesNear(x, z));
  },

  /** Something detonated. */
  reportExplosion(x: number, y: number, z: number, power = 12, byPlayer = true): void {
    emitExplosion(x, y, z, power, byPlayer ? "player" : "cartel", byPlayer ? PLAYER_ENTITY_ID : 0);
    enemyForce.onVehicleDestroyed(x, z, power * 3, frame.time);
    if (byPlayer) heat.reportCrime("explosion", x, z, true);
  },

  /** Generic crime report, for missions and destructibles. */
  reportCrime(kind: CrimeKind, x: number, z: number, witnessed = true): void {
    heat.reportCrime(kind, x, z, witnessed);
  },

  /** Nearest hijackable ambient vehicle, or −1. */
  findHijackable(x: number, z: number, radius = 4.5): number {
    return trafficSim.findHijackable(x, z, radius);
  },

  /**
   * Take a vehicle out of the traffic sim. The returned snapshot is a value
   * object; the AI no longer holds any reference to that vehicle.
   */
  hijack(id: number): HijackSnapshot | null {
    const snap = trafficSim.hijack(id);
    if (snap) heat.reportCrime("vehicle-theft", snap.x, snap.z, witnessesNear(snap.x, snap.z));
    return snap;
  },

  /** Hand a vehicle back when the player gets out. */
  relinquish(snap: HijackSnapshot): void {
    trafficSim.relinquish(snap, frame.time);
  },

  /** An enemy has been grappled. */
  grappled(entityId: number, pullX = 0, pullZ = 0): void {
    enemyForce.onGrappled(entityId, frame.time, pullX, pullZ);
  },

  /** Damage an AI entity from outside the weapon stack (fire, falling, cars). */
  damage(entityId: number, amount: number, fromX = 0, fromZ = 0): boolean {
    if (enemyForce.get(entityId)) {
      return enemyForce.applyDamage(entityId, amount, frame.time, fromX, fromZ);
    }
    if (trafficSim.get(entityId)) return trafficSim.damage(entityId, amount, frame.time);
    return pedestrians.applyDamage(entityId, amount, frame.time);
  },

  /** Wake everything hostile in a radius — mission scripting hook. */
  alert(x: number, z: number, radius = 60): void {
    enemyForce.alertArea(x, z, radius, frame.time);
  },

  /** Spawn a hostile squad — mission scripting hook. */
  spawnSquad(x: number, z: number, size = 4): void {
    enemyForce.spawnSquad(x, z, size, "cartel", "soldier", "rifle", frame.time);
  },

  /** Current wanted level, 0–5. */
  get heatLevel(): number {
    return heat.level;
  },

  stats() {
    return {
      peds: pedestrians.stats,
      traffic: trafficSim.stats,
      enemies: enemyForce.stats,
      police: police.stats,
      heat: heat.stats(),
      spawner: spawner.stats,
      nav: navGraph.stats(),
      avoidance: avoidance.agentCount,
    };
  },
};

/** Anyone around to see it? Cheap witness test for the heat system. */
function witnessesNear(x: number, z: number): boolean {
  let seen = false;
  pedestrians.forEachHitbox(x, z, 55, () => {
    seen = true;
  });
  if (seen) return true;
  for (const e of enemyForce.enemies) {
    if (!e.alive) continue;
    if (Math.hypot(e.x - x, e.z - z) < 90) return true;
  }
  return false;
}

/* ================================================================== *
 * Weapon stack integration
 * ================================================================== */

/** Reusable hitbox records — the weapon stack queries this every shot. */
const hitboxPool: Hitbox[] = [];

function hitboxAt(i: number): Hitbox {
  let h = hitboxPool[i];
  if (!h) {
    h = {
      targetId: 0,
      part: "chest",
      ax: 0,
      ay: 0,
      az: 0,
      bx: 0,
      by: 0,
      bz: 0,
      radius: 0.2,
      scale: 1,
      alive: true,
    };
    hitboxPool[i] = h;
  }
  return h;
}

function writeBody(
  out: Hitbox[],
  n: number,
  id: number,
  x: number,
  y: number,
  z: number,
  height: number,
  alive: boolean,
): number {
  // Three capsules per body. Head is small and worth 2.4×; the chest is the
  // wide one you actually hit; the legs are the cheap shot that does not kill.
  const head = hitboxAt(n);
  head.targetId = id;
  head.part = "head";
  head.ax = x;
  head.ay = y + height * 0.9;
  head.az = z;
  head.bx = x;
  head.by = y + height * 0.98;
  head.bz = z;
  head.radius = 0.115 * (height / 1.8);
  head.scale = 1;
  head.alive = alive;
  out[n] = head;

  const chest = hitboxAt(n + 1);
  chest.targetId = id;
  chest.part = "chest";
  chest.ax = x;
  chest.ay = y + height * 0.55;
  chest.az = z;
  chest.bx = x;
  chest.by = y + height * 0.84;
  chest.bz = z;
  chest.radius = 0.22 * (height / 1.8);
  chest.scale = 1;
  chest.alive = alive;
  out[n + 1] = chest;

  const legs = hitboxAt(n + 2);
  legs.targetId = id;
  legs.part = "leg";
  legs.ax = x;
  legs.ay = y + 0.06;
  legs.az = z;
  legs.bx = x;
  legs.by = y + height * 0.52;
  legs.bz = z;
  legs.radius = 0.19 * (height / 1.8);
  legs.scale = 1;
  legs.alive = alive;
  out[n + 2] = legs;

  return n + 3;
}

/**
 * Hitboxes for every AI body near a shot's path. No lag compensation: the
 * player is the only fast-moving shooter and they are already authoritative,
 * so `atTime` is ignored and the present is reported.
 */
const aiHitboxProvider: HitboxProvider = {
  query(_atTime, ax, ay, az, bx, by, bz, out) {
    const cx = (ax + bx) * 0.5;
    const cz = (az + bz) * 0.5;
    const half = Math.hypot(bx - ax, by - ay, bz - az) * 0.5;
    const radius = half + 3;
    let n = 0;
    enemyForce.forEachHitbox(cx, cz, radius, (id, x, y, z, height, alive) => {
      if (n + 3 > 240) return;
      n = writeBody(out, n, id, x, y, z, height, alive);
    });
    pedestrians.forEachHitbox(cx, cz, radius, (id, x, y, z, height, alive) => {
      if (n + 3 > 240) return;
      n = writeBody(out, n, id, x, y, z, height, alive);
    });
    // Vehicles get one fat capsule so rounds actually damage traffic.
    trafficSim.forEachNear(cx, cz, radius, (v) => {
      if (n + 1 > 240) return;
      const h = hitboxAt(n);
      h.targetId = v.id;
      h.part = "chest";
      const c = Math.cos(v.yaw) * v.spec.length * 0.42;
      const s = Math.sin(v.yaw) * v.spec.length * 0.42;
      h.ax = v.x - c;
      h.ay = v.y + v.spec.height * 0.45;
      h.az = v.z - s;
      h.bx = v.x + c;
      h.by = v.y + v.spec.height * 0.45;
      h.bz = v.z + s;
      h.radius = v.spec.width * 0.5;
      h.scale = 0.35; // sheet metal soaks rifle rounds
      h.alive = v.state !== "crashed";
      out[n] = h;
      n += 1;
    });
    out.length = n;
    return n;
  },
};

/* ================================================================== *
 * The driver
 * ================================================================== */

function AiDriver({ peaceful }: { peaceful: boolean }) {
  const { camera } = useThree();
  const quality = useSfStore((s) => s.quality);
  const perf = useRef({ acc: 0, frames: 0, slow: 0 });
  const ammoWatch = useRef<Record<string, number>>({});

  /* ---- peace ---- *
   * Switching peace on has to *clear* the opposition, not merely stop ticking
   * it. A squad that stops updating does not go away; it stands in the road
   * forever, mid-stride, holding a rifle. Same for a pursuit already in
   * progress and for the wanted level that started it. */
  useEffect(() => {
    if (!peaceful) return;
    enemyForce.reset();
    police.reset();
    heat.reset();
  }, [peaceful]);

  /* ---- wiring, once ---- */
  useEffect(() => {
    resetEntityIds();
    trafficSim.reset();
    pedestrians.reset();
    enemyForce.reset();
    police.reset();
    heat.reset();
    clearPerception();
    resetNavigation();
    spawner.reset();

    // A driver thrown out of a car becomes a fleeing pedestrian, not a puff of
    // smoke. This is the single cheapest thing that sells vehicular chaos.
    trafficSim.onDriverEjected = (x, y, z, ax, az) => {
      pedestrians.spawnFleeing(x, y, z, ax, az, frame.time);
    };

    trafficSim.onVehicleDestroyed = (v) => {
      useSfStore.getState().addChaos(trafficSim.chaosValue(v), "Vehicle destroyed");
      heat.reportCrime("vehicle-destroyed", v.x, v.z, true);
      enemyForce.onVehicleDestroyed(v.x, v.z, 18, frame.time);
    };

    pedestrians.onKilled = (x, _y, z) => {
      heat.reportCrime("civilian-kill", x, z, true);
      useSfStore.getState().notify("Civilian killed", "damage");
    };

    enemyForce.onKilled = (e: Enemy) => {
      const value = e.archetype === "swat" || e.archetype === "soldier" ? 90 : 55;
      useSfStore.getState().addChaos(value, "Hostile down");
      if (e.faction === "police" || e.faction === "military") {
        heat.reportCrime("officer-kill", e.x, e.z, true);
      }
    };

    enemyForce.onReinforcementsRequested = (x, z) => {
      // A soldier calling it in is itself a crime report: it is how a firefight
      // in an alley becomes a city-wide response.
      heat.reportCrime("assault", x, z, true);
    };

    // Register with the weapon stack. The hitbox provider is additive and safe
    // to install unconditionally; the damage sink replaces whatever was there,
    // so it re-implements the physics-ref fallback for targets it does not own.
    if (!hitboxProvider()) setHitboxProvider(aiHitboxProvider);
    setWeaponDamageSink((target, targetId, amount, hit) => {
      const now = frame.time;
      const fromX = frame.position.x;
      const fromZ = frame.position.z;
      if (enemyForce.get(targetId)) {
        const killed = enemyForce.applyDamage(
          targetId,
          amount,
          now,
          fromX,
          fromZ,
          hit?.part === "head",
        );
        return { applied: amount, killed };
      }
      if (trafficSim.get(targetId)) {
        const killed = trafficSim.damage(targetId, amount, now);
        return { applied: amount, killed };
      }
      const pedIndex = pedestrians.indexOf(targetId);
      if (pedIndex >= 0) {
        const killed = pedestrians.applyDamage(targetId, amount, now);
        return { applied: amount, killed };
      }
      // Not ours: reproduce the bridge's own fallback so installing this sink
      // never silently disarms damage against somebody else's entities.
      const ref = (target?.ref ?? null) as { applyDamage?: (n: number, h: unknown) => unknown } | null;
      if (ref && typeof ref.applyDamage === "function") {
        return { applied: amount, killed: ref.applyDamage(amount, hit) === true };
      }
      return { applied: 0, killed: false };
    });

    const g = globalThis as Record<string, unknown>;
    g.__sfAi = sfAi;

    return () => {
      setWeaponDamageSink(null);
      if (hitboxProvider() === aiHitboxProvider) setHitboxProvider(null);
      trafficSim.onDriverEjected = null;
      trafficSim.onVehicleDestroyed = null;
      pedestrians.onKilled = null;
      enemyForce.onKilled = null;
      enemyForce.onReinforcementsRequested = null;
      if (g.__sfAi === sfAi) delete g.__sfAi;
      disposeStage();
    };
  }, []);

  useEffect(() => {
    spawner.setQuality(quality);
    characterBatch().setLodDistance(quality === "low" ? 34 : quality === "medium" ? 44 : 58);
  }, [quality]);

  /**
   * Gunfire detection without a hook into the weapon stack.
   *
   * Every weapon decrements its magazine through the store, so a magazine that
   * went down since last frame *is* a shot. This means the crowd reacts to the
   * player's gun with no integration work at all; an integrator who wants the
   * exact muzzle position can call `sfAi.reportGunshot` instead and this will
   * simply agree with it.
   */
  const detectPlayerFire = (now: number) => {
    const s = useSfStore.getState();
    const watch = ammoWatch.current;
    let fired = false;
    for (const key in s.ammo) {
      const mag = s.ammo[key]?.magazine ?? 0;
      const prev = watch[key];
      if (prev !== undefined && mag < prev && !s.reloading) fired = true;
      watch[key] = mag;
    }
    if (!fired) return;
    const p = frame.position;
    emitGunshot(p.x, p.y, p.z, "player", PLAYER_ENTITY_ID, 1);
    heat.reportCrime("gunfire", p.x, p.z, witnessesNear(p.x, p.z));
  };

  useFrame((_, delta) => {
    if (frame.paused) return;
    const dt = Math.min(delta, 1 / 20);
    const now = frame.time;
    const px = frame.position.x;
    const py = frame.position.y;
    const pz = frame.position.z;
    const fx = frame.forward.x;
    const fz = frame.forward.z;

    perceptionTick(now);
    if (!peaceful) detectPlayerFire(now);
    avoidance.begin();

    trafficSim.update(dt, now, px, pz);
    pedestrians.update(dt, now, px, pz);
    // The hostile half of the city. Skipped wholesale rather than fed zeroes:
    // these are the systems that walk every agent every frame, and the point
    // of a peaceful world is that they are not running at all.
    if (!peaceful) {
      enemyForce.update(dt, now, px, py, pz);
      police.observe(now, px, pz);
      heat.update(dt, now);
      police.update(dt, now, px, py, pz);
    }
    spawner.update(dt, now, px, py, pz, fx, fz);

    /* ---- instance upload ---- */
    const cam = camera.position;
    const chars = characterBatch();
    chars.begin();
    pedestrians.render(chars, cam.x, cam.y, cam.z);
    if (!peaceful) enemyForce.render(chars, cam.x, cam.y, cam.z);
    chars.commit();

    const veh = vehicleBatch();
    const night = headlightFactor(frame.timeOfDay);
    veh.begin();
    for (const v of trafficSim.vehicles) {
      if (v.state === "hijacked") continue;
      // Emergency vehicles run their headlights around the clock; everyone else
      // follows the sun.
      const lamps = v.sirenOn ? Math.max(night, 0.85) : night;
      veh.push(
        v.kind,
        v.x,
        v.y,
        v.z,
        v.yaw,
        v.pitch,
        v.roll,
        v.wheelSpin,
        v.steer,
        v.brake,
        v.sirenOn ? v.sirenPhase : 0,
        v.r,
        v.g,
        v.b,
        v.damage,
        lamps,
        v.seed,
      );
    }
    veh.commit();

    police.render(helicopterBatch());

    /* ---- adaptive load shedding ---- */
    const p = perf.current;
    p.acc += delta;
    p.frames++;
    if (p.acc >= 1) {
      const fps = p.frames / p.acc;
      // Two consecutive bad seconds shed population; two good ones restore it.
      if (fps < 45) p.slow = Math.min(4, p.slow + 1);
      else if (fps > 56) p.slow = Math.max(0, p.slow - 1);
      spawner.setRelief(1 - p.slow * 0.18);
      p.acc = 0;
      p.frames = 0;
    }
  });

  return null;
}

/* ================================================================== *
 * The component
 * ================================================================== */

export interface CityAIProps {
  /** Render the crowd. Off leaves the simulation running but invisible. */
  crowd?: boolean;
  /** Render traffic and air support. */
  traffic?: boolean;
  /** Cast shadows from agents and vehicles. */
  shadows?: boolean;
  /**
   * No opposition, no police, no wanted level.
   *
   * The city still lives — crowds walk, traffic drives, horns go off, people
   * get out of your way — but nothing in it is hunting you and nothing is
   * keeping score. This is the default, and it is not a reduced version of the
   * game so much as a different one: San Francisco as a place to be in rather
   * than a place to be chased through.
   *
   * It is also most of the CPU. Perception, threat propagation, the heat model
   * and the pursuit AI all run every frame whether or not anything has
   * happened, and they run over every agent.
   */
  peaceful?: boolean;
}

/**
 * The whole living city. Mount once, inside the Canvas, after the street layer
 * so the road graph exists by the time the first spawn attempt runs.
 */
export default function CityAI({
  crowd = true,
  traffic = true,
  shadows,
  peaceful = false,
}: CityAIProps) {
  const quality = useSfStore((s) => s.quality);
  const castShadows = useMemo(
    () => (shadows === undefined ? QUALITY[quality].shadowCascades > 2 : shadows),
    [shadows, quality],
  );

  return (
    <>
      <AiDriver peaceful={peaceful} />
      {crowd && <Pedestrians shadows={castShadows} />}
      {traffic && <Traffic shadows={castShadows} />}
    </>
  );
}

/* ================================================================== *
 * Re-exports — everything another subsystem might legitimately want
 * ================================================================== */

export { default as Pedestrians } from "./Pedestrians";
export { default as Traffic, headlightFactor } from "./Traffic";

export { pedestrians, Pedestrians as PedestrianSim } from "./pedestrians";
export { trafficSim, type TrafficVehicle, type TrafficState } from "./traffic";
export { enemyForce, EnemyForce, Squad, LOADOUTS, type Enemy, type EnemyState } from "./enemies";
export { police, PoliceResponse } from "./police";
export { heat, HeatSystem, type CrimeKind } from "./heat";
export { spawner, Spawner, BAND_FULL, BAND_SIMPLE, BAND_FROZEN } from "./spawner";

export {
  navGraph,
  avoidance,
  findPath,
  makeNavPath,
  advancePath,
  pathFinished,
  pathTarget,
  sidewalkPoint,
  lanePoint,
  crossingPoint,
  sideOfEdge,
  sAlongEdge,
  chooseContinuation,
  groundHeight,
  probeAhead,
  slideAlong,
  clearPathCache,
  pathCacheStats,
  resetNavigation,
  type NavPath,
  type PathOptions,
  type NavPoint,
} from "./navigation";

export {
  emitNoise,
  emitGunshot,
  emitExplosion,
  emitCrash,
  emitSiren,
  forEachEventNear,
  strongestThreatNear,
  lastEventTime,
  liveEventCount,
  perceptionTick,
  clearPerception,
  type NoiseEvent,
  type NoiseKind,
  type ThreatSample,
} from "./perception";

export {
  CharacterBatch,
  buildCharacterGeometry,
  makeCharacterMaterial,
  makeCharacterDepthMaterial,
  makePalette,
  archetypeMask,
  archetypeBody,
  PALETTE_FLOATS,
  CHARACTER_PIVOTS,
  CHAR_MASK_HAIR,
  CHAR_MASK_CAP,
  CHAR_MASK_HELMET,
  CHAR_MASK_VEST,
  CHAR_MASK_RIFLE,
  CHAR_MASK_SIDEARM,
  CHAR_MASK_BACKPACK,
  CHAR_MASK_COAT,
} from "./characters";

export {
  VehicleBatch,
  HelicopterBatch,
  VEHICLE_SPECS,
  buildVehicleGeometry,
  buildHelicopterGeometry,
  makeVehicleMaterial,
  type VehicleSpec,
} from "./vehicleMeshes";

export {
  characterBatch,
  vehicleBatch,
  helicopterBatch,
  disposeStage,
} from "./stage";

export {
  nextEntityId,
  losKey,
  hostile,
  PLAYER_ENTITY_ID,
  LOD_FULL,
  LOD_SIMPLE,
  LOD_FROZEN,
  TRAFFIC_KINDS,
  type Faction,
  type AiLod,
  type CharacterArchetype,
  type TrafficVehicleKind,
  type HijackSnapshot,
} from "./types";
