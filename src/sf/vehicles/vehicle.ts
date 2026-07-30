/**
 * vehicle.ts — the vehicle runtime.
 *
 * Everything that turns a mesh and a rigid body into a *thing in the world*:
 * spawning and despawning against a budget, binding to the right physics
 * model, accumulating damage, cooking off fuel tanks, opening doors, carrying
 * passengers, and dying properly.
 *
 * Three deliberate design decisions worth stating up front.
 *
 * **The physics model is chosen by class, not by kind.** Cars, trucks, buses,
 * bikes and the cable car all get `physics.Vehicle` (raycast chassis + the
 * Pacejka drivetrain). Helicopters and gunships get `physics.Helicopter`.
 * Boats get `physics.Boat`. Aircraft get a `Vehicle` for their landing gear
 * with the aerodynamics bolted on by `flight.ts` — which is why a plane can
 * taxi to the end of Crissy Field and then take off, rather than being a
 * helicopter with wings drawn on.
 *
 * **Damage is spatial.** A vehicle is not a health bar; it is a small set of
 * components with positions. Shoot the engine and it smokes and loses power.
 * Shoot a tyre and it goes flat and pulls to one side. Shoot the fuel tank and
 * you get about a second and a half of warning before you do not have a car any
 * more. This is the difference between "vehicles explode" and "vehicles are
 * worth shooting at".
 *
 * **The hero model is a rented resource.** Full rigs are expensive (a dozen
 * draw calls each). A small pool of them is handed to whichever vehicles are
 * closest to the camera; everything else is drawn by the shared instanced
 * batch in `Vehicles.tsx`. Attaching and detaching is cheap because the
 * geometry is cached and only the paint shell is cloned.
 *
 * Public API
 * ----------
 *   vehicleRuntime                    the singleton registry
 *   .spawn(opts) / .despawn(id) / .get(id) / .clear()
 *   .update(dt, camX, camY, camZ)     call once per rendered frame
 *   .hit(id, x, y, z, damage, kind)   the weapon stack's entry point
 *   .nearest(x, y, z, radius, filter)
 *   VehicleInstance                   one live vehicle
 *   enableVehicleAudio() / setVehicleAudioVolume()
 */
import * as THREE from "three";
import type * as RAPIER from "@dimforge/rapier3d-compat";
import { CHAOS, QUALITY, type QualityTier } from "../config";
import { frame, useSfStore } from "../state/store";
import { isPark, isRoad, isWater, terrainHeight, WORLD } from "../geo/sfGeo";
import { clamp01, damp, makeRng, type Rng } from "../math/rng";
import {
  Boat,
  Helicopter,
  Vehicle as PhysVehicle,
  objectForColliderHandle,
  onContactForce,
  physics,
  sampleTransform,
  type PhysicsObject,
} from "@/sf/physics";
import {
  emitExhaust,
  emitTyreSmoke,
  fire,
  igniteFire,
  registerFlammable,
  spawnExplosion,
  spawnDebrisBurst,
  oilDecal,
  tyreMarkDecal,
} from "@/sf/vfx";
import {
  VEHICLE_DEFS,
  buildVehicleModel,
  originYFor,
  paintFor,
  toPhysicsSpec,
  type LampState,
  type VehicleDef,
  type VehicleKind,
  type VehicleModel,
  type WheelVisual,
} from "./models";

/* ================================================================== *
 * Types
 * ================================================================== */

export type VehicleFaction = "civilian" | "police" | "military" | "cartel" | "player";

export interface SpawnOptions {
  kind: VehicleKind;
  x: number;
  y: number;
  z: number;
  /** Heading, radians. 0 faces −Z (north-ish in world space). */
  yaw?: number;
  paint?: number;
  /** Stable seed; the same seed always produces the same car. */
  seed?: string | number;
  faction?: VehicleFaction;
  /** Locked vehicles must be broken into before they can be hijacked. */
  locked?: boolean;
  /** Never despawned by the distance policy — mission and player vehicles. */
  persistent?: boolean;
  /** Force a hero rig regardless of distance. */
  hero?: boolean;
  /** How many AI occupants to seed. Clamped to the seat count. */
  occupants?: number;
  /** Start with the engine running (traffic) or cold (parked). */
  running?: boolean;
}

export interface Passenger {
  seat: number;
  faction: VehicleFaction;
  alive: boolean;
  /** AI entity id, if the AI layer has adopted this occupant. */
  entityId: number;
}

/** A discrete component that can be shot out independently. */
interface Component {
  /** Local-space centre. */
  x: number;
  y: number;
  z: number;
  radius: number;
  /** 1 = intact, 0 = destroyed. */
  health: number;
}

export type DamageKind = "bullet" | "explosion" | "collision" | "fire" | "melee";

/**
 * Engine archetypes, for whatever is synthesising the sound.
 *
 * Deliberately a plain string rather than an import from the audio module: the
 * vehicle layer must not fail to compile because the mixer is mid-rewrite, and
 * "what kind of engine is this" is a stable enough concept to name in prose.
 * The strings match `audio/vehicleSounds.ts`'s archetype set.
 */
export type EngineArchetype =
  | "sedan" | "sports" | "muscle" | "truck" | "bus"
  | "police" | "motorcycle" | "electric" | "helicopter";

export const ENGINE_ARCHETYPE: Record<VehicleKind, EngineArchetype> = {
  sedan: "sedan",
  taxi: "sedan",
  suv: "truck",
  sports: "sports",
  pickup: "muscle",
  van: "truck",
  boxtruck: "truck",
  semi: "truck",
  police: "police",
  swatvan: "truck",
  ambulance: "truck",
  firetruck: "truck",
  bus: "bus",
  cablecar: "electric",
  motorcycle: "motorcycle",
  helicopter: "helicopter",
  gunship: "helicopter",
  aircraft: "helicopter",
  speedboat: "muscle",
  jetski: "motorcycle",
};

/** What the tyres are rolling on. Matches the mixer's surface set. */
export type RoadSurfaceTag =
  | "asphalt" | "concrete" | "gravel" | "dirt" | "grass" | "sand" | "water" | "metal";

/**
 * One frame of a vehicle's acoustic state.
 *
 * The field names are chosen to match `audio/vehicleSounds.ts`'s
 * `VehicleAudioState` exactly, so wiring a mixer in is a pass-through rather
 * than a translation layer:
 *
 *   vehicleRuntime.onAudio = (f) => sfAudio.updateVehicle(f.id, f.archetype, f, f.dt);
 *   vehicleRuntime.onAudioRelease = (id) => sfAudio.releaseVehicle(id);
 *
 * The struct is reused between calls — copy what you need, do not retain it.
 */
export interface EngineAudioFrame {
  id: number;
  kind: VehicleKind;
  archetype: EngineArchetype;
  dt: number;

  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Unit forward vector, for the exhaust cone. */
  fx: number;
  fy: number;
  fz: number;

  rpm: number;
  /** 0..1 pedal. */
  throttle: number;
  /** 0..1 how hard the engine is actually working. */
  load: number;
  gear: number;
  /** Signed ground speed, m/s. */
  speed: number;
  /** 0..1 peak wheel slip — the skid layer. */
  slip: number;
  grounded: boolean;
  surface: RoadSurfaceTag;
  /** 0..1 suspension impulse this frame — fires a knock. */
  suspension: number;
  /** 0..1 collision impulse this frame. */
  impact: number;
  /** 0..1 helicopter collective / aircraft throttle. */
  collective: number;

