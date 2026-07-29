/**
 * ai/traffic.ts — San Francisco actually driving.
 *
 * This is a microscopic traffic simulation, not a set of cars on splines. Every
 * vehicle runs the Intelligent Driver Model against a real leader, obeys the
 * road graph's own signals and rights of way, changes lanes when the lane it is
 * in stops paying, and holds a queue at a red light that discharges the way a
 * real queue discharges — front to back, with reaction lag.
 *
 * Why microscopic rather than "spawn a car, drive it down a spline, despawn":
 * the moment the player parks across Market Street, or shoots a driver, or
 * drops a fuel tanker into an intersection, spline traffic reveals itself. A
 * car-following model handles all three for free, because the only thing a
 * vehicle ever asks is "what is in front of me and how fast is it going".
 *
 * What is in here
 * ---------------
 *   - IDM car-following with lane discipline and MOBIL-style lane changes
 *   - signalised junctions, stop signs, and priority at uncontrolled ones,
 *     using a per-node reservation so nobody occupies a junction box together
 *   - emergency vehicles that broadcast a corridor and are pulled over for
 *   - MUNI buses on arterial routes with kerbside dwell, and cable cars that
 *     are restricted to the cable corridors the road network tags
 *   - honking, panic, swerving, collisions, abandonment under fire
 *   - a hijack API: the vehicle leaves this sim entirely and is handed to the
 *     player's vehicle system as a value snapshot
 *
 * Kinematic, not rigid-body, on purpose. Two hundred Rapier vehicles is not a
 * budget any browser has; the player's own car is a real rigid body, everything
 * else is a kinematic agent on the graph, and the handover between the two is
 * the hijack snapshot.
 *
 * Public API
 * ----------
 *   trafficSim.update(dt, now, cx, cz)
 *   trafficSim.spawnNear / cullFar / forEachVisible
 *   trafficSim.findHijackable / hijack / relinquish
 *   trafficSim.damage / destroy
 *   TrafficVehicle
 */
import { CHAOS } from "../config";
import { districtAt, isWater } from "../geo/sfGeo";
import { makeRng, type Rng } from "../math/rng";
import {
  edgeSpan,
  roadNetwork,
  roadSurface,
  signalState,
  approachPhase,
  travelLanes,
  type Lane,
  type RoadEdge,
} from "../world/street/roadNetwork";
import { chooseContinuation, navGraph } from "./navigation";
import { emitCrash, emitNoise, emitSiren, strongestThreatNear } from "./perception";
import { VEHICLE_SPECS, type VehicleSpec } from "./vehicleMeshes";
import {
  LOD_FROZEN,
  LOD_FULL,
  LOD_SIMPLE,
  nextEntityId,
  type AiLod,
  type HijackSnapshot,
  type TrafficVehicleKind,
} from "./types";

/* ================================================================== *
 * Model constants
 * ================================================================== */

/** IDM: minimum bumper-to-bumper gap at rest, metres. */
const IDM_S0 = 2.1;
/** IDM: desired time headway, seconds. SF drivers are not patient. */
const IDM_T = 1.25;
/** IDM: acceleration exponent. */
const IDM_DELTA = 4;
/** Braking used when a signal turns amber and stopping is still comfortable. */
const AMBER_DECEL = 3.2;
/** Junction box clearance a vehicle must have before entering, metres. */
const JUNCTION_CLEAR = 6;
/** How long a claimed junction stays claimed if the claimant vanishes. */
const RESERVATION_TIMEOUT = 6;

export type TrafficState =
  | "drive"
  | "queue"
  | "dwell"
  | "panic"
  | "crashed"
  | "abandoned"
  | "hijacked";

export interface TrafficVehicle {
  id: number;
  kind: TrafficVehicleKind;
  spec: VehicleSpec;

  /* ---- graph position ---- */
  edge: number;
  /** +1 travels a→b, −1 travels b→a. */
  dir: 1 | -1;
  lane: Lane | null;
  /** Lateral offset actually rendered, lerped toward the lane during changes. */
  lateral: number;
  targetLateral: number;
  /** Distance travelled along the current edge, measured from the entry node. */
  travel: number;

  /* ---- kinematics ---- */
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  speed: number;
  accel: number;
  steer: number;
  wheelSpin: number;

  /* ---- presentation ---- */
  r: number;
  g: number;
  b: number;
  damage: number;
  seed: number;
  brake: number;
  sirenPhase: number;
  headlights: number;

  /* ---- behaviour ---- */
  state: TrafficState;
  desiredSpeed: number;
  blockedTime: number;
  honkCooldown: number;
  panicTimer: number;
  dwellTimer: number;
  laneChangeCooldown: number;
  yieldTimer: number;
  emergency: boolean;
  sirenOn: boolean;
  routed: boolean;
  hasDriver: boolean;
  health: number;
  lod: AiLod;
  /** Junction currently claimed by this vehicle, or −1. */
  claimed: number;
  /** Sim time this vehicle entered the world — used by the despawn policy. */
  born: number;
  alive: boolean;
}

/* ================================================================== *
 * The simulation
 * ================================================================== */

