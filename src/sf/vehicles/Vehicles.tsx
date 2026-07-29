/**
 * Vehicles.tsx — the vehicle subsystem's one component.
 *
 * Mount it once inside the Canvas, after `<Player />`, and it owns everything:
 *
 *   <Vehicles />
 *
 * Responsibilities, in the order they run each frame:
 *
 *  1. **Streaming.** A deterministic kerbside spawner keeps the streets around
 *     the player parked-up. It reads street lines straight out of `sfGeo`'s
 *     grid — every parking bay is a hash of (grid, line, slot, side), so the
 *     same corner of Pacific Heights always has the same silver SUV on it, in
 *     the same place, at any quality tier and after any reload. That determinism
 *     is not a nicety; the screenshot harness depends on it.
 *  2. **Special spawns.** Boats in the marinas, helicopters on the real
 *     heliports, the aircraft on the old Crissy Field strip — placed at true
 *     lat/lon and streamed in when the player gets near.
 *  3. **The runtime.** `vehicleRuntime.update` steps damage, doors, fire, LOD
 *     and audio for everything alive.
 *  4. **The player.** Driving, then flight, then boats, then hijacking — in
 *     that order, because each later system only acts when the earlier ones
 *     have not claimed the frame.
 *  5. **Ambient rendering.** Everything that did not earn a hero rig is drawn
 *     through the AI traffic system's `VehicleBatch`: one instanced draw call
 *     per body style for the whole city. Pass your own batch in to share
 *     instances with the traffic renderer rather than allocating a second set.
 *
 * The component renders exactly one `<group>`: the parent that hero rigs are
 * attached to. Everything else is imperative, because a car is not a React
 * component and pretending otherwise costs a reconciliation pass per frame per
 * vehicle.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { QUALITY } from "../config";
import { frame, useSfStore } from "../state/store";
import {
  DISTRICTS,
  ROAD_HALF_WIDTH,
  WORLD,
  clampToWorld,
  districtAt,
  gridAt,
  isExcluded,
  isPark,
  isWater,
  latLonToWorld,
  landSDF,
  terrainHeight,
  terrainSlope,
  type GridSystem,
} from "../geo/sfGeo";
import { hashSeed, makeRng } from "../math/rng";
import { VehicleBatch } from "../ai/vehicleMeshes";
import type { TrafficVehicleKind } from "../ai/types";
import { boatSystem, installWaterSampler } from "./boats";
import { drivingSystem } from "./driving";
import { flightSystem } from "./flight";
import { hijackSystem } from "./hijack";
import { disposeVehicleAssets, originYFor, type VehicleKind } from "./models";
import { vehicleRuntime, type SpawnOptions, type VehicleInstance } from "./vehicle";

/* ================================================================== *
 * Ambient LOD mapping
 * ================================================================== *
 * The traffic batch knows thirteen body styles. Everything this module can
 * spawn maps onto one of them for its far-LOD silhouette; the handful that map
 * onto nothing (aircraft, boats) never lose their hero rig, so they never need
 * a stand-in.
 */
const BATCH_KIND: Partial<Record<VehicleKind, TrafficVehicleKind>> = {
  sedan: "sedan",
  sports: "sedan",
  taxi: "taxi",
  suv: "suv",
  pickup: "pickup",
  van: "van",
  boxtruck: "van",
  semi: "van",
  police: "police",
  swatvan: "swatvan",
  ambulance: "ambulance",
  firetruck: "firetruck",
  bus: "bus",
  cablecar: "cablecar",
  motorcycle: "hatchback",
};

/* ================================================================== *
 * Deterministic street parking
 * ================================================================== */

/** Distance between candidate parking slots, in blocks along a street line. */
const SLOT_STRIDE = 0.28;
/** How far out we keep parked cars, metres. */
const PARK_RADIUS = 260;
/** Max parked vehicles alive at once, before the quality multiplier. */
const PARK_BUDGET = 46;