  /** true on the frame a gear change fires. */
  shifted: boolean;
  running: boolean;
  siren: number;
  horn: number;
  /** 0..1 rotor/prop speed. */
  rotor: number;
  /** Distance to the listener, metres. */
  distance: number;
}

/* ================================================================== *
 * Scratch — nothing in this module allocates per frame.
 * ================================================================== */

const _pose = new Float32Array(7);
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _local = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const _lamp: LampState = { head: 0, brake: 0, reverse: 0, indicator: 0, siren: 0, highBeam: 0 };
const _wheelVis: WheelVisual = { suspension: 0, spin: 0, steer: 0, flat: 0 };
const _audioFrame: EngineAudioFrame = {
  id: 0, kind: "sedan", archetype: "sedan", dt: 1 / 60,
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, fx: 0, fy: 0, fz: -1,
  rpm: 0, throttle: 0, load: 0, gear: 1, speed: 0, slip: 0,
  grounded: false, surface: "asphalt", suspension: 0, impact: 0, collective: 0,
  shifted: false, running: false, siren: 0, horn: 0, rotor: 0, distance: 0,
};

let nextVehicleId = 1;

/* ================================================================== *
 * One vehicle
 * ================================================================== */

export class VehicleInstance {
  readonly id: number;
  readonly kind: VehicleKind;
  readonly def: VehicleDef;
  readonly faction: VehicleFaction;
  readonly rng: Rng;
  readonly paint: number;
  readonly seed: number;

  /* ---- physics bindings; exactly one of these is non-null ---- */
  car: PhysVehicle | null = null;
  boat: Boat | null = null;
  heli: Helicopter | null = null;

  /** Hero rig, present only while this vehicle holds a model slot. */
  model: VehicleModel | null = null;

  /* ---- lifecycle ---- */
  alive = true;
  persistent: boolean;
  locked: boolean;
  spawnedAt = 0;
  /** Set once the physics body actually exists (Rapier may not have booted). */
  ready = false;
  private wantX = 0;
  private wantY = 0;
  private wantZ = 0;
  private wantYaw = 0;

  /* ---- condition ---- */
  /** Remaining structural damage points. */
  health: number;
  readonly maxHealth: number;
  /** 0 = pristine, 1 = scrap. Drives paint, power loss and handling. */
  damage01 = 0;
  engine: Component;
  tanks: Component[] = [];
  /** Per-wheel tyre condition, 1 = good. */
  tyres: Float32Array;
  wrecked = false;
  burning = false;
  private fireSlot = -1;
  private cookOff = -1;
  private unregisterFlammables: (() => void)[] = [];
  /** Seconds since the wreck, for the despawn timer. */
  private wreckAge = 0;

  /* ---- fit-out ---- */
  fuel: number;
  readonly fuelCapacity: number;
  running: boolean;
  /** 0..1 per door, damped toward `doorTarget`. */
  readonly doorOpen: Float32Array;
  readonly doorTarget: Float32Array;
  passengers: Passenger[] = [];
  /** Occupied seats — index 0 is the driver. */
  driverIsPlayer = false;

  /* ---- presentation state, written by driving/flight/boats ---- */
  readonly lights: LampState = { head: 0, brake: 0, reverse: 0, indicator: 0, siren: 0, highBeam: 0 };
  horn = 0;
  /** Rotor/prop angle accumulators. */
  rotorAngle = 0;
  tailRotorAngle = 0;
  rotorSpeed = 0;

  /* ---- cached pose, world space ---- */
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  /** Signed forward speed, m/s. */
  speed = 0;
  /** Distance to the render camera, updated once per frame. */
  distance = 1e9;

  /**
   * Range inside which this vehicle deserves a full rig.
   *
   * A parked hatchback stops being worth twelve draw calls at ninety metres.
   * A helicopter a kilometre up is still the most interesting thing on screen,
   * and there is no instanced stand-in for it, so aircraft and boats keep their
   * rigs far beyond the point where a car would have lost one.
   */
  get heroRadius(): number {
    switch (this.def.klass) {
      case "heli":
      case "plane":
        return 1600;
      case "boat":
        return 520;
      case "rail":
        return 220;
      default:
        return 95;
    }
  }

  /** True for classes with no instanced fallback — they must keep a rig. */
  get needsModel(): boolean {
    const k = this.def.klass;
    return k === "heli" || k === "plane" || k === "boat";
  }

  /** 0..1 collision impulse this frame; decays. Read by the audio frame. */
  impactPulse = 0;
  /** 0..1 suspension knock this frame; from real per-step travel. */
  suspensionPulse = 0;
  /** True on the frame the gearbox changed ratio. */
  shifted = false;
  private prevSuspension: Float32Array | null = null;
  private lastGear = 1;
  private exhaustAcc = 0;
  private skidAcc = 0;
  private smokeAcc = 0;
  private brakeHeat = 0;

  constructor(opts: SpawnOptions) {
    this.id = nextVehicleId++;
    this.kind = opts.kind;
    this.def = VEHICLE_DEFS[opts.kind];
    this.faction = opts.faction ?? "civilian";
    this.persistent = opts.persistent ?? false;
    this.locked = opts.locked ?? false;
    this.rng = makeRng(opts.seed ?? `veh-${this.id}`);
    this.seed = this.rng.next();
    this.paint = opts.paint ?? paintFor(opts.kind, this.rng);
    this.maxHealth = this.def.integrity;
    this.health = this.maxHealth;
    this.fuelCapacity = Math.max(1, this.def.fuel);
    this.fuel = this.fuelCapacity * this.rng.range(0.35, 1);
    this.running = opts.running ?? false;
    this.doorOpen = new Float32Array(this.def.doors.length);
    this.doorTarget = new Float32Array(this.def.doors.length);
    this.tyres = new Float32Array(16).fill(1);

    const d = this.def;
    this.engine =
      d.klass === "heli" || d.klass === "plane"
        ? { x: 0, y: d.beltline, z: d.cabinRearZ, radius: 0.8, health: 1 }
        : { x: 0, y: d.bonnet - 0.2, z: d.frontZ - 0.1, radius: 0.7, health: 1 };
    for (const t of d.fuelTanks) {
      this.tanks.push({ x: t.x, y: t.y, z: t.z, radius: t.radius, health: 1 });
    }

    this.wantX = opts.x;
    this.wantY = opts.y;
    this.wantZ = opts.z;
    this.wantYaw = opts.yaw ?? 0;
    this.position.set(opts.x, opts.y, opts.z);
    this.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.wantYaw);