class TrafficSim {
  readonly vehicles: TrafficVehicle[] = [];
  private byId = new Map<number, TrafficVehicle>();
  private rng: Rng = makeRng("sf-traffic");
  private spawnCounter = 0;

  /** Per (edge, lane-key) queues, rebuilt each tick and used for leader lookup. */
  private lanes = new Map<number, TrafficVehicle[]>();
  private lanePool: TrafficVehicle[][] = [];

  /** nodeId → { id, time } of whoever owns the junction box. */
  private reservations = new Map<number, { id: number; time: number }>();

  /** Hard cap; the spawner lowers it on weaker tiers. */
  maxVehicles = 130;
  /** Emergency-vehicle corridor broadcast, refreshed each tick. */
  private sirenX = 0;
  private sirenZ = 0;
  private sirenActive = false;
  private sirenTimer = 0;

  /** Callback used to eject a driver as a fleeing pedestrian. */
  onDriverEjected: ((x: number, y: number, z: number, awayX: number, awayZ: number) => void) | null =
    null;
  /** Callback when a vehicle is destroyed — chaos, VFX, physics debris. */
  onVehicleDestroyed: ((v: TrafficVehicle) => void) | null = null;

  stats = { count: 0, full: 0, simple: 0, frozen: 0, spawned: 0, despawned: 0 };

  /* ---------------- lifecycle ---------------- */

  reset(seed = "sf-traffic"): void {
    this.vehicles.length = 0;
    this.byId.clear();
    this.lanes.clear();
    this.reservations.clear();
    this.rng = makeRng(seed);
    this.spawnCounter = 0;
  }

  get(id: number): TrafficVehicle | undefined {
    return this.byId.get(id);
  }

  /* ---------------- spawning ---------------- */