/**
 * The kerbside vehicle mix.
 *
 * Weighted for a real American city, not for a game's idea of variety: mostly
 * saloons and crossovers, a fair number of pickups, and exactly enough oddities
 * that a street never looks stamped out.
 */
const PARK_MIX: [VehicleKind, number][] = [
  ["sedan", 30],
  ["suv", 22],
  ["pickup", 12],
  ["taxi", 6],
  ["van", 8],
  ["sports", 4],
  ["boxtruck", 4],
  ["motorcycle", 4],
  ["police", 2],
  ["ambulance", 1],
  ["firetruck", 1],
];
const PARK_TOTAL = PARK_MIX.reduce((a, b) => a + b[1], 0);

function pickParked(r: number): VehicleKind {
  let t = r * PARK_TOTAL;
  for (const [k, w] of PARK_MIX) {
    t -= w;
    if (t <= 0) return k;
  }
  return "sedan";
}

/**
 * Where a parking slot is, in world space.
 *
 * A grid's streets run along lines of constant u (spaced `spacingU` apart in
 * the u direction) and constant v. We only park on the constant-u lines — the
 * long ones — because that is where the kerb is in this grid and because
 * parking on both axes doubles the cost for no visible gain.
 */
function slotWorld(
  g: GridSystem,
  u: number,
  vAlong: number,
  side: number,
  halfWidth: number,
  out: { x: number; z: number },
): void {
  const c = Math.cos(g.angle);
  const s = Math.sin(g.angle);
  const su = u * g.spacingU;
  const sv = vAlong * g.spacingV;
  // Lateral offset is along the +u direction, which is (c, s) in world space.
  const off = side * (halfWidth - 1.6);
  out.x = g.originX + su * c - sv * s + c * off;
  out.z = g.originZ + su * s + sv * c + s * off;
}

/** Heading of a street line of constant u, as a vehicle yaw. */
function slotYaw(g: GridSystem, side: number): number {
  // The line runs along the +v direction, world (−sin θ, cos θ).
  const fx = -Math.sin(g.angle) * -side;
  const fz = Math.cos(g.angle) * -side;
  return Math.atan2(-fx, -fz);
}

/* ================================================================== *
 * Special spawns — real places, real coordinates
 * ================================================================== */

interface SpecialSpawn {
  key: string;
  kind: VehicleKind;
  lat: number;
  lon: number;
  /** Heading, radians. */
  yaw: number;
  /** Sits on the water rather than the ground. */
  water?: boolean;
}

const SPECIALS: SpecialSpawn[] = [
  // Marinas.
  { key: "pier39-a", kind: "speedboat", lat: 37.8093, lon: -122.4106, yaw: 1.2, water: true },
  { key: "pier39-b", kind: "jetski", lat: 37.8089, lon: -122.4098, yaw: 1.2, water: true },
  { key: "southbeach", kind: "speedboat", lat: 37.7818, lon: -122.3866, yaw: 2.4, water: true },
  { key: "marina-green", kind: "speedboat", lat: 37.8072, lon: -122.4432, yaw: -1.1, water: true },
  { key: "aquatic", kind: "jetski", lat: 37.8080, lon: -122.4218, yaw: 0.4, water: true },
  // Heliports. The Financial District pads are on the roofs; these are the
  // street-level ones you can actually reach on foot.
  { key: "heli-crissy", kind: "helicopter", lat: 37.8039, lon: -122.4620, yaw: 1.57 },
  { key: "heli-sfgh", kind: "helicopter", lat: 37.7556, lon: -122.4048, yaw: 0 },
  { key: "heli-pier", kind: "helicopter", lat: 37.7861, lon: -122.3872, yaw: 2.1 },
  { key: "heli-mil", kind: "gunship", lat: 37.8104, lon: -122.3690, yaw: 3.0 },
  // Crissy Field's old airstrip, which is exactly why it is flat and long.
  { key: "plane-crissy", kind: "aircraft", lat: 37.8043, lon: -122.4655, yaw: 1.57 },
];