    const n = Math.min(opts.occupants ?? 0, d.seats.length);
    for (let i = 0; i < n; i++) {
      this.passengers.push({ seat: i, faction: this.faction, alive: true, entityId: 0 });
    }
  }

  /* ---------------- physics ---------------- */

  /**
   * Create the rigid body. Returns false until Rapier has booted, and the
   * runtime keeps retrying — spawning into a world that does not exist yet is
   * the normal case on the first two or three frames of a level.
   */
  tryCreate(): boolean {
    if (this.ready) return true;
    const d = this.def;
    // Never spawn a wheeled vehicle below the road surface; the streets are
    // generated procedurally and a metre of error puts a car in the pavement.
    if (d.klass !== "boat") {
      const g = terrainHeight(this.wantX, this.wantZ);
      if (this.wantY < g + 0.2) this.wantY = g + originYFor(d) + 0.25;
    } else {
      this.wantY = Math.max(this.wantY, WORLD.seaLevel + d.hullDraft * 0.2);
    }

    if (d.klass === "boat") {
      const m = toPhysicsSpec(d);
      const b = new Boat(m.hx, m.hy, m.hz, d.mass, d.mass * 12, d.mass * 3.4);
      if (!b.spawn(this.wantX, this.wantY, this.wantZ, this.wantYaw)) return false;
      this.boat = b;
    } else if (d.klass === "heli") {
      const h = new Helicopter({
        mass: d.mass,
        hx: d.width * 0.5,
        hy: (d.roof - d.clearance) * 0.5,
        hz: d.length * 0.34,
        rotorRadius: d.rotorRadius,
        thrustRatio: d.kind === "gunship" ? 2.25 : 2.05,
        cyclicTorque: d.mass * 15,
        yawTorque: d.mass * 6,
        rotorRpm: 394,
        dragArea: 0.5 * 1.225 * 0.9 * (d.width * d.height * 0.8),
      });
      if (!h.spawn(this.wantX, this.wantY, this.wantZ, this.wantYaw)) return false;
      this.heli = h;
    } else {
      const v = new PhysVehicle(toPhysicsSpec(d));
      if (!v.spawn(this.wantX, this.wantY, this.wantZ, this.wantYaw)) return false;
      this.car = v;
    }

    this.ready = true;
    this.spawnedAt = physics.simTime;
    // Fuel tanks are flammables so a pool fire under the car cooks it off, and
    // so a burning car parked next to another one is a genuine hazard.
    for (const t of this.def.fuelTanks) {
      this.unregisterFlammables.push(
        registerFlammable(this.position.x, this.position.y, this.position.z, {
          radius: t.radius * 3.4,
          duration: 6,
          susceptibility: 0.85,
          onIgnite: () => this.ignite(),
        }),
      );
    }
    return true;
  }

  get physObject(): PhysicsObject | null {
    return this.car?.object ?? this.boat?.object ?? this.heli?.object ?? null;
  }

  get body(): RAPIER.RigidBody | null {
    return this.car?.body ?? this.boat?.body ?? this.heli?.body ?? null;
  }

  /* ---------------- per-frame ---------------- */

  /** Read the interpolated transform out of the physics world. */
  syncPose(): void {
    const obj = this.physObject;
    if (!obj) return;
    if (sampleTransform(obj, _pose)) {
      this.position.set(_pose[0], _pose[1], _pose[2]);
      this.quaternion.set(_pose[3], _pose[4], _pose[5], _pose[6]);
    }
    const b = this.body;
    if (b && b.isValid()) {
      const lv = b.linvel();
      this.velocity.set(lv.x, lv.y, lv.z);
    }
    this.speed = this.car ? this.car.speed : this.forwardSpeed();
  }

  /** Signed speed along the vehicle's own nose direction. */
  forwardSpeed(): number {
    _v.set(0, 0, -1).applyQuaternion(this.quaternion);
    return this.velocity.dot(_v);
  }

  /** World position of a local-space point. */
  localToWorld(lx: number, ly: number, lz: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(lx, ly, lz).applyQuaternion(this.quaternion).add(this.position);
  }

  /** World → local, without touching the scene graph. */
  worldToLocal(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    _q.copy(this.quaternion).invert();
    return out.set(x - this.position.x, y - this.position.y, z - this.position.z).applyQuaternion(_q);
  }

  /**
   * One frame of presentation: wheels, lamps, doors, exhaust, tyre smoke,
   * fuel burn and the fire that eventually kills it.
   */
  update(dt: number, camX: number, camY: number, camZ: number): void {
    if (!this.ready) return;
    this.syncPose();
    this.distance = Math.hypot(this.position.x - camX, this.position.y - camY, this.position.z - camZ);

    /* ---- fuel ------------------------------------------------- */
    if (this.running && this.fuel > 0 && this.def.fuel > 0) {
      const load = this.car ? this.car.load : this.heli ? this.heli.input.collective : 0.4;
      // Roughly litres/hour → litres/second, scaled by mass. A saloon idles at
      // ~1 l/h and drinks ~22 l/h flat out, which is about right.
      const burn = (0.0004 + load * 0.006) * (this.def.mass / 1500);
      this.fuel = Math.max(0, this.fuel - burn * dt * (1 + this.leakRate() * 40));
      if (this.fuel <= 0) this.stall();
    }

    /* ---- transients ------------------------------------------- */
    // Suspension knock: the largest single-frame change in any strut's length.
    // Taken from the solver's measured travel rather than from the body's
    // vertical velocity, so a single wheel dropping into a pothole knocks and
    // the whole car landing flat thumps.
    if (this.car) {
      const n = this.car.wheels.length;
      if (!this.prevSuspension || this.prevSuspension.length !== n) {
        this.prevSuspension = new Float32Array(n);
        for (let i = 0; i < n; i++) this.prevSuspension[i] = this.car.wheels[i].suspension;
      }
      let peak = 0;
      for (let i = 0; i < n; i++) {
        const d = this.prevSuspension[i] - this.car.wheels[i].suspension;
        if (d > peak) peak = d;
        this.prevSuspension[i] = this.car.wheels[i].suspension;
      }
      // A 6 cm compression in one frame is a solid hit.
      this.suspensionPulse = clamp01(peak / 0.06);
      this.shifted = this.car.gear !== this.lastGear;
      this.lastGear = this.car.gear;
    } else {
      this.suspensionPulse = 0;
      this.shifted = false;
    }
    this.impactPulse = Math.max(0, this.impactPulse - dt * 6);

    /* ---- doors ------------------------------------------------ */
    for (let i = 0; i < this.doorOpen.length; i++) {
      this.doorOpen[i] = damp(this.doorOpen[i], this.doorTarget[i], 7, dt);
    }

    /* ---- damage-driven systems -------------------------------- */
    this.updateSmokeAndFire(dt);

    /* ---- lamps ------------------------------------------------ */
    // Headlights come on with the light level, and always for emergency
    // vehicles, because a black-and-white with its lights off at night is a
    // pedestrian-flattening machine the player cannot see coming.
    const night = frame.timeOfDay < 7.2 || frame.timeOfDay > 18.4 || frame.fogDensity > 0.62;
    if (this.running) {
      this.lights.head = Math.max(this.lights.head, night ? 1 : 0.16);
    } else {
      this.lights.head = 0;
    }
    if (this.wrecked) {
      this.lights.head = 0;
      this.lights.brake = 0;
      this.lights.siren = 0;
    }

    /* ---- exhaust + tyre effects (only when anyone can see them) */
    if (this.distance < 90 && !frame.paused) this.emitEffects(dt);

    /* ---- the hero rig ----------------------------------------- */
    if (this.model) this.driveModel(dt);
  }

  private driveModel(dt: number): void {
    const m = this.model!;
    m.root.position.copy(this.position);
    m.root.quaternion.copy(this.quaternion);

    if (this.car) {
      const n = Math.min(m.wheelCount, this.car.wheels.length);
      for (let i = 0; i < n; i++) {
        const w = this.car.wheels[i];
        _wheelVis.suspension = w.suspension;
        _wheelVis.spin = w.spin;
        _wheelVis.steer = w.steer;
        _wheelVis.flat = 1 - this.tyres[i];
        m.setWheel(i, _wheelVis);
      }
    } else if (this.heli || this.def.klass === "plane") {
      for (let i = 0; i < m.wheelCount; i++) {
        _wheelVis.suspension = this.def.suspension;
        _wheelVis.spin = 0;
        _wheelVis.steer = 0;
        _wheelVis.flat = 0;
        m.setWheel(i, _wheelVis);
      }
    }

    if (this.def.rotorRadius > 0 || this.def.propRadius > 0) {
      const rate = this.heli ? this.heli.rotorSpeed * 41 : this.rotorSpeed * 130;
      this.rotorAngle = (this.rotorAngle + rate * dt) % (Math.PI * 2);
      this.tailRotorAngle = (this.tailRotorAngle + rate * 5 * dt) % (Math.PI * 2);
      m.setRotors(this.rotorAngle, this.tailRotorAngle, 0);
    }

    _lamp.head = this.lights.head;
    _lamp.brake = this.lights.brake;
    _lamp.reverse = this.lights.reverse;
    _lamp.indicator = this.lights.indicator;
    _lamp.siren = this.lights.siren;
    _lamp.highBeam = this.lights.highBeam;
    m.setLights(_lamp, dt);

    for (let i = 0; i < this.doorOpen.length; i++) m.setDoor(i, this.doorOpen[i]);

    m.setDamage({
      integrity01: this.damage01,
      burn: this.wrecked ? 1 : clamp01((this.damage01 - 0.7) * 3),
      wet: 0,
      grime: 0.2 + this.damage01 * 0.5,
    });
  }

  /**
   * Exhaust, tyre smoke and skid marks.
   *
   * Rate-limited by accumulators rather than emitted every frame: particles are
   * a budget, and a hundred cars each emitting one puff a frame is how you
   * spend the whole budget on smoke nobody looks at.
   */
  private emitEffects(dt: number): void {
    const d = this.def;
    if (this.running && d.fuel > 0 && !this.wrecked) {
      this.exhaustAcc += dt * (2 + (this.car ? this.car.load * 8 : 2));
      if (this.exhaustAcc > 1) {
        this.exhaustAcc = 0;
        const ex = d.klass === "truck" || d.klass === "bus" ? 0 : d.width * 0.3;
        this.localToWorld(ex, d.clearance + 0.08 - this.originY(), d.length * 0.5 + 0.06, _v);
        _v2.set(0, 0, 1).applyQuaternion(this.quaternion);
        const cold = frame.timeOfDay < 8.5 && frame.time < 240;
        emitExhaust(_v.x, _v.y, _v.z, _v2.x, _v2.z, this.car ? this.car.load : 0.3, cold,
          d.mass > 3000);
      }
    }

    // Tyre smoke and rubber: only where a wheel is actually sliding.
    if (this.car && this.car.grounded) {
      let peak = 0;
      for (let i = 0; i < this.car.wheels.length; i++) {
        const w = this.car.wheels[i];
        if (!w.grounded) continue;
        const slip = Math.max(w.slip, (1 - this.tyres[i]) * 0.9);
        if (slip < 0.55) continue;
        peak = Math.max(peak, slip);
        this.skidAcc += dt * slip * 26;
        if (this.skidAcc > 1) {
          this.skidAcc = 0;
          emitTyreSmoke(w.px, w.py, w.pz, slip);
          if (slip > 0.9) {
            _v2.set(0, 0, -1).applyQuaternion(this.quaternion);
            tyreMarkDecal(
              w.px, w.py + 0.02, w.pz,
              Math.atan2(_v2.x, _v2.z),
              d.wheelWidth * 1.2,
              1.6,
              clamp01(slip),
            );
          }
        }
      }
      // Brake fade: heat builds under braking and bleeds off with airflow.
      // On a 30% Nob Hill grade a heavy vehicle can genuinely cook its brakes,
      // and it should be able to here too.
      const braking = this.car.input.brake;
      this.brakeHeat = clamp01(
        this.brakeHeat + (braking * Math.abs(this.speed) * 0.0022 - 0.14 * dt) * dt * 10,
      );
      this.car.damage = Math.max(this.damage01, this.brakeHeat * 0.35);
      void peak;
    }
  }

  /** Height of the chassis centre above the road — the authoring offset. */
  private originY(): number {
    return originYFor(this.def);
  }

  /* ---------------- damage ---------------- */

  /** 0..1 how fast fuel is pouring out of a punctured tank. */
  private leakRate(): number {
    let worst = 0;
    for (const t of this.tanks) worst = Math.max(worst, 1 - t.health);
    return worst;
  }

  /**
   * Take a hit at a world-space point.
   *
   * Component hits are resolved first and multiply the damage: a round through
   * the tank is worth six through a door. Returns the damage actually applied,
   * so the weapon layer can show a hit marker only when it did something.
   */
  hit(x: number, y: number, z: number, amount: number, kind: DamageKind = "bullet"): number {
    if (!this.alive || this.wrecked) return 0;
    this.worldToLocal(x, y, z, _local);

    let mult = 1;
    let hitTank = false;

    // Fuel tanks.
    for (const t of this.tanks) {
      const d2 =
        (_local.x - t.x) ** 2 + (_local.y - t.y) ** 2 + (_local.z - t.z) ** 2;
      if (d2 < (t.radius * 1.35) ** 2 && t.health > 0) {
        t.health = Math.max(0, t.health - amount / 140);
        mult = 5.5;
        hitTank = true;
        if (t.health <= 0 && this.cookOff < 0) {
          // A ruptured tank does not detonate instantly — it dumps fuel, it
          // catches, and *then* it goes. That second and a half is the whole
          // reason shooting a tank is satisfying rather than a magic kill.
          this.cookOff = kind === "explosion" ? 0.35 : 1.6;
          this.localToWorld(t.x, t.y - t.radius, t.z, _v);
          oilDecal(_v.x, terrainHeight(_v.x, _v.z) + 0.02, _v.z, 1.6);
          this.ignite();
        }
      }
    }

    // Engine bay.
    const ed =
      (_local.x - this.engine.x) ** 2 + (_local.y - this.engine.y) ** 2 + (_local.z - this.engine.z) ** 2;
    if (!hitTank && ed < (this.engine.radius * 1.4) ** 2) {
      this.engine.health = Math.max(0, this.engine.health - amount / 320);
      mult = 2.2;
      if (this.engine.health <= 0 && this.running) this.stall();
    }

    // Tyres — a small target, and worth hitting.
    if (this.car && !hitTank) {
      const spec = this.car.spec.wheels;
      for (let i = 0; i < spec.length; i++) {
        const w = spec[i];
        const wd = (_local.x - w.x) ** 2 + (_local.y - (w.y - this.def.suspension)) ** 2 + (_local.z - w.z) ** 2;
        if (wd < (w.radius * 1.15) ** 2 && this.tyres[i] > 0) {
          this.tyres[i] = Math.max(0, this.tyres[i] - amount / 60);
          mult = Math.max(mult, 0.35);
          if (this.tyres[i] <= 0) {
            // A flat tyre loses grip and drags: the car pulls hard to that side.
            this.car.spec.wheels[i].gripScale = 0.42;
            spawnDebrisBurst({ x, y, z, count: 6, surface: "rubber", speed: 3, size: 0.06 });
          }
        }
      }
    }

    const applied = amount * mult;
    this.health -= applied;
    this.damage01 = clamp01(1 - this.health / this.maxHealth);
    if (this.car) this.car.damage = Math.max(this.car.damage, this.damage01 * 0.8);

    // Panel damage: crush the shell where the round went in.
    if (this.model && kind !== "fire") {
      this.model.applyImpact(
        _local.x, _local.y, _local.z,
        -_local.x, -_local.y * 0.4, -_local.z,
        kind === "explosion" ? applied / 120 : applied / 420,
      );
      if (kind === "explosion" && applied > 140) this.model.breakGlass("all");
    }

    if (this.health <= 0) this.destroy(kind === "explosion");
    return applied;
  }

  /** Engine off: out of fuel, shot out, or the player switched it off. */
  stall(): void {
    this.running = false;
    if (this.car) this.car.engineOn = false;
    if (this.heli) this.heli.engineOn = false;
  }

  start(): boolean {
    if (this.wrecked || this.engine.health <= 0 || this.fuel <= 0) return false;
    this.running = true;
    if (this.car) this.car.engineOn = true;
    if (this.heli) this.heli.engineOn = true;
    return true;
  }

  /** Light it on fire. Idempotent. */
  ignite(): void {
    if (this.burning || this.wrecked) return;
    this.burning = true;
    this.localToWorld(this.engine.x, this.engine.y, this.engine.z, _v);
    this.fireSlot = igniteFire(_v.x, _v.y, _v.z, {
      radius: this.def.length * 0.22,
      duration: 0,
      intensity: 0.85,
      spread: true,
      smoke: 1.6,
    });
    if (this.cookOff < 0) this.cookOff = 4.5 + this.rng.range(0, 3);
  }

  private updateSmokeAndFire(dt: number): void {
    // Engine damage smokes long before it burns.
    const smoke = clamp01(1 - this.engine.health) * 0.8 + clamp01(this.damage01 - 0.55) * 1.4;
    if (smoke > 0.12 && !this.wrecked && this.distance < 200) {
      this.smokeAcc += dt * smoke * 14;
      if (this.smokeAcc > 1) {
        this.smokeAcc = 0;
        this.localToWorld(this.engine.x, this.engine.y + 0.2, this.engine.z, _v);
        emitExhaust(_v.x, _v.y, _v.z, 0, 0, smoke, false, true);
      }
      if (smoke > 0.85 && !this.burning && this.rng.next() < dt * 0.35) this.ignite();
    }

    if (this.burning && this.fireSlot >= 0) {
      this.localToWorld(this.engine.x, this.engine.y, this.engine.z, _v);
      fire.moveFire(this.fireSlot, _v.x, _v.y, _v.z);
    }

    if (this.cookOff > 0) {
      this.cookOff -= dt;
      if (this.cookOff <= 0) this.destroy(true);
    }
  }

  /**
   * Destroy it. One explosion, one wreck, and every occupant thrown clear —
   * which is what makes a vehicle kill read as an event rather than a
   * disappearing prop.
   */
  destroy(violent = true): void {
    if (this.wrecked) return;
    this.wrecked = true;
    this.health = 0;
    this.damage01 = 1;
    this.cookOff = -1;
    this.running = false;
    this.wreckAge = 0;

    const p = this.position;
    const air = this.def.klass === "heli" || this.def.klass === "plane";
    const big = this.def.mass > 5000 || this.def.fuelTanks.some((t) => t.capacity > 300);
    spawnExplosion(p.x, p.y + 0.4, p.z, {
      yield: air ? "helicopter" : big ? "tank" : "car",
      dy: 0.65,
      burn: true,
      debris: violent,
      surface: "thinMetal",
      airburst: p.y - terrainHeight(p.x, p.z) > 6,
    });

    if (this.car) {
      this.car.engineOn = false;
      this.car.damage = 1;
      // A wreck flops: kill the tyres so it sits on its rims and stops dead.
      for (let i = 0; i < this.car.spec.wheels.length; i++) {
        this.car.spec.wheels[i].gripScale = 0.28;
        this.tyres[i] = 0;
      }
      // Launch it a little. Cars do leave the ground when they go up.
      this.car.applyImpulse(
        this.rng.gauss() * this.def.mass * 0.7,
        this.def.mass * (violent ? 2.6 : 1.1),
        this.rng.gauss() * this.def.mass * 0.7,
      );
    }
    if (this.heli) this.heli.engineOn = false;

    if (!this.burning) {
      this.burning = true;
      this.fireSlot = igniteFire(p.x, p.y + 0.3, p.z, {
        radius: this.def.length * 0.3,
        duration: 26,
        intensity: 1,
        spread: true,
        smoke: 2.2,
      });
    }

    if (this.model) this.model.setWrecked(true);

    for (const occ of this.passengers) {
      if (!occ.alive) continue;
      occ.alive = false;
      this.localToWorld(0, 0.6, 0, _v);
      vehicleRuntime.onOccupantKilled?.(this, occ, _v.x, _v.y, _v.z);
    }

    const points = this.tanks.some((t) => t.health <= 0)
      ? CHAOS.points.fuelTank
      : CHAOS.points.vehicle;
    useSfStore.getState().addChaos(points, `${this.def.label} destroyed`);
    vehicleRuntime.onDestroyed?.(this);
  }

  /** How long this wreck has been sitting there. */
  ageWreck(dt: number): number {
    if (this.wrecked) this.wreckAge += dt;
    return this.wreckAge;
  }

  /* ---------------- occupancy ---------------- */

  /** Free seat index, or −1. Seat 0 is the driver. */
  freeSeat(preferDriver = true): number {
    const taken = new Set(this.passengers.filter((p) => p.alive).map((p) => p.seat));
    if (preferDriver && !taken.has(0) && !this.driverIsPlayer) return 0;
    for (let i = 0; i < this.def.seats.length; i++) if (!taken.has(i)) return i;
    return -1;
  }

  /** Remove an occupant and hand them to the AI layer as a loose body. */
  ejectOccupant(seat: number, awayX = 0, awayZ = 0): Passenger | null {
    const idx = this.passengers.findIndex((p) => p.seat === seat && p.alive);
    if (idx < 0) return null;
    const occ = this.passengers[idx];
    occ.alive = false;
    this.passengers.splice(idx, 1);
    const s = this.def.seats[seat] ?? this.def.seats[0];
    this.localToWorld(s.x + Math.sign(s.x || -1) * 1.1, s.y, s.z, _v);
    this.openDoorNear(seat);
    vehicleRuntime.onOccupantEjected?.(this, occ, _v.x, _v.y, _v.z, awayX, awayZ);
    return occ;
  }

  /** Open whichever door is closest to a seat — used by hijacks and exits. */
  openDoorNear(seat: number): number {
    const s = this.def.seats[seat] ?? this.def.seats[0];
    if (!s) return -1;
    let best = -1;
    let bestD = 1e9;
    for (let i = 0; i < this.def.doors.length; i++) {
      const dd = this.def.doors[i];
      if (dd.side !== 0 && Math.sign(s.x || -1) !== dd.side) continue;
      const cz = (dd.z0 + dd.z1) * 0.5;
      const d = Math.abs(cz - s.z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) this.doorTarget[best] = 1;
    return best;
  }

  closeDoors(): void {
    this.doorTarget.fill(0);
  }

  /* ---------------- model LOD ---------------- */

  attachModel(scene: THREE.Object3D, realLights: boolean): void {
    if (this.model) return;
    this.model = buildVehicleModel(this.kind, {
      paint: this.paint,
      seed: this.seed,
      realLights,
    });
    this.model.root.position.copy(this.position);
    this.model.root.quaternion.copy(this.quaternion);
    if (this.wrecked) this.model.setWrecked(true);
    scene.add(this.model.root);
  }

  detachModel(): void {
    if (!this.model) return;
    this.model.root.removeFromParent();
    this.model.dispose();
    this.model = null;
  }

  /* ---------------- teardown ---------------- */

  dispose(): void {
    this.alive = false;
    this.detachModel();
    for (const u of this.unregisterFlammables) u();
    this.unregisterFlammables.length = 0;
    if (this.fireSlot >= 0) {
      fire.extinguish(this.fireSlot, false);
      this.fireSlot = -1;
    }
    this.car?.destroy();
    this.boat?.destroy();
    this.heli?.destroy();
    this.car = null;
    this.boat = null;
    this.heli = null;
    this.ready = false;
  }
}