  /**
   * Try to spawn one vehicle on a road near (cx, cz) but outside `minDist`, so
   * traffic materialises behind the player's shoulder rather than in front of
   * their eyes. Returns the vehicle or null.
   */
  spawnNear(cx: number, cz: number, minDist: number, maxDist: number, now: number): TrafficVehicle | null {
    if (this.vehicles.length >= this.maxVehicles) return null;
    const rng = this.rng;
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = rng.next() * Math.PI * 2;
      const d = minDist + rng.next() * (maxDist - minDist);
      const px = cx + Math.cos(a) * d;
      const pz = cz + Math.sin(a) * d;
      if (isWater(px, pz)) continue;
      navGraph.ensure(px, pz, 200);
      const hit = roadNetwork.nearestEdge(px, pz, 70);
      if (!hit) continue;
      const e = hit.edge;
      if (e.isAlley) continue;
      const span = edgeSpan(e);
      if (span.len < 14) continue;

      const dir: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      const lanes = travelLanes(e, dir, []);
      if (lanes.length === 0) continue;
      const lane = lanes[rng.int(0, lanes.length - 1)];
      const travel = span.s0 + rng.next() * (span.len - 6) + 3;

      // Refuse to drop a car on top of another one.
      const s = dir === 1 ? travel : e.length - travel;
      const sp = roadSurface(e, s, lane.offset);
      if (this.occupied(sp.x, sp.z, 7)) continue;

      const kind = this.pickKind(e, rng);
      const v = this.create(kind, e, dir, lane, travel, now, rng);
      return v;
    }
    return null;
  }

  /** Deliberately spawn a specific kind at a specific place — the police use it. */
  spawnAt(
    kind: TrafficVehicleKind,
    x: number,
    z: number,
    now: number,
    towardX?: number,
    towardZ?: number,
  ): TrafficVehicle | null {
    if (this.vehicles.length >= this.maxVehicles + 24) return null;
    navGraph.ensure(x, z, 160);
    const hit = roadNetwork.nearestEdge(x, z, 90);
    if (!hit) return null;
    const e = hit.edge;
    const span = edgeSpan(e);
    if (span.len < 10) return null;
    // Choose the direction that points at the target, if one was given.
    let dir: 1 | -1 = 1;
    if (towardX !== undefined && towardZ !== undefined) {
      const toX = towardX - x;
      const toZ = towardZ - z;
      dir = toX * e.dx + toZ * e.dz >= 0 ? 1 : -1;
    } else if (this.rng.chance(0.5)) {
      dir = -1;
    }
    const lanes = travelLanes(e, dir, []);
    if (lanes.length === 0) return null;
    const lane = lanes[0];
    const sOnEdge = hit.s;
    const travel = dir === 1 ? sOnEdge : e.length - sOnEdge;
    return this.create(kind, e, dir, lane, Math.max(span.s0 + 2, Math.min(travel, span.s1 - 2)), now, this.rng);
  }

  private pickKind(e: RoadEdge, rng: Rng): TrafficVehicleKind {
    if (e.cableCar && rng.chance(0.35)) return "cablecar";
    if ((e.cls === "arterial" || e.cls === "boulevard") && rng.chance(0.07)) return "bus";
    const d = districtAt(e.samples[0], e.samples[2]);
    const commercial = d.key === "fidi" || d.key === "soma" || d.key === "embarcadero";
    const roll = rng.next();
    if (commercial) {
      if (roll < 0.2) return "taxi";
      if (roll < 0.34) return "van";
      if (roll < 0.44) return "suv";
      if (roll < 0.5) return "pickup";
      if (roll < 0.56) return "hatchback";
      return "sedan";
    }
    if (roll < 0.08) return "taxi";
    if (roll < 0.2) return "suv";
    if (roll < 0.3) return "hatchback";
    if (roll < 0.38) return "pickup";
    if (roll < 0.45) return "van";
    return "sedan";
  }

  private create(
    kind: TrafficVehicleKind,
    e: RoadEdge,
    dir: 1 | -1,
    lane: Lane,
    travel: number,
    now: number,
    rng: Rng,
  ): TrafficVehicle {
    const spec = VEHICLE_SPECS[kind];
    const paint = spec.palette[rng.int(0, spec.palette.length - 1)];
    // sRGB → linear by hand: no THREE.Color allocation in a spawn loop that
    // may run several times a second.
    const sr = ((paint >> 16) & 255) / 255;
    const sg = ((paint >> 8) & 255) / 255;
    const sb = (paint & 255) / 255;
    const v: TrafficVehicle = {
      id: nextEntityId(),
      kind,
      spec,
      edge: e.id,
      dir,
      lane,
      lateral: lane.offset,
      targetLateral: lane.offset,
      travel,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      speed: spec.desiredSpeed * (0.55 + rng.next() * 0.4),
      accel: 0,
      steer: 0,
      wheelSpin: rng.next() * 6.28,
      r: srgbToLinear(sr) * (0.9 + rng.next() * 0.2),
      g: srgbToLinear(sg) * (0.9 + rng.next() * 0.2),
      b: srgbToLinear(sb) * (0.9 + rng.next() * 0.2),
      damage: 0,
      seed: rng.next(),
      brake: 0,
      sirenPhase: 0,
      headlights: 0,
      state: "drive",
      // Individual driver aggression: ±18 % of the posted desire. Uniform
      // desired speeds are the single most obvious tell of fake traffic.
      desiredSpeed: spec.desiredSpeed * (0.86 + rng.next() * 0.32),
      blockedTime: 0,
      honkCooldown: rng.next() * 3,
      panicTimer: 0,
      dwellTimer: 0,
      laneChangeCooldown: rng.next() * 4,
      yieldTimer: 0,
      emergency: spec.emergency,
      sirenOn: false,
      routed: spec.routed,
      hasDriver: true,
      health: 100 * spec.mass * 0.6 + 60,
      lod: LOD_FULL,
      claimed: -1,
      born: now,
      alive: true,
    };
    this.resolvePose(v);
    this.vehicles.push(v);
    this.byId.set(v.id, v);
    this.spawnCounter++;
    this.stats.spawned++;
    return v;
  }

  private occupied(x: number, z: number, radius: number): boolean {
    const r2 = radius * radius;
    for (const v of this.vehicles) {
      const dx = v.x - x;
      const dz = v.z - z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }

  /** Remove vehicles beyond `maxDist` that the player is not looking at. */
  cullFar(cx: number, cz: number, maxDist: number, now: number): number {
    const max2 = maxDist * maxDist;
    let removed = 0;
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      const dx = v.x - cx;
      const dz = v.z - cz;
      if (dx * dx + dz * dz <= max2) continue;
      // A wreck is scenery the player made; it stays a good while longer.
      if (v.state === "crashed" && now - v.born < 90 && dx * dx + dz * dz < max2 * 2.2) continue;
      this.removeAt(i);
      removed++;
      this.stats.despawned++;
    }
    return removed;
  }

  private removeAt(i: number): void {
    const v = this.vehicles[i];
    if (v.claimed >= 0) this.reservations.delete(v.claimed);
    this.byId.delete(v.id);
    this.vehicles[i] = this.vehicles[this.vehicles.length - 1];
    this.vehicles.pop();
    v.alive = false;
  }

  despawn(id: number): void {
    const i = this.vehicles.findIndex((v) => v.id === id);
    if (i >= 0) this.removeAt(i);
  }

  /* ---------------- the tick ---------------- */

  update(dt: number, now: number, cx: number, cz: number): void {
    if (dt <= 0) return;
    this.buildLaneIndex();
    this.updateSirenBroadcast(dt, now);

    let full = 0;
    let simple = 0;
    let frozen = 0;

    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      const dx = v.x - cx;
      const dz = v.z - cz;
      const d2 = dx * dx + dz * dz;
      v.lod = d2 < 160 * 160 ? LOD_FULL : d2 < 420 * 420 ? LOD_SIMPLE : LOD_FROZEN;
      if (v.lod === LOD_FULL) full++;
      else if (v.lod === LOD_SIMPLE) simple++;
      else frozen++;

      if (v.state === "hijacked") continue;

      // Frozen vehicles coast on the graph with no queries at all: they still
      // move, so the block you walk back to has not stopped in time, but they
      // cost nothing but an integration.
      if (v.lod === LOD_FROZEN) {
        this.integrateSimple(v, dt, now);
        continue;
      }

      this.step(v, dt, now, cx, cz);
    }

    this.stats.count = this.vehicles.length;
    this.stats.full = full;
    this.stats.simple = simple;
    this.stats.frozen = frozen;
    this.expireReservations(now);
  }

  /** Group vehicles by (edge, direction, lane) and sort each queue by travel. */
  private buildLaneIndex(): void {
    // Recycle the arrays: a Map rebuilt from fresh arrays every frame at 60 Hz
    // is a steady 3 MB/s of garbage for no benefit.
    let pool = 0;
    this.lanes.forEach((arr) => {
      arr.length = 0;
      this.lanePool[pool++] = arr;
    });
    this.lanes.clear();
    let poolCursor = 0;
    for (const v of this.vehicles) {
      if (!v.lane || v.state === "hijacked") continue;
      const key = v.edge * 32 + (v.dir === 1 ? 0 : 16) + Math.min(15, Math.max(0, laneIndexOf(v)));
      let arr = this.lanes.get(key);
      if (!arr) {
        arr = poolCursor < pool ? this.lanePool[poolCursor++] : [];
        this.lanes.set(key, arr);
      }
      arr.push(v);
    }
    this.lanes.forEach((arr) => arr.sort((a, b) => a.travel - b.travel));
  }

  private updateSirenBroadcast(dt: number, now: number): void {
    this.sirenActive = false;
    this.sirenTimer -= dt;
    for (const v of this.vehicles) {
      if (!v.sirenOn) continue;
      this.sirenActive = true;
      this.sirenX = v.x;
      this.sirenZ = v.z;
      v.sirenPhase = (now * 2.6 + v.seed * 7) % 1;
      if (this.sirenTimer <= 0) {
        emitSiren(v.x, v.y, v.z, v.id);
      }
    }
    if (this.sirenTimer <= 0) this.sirenTimer = 1.4;
  }

  /* ---------------- per-vehicle behaviour ---------------- */

  private step(v: TrafficVehicle, dt: number, now: number, cx: number, cz: number): void {
    const edges = roadNetwork.edges;
    const e = edges[v.edge];
    if (!e) {
      v.state = "crashed";
      return;
    }

    /* --- crashed / abandoned: settle and stop thinking --- */
    if (v.state === "crashed" || v.state === "abandoned") {
      v.speed = Math.max(0, v.speed - 9 * dt);
      v.brake = 1;
      this.advance(v, e, dt);
      this.resolvePose(v);
      return;
    }

    /* --- react to violence --- */
    if (v.lod === LOD_FULL) {
      const threat = strongestThreatNear(v.x, v.z, now - 1.2);
      if (threat && threat.threat > 0.5) {
        if (v.state !== "panic") {
          v.state = "panic";
          v.panicTimer = 4 + this.rng.next() * 4;
          // A quarter of drivers lose it entirely: brake hard, swerve, and bail.
          if (this.rng.chance(0.22) && v.speed > 4) {
            this.crash(v, now, 0.5);
            return;
          }
        }
      }
    }
    if (v.state === "panic") {
      v.panicTimer -= dt;
      if (v.panicTimer <= 0) v.state = "drive";
    }

    /* --- dwelling at a bus stop --- */
    if (v.state === "dwell") {
      v.dwellTimer -= dt;
      v.speed = Math.max(0, v.speed - v.spec.brake * 2 * dt);
      v.brake = 1;
      if (v.dwellTimer <= 0 && v.speed < 0.05) v.state = "drive";
      this.advance(v, e, dt);
      this.resolvePose(v);
      return;
    }

    /* --- desired speed for this moment --- */
    let desired = v.desiredSpeed;
    if (v.state === "panic") desired *= 1.5;
    if (v.sirenOn) desired *= 1.35;
    // Hills: the graph knows the grade, and nobody takes Filbert at 30.
    desired *= 1 - Math.min(0.45, Math.abs(e.grade) * 1.6);
    if (v.yieldTimer > 0) desired = Math.min(desired, 3.5);

    /* --- car following --- */
    const leader = this.leaderOf(v);
    let gap = Infinity;
    let leaderSpeed = 0;
    if (leader) {
      gap = leader.travel - v.travel - (leader.spec.length * 0.5 + v.spec.length * 0.5);
      leaderSpeed = leader.speed;
    }

    /* --- the junction ahead --- *
     * `travel` is measured from the *entry* node, so the distance left is the
     * edge length minus the far end's junction trim. Getting this backwards
     * puts every westbound car's stop line at the wrong end of the block. */
    const toJunction = e.length - (v.dir === 1 ? e.trimB : e.trimA) - v.travel;
    const stopGap = this.junctionConstraint(v, e, now, toJunction);
    if (stopGap < gap) {
      gap = stopGap;
      leaderSpeed = 0;
    }

    /* --- IDM --- */
    let a = this.idm(v.speed, desired, gap, leaderSpeed, v.spec);

    // Emergency vehicles bully through: they accept smaller gaps and treat a
    // red light as a give-way rather than a wall.
    if (v.sirenOn) a = Math.max(a, -v.spec.brake * 0.6);

    v.accel = a;
    v.speed = Math.max(0, v.speed + a * dt);
    v.brake = a < -0.7 ? Math.min(1, -a / v.spec.brake) : 0;

    /* --- blocked / honking --- */
    if (v.speed < 0.6 && gap < 12) {
      v.blockedTime += dt;
    } else {
      v.blockedTime = Math.max(0, v.blockedTime - dt * 2);
    }
    v.honkCooldown -= dt;
    if (v.blockedTime > 2.6 && v.honkCooldown <= 0 && v.lod === LOD_FULL) {
      emitNoise("horn", v.x, v.y + 1, v.z, "civilian", v.id);
      v.honkCooldown = 2.5 + this.rng.next() * 4;
      v.blockedTime = 1.2;
    }

    /* --- lane changes --- */
    v.laneChangeCooldown -= dt;
    if (
      v.lod === LOD_FULL &&
      v.laneChangeCooldown <= 0 &&
      v.speed > 2 &&
      toJunction > 24 &&
      !v.routed
    ) {
      this.tryLaneChange(v, e, gap, leaderSpeed);
    }

    /* --- pull over for sirens --- */
    if (this.sirenActive && !v.sirenOn) {
      const dx = this.sirenX - v.x;
      const dz = this.sirenZ - v.z;
      if (dx * dx + dz * dz < 55 * 55) {
        v.yieldTimer = 2.2;
        v.targetLateral = v.lane ? v.lane.offset + (v.dir === 1 ? 1 : -1) * 1.5 : v.lateral;
      }
    }
    if (v.yieldTimer > 0) {
      v.yieldTimer -= dt;
      if (v.yieldTimer <= 0 && v.lane) v.targetLateral = v.lane.offset;
    }

    /* --- panic swerve --- */
    if (v.state === "panic" && v.lane) {
      const wobble = Math.sin(now * 5.5 + v.seed * 30) * 1.1;
      v.targetLateral = v.lane.offset + wobble;
    } else if (v.yieldTimer <= 0 && v.lane) {
      v.targetLateral = v.lane.offset;
    }

    /* --- integrate --- */
    const prevLateral = v.lateral;
    v.lateral += (v.targetLateral - v.lateral) * Math.min(1, dt * 2.6);
    this.advance(v, e, dt, now);
    this.resolvePose(v);

    // Steering angle for the render: from lateral rate plus the edge's own
    // curvature at the junction approach.
    const lateralRate = (v.lateral - prevLateral) / Math.max(dt, 1e-4);
    v.steer += (clampF(-lateralRate * 0.22, -0.5, 0.5) - v.steer) * Math.min(1, dt * 8);
    v.wheelSpin += (v.speed / Math.max(0.2, v.spec.wheelRadius)) * dt * (v.dir === 1 ? 1 : 1);
    if (v.wheelSpin > 1e6) v.wheelSpin = 0;
  }

  /** Cheap integration for the frozen band: no leader, no signals, no queries. */
  private integrateSimple(v: TrafficVehicle, dt: number, now: number): void {
    const e = roadNetwork.edges[v.edge];
    if (!e) return;
    v.speed += (v.desiredSpeed - v.speed) * Math.min(1, dt * 0.4);
    this.advance(v, e, dt, now);
    this.resolvePose(v);
    v.wheelSpin += (v.speed / Math.max(0.2, v.spec.wheelRadius)) * dt;
  }

  /**
   * The Intelligent Driver Model. One equation, and it produces queue
   * discharge, stop-and-go waves and comfortable following distances for free —
   * which is why every traffic engineer and every open-world game uses it.
   */
  private idm(v: number, v0: number, gap: number, leaderV: number, spec: VehicleSpec): number {
    const A = spec.accel;
    const B = spec.brake;
    const free = 1 - Math.pow(Math.min(1, v / Math.max(0.5, v0)), IDM_DELTA);
    if (!isFinite(gap) || gap > 400) return A * free;
    const dv = v - leaderV;
    const sStar = IDM_S0 + Math.max(0, v * IDM_T + (v * dv) / (2 * Math.sqrt(A * B)));
    const interaction = Math.pow(sStar / Math.max(0.4, gap), 2);
    return A * (free - interaction);
  }

  /** The vehicle immediately ahead in the same lane, or null. */
  private leaderOf(v: TrafficVehicle): TrafficVehicle | null {
    const key = v.edge * 32 + (v.dir === 1 ? 0 : 16) + Math.min(15, Math.max(0, laneIndexOf(v)));
    const arr = this.lanes.get(key);
    if (!arr) return null;
    // The queue is sorted by travel; find self and take the next entry.
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] === v) return i + 1 < arr.length ? arr[i + 1] : null;
    }
    return null;
  }

  /**
   * Distance to a virtual stopped obstacle at the junction, or +∞ if the
   * vehicle may proceed. Handles signals, stop signs, priority and the
   * reservation that stops two cars occupying one junction box.
   */
  private junctionConstraint(v: TrafficVehicle, e: RoadEdge, now: number, toJunction: number): number {
    if (toJunction > 60) return Infinity;
    const exitNodeId = v.dir === 1 ? e.b : e.a;
    const node = roadNetwork.nodes[exitNodeId];
    if (!node) return Infinity;

    // Already inside the box: hold the claim and keep going.
    if (toJunction < 1.5) {
      if (v.claimed !== exitNodeId) {
        this.reservations.set(exitNodeId, { id: v.id, time: now });
        v.claimed = exitNodeId;
      }
      return Infinity;
    }

    if (node.control === "signal") {
      const st = signalState(node, now);
      const mine = approachPhase(node, e.id);
      const green = st.green === mine && !st.allRed;
      if (!green) {
        // Amber: go if stopping would need more than a comfortable deceleration.
        if (st.amber && st.green === mine) {
          const stopDist = (v.speed * v.speed) / (2 * AMBER_DECEL);
          if (stopDist > toJunction - 1) return Infinity;
        }
        if (v.sirenOn && toJunction < 18 && v.speed < 8) return Infinity;
        return Math.max(0, toJunction - 3.2);
      }
    } else if (node.control === "stop") {
      // A stop sign is only satisfied once, and only if we actually stopped.
      if (v.speed > 1.2 && toJunction < 9) return Math.max(0, toJunction - 3.4);
      if (v.speed <= 1.2 && toJunction < 9) {
        const held = this.reservations.get(exitNodeId);
        if (held && held.id !== v.id && now - held.time < RESERVATION_TIMEOUT) {
          return Math.max(0, toJunction - 3.4);
        }
      }
    }

    // Uncontrolled or green: still refuse to enter an occupied box.
    if (toJunction < JUNCTION_CLEAR) {
      const held = this.reservations.get(exitNodeId);
      if (held && held.id !== v.id && now - held.time < RESERVATION_TIMEOUT) {
        // Emergency vehicles push in anyway; everyone else waits.
        if (!v.sirenOn) return Math.max(0, toJunction - 3.2);
      }
      this.reservations.set(exitNodeId, { id: v.id, time: now });
      v.claimed = exitNodeId;
    }
    return Infinity;
  }

  private expireReservations(now: number): void {
    if (this.reservations.size === 0) return;
    const dead: number[] = [];
    this.reservations.forEach((r, nodeId) => {
      if (now - r.time > RESERVATION_TIMEOUT || !this.byId.has(r.id)) dead.push(nodeId);
    });
    for (const n of dead) this.reservations.delete(n);
  }

  /**
   * MOBIL-lite: change lanes when the target lane is clearly better and the
   * move does not force whoever is behind there into an emergency stop.
   */
  private tryLaneChange(v: TrafficVehicle, e: RoadEdge, gap: number, leaderSpeed: number): void {
    if (gap > 30 && leaderSpeed > v.desiredSpeed * 0.85) return;
    const lanes = travelLanes(e, v.dir, _laneScratch);
    if (lanes.length < 2) return;
    const cur = lanes.indexOf(v.lane as Lane);
    if (cur < 0) return;

    for (const delta of this.rng.chance(0.5) ? [-1, 1] : [1, -1]) {
      const t = cur + delta;
      if (t < 0 || t >= lanes.length) continue;
      const target = lanes[t];
      const key = e.id * 32 + (v.dir === 1 ? 0 : 16) + Math.min(15, t);
      const arr = this.lanes.get(key);
      let aheadGap = Infinity;
      let behindGap = Infinity;
      let behindSpeed = 0;
      if (arr) {
        for (const o of arr) {
          const d = o.travel - v.travel;
          if (d > 0) aheadGap = Math.min(aheadGap, d - v.spec.length);
          else {
            const bg = -d - v.spec.length;
            if (bg < behindGap) {
              behindGap = bg;
              behindSpeed = o.speed;
            }
          }
        }
      }
      // Politeness: do not cut up a faster car that is close behind.
      const needBehind = 6 + Math.max(0, behindSpeed - v.speed) * 1.6;
      if (aheadGap > gap + 12 && behindGap > needBehind) {
        v.lane = target;
        v.targetLateral = target.offset;
        v.laneChangeCooldown = 3.5 + this.rng.next() * 4;
        return;
      }
    }
    v.laneChangeCooldown = 1.4;
  }

  /** Move along the edge, handing over to the next edge at the far node. */
  private advance(v: TrafficVehicle, e: RoadEdge, dt: number, now = 0): void {
    v.travel += v.speed * dt;
    if (v.travel < e.length) return;
    // Reached the far node: release the junction and pick the next street.
    const exitNodeId = v.dir === 1 ? e.b : e.a;
    const node = roadNetwork.nodes[exitNodeId];
    if (v.claimed === exitNodeId) {
      this.reservations.delete(exitNodeId);
      v.claimed = -1;
    }
    if (!node) {
      v.state = "crashed";
      return;
    }
    navGraph.ensure(node.x, node.z, 220);

    const nextId = this.pickNextEdge(v, node, e);
    const next = roadNetwork.edges[nextId];
    if (!next || nextId === e.id) {
      // Dead end: turn round on the spot rather than vanish.
      v.dir = v.dir === 1 ? -1 : 1;
      v.travel = 1;
      const back = travelLanes(e, v.dir, _laneScratch);
      v.lane = back.length ? back[0] : v.lane;
      if (v.lane) {
        v.lateral = v.lane.offset;
        v.targetLateral = v.lane.offset;
      }
      v.speed *= 0.25;
      return;
    }

    const overshoot = v.travel - e.length;
    v.edge = next.id;
    v.dir = next.a === exitNodeId ? 1 : -1;
    v.travel = Math.max(0, overshoot);
    const lanes = travelLanes(next, v.dir, _laneScratch);
    v.lane = lanes.length ? lanes[Math.min(lanes.length - 1, this.rng.int(0, lanes.length - 1))] : null;
    if (v.lane) {
      v.targetLateral = v.lane.offset;
      v.lateral = v.lane.offset;
    }
    v.laneChangeCooldown = Math.max(v.laneChangeCooldown, 1.5);

    // MUNI dwell: buses stop at roughly every fourth signalised junction on an
    // arterial, which is about right for the real headways downtown.
    if (v.kind === "bus" && node.control === "signal" && (node.seed & 3) === 0) {
      v.state = "dwell";
      v.dwellTimer = 4 + this.rng.next() * 5;
      if (v.lane) v.targetLateral = v.lane.offset + (v.dir === 1 ? 1 : -1) * 1.6;
    }
  }

  /** Route selection: routed vehicles stay on their corridor, others wander. */
  private pickNextEdge(v: TrafficVehicle, node: { id: number; edges: number[] }, e: RoadEdge): number {
    const edges = roadNetwork.edges;
    if (v.kind === "cablecar") {
      // Cable cars are captives of the cable: only tagged edges, and if the
      // corridor ends they reverse rather than leave it.
      for (const eid of node.edges) {
        if (eid === e.id) continue;
        const cand = edges[eid];
        if (cand && cand.cableCar) return eid;
      }
      return e.id;
    }
    if (v.kind === "bus" || v.emergency) {
      // Buses and emergency traffic prefer to stay on the big streets.
      let best = -1;
      let bestScore = -Infinity;
      for (const eid of node.edges) {
        if (eid === e.id) continue;
        const cand = edges[eid];
        if (!cand || cand.isAlley) continue;
        const outX = cand.a === node.id ? cand.dx : -cand.dx;
        const outZ = cand.a === node.id ? cand.dz : -cand.dz;
        const inX = e.a === node.id ? e.dx : -e.dx;
        const inZ = e.a === node.id ? e.dz : -e.dz;
        const straight = outX * inX + outZ * inZ;
        const clsBonus = cand.cls === "boulevard" ? 1.4 : cand.cls === "arterial" ? 1.0 : 0.2;
        const score = straight * 1.6 + clsBonus + (cand.transitLane ? 0.6 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = eid;
        }
      }
      return best >= 0 ? best : e.id;
    }
    // Ordinary traffic: strongly biased straight on, which is what makes a
    // corridor look like a corridor rather than a random walk.
    return chooseContinuation(roadNetwork.nodes[node.id], e.id, 1.6, this.rng.next(), true);
  }

  /** Sample the road surface and write the render pose. */
  private resolvePose(v: TrafficVehicle): void {
    const e = roadNetwork.edges[v.edge];
    if (!e) return;
    const s = v.dir === 1 ? v.travel : e.length - v.travel;
    const sp = roadSurface(e, clampF(s, 0, e.length), v.lateral);
    v.x = sp.x;
    v.z = sp.z;
    v.y = sp.y + v.spec.wheelRadius * 0.02;
    const heading = v.dir === 1 ? Math.atan2(e.dz, e.dx) : Math.atan2(-e.dz, -e.dx);
    v.yaw = heading;
    // Pitch from the longitudinal grade, in the *travel* frame: a westbound car
    // on Filbert has its nose up when the eastbound tangent points down.
    v.pitch = Math.asin(clampF(sp.ty, -1, 1)) * (v.dir === 1 ? 1 : -1);
    v.roll = 0.02 * (v.lateral >= 0 ? 1 : -1) * (v.dir === 1 ? 1 : -1);
    // Body lean under acceleration and cornering — small, but its absence is
    // what makes traffic look like it is on rails.
    v.pitch += clampF(-v.accel * 0.012, -0.05, 0.05);
    v.roll += clampF(v.steer * v.speed * 0.006, -0.06, 0.06);
  }

  /* ---------------- damage, crashes, hijacking ---------------- */

  /** Apply damage. Returns true if the vehicle was destroyed by it. */
  damage(id: number, amount: number, now: number): boolean {
    const v = this.byId.get(id);
    if (!v || !v.alive) return false;
    v.health -= amount;
    v.damage = Math.min(1, v.damage + amount / 260);
    if (v.state === "drive" || v.state === "queue") {
      v.state = "panic";
      v.panicTimer = 5;
    }
    if (v.health <= 0) {
      this.destroy(v, now);
      return true;
    }
    return false;
  }

  /** Blow it up: chaos, noise, driver ejection, and a wreck left behind. */
  destroy(v: TrafficVehicle, now: number): void {
    if (!v.alive || v.state === "crashed") return;
    v.state = "crashed";
    v.damage = 1;
    v.speed = 0;
    v.sirenOn = false;
    emitNoise("explosion", v.x, v.y + 1, v.z, "civilian", v.id, 200, 1);
    this.ejectDriver(v);
    this.onVehicleDestroyed?.(v);
  }

  /** A driver panics into a wall. Less final than destruction. */
  private crash(v: TrafficVehicle, now: number, severity: number): void {
    v.state = "crashed";
    v.damage = Math.min(1, v.damage + 0.45 + severity * 0.3);
    v.speed *= 0.2;
    emitCrash(v.x, v.y + 1, v.z, severity);
    if (this.rng.chance(0.7)) this.ejectDriver(v);
  }

  private ejectDriver(v: TrafficVehicle): void {
    if (!v.hasDriver) return;
    v.hasDriver = false;
    v.state = v.state === "crashed" ? "crashed" : "abandoned";
    const side = this.rng.chance(0.5) ? 1 : -1;
    const ox = -Math.sin(v.yaw) * side * 1.6;
    const oz = Math.cos(v.yaw) * side * 1.6;
    this.onDriverEjected?.(v.x + ox, v.y, v.z + oz, ox, oz);
  }

  /* ---------------- the vehicles-system seam ---------------- */

  /**
   * Nearest hijackable vehicle within `radius` of a point, or −1.
   *
   * "Hijackable" excludes wrecks and anything already handed over. A moving
   * vehicle is fair game — being yanked out of a car doing 40 is the entire
   * point of the genre.
   */
  findHijackable(x: number, z: number, radius: number, maxSpeed = 40): number {
    let best = -1;
    let bestD2 = radius * radius;
    for (const v of this.vehicles) {
      if (!v.alive || v.state === "hijacked" || v.state === "crashed") continue;
      if (v.speed > maxSpeed) continue;
      const dx = v.x - x;
      const dz = v.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = v.id;
      }
    }
    return best;
  }

  /**
   * Hand a vehicle to the player's vehicle system. The traffic sim forgets it
   * completely — it is removed from the lane index, its junction claim is
   * released and its driver is thrown clear. Returns null if the id is stale.
   */
  hijack(id: number): HijackSnapshot | null {
    const v = this.byId.get(id);
    if (!v || !v.alive || v.state === "crashed") return null;
    const hadDriver = v.hasDriver;
    this.ejectDriver(v);
    v.state = "hijacked";
    if (v.claimed >= 0) {
      this.reservations.delete(v.claimed);
      v.claimed = -1;
    }
    const snap: HijackSnapshot = {
      id: v.id,
      kind: v.kind,
      x: v.x,
      y: v.y,
      z: v.z,
      yaw: v.yaw,
      speed: v.speed,
      color: linearToHex(v.r, v.g, v.b),
      hadDriver,
      emergency: v.emergency,
      health: Math.max(0, Math.min(1, v.health / (100 * v.spec.mass * 0.6 + 60))),
    };
    this.despawn(id);
    return snap;
  }

  /**
   * Give a vehicle back to the world — the player got out. It re-enters the sim
   * as an abandoned vehicle at the kerb rather than as live traffic, because a
   * car that drives away by itself the moment you step out is worse than one
   * that just sits there.
   */
  relinquish(snap: HijackSnapshot, now: number): TrafficVehicle | null {
    const v = this.spawnAt(snap.kind, snap.x, snap.z, now);
    if (!v) return null;
    v.state = "abandoned";
    v.hasDriver = false;
    v.speed = 0;
    v.damage = 1 - snap.health;
    return v;
  }

  /* ---------------- queries for other systems ---------------- */

  /** Visit every vehicle within `radius` of a point. Allocation-free. */
  forEachNear(x: number, z: number, radius: number, cb: (v: TrafficVehicle, d: number) => void): void {
    const r2 = radius * radius;
    for (const v of this.vehicles) {
      const dx = v.x - x;
      const dz = v.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= r2) cb(v, Math.sqrt(d2));
    }
  }

  /** Turn a vehicle into an emergency responder with its siren running. */
  setSiren(id: number, on: boolean): void {
    const v = this.byId.get(id);
    if (!v) return;
    v.sirenOn = on && v.emergency;
  }

  /** Chaos value of destroying this vehicle, for the score system. */
  chaosValue(v: TrafficVehicle): number {
    if (v.spec.mass > 8) return CHAOS.points.vehicle * 2.2;
    if (v.emergency) return CHAOS.points.vehicle * 1.6;
    return CHAOS.points.vehicle;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const _laneScratch: Lane[] = [];

/** Stable small integer per lane so the lane index key is cheap. */
function laneIndexOf(v: TrafficVehicle): number {
  if (!v.lane) return 0;
  const e = roadNetwork.edges[v.edge];
  if (!e) return 0;
  const lanes = travelLanes(e, v.dir, _laneScratch);
  const i = lanes.indexOf(v.lane);
  return i < 0 ? 0 : i;
}

function clampF(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** sRGB → linear, the exact transfer function three uses. */
function srgbToLinear(c: number): number {
  return c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  return c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function linearToHex(r: number, g: number, b: number): number {
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(linearToSrgb(v) * 255)));
  return (q(r) << 16) | (q(g) << 8) | q(b);
}

export const trafficSim = new TrafficSim();