/* ================================================================== *
 * Scratch
 * ================================================================== */

const _slot = { x: 0, z: 0 };
const _col = new THREE.Color();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();

/* ================================================================== *
 * The component
 * ================================================================== */

export interface VehiclesProps {
  /**
   * Share an existing instanced batch with the AI traffic renderer instead of
   * allocating a second one. When supplied, the *owner* is expected to call
   * `begin()`/`commit()`; set `ownsBatch` if this component should do it.
   */
  batch?: VehicleBatch;
  /** Call begin/commit on the supplied batch. Ignored when we allocate our own. */
  ownsBatch?: boolean;
  /** Populate kerbs with parked vehicles. Default true. */
  parked?: boolean;
  /** Stream in the marina boats, heliports and the airstrip. Default true. */
  special?: boolean;
  /** Attach real spot lights to the player's headlamps. Default true. */
  realHeadlights?: boolean;
  /** Multiplier on the parked-vehicle budget, on top of the quality tier. */
  density?: number;
}

export default function Vehicles({
  batch: sharedBatch,
  ownsBatch = false,
  parked = true,
  special = true,
  realHeadlights = true,
  density = 1,
}: VehiclesProps = {}) {
  const { scene } = useThree();
  const tier = useSfStore((s) => s.quality);
  const groupRef = useRef<THREE.Group>(null);

  /* ---- the ambient instanced batch ---- */
  const owned = useMemo(() => {
    if (sharedBatch) return null;
    // Small per-kind caps: this batch only ever draws what the hero pool could
    // not, which within `PARK_RADIUS` is a few dozen vehicles.
    return new VehicleBatch(
      { sedan: 40, suv: 28, taxi: 16, pickup: 20, van: 16, police: 10, hatchback: 12 },
      12,
    );
  }, [sharedBatch]);
  const batch = sharedBatch ?? owned;
  const driveBatch = sharedBatch ? ownsBatch : true;

  /* ---- streaming bookkeeping ---- */
  const state = useMemo(
    () => ({
      /** slot key → vehicle id, for everything this component spawned. */
      parkedIds: new Map<string, number>(),
      specialIds: new Map<string, number>(),
      streamTimer: 0,
      lastX: 1e9,
      lastZ: 1e9,
    }),
    [],
  );

  /* ---- mount ---- */
  // Attach once. Quality is a separate effect on purpose: rebuilding the whole
  // vehicle world because the player nudged a slider would despawn the car they
  // are sitting in.
  useEffect(() => {
    const g = groupRef.current ?? scene;
    vehicleRuntime.attach(g, tier);
    installWaterSampler();
    if (owned) scene.add(owned.group);
    return () => {
      // Hand the player back to the character controller before anything is
      // torn down, or unmounting mid-drive leaves `frame.vehicleId` pointing at
      // a vehicle that no longer exists and the capsule frozen in a seat.
      hijackSystem.cancel();
      if (drivingSystem.active) drivingSystem.exit(false);
      if (owned) {
        scene.remove(owned.group);
        owned.dispose();
      }
      boatSystem.dispose();
      flightSystem.dispose();
      vehicleRuntime.clear();
      state.parkedIds.clear();
      state.specialIds.clear();
      disposeVehicleAssets();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, owned, state]);

  useEffect(() => {
    vehicleRuntime.setQuality(tier);
  }, [tier]);

  useEffect(() => {
    vehicleRuntime.realHeadlights = realHeadlights;
  }, [realHeadlights]);

  /* ---- the frame ---- */
  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 20);
    const cam = frame.position;

    /* 1–2. streaming, at 4 Hz — nothing here changes fast enough to be worth
       doing every frame, and it touches a lot of memory. */
    state.streamTimer -= dt;
    const moved = Math.hypot(cam.x - state.lastX, cam.z - state.lastZ) > 24;
    if (!frame.paused && (state.streamTimer <= 0 || moved)) {
      state.streamTimer = 0.25;
      state.lastX = cam.x;
      state.lastZ = cam.z;
      if (parked) streamParked(state, cam.x, cam.z, tier, density);
      if (special) streamSpecial(state, cam.x, cam.z);
    }

    /* 3. the runtime */
    vehicleRuntime.update(dt, cam.x, cam.y, cam.z);

    /* 4. the player's systems, in precedence order */
    drivingSystem.update(dt);
    flightSystem.update(dt);
    boatSystem.update(dt);
    hijackSystem.update(dt);

    /* 5. ambient instanced draw */
    if (batch) {
      if (driveBatch) batch.begin();
      pushAmbient(batch);
      if (driveBatch) batch.commit();
    }
  });

  return <group ref={groupRef} name="sf-vehicles" />;
}