/* ================================================================== *
 * Engine audio
 * ================================================================== *
 * A four-oscillator engine, not a sample library.
 *
 * Real engine audio in a shipped game is granular resynthesis of recorded
 * loops. We have no assets, so this is the next best thing: a sawtooth stack
 * at the firing frequency with its harmonics, a resonant low-pass whose cutoff
 * tracks throttle (that is what "load" sounds like), and a noise bed for
 * induction roar. It is not a V8, but it is unmistakably an engine, it tracks
 * rpm continuously, and it costs four oscillators.
 *
 * Deliberately opt-in, for two reasons: the screenshot harness must never
 * create an AudioContext, and this is a *fallback*. When the game's audio
 * subsystem is mounted it does all of this properly — granular pulse trains,
 * exhaust cones, load-dependent layers — and the right wiring is to leave this
 * synth off and forward `onAudio` to it instead:
 *
 *   vehicleRuntime.onAudio = (f) => sfAudio.updateVehicle(f.id, f.archetype, f, f.dt);
 *   vehicleRuntime.onAudioRelease = (id) => sfAudio.releaseVehicle(id);
 *
 * What this buys is that a build with no audio subsystem is not silent.
 */

let audioCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let audioEnabled = false;

export function enableVehicleAudio(): boolean {
  if (audioEnabled) return true;
  if (typeof window === "undefined") return false;
  const Ctor =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return false;
  audioCtx = new Ctor();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.5;
  masterGain.connect(audioCtx.destination);
  audioEnabled = true;
  return true;
}

export function setVehicleAudioVolume(v: number): void {
  if (masterGain) masterGain.gain.value = clamp01(v);
}

class EngineVoice {
  private osc: OscillatorNode[] = [];
  private gain: GainNode;
  private filter: BiquadFilterNode;
  private noise: AudioBufferSourceNode | null = null;
  private noiseGain: GainNode;
  private started = false;

  constructor(private ctx: AudioContext, out: AudioNode, private cylinders: number) {
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 700;
    this.filter.Q.value = 4;
    this.gain.connect(out);
    this.filter.connect(this.gain);
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      o.type = i === 0 ? "sawtooth" : i === 1 ? "square" : "sawtooth";
      o.detune.value = i === 0 ? 0 : i === 1 ? -6 : 9;
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 0.6 : i === 1 ? 0.22 : 0.28;
      o.connect(g);
      g.connect(this.filter);
      this.osc.push(o);
    }
    // Induction / exhaust noise.
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    this.noiseGain.connect(this.filter);
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // Brown-ish noise: an engine's noise floor is not white.
      last = (last + (Math.random() * 2 - 1) * 0.16) * 0.94;
      data[i] = last;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.noiseGain);
    this.noise = src;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const t = this.ctx.currentTime;
    for (const o of this.osc) o.start(t);
    this.noise?.start(t);
  }

  set(rpm: number, load: number, gainScale: number): void {
    if (!this.started) this.start();
    const t = this.ctx.currentTime;
    // Firing frequency: rpm/60 × cylinders/2 for a four-stroke.
    const f = Math.max(18, (rpm / 60) * (this.cylinders * 0.5));
    for (let i = 0; i < this.osc.length; i++) {
      this.osc[i].frequency.setTargetAtTime(f * (i === 2 ? 2 : 1), t, 0.03);
    }
    this.filter.frequency.setTargetAtTime(420 + load * 3600 + rpm * 0.28, t, 0.05);
    this.gain.gain.setTargetAtTime(gainScale * (0.12 + load * 0.5), t, 0.06);
    this.noiseGain.gain.setTargetAtTime(load * 0.22 + 0.03, t, 0.08);
  }

  stop(): void {
    const t = this.ctx.currentTime;
    this.gain.gain.setTargetAtTime(0, t, 0.08);
    try {
      for (const o of this.osc) o.stop(t + 0.4);
      this.noise?.stop(t + 0.4);
    } catch {
      /* already stopped */
    }
    this.osc.length = 0;
    this.noise = null;
  }
}