/* ================================================================== *
 * Streaming
 * ================================================================== */

interface StreamState {
  parkedIds: Map<string, number>;
  specialIds: Map<string, number>;
  streamTimer: number;
  lastX: number;
  lastZ: number;
}

/**
 * Keep the kerbs near the player populated.
 *
 * Walks the grid lines inside `PARK_RADIUS`, hashes each slot, and spawns or
 * releases to match. Slots are evaluated in a stable order and the budget is a
 * hard cut, so approaching a junction from either direction produces the same
 * set of cars.
 */
function streamParked(state: StreamState, cx: number, cz: number, tier: string, density: number): void {
  const q = QUALITY[tier as keyof typeof QUALITY] ?? QUALITY.high;
  const budget = Math.max(4, Math.round(PARK_BUDGET * q.crowdDensity * density));

  const g = gridAt(cx, cz);
  const c = Math.cos(-g.angle);
  const s = Math.sin(-g.angle);
  const du = ((cx - g.originX) * c - (cz - g.originZ) * s) / g.spacingU;
  const dv = ((cx - g.originX) * s + (cz - g.originZ) * c) / g.spacingV;

  const uSpan = Math.ceil(PARK_RADIUS / g.spacingU);
  const vSpan = Math.ceil(PARK_RADIUS / g.spacingV);

  const wanted = new Set<string>();
  let count = state.parkedIds.size;

  // Slot indices are integers anchored to the grid origin, never to the
  // player. Deriving them from the player's fractional block position — which
  // is what an earlier version did — meant the same kerb produced different
  // slot keys depending on where you were standing, and cars re-rolled
  // themselves as you walked. Determinism here is load-bearing: the screenshot
  // harness photographs the same street twice and expects the same cars.
  const uCentre = Math.round(du);
  const vCentre = Math.round(dv / SLOT_STRIDE);
  const vSteps = Math.ceil(vSpan / SLOT_STRIDE);

  for (let ui = -uSpan; ui <= uSpan; ui++) {
    const u = uCentre + ui;
    for (let vi = -vSteps; vi <= vSteps; vi++) {
      const vIndex = vCentre + vi;
      const vAlong = vIndex * SLOT_STRIDE;
      for (const side of [-1, 1] as const) {
        const key = `${g.name}:${u}:${vIndex}:${side}`;
        // One deterministic RNG per slot: occupancy, kind, colour and the
        // little parking jitter all come out of the same stream.
        const rng = makeRng(hashSeed(key));
        // Roughly one bay in three is occupied — a real street is not solid
        // metal, and gaps are what make the occupied ones read.
        if (rng.next() > 0.42) continue;

        slotWorld(g, u, vAlong, side, ROAD_HALF_WIDTH.street, _slot);
        const dx = _slot.x - cx;
        const dz = _slot.z - cz;
        if (dx * dx + dz * dz > PARK_RADIUS * PARK_RADIUS) continue;

        if (state.parkedIds.has(key)) {
          wanted.add(key);
          continue;
        }
        if (count >= budget) continue;
        if (!validParkingSpot(_slot.x, _slot.z)) continue;

        const kind = pickParked(rng.next());
        // Nudge along the kerb so a street is not a metronome.
        const jitterAlong = rng.range(-6, 6);
        const yaw = slotYaw(g, side);
        const jx = -Math.sin(g.angle) * jitterAlong;
        const jz = Math.cos(g.angle) * jitterAlong;
        const x = _slot.x + jx;
        const z = _slot.z + jz;
        if (!validParkingSpot(x, z)) continue;

        const opts: SpawnOptions = {
          kind,
          x,
          y: terrainHeight(x, z) + 0.6,
          z,
          yaw: yaw + rng.range(-0.05, 0.05),
          seed: key,
          faction: kind === "police" || kind === "swatvan" ? "police" : "civilian",
          locked: rng.next() < 0.55,
          running: false,
        };
        const v = vehicleRuntime.spawn(opts);
        state.parkedIds.set(key, v.id);
        wanted.add(key);
        count++;
      }
    }
  }

  // Release anything that fell out of range, unless the player has adopted it.
  for (const [key, id] of state.parkedIds) {
    if (wanted.has(key)) continue;
    const v = vehicleRuntime.get(id);
    if (v && (v.persistent || v.driverIsPlayer)) {
      state.parkedIds.delete(key);
      continue;
    }
    if (v) vehicleRuntime.despawn(id);
    state.parkedIds.delete(key);
  }
}