/* ================================================================== *
 * The runtime
 * ================================================================== */

/** How many hero rigs may exist at once, per quality tier. */
const HERO_BUDGET: Record<QualityTier, number> = { low: 2, medium: 4, high: 7, ultra: 11 };
/** Beyond this, non-persistent vehicles are recycled. */
const DESPAWN_RADIUS = 620;
/** A wreck hangs around this long before it is cleaned up. */
const WRECK_LIFETIME = 55;

export type VehicleFilter = (v: VehicleInstance) => boolean;

class VehicleRuntime {
  readonly vehicles: VehicleInstance[] = [];
  private byId = new Map<number, VehicleInstance>();
  private byPhysObj = new Map<number, VehicleInstance>();
  private pending: VehicleInstance[] = [];
  private scene: THREE.Object3D | null = null;
  private tier: QualityTier = "high";
  private detachContact: (() => void) | null = null;
  private voices = new Map<number, EngineVoice>();
  private heroSorted: VehicleInstance[] = [];

  /** Global cap; the spawn manager lowers it on weaker tiers. */
  maxVehicles = 64;
  /** Enable real spot lights on the player's headlamps. */
  realHeadlights = true;

  readonly stats = { count: 0, hero: 0, wrecked: 0, spawned: 0, despawned: 0 };

  /* ---- integration hooks. All optional; all called at most once per event. */
  onDestroyed: ((v: VehicleInstance) => void) | null = null;
  onOccupantEjected:
    | ((v: VehicleInstance, p: Passenger, x: number, y: number, z: number, awayX: number, awayZ: number) => void)
    | null = null;
  onOccupantKilled: ((v: VehicleInstance, p: Passenger, x: number, y: number, z: number) => void) | null = null;
  /** Called once per frame per audible vehicle; wire an audio mixer to it. */
  onAudio: ((f: EngineAudioFrame) => void) | null = null;
  /** Called when a vehicle goes away, so its voice can be released. */
  onAudioRelease: ((id: number) => void) | null = null;
  /** Called on every significant impact: (vehicle, energy, worldPoint). */
  onImpact: ((v: VehicleInstance, energy: number, x: number, y: number, z: number) => void) | null = null;
  /**
   * Second impact hook, owned by `driving.ts`.
   *
   * Two slots rather than one because the driving system needs a subscription
   * whose lifetime is "while the player is in a car", and it must not be able
   * to stomp whatever the mission layer put in `onImpact`. Chaining through a
   * saved previous handler works right up until two systems unsubscribe out of
   * order, and then it silently leaks a stale closure.
   */
  onPlayerImpact: ((v: VehicleInstance, energy: number, x: number, y: number, z: number) => void) | null = null;

  /* ---------------- lifecycle ---------------- */

  attach(scene: THREE.Object3D, tier: QualityTier): void {
    this.scene = scene;
    this.tier = tier;
    if (!this.detachContact) {
      this.detachContact = onContactForce((e) => this.handleContact(e));
    }
  }

  setQuality(tier: QualityTier): void {
    this.tier = tier;
    this.maxVehicles = Math.round(64 * QUALITY[tier].crowdDensity);
  }

  spawn(opts: SpawnOptions): VehicleInstance {
    const v = new VehicleInstance(opts);
    this.vehicles.push(v);
    this.byId.set(v.id, v);
    if (!v.tryCreate()) this.pending.push(v);
    else this.register(v);
    if (opts.hero && this.scene) v.attachModel(this.scene, opts.faction === "player");
    this.stats.spawned++;
    return v;
  }

  private register(v: VehicleInstance): void {
    const o = v.physObject;
    if (o) this.byPhysObj.set(o.id, v);
  }

  despawn(id: number): void {
    const v = this.byId.get(id);
    if (!v) return;
    const o = v.physObject;
    if (o) this.byPhysObj.delete(o.id);
    const voice = this.voices.get(id);
    if (voice) {
      voice.stop();
      this.voices.delete(id);
    }
    this.onAudioRelease?.(id);
    v.dispose();
    this.byId.delete(id);
    const i = this.vehicles.indexOf(v);
    if (i >= 0) {
      this.vehicles[i] = this.vehicles[this.vehicles.length - 1];
      this.vehicles.pop();
    }
    this.stats.despawned++;
  }

  get(id: number): VehicleInstance | null {
    return this.byId.get(id) ?? null;
  }

  /** Resolve a physics collider handle back to a vehicle, for weapon hits. */
  fromCollider(handle: number): VehicleInstance | null {
    const o = objectForColliderHandle(handle);
    return o ? this.byPhysObj.get(o.id) ?? null : null;
  }

  fromPhysicsObject(o: PhysicsObject | null): VehicleInstance | null {
    return o ? this.byPhysObj.get(o.id) ?? null : null;
  }

  /** Damage entry point for the weapon stack. */
  hit(id: number, x: number, y: number, z: number, amount: number, kind: DamageKind = "bullet"): number {
    return this.byId.get(id)?.hit(x, y, z, amount, kind) ?? 0;
  }

  /** Closest vehicle to a point, optionally filtered. */
  nearest(x: number, y: number, z: number, radius: number, filter?: VehicleFilter): VehicleInstance | null {
    let best: VehicleInstance | null = null;
    let bestD = radius * radius;
    for (const v of this.vehicles) {
      if (!v.ready || (filter && !filter(v))) continue;
      const d =
        (v.position.x - x) ** 2 + (v.position.y - y) ** 2 + (v.position.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  clear(): void {
    for (let i = this.vehicles.length - 1; i >= 0; i--) this.despawn(this.vehicles[i].id);
    this.vehicles.length = 0;
    this.byId.clear();
    this.byPhysObj.clear();
    this.pending.length = 0;
    for (const [, v] of this.voices) v.stop();
    this.voices.clear();
    if (this.detachContact) {
      this.detachContact();
      this.detachContact = null;
    }
    this.scene = null;
  }

  /* ---------------- the frame ---------------- */

  update(dt: number, camX: number, camY: number, camZ: number): void {
    // Retry anything that spawned before Rapier booted.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const v = this.pending[i];
      if (!v.alive) {
        this.pending.splice(i, 1);
      } else if (v.tryCreate()) {
        this.register(v);
        this.pending.splice(i, 1);
      }
    }

    let wrecked = 0;
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      v.update(dt, camX, camY, camZ);
      if (v.wrecked) {
        wrecked++;
        // Wrecks are cleaned up on a timer, but never while the player is
        // standing next to one — objects vanishing in your peripheral vision is
        // the cheapest possible immersion break.
        if (v.ageWreck(dt) > WRECK_LIFETIME && v.distance > 70 && !v.persistent) {
          this.despawn(v.id);
          continue;
        }
      }
      if (!v.persistent && !v.driverIsPlayer && v.distance > DESPAWN_RADIUS) {
        this.despawn(v.id);
      }
    }

    this.assignHeroModels();
    this.updateAudio(dt, camX, camY, camZ);

    this.stats.count = this.vehicles.length;
    this.stats.wrecked = wrecked;
  }

  /**
   * Hand hero rigs to the closest vehicles.
   *
   * Sorted by distance with the player's own vehicle forced to the front, then
   * a straight budget cut. Hysteresis comes free from the radius: a vehicle
   * must be inside HERO_RADIUS to gain a rig but only outside 1.25× it to lose
   * one, so a car idling at the boundary does not thrash the pool.
   */
  private assignHeroModels(): void {
    if (!this.scene) return;
    const budget = HERO_BUDGET[this.tier] ?? 6;
    // Aircraft and boats draw from their own allowance so a busy street can
    // never take the rig off the helicopter you are looking at.
    let airBudget = 5;
    const list = this.heroSorted;
    list.length = 0;
    for (const v of this.vehicles) {
      if (v.ready && v.distance < v.heroRadius * 1.25) list.push(v);
    }
    list.sort((a, b) => {
      const ap = a.driverIsPlayer ? -1e6 : 0;
      const bp = b.driverIsPlayer ? -1e6 : 0;
      return a.distance + ap - (b.distance + bp);
    });
    let given = 0;
    for (const v of list) {
      const air = v.needsModel;
      const inRange = v.distance < v.heroRadius;
      // Hysteresis is free: gaining a rig needs `heroRadius`, keeping one only
      // needs 1.25× it, so a vehicle idling at the boundary never thrashes.
      const affordable = air ? airBudget > 0 : given < budget;
      if (affordable && (inRange || v.model !== null)) {
        if (!v.model) v.attachModel(this.scene, this.realHeadlights && v.driverIsPlayer);
        if (air) airBudget--;
        else given++;
      } else if (v.model) {
        v.detachModel();
      }
    }
    // Anything that fell out of the sorted set loses its rig.
    for (const v of this.vehicles) {
      if (v.model && v.distance >= v.heroRadius * 1.25) v.detachModel();
    }
    this.stats.hero = given;
  }

  /**
   * Audio: at most six voices, allocated to the closest running engines.
   * Everything else is reported through `onAudio` so a proper mixer can do
   * better, but the built-in synth keeps the game from being silent.
   */
  private updateAudio(dt: number, camX: number, camY: number, camZ: number): void {
    if (!this.onAudio && !audioEnabled) return;
    const list = this.heroSorted;
    list.length = 0;
    for (const v of this.vehicles) {
      if (v.ready && v.distance < 120) list.push(v);
    }
    list.sort((a, b) => a.distance - b.distance);
    const maxVoices = 6;

    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const audible = i < maxVoices && v.running && !v.wrecked;
      if (this.onAudio) {
        const f = _audioFrame;
        f.id = v.id;
        f.kind = v.kind;
        f.archetype = ENGINE_ARCHETYPE[v.kind];
        f.dt = dt;
        f.x = v.position.x;
        f.y = v.position.y;
        f.z = v.position.z;
        f.vx = v.velocity.x;
        f.vy = v.velocity.y;
        f.vz = v.velocity.z;
        _v.set(0, 0, -1).applyQuaternion(v.quaternion);
        f.fx = _v.x;
        f.fy = _v.y;
        f.fz = _v.z;
        f.rpm = v.car ? v.car.rpm : v.heli ? 600 + v.heli.rotorSpeed * 900 : 900;
        f.throttle = v.car ? v.car.input.throttle : v.heli ? v.heli.input.collective : 0;
        f.load = v.car ? v.car.load : v.heli ? v.heli.input.collective : 0;
        f.gear = v.car ? v.car.gear : 1;
        f.speed = v.speed;
        f.slip = v.car ? v.car.slip : 0;
        f.grounded = v.car ? v.car.grounded : v.def.klass === "boat";
        f.surface = surfaceUnder(v);
        f.suspension = v.suspensionPulse;
        f.impact = v.impactPulse;
        f.collective = v.heli ? v.heli.input.collective : v.rotorSpeed;
        f.shifted = v.shifted;
        f.running = v.running;
        f.siren = v.lights.siren;
        f.horn = v.horn;
        f.rotor = v.heli ? v.heli.rotorSpeed : v.rotorSpeed;
        f.distance = v.distance;
        this.onAudio(f);
      }
      if (!audioEnabled || !audioCtx || !masterGain) continue;

      let voice = this.voices.get(v.id);
      if (!audible) {
        if (voice) {
          voice.stop();
          this.voices.delete(v.id);
        }
        continue;
      }
      if (!voice) {
        const cyl = v.def.mass > 4000 ? 6 : v.def.kind === "motorcycle" ? 2 : v.def.kind === "sports" ? 8 : 4;
        voice = new EngineVoice(audioCtx, masterGain, cyl);
        this.voices.set(v.id, voice);
      }
      const rpm = v.car ? v.car.rpm : v.heli ? 600 + v.heli.rotorSpeed * 900 : 900;
      const load = v.car ? v.car.load : v.heli ? v.heli.input.collective : 0.3;
      // Inverse-square-ish falloff with a floor so the player's own car is
      // always present without being deafening.
      const g = v.driverIsPlayer ? 0.9 : clamp01(1 - v.distance / 120) ** 2 * 0.6;
      voice.set(rpm, load, g);
    }

    // Voices for vehicles that dropped out of the list entirely.
    for (const [id, voice] of this.voices) {
      if (!this.byId.has(id)) {
        voice.stop();
        this.voices.delete(id);
      }
    }
  }