/**
 * Is this a place a car could actually be parked?
 *
 * Water, parks, exclusion zones and anything steep enough that a parked car
 * would roll away are all rejected. The slope test matters more here than
 * anywhere else in the game: San Francisco has streets at 31%, and a car
 * spawned on one without its wheels cut will end up in the bay.
 */
function validParkingSpot(x: number, z: number): boolean {
  if (x < WORLD.minX + 40 || x > WORLD.maxX - 40 || z < WORLD.minZ + 40 || z > WORLD.maxZ - 40) return false;
  if (isWater(x, z)) return false;
  if (landSDF(x, z) > -6) return false;
  if (isExcluded(x, z)) return false;
  if (isPark(x, z)) return false;
  if (terrainHeight(x, z) < WORLD.seaLevel + 0.6) return false;
  // 45% is beyond anything real; above that we are on a hillside, not a street.
  if (terrainSlope(x, z) > 0.45) return false;
  // Only park where there is something to park in front of.
  const d = districtAt(x, z);
  return d.density > 0.12;
}

/** Boats, helicopters and the aeroplane, streamed by proximity. */
function streamSpecial(state: StreamState, cx: number, cz: number): void {
  const RANGE = 900;
  for (const sp of SPECIALS) {
    const p = latLonToWorld(sp.lat, sp.lon);
    const c = clampToWorld(p.x, p.z);
    const d = Math.hypot(c.x - cx, c.z - cz);
    const have = state.specialIds.get(sp.key);

    if (d < RANGE) {
      if (have !== undefined && vehicleRuntime.get(have)) continue;
      const y = sp.water
        ? WORLD.seaLevel + 0.4
        : terrainHeight(c.x, c.z) + 1.2;
      // A water spawn that has silted up (the coastline is procedural and can
      // move) is skipped rather than beached on a mudbank at level load.
      if (sp.water && landSDF(c.x, c.z) > -4) continue;
      const v = vehicleRuntime.spawn({
        kind: sp.kind,
        x: c.x,
        y,
        z: c.z,
        yaw: sp.yaw,
        seed: sp.key,
        faction: sp.kind === "gunship" ? "military" : "civilian",
        persistent: false,
        running: false,
      });
      if (sp.kind === "aircraft") flightSystem.attachAero(v);
      state.specialIds.set(sp.key, v.id);
    } else if (have !== undefined) {
      const v = vehicleRuntime.get(have);
      if (v && !v.driverIsPlayer && !v.persistent) vehicleRuntime.despawn(have);
      if (!v || !v.driverIsPlayer) state.specialIds.delete(sp.key);
    }
  }
}