  /**
   * Collision response.
   *
   * Rapier reports a contact force magnitude; converting it to damage needs
   * care, because a 16-tonne truck resting on its suspension generates a
   * standing force far larger than a 40 km/h shunt in a hatchback. So the
   * damage is scaled by the *impulse relative to the vehicle's own weight* and
   * only counted above a threshold, and the dent is placed at the contact
   * direction rather than at the centre of mass.
   */
  private handleContact(e: {
    a: PhysicsObject | null;
    b: PhysicsObject | null;
    maxMagnitude: number;
    dirX: number;
    dirY: number;
    dirZ: number;
  }): void {
    for (const side of [0, 1] as const) {
      const obj = side === 0 ? e.a : e.b;
      const v = this.fromPhysicsObject(obj);
      if (!v || !v.ready || v.wrecked) continue;
      const weight = v.def.mass * 9.81;
      const g = e.maxMagnitude / Math.max(1, weight);
      if (g < 2.2) continue; // suspension load and kerb rattle
      const energy = Math.min(9, (g - 2.2) * 0.55);
      const sign = side === 0 ? 1 : -1;
      v.localToWorld(0, 0, 0, _v);
      const px = _v.x + e.dirX * sign * v.def.length * 0.4;
      const py = _v.y + e.dirY * sign * 0.3;
      const pz = _v.z + e.dirZ * sign * v.def.length * 0.4;

      v.impactPulse = Math.max(v.impactPulse, clamp01(energy / 6));
      v.hit(px, py, pz, energy * 26, "collision");
      if (v.model) {
        v.worldToLocal(px, py, pz, _local);
        v.model.applyImpact(_local.x, _local.y, _local.z, -e.dirX * sign, -e.dirY * sign, -e.dirZ * sign, energy);
        if (energy > 4.5) v.model.breakGlass("front");
      }
      this.onImpact?.(v, energy, px, py, pz);
      this.onPlayerImpact?.(v, energy, px, py, pz);
    }
  }
}

export const vehicleRuntime = new VehicleRuntime();

/* ================================================================== *
 * Helpers other subsystems want
 * ================================================================== */

/**
 * What this vehicle's tyres (or hull) are on.
 *
 * Read from `sfGeo` rather than from a physics surface tag because the tag is
 * whatever collider the wheel happened to hit this step, which flickers between
 * road and kerb at exactly the moment a skid is loudest.
 */
function surfaceUnder(v: VehicleInstance): RoadSurfaceTag {
  const x = v.position.x;
  const z = v.position.z;
  if (v.def.klass === "boat" || isWater(x, z)) return "water";
  if (isRoad(x, z)) return "asphalt";
  if (isPark(x, z)) return "grass";
  return "concrete";
}

/** Is this world point inside (or on) a vehicle? Used by grapple and hijack. */
export function vehicleAt(x: number, y: number, z: number, slack = 0.6): VehicleInstance | null {
  for (const v of vehicleRuntime.vehicles) {
    if (!v.ready) continue;
    const d = v.def;
    const r = Math.max(d.length, d.width, d.height) * 0.5 + slack;
    if ((v.position.x - x) ** 2 + (v.position.y - y) ** 2 + (v.position.z - z) ** 2 > r * r) continue;
    v.worldToLocal(x, y, z, _local);
    if (
      Math.abs(_local.x) < d.width * 0.5 + slack &&
      Math.abs(_local.z) < d.length * 0.5 + slack &&
      _local.y > -d.height * 0.5 - slack &&
      _local.y < d.height * 0.5 + slack
    ) {
      return v;
    }
  }
  return null;
}

/** World-space matrix for a vehicle, for anything that needs to parent to it. */
export function vehicleMatrix(v: VehicleInstance, out: THREE.Matrix4): THREE.Matrix4 {
  return out.compose(v.position, v.quaternion, _scale);
}