/* ================================================================== *
 * Ambient instanced rendering
 * ================================================================== */

/**
 * Draw everything that did not get a hero rig.
 *
 * The traffic batch's models are authored with **+X forward** and their origin
 * on the road surface; ours are **−Z forward** with the origin at the chassis
 * centre. Both conversions happen here, once, rather than being smeared through
 * two coordinate conventions in twenty files.
 */
function pushAmbient(batch: VehicleBatch): void {
  for (const v of vehicleRuntime.vehicles) {
    if (!v.ready || v.model) continue;
    const kind = BATCH_KIND[v.kind];
    if (!kind) continue;

    _fwd.set(0, 0, -1).applyQuaternion(v.quaternion);
    _up.set(0, 1, 0).applyQuaternion(v.quaternion);
    _right.set(1, 0, 0).applyQuaternion(v.quaternion);

    // Their nose is +X: a vertex at (1,0,0) lands on (cos y, sin y).
    const yaw = Math.atan2(_fwd.z, _fwd.x);
    // Nose up is positive pitch. Positive roll leans *left*, because with +X
    // forward and +Y up their +Z points to the driver's left.
    const pitch = Math.asin(Math.max(-1, Math.min(1, _fwd.y)));
    const roll = Math.atan2(_right.y, Math.max(1e-4, _up.y));

    _col.setHex(v.paint).convertSRGBToLinear();

    const spin = v.car ? v.car.wheels[0]?.spin ?? 0 : 0;
    const steer = v.car ? v.car.wheels[0]?.steer ?? 0 : 0;

    batch.push(
      kind,
      v.position.x,
      v.position.y - chassisDrop(v),
      v.position.z,
      yaw,
      pitch,
      roll,
      spin,
      steer,
      v.lights.brake,
      v.lights.siren > 0.01 ? frame.time * 2.6 + v.seed * 7 : 0,
      _col.r,
      _col.g,
      _col.b,
      v.damage01,
      v.lights.head,
      v.seed,
    );
  }
}

/**
 * How far below the body origin the road surface is.
 *
 * The instanced meshes are authored from the ground up; ours from the chassis
 * collider centre. `chassisMetrics` is the single definition of where that
 * centre sits, so reusing it here is what stops the far-LOD traffic from
 * floating six inches above the tarmac — the classic version of this bug.
 */
function chassisDrop(v: VehicleInstance): number {
  return originYFor(v.def);
}

/* ================================================================== *
 * Integration helpers
 * ================================================================== */

/**
 * Promote an AI traffic vehicle into a real, simulated one.
 *
 * The traffic sim runs kinematic cars on a graph — cheap, and correct for
 * anything the player is not touching. The moment they *are* touched (hijacked,
 * shot, rammed) they need a rigid body and a damage model. Call this with the
 * traffic vehicle's pose, despawn it from the traffic sim, and hand the
 * returned id to `drivingSystem.enter()`.
 */
export function promoteToSimulated(
  kind: VehicleKind,
  x: number,
  y: number,
  z: number,
  yaw: number,
  opts: Partial<SpawnOptions> = {},
): VehicleInstance {
  return vehicleRuntime.spawn({
    kind,
    x,
    y,
    z,
    yaw,
    running: true,
    persistent: true,
    ...opts,
  });
}

/** Which of our kinds a traffic body style corresponds to, for promotion. */
export const KIND_FROM_TRAFFIC: Record<TrafficVehicleKind, VehicleKind> = {
  sedan: "sedan",
  hatchback: "sedan",
  suv: "suv",
  taxi: "taxi",
  van: "van",
  pickup: "pickup",
  bus: "bus",
  cablecar: "cablecar",
  police: "police",
  swatvan: "swatvan",
  ambulance: "ambulance",
  firetruck: "firetruck",
  apc: "swatvan",
};

/** Districts, exported so a mission script can bias spawns by neighbourhood. */
export { DISTRICTS as VEHICLE_DISTRICTS };
