/**
 * models.ts — every drivable, flyable and floatable thing in San Francisco,
 * generated in code.
 *
 * The traffic system already has a vehicle mesh: one merged loft per kind,
 * instanced, one draw call for two hundred cars. That is exactly right for a
 * car you see for four seconds at forty metres, and exactly wrong for the car
 * you are sitting in, hanging off, or prising a driver out of. This module is
 * the other half of that LOD ladder — the *hero* rig:
 *
 *   • separate meshes and materials per surface class (paint, glass, chrome,
 *     rubber, interior, and six independently-driven lamp channels), because a
 *     brake light that is a region ID inside one übershader cannot be a
 *     different colour temperature to a headlight, and it shows;
 *   • a cabin you can see through the glass — seats with bolsters, a dash, a
 *     wheel with three spokes, pillars, a headliner — because the single most
 *     common tell of a cheap car model is a window that looks into a void;
 *   • wheel arches actually *cut out* of the bodywork with a flared lip and a
 *     wheel well behind them, rather than a slab with a cylinder poking through;
 *   • door, bonnet and boot apertures cut from the same loft, with the panels
 *     rebuilt as separate hinged parts that swing;
 *   • a deformable paint shell: `applyImpact()` displaces real vertices and
 *     raises a per-vertex dent channel that the shader reads for creased,
 *     roughened, paint-cracked metal. Damage is geometry, not a decal.
 *
 * Coordinate convention (shared with `physics/vehiclePhysics.ts`):
 *   local **-Z is forward**, +X is right, +Y is up.
 * Geometry is *authored* with y = 0 at the ground because every dimension a
 * human knows about a car ("the roof is 1.46 m") is measured from the road;
 * `finish()` shifts the whole model down by `originY` so the model origin
 * coincides with the chassis collider centre that Rapier drives.
 *
 * Public API
 * ----------
 *   VEHICLE_KINDS, VehicleKind, VehicleDef, VEHICLE_DEFS
 *   toPhysicsSpec(def)            → the drivetrain spec vehiclePhysics wants
 *   buildVehicleModel(kind, opts) → a VehicleModel rig
 *   VehicleModel                  → setWheel / setLights / setDoor / applyImpact / …
 *   paintFor(kind, rng)           → a seeded, kind-appropriate paint colour
 *   disposeVehicleAssets()        → drop the shared geometry cache
 */
import * as THREE from "three";
import type { VehicleSpec as PhysicsVehicleSpec, WheelSpec } from "@/sf/physics";
import { clamp01, makeRng, type Rng } from "../math/rng";

/* ================================================================== *
 * Taxonomy
 * ================================================================== */

export type VehicleKind =
  | "sedan"
  | "suv"
  | "sports"
  | "pickup"
  | "van"
  | "boxtruck"
  | "semi"
  | "police"
  | "swatvan"
  | "ambulance"
  | "firetruck"
  | "bus"
  | "cablecar"
  | "taxi"
  | "motorcycle"
  | "helicopter"
  | "gunship"
  | "aircraft"
  | "speedboat"
  | "jetski";

export const VEHICLE_KINDS: readonly VehicleKind[] = [
  "sedan", "suv", "sports", "pickup", "van", "boxtruck", "semi",
  "police", "swatvan", "ambulance", "firetruck", "bus", "cablecar", "taxi",
  "motorcycle", "helicopter", "gunship", "aircraft", "speedboat", "jetski",
];

/** Which builder and which runtime drives it. */
export type VehicleClass = "car" | "truck" | "bus" | "rail" | "bike" | "heli" | "plane" | "boat";

/**
 * Paint schemes done in the shader rather than with textures. A livery is a
 * function of the local position — a door band, a checker stripe, a chevron —
 * so it costs nothing, never needs a UV unwrap and stays crisp at any range.
 */
export type LiveryKind =
  | "none" | "police" | "taxi" | "ambulance" | "fire" | "muni" | "swat" | "military" | "cablecar";

export interface SeatDef {
  x: number;
  /** Seat *base* height above the ground; the eye sits ~0.62 m above it. */
  y: number;
  z: number;
  driver?: boolean;
  /** Gunner seats face outward and expose a weapon mount. */
  gunner?: boolean;
}

export interface DoorDef {
  /** −1 = left (driver's side in the US), +1 = right, 0 = centre-line panel. */
  side: -1 | 0 | 1;
  z0: number;
  z1: number;
  y0: number;
  y1: number;
  /** Which edge the hinge is on. */
  hinge: "front" | "rear" | "top" | "bottom";
  /** Fully-open angle, radians. */
  max: number;
  /** Slide instead of swing — a van's cargo door, a bus's. */
  slide?: boolean;
}

/** A discrete weak point. Shoot it and the vehicle cooks off early. */
export interface FuelTankDef {
  x: number;
  y: number;
  z: number;
  radius: number;
  /** Litres — bigger tank, bigger fireball. */
  capacity: number;
}

export interface VehicleDef {
  kind: VehicleKind;
  klass: VehicleClass;
  label: string;

  /* ---- overall metres ---- */
  length: number;
  width: number;
  height: number;
  /** Underbody clearance. */
  clearance: number;

  /* ---- running gear (forward is −Z, so frontZ is negative) ---- */
  frontZ: number;
  rearZ: number;
  /** Second driven axle, or 0 for none. */
  tandemZ: number;
  /** Trailer bogie for the semi, or 0. */
  trailerZ: number;
  wheelRadius: number;
  wheelWidth: number;
  /** Centre-to-centre wheel spacing. */
  track: number;
  /** Suspension rest length — sets the visual ride height and the hard point. */
  suspension: number;

  /* ---- the greenhouse ---- */
  cabinFrontZ: number;
  cabinRearZ: number;
  /** Window sill height above the road. */
  beltline: number;
  /** Roof height above the road. */
  roof: number;
  /** Bonnet/cowl height above the road. */
  bonnet: number;
  /** 0 = curvy coupé shoulder, 1 = slab-sided box. */
  boxiness: number;
  /** How much the glasshouse pulls in at the top. 0.18 is a typical saloon. */
  tumblehome: number;

  /* ---- fit-out ---- */
  seats: SeatDef[];
  doors: DoorDef[];
  fuelTanks: FuelTankDef[];
  livery: LiveryKind;
  palette: number[];
  /** Roof furniture / body add-ons. */
  lightbar: boolean;
  pushbar: boolean;
  bed: boolean;
  boxBody: boolean;
  ladder: boolean;
  trolleyPoles: boolean;
  roofSign: boolean;
  openSides: boolean;
  chinGun: boolean;
  rocketPods: boolean;

  /* ---- mass and drivetrain ---- */
  mass: number;
  /** Peak crank torque, N·m, and where it happens. */
  peakTorque: number;
  peakTorqueRpm: number;
  redlineRpm: number;
  idleRpm: number;
  gearRatios: number[];
  finalDrive: number;
  /** m/s. */
  topSpeed: number;
  drivetrain: "fwd" | "rwd" | "awd";
  tyreGrip: number;
  brakeTorque: number;
  maxSteer: number;
  /** Structural health, in "damage points". A sports car is a soap bubble. */
  integrity: number;
  /** Litres in the tank; consumption is derived from mass and load. */
  fuel: number;

  /* ---- air/water only ---- */
  rotorRadius: number;
  tailRotorRadius: number;
  wingSpan: number;
  propRadius: number;
  hullDraft: number;
}

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

const CITY_PAINT = [
  0x2b2f36, 0x9ba2a9, 0xc7ccd1, 0x14171b, 0x6b7278, 0x27384a,
  0x7a2f2a, 0x37543f, 0xd9d6cd, 0x4a4038, 0x1d3f6e, 0xb0b6ba,
];

function def(p: Partial<VehicleDef> & { kind: VehicleKind }): VehicleDef {
  const base: VehicleDef = {
    kind: p.kind,
    klass: "car",
    label: p.kind,
    length: 4.85, width: 1.84, height: 1.46, clearance: 0.15,
    frontZ: -1.42, rearZ: 1.43, tandemZ: 0, trailerZ: 0,
    wheelRadius: 0.34, wheelWidth: 0.23, track: 1.56, suspension: 0.36,
    cabinFrontZ: -0.42, cabinRearZ: 1.28,
    beltline: 1.02, roof: 1.46, bonnet: 0.94, boxiness: 0.36, tumblehome: 0.17,
    seats: [], doors: [], fuelTanks: [],
    livery: "none", palette: CITY_PAINT,
    lightbar: false, pushbar: false, bed: false, boxBody: false, ladder: false,
    trolleyPoles: false, roofSign: false, openSides: false,
    chinGun: false, rocketPods: false,
    mass: 1480,
    peakTorque: 320, peakTorqueRpm: 3800, redlineRpm: 6600, idleRpm: 780,
    gearRatios: [3.54, 2.05, 1.38, 1.0, 0.78, 0.63], finalDrive: 3.9,
    topSpeed: 62, drivetrain: "fwd", tyreGrip: 1.42, brakeTorque: 4200, maxSteer: 0.62,
    integrity: 1000, fuel: 55,
    rotorRadius: 0, tailRotorRadius: 0, wingSpan: 0, propRadius: 0, hullDraft: 0,
  };
  const d = { ...base, ...p };
  // Defaults that depend on the final dimensions.
  if (d.seats.length === 0) d.seats = defaultSeats(d);
  if (d.doors.length === 0) d.doors = defaultDoors(d);
  if (d.fuelTanks.length === 0) d.fuelTanks = defaultTanks(d);
  return d;
}

function defaultSeats(d: VehicleDef): SeatDef[] {
  if (d.klass === "bike") return [{ x: 0, y: d.beltline * 0.62, z: 0.05, driver: true }];
  const sx = Math.min(0.42, d.width * 0.24);
  const front = d.cabinFrontZ + 0.52;
  const seats: SeatDef[] = [
    { x: -sx, y: d.beltline - 0.44, z: front, driver: true },
    { x: sx, y: d.beltline - 0.44, z: front },
  ];
  const rear = d.cabinRearZ - 0.45;
  if (rear - front > 0.75) {
    seats.push({ x: -sx, y: d.beltline - 0.42, z: rear });
    seats.push({ x: sx, y: d.beltline - 0.42, z: rear });
  }
  return seats;
}

function defaultDoors(d: VehicleDef): DoorDef[] {
  if (d.klass === "bike" || d.klass === "boat" || d.openSides) return [];
  const y0 = d.clearance + (d.beltline - d.clearance) * 0.24;
  const y1 = d.beltline - 0.02;
  const fz0 = d.cabinFrontZ + 0.1;
  const fz1 = Math.min(d.cabinRearZ - 0.08, fz0 + 1.05);
  const out: DoorDef[] = [
    { side: -1, z0: fz0, z1: fz1, y0, y1, hinge: "front", max: 1.18 },
    { side: 1, z0: fz0, z1: fz1, y0, y1, hinge: "front", max: 1.18 },
  ];
  const rz0 = fz1 + 0.07;
  const rz1 = d.cabinRearZ - 0.1;
  if (rz1 - rz0 > 0.55) {
    out.push({ side: -1, z0: rz0, z1: rz1, y0, y1, hinge: "front", max: 1.1 });
    out.push({ side: 1, z0: rz0, z1: rz1, y0, y1, hinge: "front", max: 1.1 });
  }
  return out;
}

function defaultTanks(d: VehicleDef): FuelTankDef[] {
  if (d.klass === "heli" || d.klass === "plane") {
    return [{ x: 0, y: d.clearance + 0.5, z: 0.4, radius: 0.6, capacity: 700 }];
  }
  if (d.klass === "boat") {
    return [{ x: 0, y: d.clearance + 0.35, z: 1.1, radius: 0.5, capacity: 300 }];
  }
  if (d.klass === "bike") {
    return [{ x: 0, y: d.beltline * 0.9, z: -0.15, radius: 0.22, capacity: 16 }];
  }
  // Behind the rear axle, under the floor — where a real one is, and the
  // reason a rear-end hit is the one that cooks a car off.
  return [{ x: 0, y: d.clearance + 0.22, z: d.rearZ - 0.25, radius: 0.36, capacity: d.fuel }];
}

export const VEHICLE_DEFS: Record<VehicleKind, VehicleDef> = {
  sedan: def({ kind: "sedan", label: "Sedan" }),

  suv: def({
    kind: "suv", label: "SUV",
    length: 4.94, width: 1.98, height: 1.8, clearance: 0.22,
    frontZ: -1.46, rearZ: 1.46, wheelRadius: 0.39, wheelWidth: 0.27, track: 1.66,
    suspension: 0.42,
    cabinFrontZ: -0.5, cabinRearZ: 1.7, beltline: 1.2, roof: 1.8, bonnet: 1.12,
    boxiness: 0.62, tumblehome: 0.1,
    mass: 2200, peakTorque: 420, topSpeed: 58, drivetrain: "awd",
    tyreGrip: 1.32, brakeTorque: 5200, integrity: 1400, fuel: 76,
  }),

  sports: def({
    kind: "sports", label: "Sports Coupe",
    length: 4.42, width: 1.96, height: 1.19, clearance: 0.1,
    frontZ: -1.3, rearZ: 1.34, wheelRadius: 0.34, wheelWidth: 0.3, track: 1.68,
    suspension: 0.24,
    cabinFrontZ: -0.24, cabinRearZ: 0.92, beltline: 0.82, roof: 1.19, bonnet: 0.74,
    boxiness: 0.12, tumblehome: 0.26,
    palette: [0x9c1408, 0xe4b400, 0x101318, 0xdedfe1, 0x0b3a6b, 0x2a6b3c, 0xd35400],
    mass: 1390,
    peakTorque: 640, peakTorqueRpm: 5200, redlineRpm: 8200, idleRpm: 900,
    gearRatios: [3.13, 2.1, 1.55, 1.21, 1.0, 0.84, 0.7], finalDrive: 3.55,
    topSpeed: 88, drivetrain: "rwd", tyreGrip: 1.78, brakeTorque: 7200, maxSteer: 0.56,
    integrity: 780, fuel: 62,
  }),

  pickup: def({
    kind: "pickup", label: "Pickup",
    length: 5.72, width: 2.03, height: 1.94, clearance: 0.25,
    frontZ: -1.72, rearZ: 1.74, wheelRadius: 0.42, wheelWidth: 0.3, track: 1.7,
    suspension: 0.44,
    cabinFrontZ: -1.02, cabinRearZ: 0.32, beltline: 1.3, roof: 1.94, bonnet: 1.22,
    boxiness: 0.78, tumblehome: 0.08, bed: true,
    mass: 2480, peakTorque: 620, peakTorqueRpm: 3200, redlineRpm: 5400,
    topSpeed: 56, drivetrain: "rwd", tyreGrip: 1.22, brakeTorque: 5600,
    integrity: 1500, fuel: 98,
  }),

  van: def({
    kind: "van", label: "Cargo Van",
    length: 5.62, width: 2.02, height: 2.38, clearance: 0.2,
    frontZ: -1.56, rearZ: 1.72, wheelRadius: 0.37, wheelWidth: 0.25, track: 1.72,
    suspension: 0.4,
    cabinFrontZ: -1.34, cabinRearZ: -0.12, beltline: 1.44, roof: 2.38, bonnet: 1.3,
    boxiness: 0.9, tumblehome: 0.05, boxBody: true,
    palette: [0xe8e6e1, 0xcfd2d4, 0x8d9298, 0x39404a, 0xa8412c, 0x2f4f75],
    doors: [
      { side: -1, z0: -1.28, z1: -0.22, y0: 0.46, y1: 1.42, hinge: "front", max: 1.1 },
      { side: 1, z0: -1.28, z1: -0.22, y0: 0.46, y1: 1.42, hinge: "front", max: 1.1 },
      { side: 1, z0: -0.1, z1: 1.1, y0: 0.42, y1: 1.9, hinge: "rear", max: 1.0, slide: true },
      { side: 0, z0: 2.5, z1: 2.8, y0: 0.42, y1: 2.0, hinge: "front", max: 1.5 },
    ],
    mass: 2750, peakTorque: 500, peakTorqueRpm: 2600, redlineRpm: 4600,
    topSpeed: 46, drivetrain: "rwd", tyreGrip: 1.12, brakeTorque: 5400, maxSteer: 0.52,
    integrity: 1500, fuel: 80,
  }),

  boxtruck: def({
    kind: "boxtruck", label: "Box Truck",
    length: 7.7, width: 2.34, height: 3.35, clearance: 0.34,
    frontZ: -2.36, rearZ: 2.06, wheelRadius: 0.47, wheelWidth: 0.3, track: 1.94,
    suspension: 0.46,
    cabinFrontZ: -2.2, cabinRearZ: -0.9, beltline: 1.92, roof: 2.5, bonnet: 1.72,
    boxiness: 1, tumblehome: 0.03, boxBody: true,
    palette: [0xe6e4de, 0xd6a52c, 0x3d4b5c, 0x8c2f26, 0x9aa0a4],
    doors: [
      { side: -1, z0: -2.14, z1: -1.02, y0: 0.9, y1: 1.9, hinge: "front", max: 1.1 },
      { side: 1, z0: -2.14, z1: -1.02, y0: 0.9, y1: 1.9, hinge: "front", max: 1.1 },
      { side: 0, z0: 3.5, z1: 3.8, y0: 0.9, y1: 3.2, hinge: "top", max: 1.5 },
    ],
    mass: 6900, peakTorque: 900, peakTorqueRpm: 2100, redlineRpm: 3400, idleRpm: 620,
    gearRatios: [5.2, 3.1, 2.0, 1.4, 1.0, 0.78], finalDrive: 4.6,
    topSpeed: 38, drivetrain: "rwd", tyreGrip: 1.08, brakeTorque: 9600, maxSteer: 0.46,
    integrity: 2600, fuel: 190,
  }),

  semi: def({
    kind: "semi", klass: "truck", label: "Semi Tractor",
    length: 16.4, width: 2.55, height: 4.05, clearance: 0.4,
    frontZ: -6.6, rearZ: -3.6, tandemZ: -2.2, trailerZ: 5.3,
    wheelRadius: 0.53, wheelWidth: 0.32, track: 2.06, suspension: 0.48,
    cabinFrontZ: -6.5, cabinRearZ: -4.6, beltline: 2.35, roof: 3.5, bonnet: 2.1,
    boxiness: 1, tumblehome: 0.02, boxBody: true,
    palette: [0x1c2733, 0xb8bcc0, 0x8f2119, 0x2f5c3a, 0xd9d5cb],
    doors: [
      { side: -1, z0: -6.4, z1: -5.2, y0: 1.3, y1: 2.32, hinge: "front", max: 1.1 },
      { side: 1, z0: -6.4, z1: -5.2, y0: 1.3, y1: 2.32, hinge: "front", max: 1.1 },
    ],
    fuelTanks: [
      { x: -1.28, y: 0.95, z: -3.0, radius: 0.42, capacity: 380 },
      { x: 1.28, y: 0.95, z: -3.0, radius: 0.42, capacity: 380 },
    ],
    mass: 16500, peakTorque: 2400, peakTorqueRpm: 1400, redlineRpm: 2300, idleRpm: 560,
    gearRatios: [8.2, 5.4, 3.6, 2.4, 1.6, 1.15, 0.86], finalDrive: 4.1,
    topSpeed: 34, drivetrain: "rwd", tyreGrip: 1.0, brakeTorque: 22000, maxSteer: 0.42,
    integrity: 5200, fuel: 760,
  }),

  police: def({
    kind: "police", label: "Police Cruiser",
    length: 5.02, width: 1.96, height: 1.53, clearance: 0.16,
    frontZ: -1.5, rearZ: 1.5, wheelRadius: 0.36, wheelWidth: 0.25, track: 1.62,
    cabinFrontZ: -0.44, cabinRearZ: 1.32, beltline: 1.06, roof: 1.53, bonnet: 0.98,
    boxiness: 0.42, tumblehome: 0.15,
    livery: "police", palette: [0xe9eaec], lightbar: true, pushbar: true,
    mass: 1930, peakTorque: 480, peakTorqueRpm: 4200, redlineRpm: 6800,
    topSpeed: 71, drivetrain: "rwd", tyreGrip: 1.56, brakeTorque: 6400,
    integrity: 1150, fuel: 72,
  }),

  swatvan: def({
    kind: "swatvan", label: "SWAT Van",
    length: 6.25, width: 2.26, height: 2.68, clearance: 0.28,
    frontZ: -1.94, rearZ: 1.88, wheelRadius: 0.44, wheelWidth: 0.32, track: 1.86,
    suspension: 0.44,
    cabinFrontZ: -1.9, cabinRearZ: -0.5, beltline: 1.66, roof: 2.68, bonnet: 1.52,
    boxiness: 1, tumblehome: 0.04, boxBody: true, lightbar: true, pushbar: true,
    livery: "swat", palette: [0x23282e],
    doors: [
      { side: -1, z0: -1.84, z1: -0.66, y0: 0.7, y1: 1.64, hinge: "front", max: 1.1 },
      { side: 1, z0: -1.84, z1: -0.66, y0: 0.7, y1: 1.64, hinge: "front", max: 1.1 },
      { side: 0, z0: 3.05, z1: 3.35, y0: 0.66, y1: 2.3, hinge: "front", max: 1.5 },
    ],
    mass: 5200, peakTorque: 780, peakTorqueRpm: 2800, redlineRpm: 4600,
    topSpeed: 42, drivetrain: "awd", tyreGrip: 1.2, brakeTorque: 8800, maxSteer: 0.48,
    integrity: 3400, fuel: 130,
  }),

  ambulance: def({
    kind: "ambulance", label: "Ambulance",
    length: 6.55, width: 2.3, height: 2.86, clearance: 0.3,
    frontZ: -2.05, rearZ: 1.96, wheelRadius: 0.44, wheelWidth: 0.28, track: 1.92,
    suspension: 0.44,
    cabinFrontZ: -2.0, cabinRearZ: -0.72, beltline: 1.74, roof: 2.86, bonnet: 1.58,
    boxiness: 1, tumblehome: 0.03, boxBody: true, lightbar: true,
    livery: "ambulance", palette: [0xf3f4f5],
    doors: [
      { side: -1, z0: -1.94, z1: -0.86, y0: 0.78, y1: 1.72, hinge: "front", max: 1.1 },
      { side: 1, z0: -1.94, z1: -0.86, y0: 0.78, y1: 1.72, hinge: "front", max: 1.1 },
      { side: 0, z0: 3.2, z1: 3.5, y0: 0.74, y1: 2.5, hinge: "front", max: 1.5 },
    ],
    mass: 4300, peakTorque: 700, peakTorqueRpm: 2900, redlineRpm: 4800,
    topSpeed: 45, drivetrain: "rwd", tyreGrip: 1.14, brakeTorque: 8000, maxSteer: 0.5,
    integrity: 2400, fuel: 130,
  }),

  firetruck: def({
    kind: "firetruck", klass: "truck", label: "Fire Engine",
    length: 9.7, width: 2.52, height: 3.25, clearance: 0.38,
    frontZ: -3.1, rearZ: 2.3, tandemZ: 3.6,
    wheelRadius: 0.54, wheelWidth: 0.34, track: 2.02, suspension: 0.5,
    cabinFrontZ: -3.0, cabinRearZ: -1.1, beltline: 2.0, roof: 3.05, bonnet: 1.8,
    boxiness: 1, tumblehome: 0.02, boxBody: true, lightbar: true, ladder: true,
    livery: "fire", palette: [0xa8241d],
    doors: [
      { side: -1, z0: -2.94, z1: -1.86, y0: 1.0, y1: 1.96, hinge: "front", max: 1.1 },
      { side: 1, z0: -2.94, z1: -1.86, y0: 1.0, y1: 1.96, hinge: "front", max: 1.1 },
      { side: -1, z0: -1.7, z1: -0.6, y0: 1.0, y1: 1.96, hinge: "front", max: 1.1 },
      { side: 1, z0: -1.7, z1: -0.6, y0: 1.0, y1: 1.96, hinge: "front", max: 1.1 },
    ],
    mass: 14200, peakTorque: 1800, peakTorqueRpm: 1600, redlineRpm: 2600, idleRpm: 600,
    gearRatios: [6.6, 3.9, 2.4, 1.6, 1.1, 0.82], finalDrive: 4.4,
    topSpeed: 33, drivetrain: "awd", tyreGrip: 1.02, brakeTorque: 20000, maxSteer: 0.44,
    integrity: 5000, fuel: 380,
  }),

  bus: def({
    kind: "bus", klass: "bus", label: "MUNI Coach",
    length: 12.3, width: 2.6, height: 3.28, clearance: 0.32,
    frontZ: -4.3, rearZ: 3.3, tandemZ: 4.5,
    wheelRadius: 0.52, wheelWidth: 0.32, track: 2.1, suspension: 0.4,
    cabinFrontZ: -5.7, cabinRearZ: 5.7, beltline: 1.9, roof: 3.28, bonnet: 1.9,
    boxiness: 1, tumblehome: 0.05, trolleyPoles: true,
    livery: "muni", palette: [0xb63b2e],
    doors: [
      { side: 1, z0: -4.9, z1: -3.8, y0: 0.34, y1: 2.35, hinge: "front", max: 1.4, slide: true },
      { side: 1, z0: 1.1, z1: 2.5, y0: 0.34, y1: 2.35, hinge: "front", max: 1.4, slide: true },
    ],
    seats: [{ x: -0.72, y: 1.16, z: -5.0, driver: true }],
    mass: 12400, peakTorque: 1500, peakTorqueRpm: 1500, redlineRpm: 2400, idleRpm: 560,
    gearRatios: [5.8, 3.2, 2.0, 1.34, 1.0], finalDrive: 5.1,
    topSpeed: 27, drivetrain: "rwd", tyreGrip: 1.05, brakeTorque: 17000, maxSteer: 0.5,
    integrity: 4200, fuel: 340,
  }),

  cablecar: def({
    kind: "cablecar", klass: "rail", label: "Cable Car",
    length: 8.8, width: 2.42, height: 3.06, clearance: 0.28,
    frontZ: -2.8, rearZ: 2.8, wheelRadius: 0.35, wheelWidth: 0.15, track: 1.6,
    suspension: 0.2,
    cabinFrontZ: -3.4, cabinRearZ: 3.4, beltline: 1.6, roof: 2.92, bonnet: 1.6,
    boxiness: 1, tumblehome: 0.06, openSides: true,
    livery: "cablecar", palette: [0x8f2f28],
    seats: [{ x: 0, y: 1.05, z: -3.1, driver: true }],
    mass: 7000, peakTorque: 1400, peakTorqueRpm: 900, redlineRpm: 1600, idleRpm: 300,
    gearRatios: [6.0], finalDrive: 5.5,
    topSpeed: 6.5, drivetrain: "awd", tyreGrip: 0.95, brakeTorque: 18000, maxSteer: 0,
    integrity: 3000, fuel: 0,
    fuelTanks: [],
  }),

  taxi: def({
    kind: "taxi", label: "Taxi",
    length: 4.9, width: 1.86, height: 1.53,
    beltline: 1.05, roof: 1.53, bonnet: 0.96,
    livery: "taxi", palette: [0xf0b429], roofSign: true,
    mass: 1540, peakTorque: 340, topSpeed: 60, integrity: 1000, fuel: 60,
  }),

  motorcycle: def({
    kind: "motorcycle", klass: "bike", label: "Motorcycle",
    length: 2.16, width: 0.8, height: 1.16, clearance: 0.16,
    frontZ: -0.72, rearZ: 0.72, wheelRadius: 0.32, wheelWidth: 0.14, track: 0.0,
    suspension: 0.24,
    cabinFrontZ: -0.4, cabinRearZ: 0.4, beltline: 0.78, roof: 1.16, bonnet: 0.8,
    boxiness: 0.2, tumblehome: 0,
    palette: [0x14171b, 0x8f1d17, 0x1d3f6e, 0xd9d6cd, 0x2f5c3a],
    mass: 215, peakTorque: 118, peakTorqueRpm: 8600, redlineRpm: 12500, idleRpm: 1200,
    gearRatios: [2.85, 2.05, 1.6, 1.33, 1.14, 1.0], finalDrive: 2.9,
    topSpeed: 82, drivetrain: "rwd", tyreGrip: 1.6, brakeTorque: 1900, maxSteer: 0.72,
    integrity: 320, fuel: 17,
  }),

  helicopter: def({
    kind: "helicopter", klass: "heli", label: "Light Helicopter",
    length: 11.2, width: 2.1, height: 3.2, clearance: 0.42,
    frontZ: -4.2, rearZ: 1.2, wheelRadius: 0.2, wheelWidth: 0.12, track: 1.5,
    suspension: 0.1,
    cabinFrontZ: -4.1, cabinRearZ: -1.1, beltline: 1.62, roof: 2.42, bonnet: 1.5,
    boxiness: 0.28, tumblehome: 0.3,
    palette: [0x1d3f6e, 0xd9d6cd, 0x2b2f36, 0xa8241d, 0x2f5c3a],
    doors: [
      { side: -1, z0: -3.8, z1: -2.6, y0: 0.75, y1: 1.95, hinge: "front", max: 1.2 },
      { side: 1, z0: -3.8, z1: -2.6, y0: 0.75, y1: 1.95, hinge: "front", max: 1.2 },
    ],
    seats: [
      { x: -0.5, y: 1.05, z: -3.5, driver: true },
      { x: 0.5, y: 1.05, z: -3.5 },
      { x: -0.55, y: 1.02, z: -2.5 },
      { x: 0.55, y: 1.02, z: -2.5 },
    ],
    mass: 2400, topSpeed: 72, integrity: 900, fuel: 420,
    rotorRadius: 5.4, tailRotorRadius: 0.95,
  }),

  gunship: def({
    kind: "gunship", klass: "heli", label: "Attack Helicopter",
    length: 13.4, width: 2.6, height: 3.6, clearance: 0.5,
    frontZ: -5.0, rearZ: 1.5, wheelRadius: 0.24, wheelWidth: 0.14, track: 1.9,
    suspension: 0.1,
    cabinFrontZ: -4.9, cabinRearZ: -1.6, beltline: 1.8, roof: 2.75, bonnet: 1.6,
    boxiness: 0.4, tumblehome: 0.26,
    livery: "military", palette: [0x3d4436, 0x4a4f3c, 0x2f3229],
    chinGun: true, rocketPods: true,
    doors: [],
    seats: [
      { x: 0, y: 1.2, z: -3.0, driver: true },
      { x: 0, y: 1.5, z: -4.2, gunner: true },
    ],
    mass: 3600, topSpeed: 88, integrity: 2200, fuel: 700,
    rotorRadius: 6.2, tailRotorRadius: 1.2,
  }),

  aircraft: def({
    kind: "aircraft", klass: "plane", label: "Light Attack Aircraft",
    length: 10.4, width: 1.6, height: 3.5, clearance: 0.5,
    frontZ: -3.5, rearZ: 0.4, wheelRadius: 0.32, wheelWidth: 0.16, track: 3.0,
    suspension: 0.22,
    cabinFrontZ: -2.4, cabinRearZ: -0.4, beltline: 1.9, roof: 2.62, bonnet: 1.8,
    boxiness: 0.2, tumblehome: 0.35,
    livery: "military", palette: [0x39463a, 0x2b3340, 0x6b6f63],
    rocketPods: true, chinGun: true,
    doors: [],
    seats: [
      { x: 0, y: 1.32, z: -1.9, driver: true },
      { x: 0, y: 1.36, z: -1.05 },
    ],
    mass: 3200, topSpeed: 150, integrity: 1400, fuel: 900,
    wingSpan: 11.6, propRadius: 1.35,
  }),

  speedboat: def({
    kind: "speedboat", klass: "boat", label: "Speedboat",
    length: 8.5, width: 2.62, height: 2.1, clearance: 0,
    frontZ: 0, rearZ: 0, wheelRadius: 0, wheelWidth: 0, track: 0, suspension: 0,
    cabinFrontZ: -0.8, cabinRearZ: 1.4, beltline: 1.0, roof: 1.85, bonnet: 0.95,
    boxiness: 0.3, tumblehome: 0.3,
    palette: [0xf1f2f3, 0x1d3f6e, 0x14171b, 0xa8241d],
    doors: [],
    seats: [
      { x: -0.5, y: 0.9, z: 0.2, driver: true },
      { x: 0.5, y: 0.9, z: 0.2 },
      { x: -0.6, y: 0.88, z: 1.3 },
      { x: 0.6, y: 0.88, z: 1.3 },
    ],
    mass: 2600, topSpeed: 32, integrity: 900, fuel: 300, hullDraft: 0.62,
  }),

  jetski: def({
    kind: "jetski", klass: "boat", label: "Jet Ski",
    length: 3.25, width: 1.22, height: 1.15, clearance: 0,
    frontZ: 0, rearZ: 0, wheelRadius: 0, wheelWidth: 0, track: 0, suspension: 0,
    cabinFrontZ: -0.4, cabinRearZ: 0.6, beltline: 0.62, roof: 0.95, bonnet: 0.72,
    boxiness: 0.22, tumblehome: 0.25,
    palette: [0xe4b400, 0x0f7bbd, 0xd9302c, 0x14171b],
    doors: [],
    seats: [{ x: 0, y: 0.68, z: 0.15, driver: true }],
    mass: 360, topSpeed: 28, integrity: 220, fuel: 60, hullDraft: 0.3,
  }),
};

/* ================================================================== *
 * Physics spec derivation
 * ================================================================== *
 * One geometry, one source of truth. The suspension hard points, the wheel
 * radii and the chassis half-extents the solver uses are *computed from the
 * model*, so a wheel can never end up 8 cm inside the bodywork because two
 * files disagreed about where the axle was.
 */

/** Chassis collider half-height, and the height of its centre above the road. */
export function chassisMetrics(d: VehicleDef): { hx: number; hy: number; hz: number; originY: number } {
  const top =
    d.klass === "heli" || d.klass === "plane"
      ? d.beltline + 0.55
      : d.klass === "boat"
        ? d.beltline * 0.9
        : Math.min(d.roof, d.beltline + 0.42);
  const bottom = d.klass === "boat" ? -d.hullDraft : d.clearance;
  const hy = Math.max(0.35, (top - bottom) * 0.5);
  return {
    hx: d.width * 0.5 * (d.klass === "bike" ? 0.62 : 0.94),
    hy,
    // The semi's collider covers the tractor and the trailer as one rigid box,
    // but a box the full 16 m long would clip every kerb in Chinatown, so it is
    // deliberately short of the real overall length.
    hz: d.length * 0.5 * (d.kind === "semi" ? 0.62 : 0.96),
    originY: bottom + hy,
  };
}

/**
 * Every axle this vehicle has, front to back, as (z, steered, powered).
 * Kept in one place because the model builder, the physics spec and the
 * runtime wheel writer must agree on both the count and the order.
 */
export function axleLayout(d: VehicleDef): { z: number; steered: boolean; powered: boolean }[] {
  if (d.klass === "boat") return [];
  const rear = d.drivetrain !== "fwd";
  const front = d.drivetrain !== "rwd";
  const out = [
    { z: d.frontZ, steered: d.maxSteer > 0, powered: front },
    { z: d.rearZ, steered: false, powered: rear },
  ];
  if (d.tandemZ) out.push({ z: d.tandemZ, steered: false, powered: rear });
  if (d.trailerZ) {
    out.push({ z: d.trailerZ, steered: false, powered: false });
    out.push({ z: d.trailerZ + 1.32, steered: false, powered: false });
  }
  return out;
}

/**
 * Turn a `VehicleDef` into the drivetrain spec `vehiclePhysics.Vehicle` wants.
 *
 * Brake bias is front-heavy on everything because weight transfers forward
 * under braking; the handbrake acts only on the rearmost driven axle, which is
 * the whole reason a handbrake turn rotates the car instead of stopping it.
 */
export function toPhysicsSpec(d: VehicleDef): PhysicsVehicleSpec {
  const m = chassisMetrics(d);
  const axles = axleLayout(d);
  const wheels: WheelSpec[] = [];
  const halfTrack = (d.track || d.width * 0.8) * 0.5;
  const nPowered = Math.max(1, axles.filter((a) => a.powered).length * 2);
  const lastPowered = axles.reduce((acc, a, i) => (a.powered ? i : acc), -1);

  for (let i = 0; i < axles.length; i++) {
    const a = axles[i];
    // The front axle takes ~62% of the brake torque on a road car; heavier
    // rigs run closer to 55/45 because their rear axles carry the load.
    const front = i === 0;
    const bias = (front ? 0.62 : 0.38 / Math.max(1, axles.length - 1)) / 2;
    for (const sign of [-1, 1] as const) {
      wheels.push({
        x: sign * (d.klass === "bike" ? 0 : halfTrack),
        // Hard point sits a full suspension travel above the wheel centre.
        y: d.wheelRadius + d.suspension - m.originY,
        z: a.z,
        radius: d.wheelRadius,
        width: d.wheelWidth,
        steered: a.steered,
        powered: a.powered,
        brakeBias: bias,
        handbrake: i === lastPowered && i > 0,
        restLength: d.suspension,
        gripScale: i === 0 ? 1 : 1.04,
      });
    }
  }
  if (wheels.length === 0) {
    // Boats still need a wheel array for the type; give them one dummy that
    // never touches anything, because they are driven by `Boat`, not `Vehicle`.
    wheels.push({
      x: 0, y: -m.hy, z: 0, radius: 0.2, width: 0.1,
      steered: false, powered: false, brakeBias: 1, handbrake: false,
    });
  }

  const RHO = 1.225;
  const frontalArea = d.width * (d.height - d.clearance) * 0.82;
  const cd = d.klass === "car" ? (d.boxiness > 0.7 ? 0.42 : 0.31) : d.boxiness > 0.8 ? 0.68 : 0.4;

  return {
    mass: d.mass,
    hx: m.hx, hy: m.hy, hz: m.hz,
    // Centre of mass below the box centre and slightly rearward. A low COM is
    // the single most effective anti-rollover measure there is, and SF's
    // camber will find any vehicle that does not have one.
    comY: -m.hy * 0.55,
    comZ: 0.04 * d.length * 0.1,
    wheels,
    peakTorque: d.peakTorque,
    peakTorqueRpm: d.peakTorqueRpm,
    idleRpm: d.idleRpm,
    redlineRpm: d.redlineRpm,
    gearRatios: d.gearRatios,
    reverseRatio: d.gearRatios[0] * 0.92,
    finalDrive: d.finalDrive,
    efficiency: 0.88,
    shiftTime: d.klass === "car" ? 0.2 : 0.42,
    maxSteer: d.maxSteer,
    steerRate: d.klass === "car" ? 3.4 : 2.2,
    steerSpeedFalloff: 22,
    brakeTorque: d.brakeTorque,
    handbrakeTorque: d.brakeTorque * 0.62,
    tyreGrip: d.tyreGrip,
    loadSensitivity: 0.28,
    pacejkaB: d.kind === "sports" ? 9.6 : 8.6,
    pacejkaC: 1.36,
    pacejkaE: d.kind === "sports" ? 0.86 : 0.94,
    antiRollFront: d.mass * 15,
    antiRollRear: d.mass * 10,
    dragArea: 0.5 * RHO * cd * frontalArea,
    downforceArea: d.kind === "sports" ? 0.5 * RHO * 0.42 * 2.0 : 0.5 * RHO * 0.06 * frontalArea,
    maxSpeed: d.topSpeed,
  };
}

/* ================================================================== *
 * Geometry builder
 * ================================================================== */

/**
 * Surface classes. Each becomes one mesh with one material — which is what
 * lets a brake light be genuinely emissive while the paint next to it is
 * genuinely metallic, instead of both being branches in one shader.
 */
export type Channel =
  | "paint"
  | "trim"
  | "chrome"
  | "rubber"
  | "glass"
  | "glassSide"
  | "interior"
  | "lampHead"
  | "lampTail"
  | "lampRev"
  | "lampIndL"
  | "lampIndR"
  | "sirenA"
  | "sirenB";

const CHANNELS: Channel[] = [
  "paint", "trim", "chrome", "rubber", "glass", "glassSide", "interior",
  "lampHead", "lampTail", "lampRev", "lampIndL", "lampIndR", "sirenA", "sirenB",
];

class Chunk {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  wear: number[] = [];
  idx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  v(x: number, y: number, z: number, u = 0, w = 0, wear = 0): number {
    const i = this.count;
    this.pos.push(x, y, z);
    this.nrm.push(0, 0, 0);
    this.uv.push(u, w);
    this.wear.push(wear);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }
}

/** One rigid sub-object: the shell, a wheel, a door, a rotor. */
class Part {
  chunks = new Map<Channel, Chunk>();
  constructor(
    readonly name: string,
    readonly px: number,
    readonly py: number,
    readonly pz: number,
  ) {}
  chunk(c: Channel): Chunk {
    let k = this.chunks.get(c);
    if (!k) {
      k = new Chunk();
      this.chunks.set(c, k);
    }
    return k;
  }
}

interface Station {
  z: number;
  halfW: number;
  yLow: number;
  yHigh: number;
  box: number;
  /** Half-width multiplier at the top of the section. */
  taperTop?: number;
  wear?: number;
}

/** Quad rejection test used to cut apertures out of a loft. */
type CutFn = (z: number, y: number, xSign: number) => boolean;

class ModelBuilder {
  parts: Part[] = [];
  cur: Part;

  constructor() {
    this.cur = new Part("body", 0, 0, 0);
    this.parts.push(this.cur);
  }

  part(name: string, px = 0, py = 0, pz = 0): Part {
    const p = new Part(name, px, py, pz);
    this.parts.push(p);
    this.cur = p;
    return p;
  }

  use(p: Part): void {
    this.cur = p;
  }

  body(): Part {
    this.cur = this.parts[0];
    return this.cur;
  }

  /* -------------------- primitives -------------------- */

  /** Axis-aligned box. `bevel` chamfers the vertical edges — free realism. */
  box(
    c: Channel,
    cx: number, cy: number, cz: number,
    sx: number, sy: number, sz: number,
    wear = 0,
    bevel = 0,
  ): void {
    const k = this.cur.chunk(c);
    const hx = sx * 0.5;
    const hy = sy * 0.5;
    const hz = sz * 0.5;
    if (bevel <= 0) {
      const s = k.count;
      const corner = [
        [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz],
        [-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz], [-hx, hy, hz],
      ];
      for (let i = 0; i < 8; i++) {
        k.v(cx + corner[i][0], cy + corner[i][1], cz + corner[i][2], (i & 1), (i >> 2) & 1, wear);
      }
      k.quad(s + 0, s + 3, s + 2, s + 1);
      k.quad(s + 4, s + 5, s + 6, s + 7);
      k.quad(s + 0, s + 1, s + 5, s + 4);
      k.quad(s + 1, s + 2, s + 6, s + 5);
      k.quad(s + 2, s + 3, s + 7, s + 6);
      k.quad(s + 3, s + 0, s + 4, s + 7);
      return;
    }
    // Bevelled: two rings inset in x/z, joined by a chamfer band.
    const b = Math.min(bevel, Math.min(hx, hz) * 0.8, hy * 0.8);
    const rings: number[][] = [];
    const levels: [number, number][] = [
      [-hy, b], [-hy + b, 0], [hy - b, 0], [hy, b],
    ];
    for (const [y, inset] of levels) {
      const ring: number[] = [];
      const ax = hx - inset;
      const az = hz - inset;
      const pts: [number, number][] = [
        [-ax, -az], [ax, -az], [ax, az], [-ax, az],
      ];
      for (let i = 0; i < 4; i++) {
        ring.push(k.v(cx + pts[i][0], cy + y, cz + pts[i][1], i / 4, (y + hy) / (2 * hy), wear));
      }
      rings.push(ring);
    }
    for (let r = 0; r < rings.length - 1; r++) {
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        k.quad(rings[r][i], rings[r][j], rings[r + 1][j], rings[r + 1][i]);
      }
    }
    // Caps.
    const bot = k.v(cx, cy - hy, cz, 0.5, 0, wear);
    const top = k.v(cx, cy + hy, cz, 0.5, 1, wear);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      k.tri(bot, rings[0][j], rings[0][i]);
      k.tri(top, rings[3][i], rings[3][j]);
    }
  }

  /** A convex quad in space — windscreens, panels, wings. */
  plate(
    c: Channel,
    p0: number[], p1: number[], p2: number[], p3: number[],
    wear = 0,
    twoSided = false,
  ): void {
    const k = this.cur.chunk(c);
    const a = k.v(p0[0], p0[1], p0[2], 0, 0, wear);
    const b = k.v(p1[0], p1[1], p1[2], 1, 0, wear);
    const d = k.v(p2[0], p2[1], p2[2], 1, 1, wear);
    const e = k.v(p3[0], p3[1], p3[2], 0, 1, wear);
    k.quad(a, b, d, e);
    if (twoSided) k.quad(e, d, b, a);
  }

  /** Cylinder along a principal axis. */
  cyl(
    c: Channel,
    axis: "x" | "y" | "z",
    cx: number, cy: number, cz: number,
    r: number, len: number,
    seg = 12,
    wear = 0,
    caps = true,
    r2 = r,
  ): void {
    const k = this.cur.chunk(c);
    const h = len * 0.5;
    const ringA: number[] = [];
    const ringB: number[] = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      let ax: number, ay: number, az: number, bx: number, by: number, bz: number;
      if (axis === "x") {
        ax = cx - h; ay = cy + sa * r; az = cz + ca * r;
        bx = cx + h; by = cy + sa * r2; bz = cz + ca * r2;
      } else if (axis === "y") {
        ax = cx + ca * r; ay = cy - h; az = cz + sa * r;
        bx = cx + ca * r2; by = cy + h; bz = cz + sa * r2;
      } else {
        ax = cx + ca * r; ay = cy + sa * r; az = cz - h;
        bx = cx + ca * r2; by = cy + sa * r2; bz = cz + h;
      }
      ringA.push(k.v(ax, ay, az, i / seg, 0, wear));
      ringB.push(k.v(bx, by, bz, i / seg, 1, wear));
    }
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      k.quad(ringA[i], ringA[j], ringB[j], ringB[i]);
    }
    if (caps) {
      const ca = k.v(cx - (axis === "x" ? h : 0), cy - (axis === "y" ? h : 0), cz - (axis === "z" ? h : 0), 0.5, 0.5, wear);
      const cb = k.v(cx + (axis === "x" ? h : 0), cy + (axis === "y" ? h : 0), cz + (axis === "z" ? h : 0), 0.5, 0.5, wear);
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        k.tri(ca, ringA[j], ringA[i]);
        k.tri(cb, ringB[i], ringB[j]);
      }
    }
  }

  /**
   * A road wheel authored around the origin, axle along X.
   * Tyre sidewall + tread + a dished rim with spokes: three cheap rings that
   * between them are the difference between "wheel" and "black cylinder".
   */
  wheel(r: number, w: number, seg = 20, chrome = true): void {
    const tyre = this.cur.chunk("rubber");
    const rim = this.cur.chunk(chrome ? "chrome" : "trim");
    const hw = w * 0.5;
    const shoulder = r * 0.92;
    const ringsSpec: [number, number][] = [
      [-hw, shoulder], [-hw * 0.78, r], [hw * 0.78, r], [hw, shoulder],
    ];
    const rings: number[][] = [];
    for (const [x, rr] of ringsSpec) {
      const ring: number[] = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        ring.push(tyre.v(x, Math.sin(a) * rr, Math.cos(a) * rr, i / seg, (x + hw) / w, 0.35));
      }
      rings.push(ring);
    }
    for (let s = 0; s < rings.length - 1; s++) {
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        tyre.quad(rings[s][i], rings[s][j], rings[s + 1][j], rings[s + 1][i]);
      }
    }
    // Rim: an outer barrel and a dished face with spokes, one per side.
    for (const sign of [-1, 1] as const) {
      const faceX = sign * hw * 0.9;
      const rimR = r * 0.66;
      const hubR = r * 0.2;
      const outer: number[] = [];
      const inner: number[] = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        outer.push(rim.v(faceX, Math.sin(a) * rimR, Math.cos(a) * rimR, i / seg, 1, 0.15));
        inner.push(rim.v(faceX - sign * r * 0.1, Math.sin(a) * hubR, Math.cos(a) * hubR, i / seg, 0, 0.15));
      }
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        if (sign > 0) rim.quad(outer[i], outer[j], inner[j], inner[i]);
        else rim.quad(inner[i], inner[j], outer[j], outer[i]);
      }
      // Five spoke slots read as a wheel even in silhouette.
      const hub = rim.v(faceX - sign * r * 0.12, 0, 0, 0.5, 0.5, 0.1);
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        if (sign > 0) rim.tri(hub, inner[i], inner[j]);
        else rim.tri(hub, inner[j], inner[i]);
      }
    }
  }

  /**
   * Loft a closed tube through a list of cross-sections.
   *
   * This is the workhorse: car bodies, boat hulls, fuselages and bus shells are
   * all the same sweep with different numbers. `cut` lets a caller punch
   * apertures (doors, wheel arches) straight out of the surface, which is the
   * only way to get a car that a door can open *into*.
   */
  loft(
    c: Channel,
    stations: Station[],
    nPts: number,
    capFront = true,
    capBack = true,
    cut?: CutFn,
  ): void {
    const k = this.cur.chunk(c);
    const rings: number[][] = [];
    const ringPts: number[][][] = [];
    for (let s = 0; s < stations.length; s++) {
      const st = stations[s];
      const ring: number[] = [];
      const pts: number[][] = [];
      for (let i = 0; i < nPts; i++) {
        const t = i / nPts;
        const p = sectionPoint(t, st.halfW, st.yLow, st.yHigh, st.box, st.taperTop ?? 0);
        // Road film accumulates from the bottom up; the sills are filthy, the
        // roof is merely dusty.
        const h = (p[1] - st.yLow) / Math.max(0.01, st.yHigh - st.yLow);
        const wear = (st.wear ?? 0) + (1 - h) * 0.45;
        ring.push(k.v(p[0], p[1], st.z, t, s / Math.max(1, stations.length - 1), clamp01(wear)));
        pts.push(p);
      }
      rings.push(ring);
      ringPts.push(pts);
    }
    for (let s = 0; s < rings.length - 1; s++) {
      for (let i = 0; i < nPts; i++) {
        const j = (i + 1) % nPts;
        if (cut) {
          const a = ringPts[s][i];
          const b = ringPts[s + 1][j];
          const mz = (stations[s].z + stations[s + 1].z) * 0.5;
          const my = (a[1] + b[1]) * 0.5;
          const mx = (a[0] + b[0]) * 0.5;
          // Only side-facing quads may be cut; a horizontal roof panel that
          // happens to overlap the door rectangle must survive.
          const sideness = Math.abs(mx) / Math.max(0.05, stations[s].halfW);
          if (sideness > 0.72 && cut(mz, my, Math.sign(mx) || 1)) continue;
        }
        k.quad(rings[s][i], rings[s][j], rings[s + 1][j], rings[s + 1][i]);
      }
    }
    if (capFront) this.capRing(k, rings[0], stations[0], nPts, true);
    if (capBack) this.capRing(k, rings[rings.length - 1], stations[stations.length - 1], nPts, false);
  }

  private capRing(k: Chunk, ring: number[], st: Station, nPts: number, front: boolean): void {
    const cy = (st.yLow + st.yHigh) * 0.5;
    const c = k.v(0, cy, st.z, 0.5, 0.5, 0.2);
    for (let i = 0; i < nPts; i++) {
      const j = (i + 1) % nPts;
      if (front) k.tri(c, ring[j], ring[i]);
      else k.tri(c, ring[i], ring[j]);
    }
  }

  /**
   * The flared lip around a wheel arch, plus the wheel well behind it.
   * Without the well you see straight through the arch into the cabin, which
   * is the sort of thing that only ever gets noticed in a screenshot.
   */
  arch(cx: number, cz: number, r: number, halfW: number, sign: number, wellDepth: number): void {
    const paint = this.cur.chunk("paint");
    const well = this.cur.chunk("interior");
    const seg = 12;
    const inner: number[] = [];
    const outer: number[] = [];
    const wellIn: number[] = [];
    const x0 = sign * (halfW - 0.015);
    const x1 = sign * (halfW + 0.032);
    const xw = sign * (halfW - wellDepth);
    for (let i = 0; i <= seg; i++) {
      const a = Math.PI * (i / seg);
      const y = cx + Math.sin(a) * r;
      const z = cz - Math.cos(a) * r;
      inner.push(paint.v(x0, y, z, i / seg, 0, 0.6));
      outer.push(paint.v(x1, y, z, i / seg, 1, 0.75));
      wellIn.push(well.v(xw, y, z, i / seg, 0, 0.9));
    }
    for (let i = 0; i < seg; i++) {
      if (sign > 0) paint.quad(inner[i], inner[i + 1], outer[i + 1], outer[i]);
      else paint.quad(outer[i], outer[i + 1], inner[i + 1], inner[i]);
    }
    // Well: a half tube from the arch lip inboard.
    const wellOut: number[] = [];
    for (let i = 0; i <= seg; i++) wellOut.push(well.v(x0, paint.pos[inner[i] * 3 + 1], paint.pos[inner[i] * 3 + 2], i / seg, 1, 0.9));
    for (let i = 0; i < seg; i++) {
      if (sign > 0) well.quad(wellOut[i], wellOut[i + 1], wellIn[i + 1], wellIn[i]);
      else well.quad(wellIn[i], wellIn[i + 1], wellOut[i + 1], wellOut[i]);
    }
  }
}

/**
 * A superellipse cross-section with optional tumblehome.
 *
 * `box` 0 is a true ellipse (a 1960s coupé shoulder); 1 is very nearly a
 * rectangle (a bus). `taperTop` pulls the section in as it rises, which is what
 * gives a glasshouse its tumblehome and stops a car reading as a shoebox.
 */
function sectionPoint(
  t: number,
  halfW: number,
  yLow: number,
  yHigh: number,
  box: number,
  taperTop: number,
): number[] {
  const a = t * Math.PI * 2;
  const cy = (yLow + yHigh) * 0.5;
  const ry = (yHigh - yLow) * 0.5;
  const ex = Math.cos(a);
  const ey = Math.sin(a);
  const n = 2 + box * 4.6;
  const inv = 2 / n;
  const bx = Math.sign(ex) * Math.pow(Math.abs(ex), inv);
  const by = Math.sign(ey) * Math.pow(Math.abs(ey), inv);
  const y = cy + by * ry;
  const h = ry > 1e-4 ? clamp01((y - yLow) / (yHigh - yLow)) : 0;
  const shrink = 1 - taperTop * h * h;
  return [bx * halfW * shrink, y];
}

function smooth01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/* ================================================================== *
 * Per-kind construction
 * ================================================================== */

/**
 * Longitudinal stations for a car's lower body.
 *
 * Extra stations are inserted around each axle so the arch cut has enough
 * resolution to be an arch rather than a rectangle. Everything else is a
 * hand-placed set of fractions that puts vertices where the shape changes:
 * the nose, the cowl, the A-pillar base, the C-pillar base, the tail.
 */
function carStations(d: VehicleDef): Station[] {
  const halfL = d.length * 0.5;
  const zs = new Set<number>();
  const key = [-1, -0.96, -0.88, -0.74, -0.58, -0.36, -0.12, 0.12, 0.36, 0.58, 0.74, 0.88, 0.96, 1];
  for (const f of key) zs.add(+(f * halfL).toFixed(4));
  for (const az of [d.frontZ, d.rearZ, d.tandemZ, d.trailerZ]) {
    if (!az) continue;
    const r = d.wheelRadius * 1.28;
    for (const o of [-1.14, -0.8, -0.45, 0, 0.45, 0.8, 1.14]) {
      const z = az + o * r;
      if (z > -halfL && z < halfL) zs.add(+z.toFixed(4));
    }
  }
  const sorted = Array.from(zs).sort((a, b) => a - b);
  const out: Station[] = [];
  const sill = d.clearance + 0.02;
  for (const z of sorted) {
    const f = z / halfL; // −1 nose … +1 tail
    // Plan taper: full width through the doors, drawn in at both extremities.
    const edge = Math.min(1, (1 - Math.abs(f)) * 6.5);
    const plan = 0.6 + 0.4 * Math.pow(edge, 0.55);
    // Height profile: bonnet at the nose, beltline through the cabin, a boot
    // lid that sits a touch lower than the belt.
    let yHigh: number;
    if (f < -0.1) {
      const t = smooth01((f + 1) / 0.9);
      yHigh = d.bonnet * (0.86 + 0.14 * t) + (d.beltline - d.bonnet) * smooth01((z - d.cabinFrontZ + 0.7) / 0.7);
    } else {
      const t = smooth01((z - d.cabinRearZ) / 0.9);
      yHigh = d.beltline - t * (d.beltline - d.bonnet) * 0.42;
    }
    yHigh = Math.min(d.beltline + 0.02, Math.max(d.bonnet * 0.8, yHigh));
    out.push({
      z,
      halfW: d.width * 0.5 * plan,
      yLow: sill + (Math.abs(f) > 0.93 ? 0.05 : 0),
      yHigh,
      box: d.boxiness,
      taperTop: 0.06,
    });
  }
  return out;
}

/** Cut apertures: wheel arches on every axle, plus every swinging door. */
function makeCut(d: VehicleDef): CutFn {
  const axles = axleLayout(d).map((a) => a.z);
  const archR = d.wheelRadius * 1.24;
  const archY = d.wheelRadius + 0.02;
  const doors = d.doors.filter((x) => x.side !== 0 && !x.slide);
  return (z, y, xSign) => {
    for (const az of axles) {
      const dz = z - az;
      const dy = y - archY;
      if (dy > -0.02 && dz * dz + dy * dy < archR * archR) return true;
      // The bit under the axle line is inside the wheel too.
      if (dy <= -0.02 && Math.abs(dz) < archR * 0.86 && y < archY) return true;
    }
    for (const dd of doors) {
      if (dd.side !== xSign) continue;
      if (z > dd.z0 && z < dd.z1 && y > dd.y0 && y < dd.y1) return true;
    }
    return false;
  };
}

/** Seats, dash, wheel, headliner — the thing you see through the glass. */
function buildInterior(b: ModelBuilder, d: VehicleDef): void {
  b.body();
  const floorY = d.clearance + 0.16;
  const cabZ0 = d.cabinFrontZ;
  const cabZ1 = d.cabinRearZ;
  const cabLen = Math.max(0.6, cabZ1 - cabZ0);
  const halfW = d.width * 0.5 - 0.09;

  // Floor pan + rear bulkhead + headliner. A closed dark box behind the glass
  // is what stops windows reading as holes into the skybox.
  b.box("interior", 0, floorY, (cabZ0 + cabZ1) * 0.5, halfW * 2, 0.06, cabLen, 0.8);
  b.box("interior", 0, (floorY + d.beltline) * 0.5, cabZ1 + 0.02, halfW * 2, d.beltline - floorY, 0.08, 0.7);
  if (d.roof > d.beltline + 0.2 && !d.openSides) {
    b.box("interior", 0, d.roof - 0.045, (cabZ0 + cabZ1) * 0.5, halfW * 1.86, 0.05, cabLen * 0.95, 0.2);
  }

  // Dashboard: a swept top pad, a binnacle, a centre stack.
  const dashZ = cabZ0 + 0.12;
  b.box("interior", 0, d.beltline - 0.16, dashZ, halfW * 1.9, 0.22, 0.34, 0.25);
  b.box("trim", 0, d.beltline - 0.3, dashZ + 0.16, halfW * 1.5, 0.34, 0.1, 0.3);

  for (const s of d.seats) {
    const seatY = s.y;
    const sw = d.klass === "bus" || d.klass === "rail" ? 0.44 : 0.5;
    // Cushion, back, headrest, and two bolsters so it is not a lump.
    b.box("interior", s.x, seatY, s.z, sw, 0.13, 0.5, 0.3, 0.03);
    b.box("interior", s.x, seatY + 0.32, s.z + 0.24, sw, 0.56, 0.12, 0.3, 0.03);
    b.box("interior", s.x, seatY + 0.66, s.z + 0.22, sw * 0.5, 0.16, 0.11, 0.3, 0.02);
    b.box("interior", s.x - sw * 0.46, seatY + 0.3, s.z + 0.1, 0.06, 0.44, 0.36, 0.3);
    b.box("interior", s.x + sw * 0.46, seatY + 0.3, s.z + 0.1, 0.06, 0.44, 0.36, 0.3);
    if (s.driver) {
      // Steering wheel: rim ring plus three spokes and a boss.
      const wy = seatY + 0.5;
      const wz = s.z - 0.42;
      const rimR = d.klass === "bus" || d.klass === "truck" ? 0.26 : 0.19;
      const seg = 16;
      const k = b.cur.chunk("trim");
      const ringA: number[] = [];
      const ringB: number[] = [];
      const tilt = 0.42;
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const rx = Math.cos(a) * rimR;
        const ry = Math.sin(a) * rimR;
        // Tilt the wheel back about X.
        const y = wy + ry * Math.cos(tilt);
        const z = wz + ry * Math.sin(tilt);
        ringA.push(k.v(s.x + rx, y - 0.018, z - 0.014, i / seg, 0, 0.2));
        ringB.push(k.v(s.x + rx, y + 0.018, z + 0.014, i / seg, 1, 0.2));
      }
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        k.quad(ringA[i], ringA[j], ringB[j], ringB[i]);
      }
      b.box("trim", s.x, wy, wz, rimR * 1.7, 0.03, 0.03, 0.2);
      b.box("trim", s.x, wy - rimR * 0.55, wz, 0.03, rimR, 0.03, 0.2);
      b.box("chrome", s.x, wy, wz, 0.09, 0.09, 0.05, 0.1);
      // Gear lever and pedals — small, but they are what sell an interior.
      if (d.klass === "car") {
        b.box("trim", s.x + 0.3, d.beltline - 0.42, s.z - 0.2, 0.05, 0.22, 0.05, 0.2);
        b.box("chrome", s.x + 0.3, d.beltline - 0.3, s.z - 0.2, 0.06, 0.06, 0.06, 0.1);
      }
    }
  }
}

/** Headlamps, tail lamps, indicators, reverse lamps and their surrounds. */
function buildLamps(b: ModelBuilder, d: VehicleDef): void {
  b.body();
  const halfL = d.length * 0.5;
  const hw = d.width * 0.5;
  const lampY = Math.max(d.clearance + 0.34, d.bonnet - 0.28);
  const noseZ = -halfL + 0.06;
  const tailZ = halfL - 0.06;

  const headW = d.boxiness > 0.8 ? 0.34 : 0.42;
  for (const sx of [-1, 1] as const) {
    // Headlamp: a lens, a chrome bezel and a small amber corner indicator.
    b.box("lampHead", sx * hw * 0.62, lampY, noseZ, headW, 0.2, 0.1, 0);
    b.box("chrome", sx * hw * 0.62, lampY, noseZ + 0.06, headW + 0.05, 0.25, 0.06, 0.1);
    b.box(sx < 0 ? "lampIndL" : "lampIndR", sx * (hw * 0.62 + headW * 0.5 + 0.06), lampY, noseZ + 0.01, 0.12, 0.16, 0.08, 0);
    // Tail cluster: red lamp, amber indicator outboard, white reverse inboard.
    b.box("lampTail", sx * hw * 0.66, lampY + 0.14, tailZ, 0.3, 0.2, 0.09, 0);
    b.box(sx < 0 ? "lampIndL" : "lampIndR", sx * (hw * 0.66 + 0.2), lampY + 0.14, tailZ, 0.12, 0.18, 0.08, 0);
    b.box("lampRev", sx * (hw * 0.66 - 0.2), lampY + 0.06, tailZ, 0.1, 0.09, 0.08, 0);
  }
  // Grille + number plates.
  b.box("trim", 0, lampY + 0.04, noseZ + 0.02, hw * 0.86, 0.2, 0.07, 0.3);
  b.box("chrome", 0, lampY - 0.2, noseZ + 0.02, 0.36, 0.12, 0.05, 0.2);
  b.box("chrome", 0, lampY - 0.06, tailZ, 0.36, 0.12, 0.05, 0.25);
}

/** Bumpers, sills, mirrors, door handles, exhaust. */
function buildTrim(b: ModelBuilder, d: VehicleDef): void {
  b.body();
  const halfL = d.length * 0.5;
  const hw = d.width * 0.5;
  const bumperY = d.clearance + 0.28;
  b.box("trim", 0, bumperY, -halfL + 0.1, d.width * 0.93, 0.3, 0.2, 0.5, 0.05);
  b.box("trim", 0, bumperY, halfL - 0.1, d.width * 0.93, 0.3, 0.2, 0.6, 0.05);
  // Rocker panels: the dirtiest thing on any car.
  for (const sx of [-1, 1] as const) {
    b.box("trim", sx * (hw - 0.03), d.clearance + 0.12, (d.cabinFrontZ + d.cabinRearZ) * 0.5,
      0.06, 0.14, Math.max(0.8, d.cabinRearZ - d.cabinFrontZ), 1.0);
    // Wing mirror on a stalk — the silhouette misses it badly when absent.
    if (!d.openSides && d.klass !== "bike") {
      b.box("trim", sx * (hw + 0.03), d.beltline + 0.02, d.cabinFrontZ + 0.16, 0.08, 0.05, 0.1, 0.2);
      b.box("trim", sx * (hw + 0.13), d.beltline + 0.06, d.cabinFrontZ + 0.16, 0.13, 0.12, 0.06, 0.2);
      b.box("chrome", sx * (hw + 0.19), d.beltline + 0.06, d.cabinFrontZ + 0.16, 0.02, 0.1, 0.05, 0);
    }
  }
  // Exhaust — a chrome tip at the offside rear, and the sooty pipe behind it.
  if (d.fuel > 0 && d.klass !== "heli" && d.klass !== "plane") {
    const ex = d.klass === "truck" || d.klass === "bus" ? 0 : hw * 0.6;
    b.cyl("chrome", "z", ex, d.clearance + 0.06, halfL - 0.02, 0.045, 0.16, 8, 0.4);
  }
}

/**
 * The greenhouse — built as discrete panels rather than lofted, because a
 * windscreen, a quarter light and a C-pillar are genuinely different surfaces
 * and a single sweep can only ever approximate all three.
 */
function buildGreenhouse(b: ModelBuilder, d: VehicleDef): void {
  if (d.roof <= d.beltline + 0.12 || d.openSides) return;
  b.body();
  const z0 = d.cabinFrontZ;
  const z1 = d.cabinRearZ;
  const belt = d.beltline;
  const roof = d.roof;
  const hw = d.width * 0.5;
  const roofHalf = hw * (1 - d.tumblehome) - 0.02;
  const glassHalf = hw - 0.035;

  // Windscreen rake: a saloon is ~30° from vertical, a van nearly upright.
  const rake = 0.42 * (1 - d.boxiness) + 0.1;
  const wsBase = z0 + 0.02;
  const wsTop = z0 + (roof - belt) * rake + 0.14;
  const rwBase = z1 - 0.02;
  const rwTop = z1 - (roof - belt) * rake * 0.86 - 0.1;

  // Roof panel with a slight crown.
  const crown = 0.03;
  b.plate("paint",
    [-roofHalf, roof, wsTop], [roofHalf, roof, wsTop],
    [roofHalf, roof, rwTop], [-roofHalf, roof, rwTop], 0.15);
  b.box("paint", 0, roof - crown * 0.5, (wsTop + rwTop) * 0.5, roofHalf * 2, crown, Math.max(0.2, rwTop - wsTop), 0.15);

  // Windscreen and backlight.
  b.plate("glass",
    [-glassHalf * 0.94, belt, wsBase], [glassHalf * 0.94, belt, wsBase],
    [roofHalf, roof, wsTop], [-roofHalf, roof, wsTop], 0.1);
  b.plate("glass",
    [-roofHalf, roof, rwTop], [roofHalf, roof, rwTop],
    [glassHalf * 0.94, belt, rwBase], [-glassHalf * 0.94, belt, rwBase], 0.1);

  // Side glass, split at the B-pillar so a four-door reads as a four-door.
  const split = d.doors.length >= 4 ? (d.doors[0].z1 + d.doors[2].z0) * 0.5 : null;
  for (const sx of [-1, 1] as const) {
    const xb = sx * glassHalf;
    const xt = sx * roofHalf;
    const segs: [number, number][] = split
      ? [[wsTop + 0.02, split - 0.03], [split + 0.03, rwTop - 0.02]]
      : [[wsTop + 0.02, rwTop - 0.02]];
    for (const [a, c] of segs) {
      if (c - a < 0.1) continue;
      b.plate("glassSide",
        [xb, belt, a], [xb, belt, c], [xt, roof - 0.03, c], [xt, roof - 0.03, a], 0.1, true);
    }
    // Pillars: A, B and C. Thin paint prisms following the glass edge.
    b.plate("paint",
      [xb - sx * 0.01, belt, wsBase], [xb - sx * 0.01, belt, wsTop + 0.06],
      [xt - sx * 0.01, roof, wsTop + 0.02], [xt - sx * 0.01, roof, wsTop - 0.06], 0.2, true);
    b.plate("paint",
      [xb - sx * 0.01, belt, rwTop - 0.06], [xb - sx * 0.01, belt, rwBase],
      [xt - sx * 0.01, roof, rwTop + 0.06], [xt - sx * 0.01, roof, rwTop - 0.02], 0.2, true);
    if (split !== null) {
      b.box("paint", xb - sx * 0.012, (belt + roof) * 0.5, split, 0.03, roof - belt, 0.07, 0.2);
    }
    // Belt line moulding — the horizontal chrome strip under the glass.
    b.box("chrome", xb + sx * 0.005, belt - 0.02, (wsTop + rwTop) * 0.5, 0.02, 0.03, Math.max(0.2, rwTop - wsTop), 0.15);
  }
}

/** Rebuild each aperture as a hinged panel that swings. */
function buildDoors(b: ModelBuilder, d: VehicleDef): void {
  const hw = d.width * 0.5;
  for (let i = 0; i < d.doors.length; i++) {
    const dd = d.doors[i];
    const hingeZ = dd.hinge === "front" ? dd.z0 : dd.z1;
    const cz = (dd.z0 + dd.z1) * 0.5;
    const cy = (dd.y0 + dd.y1) * 0.5;
    if (dd.side === 0) {
      // Rear cargo / roll-up door on the centre line.
      const p = b.part(`door${i}`, 0, dd.hinge === "top" ? dd.y1 : cy, dd.z0);
      const w = d.width * 0.9;
      b.box("paint", 0, cy - (dd.hinge === "top" ? dd.y1 : cy), 0, w, dd.y1 - dd.y0, 0.06, 0.5);
      b.box("trim", 0, cy - (dd.hinge === "top" ? dd.y1 : cy), -0.04, w * 0.92, (dd.y1 - dd.y0) * 0.9, 0.03, 0.7);
      void p;
      continue;
    }
    const x = dd.side * (hw - 0.012);
    b.part(`door${i}`, x, cy, hingeZ);
    const len = dd.z1 - dd.z0;
    const h = dd.y1 - dd.y0;
    // Outer skin, inner card, window frame, handle.
    b.box("paint", 0, 0, cz - hingeZ, 0.05, h, len, 0.55);
    b.box("interior", -dd.side * 0.05, 0, cz - hingeZ, 0.05, h * 0.94, len * 0.96, 0.4);
    b.box("trim", -dd.side * 0.02, -h * 0.4, cz - hingeZ, 0.08, h * 0.16, len * 0.98, 0.95);
    b.box("chrome", dd.side * 0.035, h * 0.22, cz - hingeZ + len * 0.22, 0.035, 0.05, 0.16, 0.2);
  }
  b.body();
}

/* ---------- kind-specific bodies ---------- */

function buildCar(b: ModelBuilder, d: VehicleDef): void {
  b.body();
  const cut = makeCut(d);
  b.loft("paint", carStations(d), 26, true, true, cut);

  // Arches and wells on every axle.
  const halfL = d.length * 0.5;
  for (const a of axleLayout(d)) {
    const f = a.z / halfL;
    const edge = Math.min(1, (1 - Math.abs(f)) * 6.5);
    const halfW = d.width * 0.5 * (0.6 + 0.4 * Math.pow(edge, 0.55));
    for (const sx of [-1, 1] as const) {
      b.arch(d.wheelRadius + 0.02, a.z, d.wheelRadius * 1.24, halfW, sx, 0.16);
    }
  }

  buildGreenhouse(b, d);
  buildInterior(b, d);
  buildLamps(b, d);
  buildTrim(b, d);
  buildDoors(b, d);

  if (d.bed) {
    // Pickup bed: walls, tailgate and a ribbed floor.
    const z0 = d.cabinRearZ + 0.12;
    const z1 = halfL - 0.2;
    const hwb = d.width * 0.5 - 0.04;
    b.body();
    b.box("paint", 0, d.clearance + 0.42, (z0 + z1) * 0.5, hwb * 2 - 0.1, 0.06, z1 - z0, 0.85);
    for (const sx of [-1, 1] as const) {
      b.box("paint", sx * (hwb - 0.05), d.beltline * 0.86, (z0 + z1) * 0.5, 0.1, 0.52, z1 - z0, 0.55);
    }
    b.box("paint", 0, d.beltline * 0.86, z1 + 0.06, hwb * 2, 0.52, 0.1, 0.7);
  }

  if (d.roofSign) {
    b.body();
    b.box("lampHead", 0, d.roof + 0.11, d.cabinFrontZ + 0.5, 0.66, 0.2, 0.28, 0);
    b.box("trim", 0, d.roof + 0.02, d.cabinFrontZ + 0.5, 0.7, 0.05, 0.32, 0.2);
  }

  if (d.pushbar) {
    b.body();
    const y = d.clearance + 0.42;
    b.box("trim", 0, y, -halfL - 0.06, d.width * 0.78, 0.09, 0.1, 0.6);
    b.box("trim", 0, y + 0.3, -halfL - 0.06, d.width * 0.78, 0.09, 0.1, 0.6);
    for (const sx of [-1, 1] as const) {
      b.box("trim", sx * d.width * 0.3, y + 0.15, -halfL - 0.06, 0.09, 0.42, 0.1, 0.6);
    }
  }
}

/** Van / box truck / ambulance / SWAT / fire engine: a cab plus a box. */
function buildBoxy(b: ModelBuilder, d: VehicleDef): void {
  b.body();
  const halfL = d.length * 0.5;
  const hw = d.width * 0.5;
  const cut = makeCut(d);

  // Cab: a short loft from the nose to the back of the cab.
  const cabRear = d.cabinRearZ + 0.1;
  const cabStations: Station[] = [];
  const zs: number[] = [];
  for (let i = 0; i <= 7; i++) zs.push(-halfL + ((cabRear + halfL) * i) / 7);
  for (const az of [d.frontZ]) {
    for (const o of [-1.1, -0.7, -0.35, 0, 0.35, 0.7, 1.1]) {
      const z = az + o * d.wheelRadius * 1.28;
      if (z > -halfL && z < cabRear) zs.push(z);
    }
  }
  zs.sort((a, c) => a - c);
  for (const z of zs) {
    const f = (z + halfL) / (cabRear + halfL);
    const plan = 0.78 + 0.22 * smooth01(Math.min(1, f * 4));
    const yHigh = d.bonnet + (d.beltline + 0.55 - d.bonnet) * smooth01(Math.min(1, f * 2.6));
    cabStations.push({
      z, halfW: hw * plan, yLow: d.clearance + 0.02,
      yHigh: Math.min(d.roof, yHigh), box: Math.max(0.7, d.boxiness), taperTop: 0.05,
    });
  }
  b.loft("paint", cabStations, 22, true, false, cut);

  // Cargo box: a slab with a chamfered leading edge and a ribbed skin.
  const boxZ0 = cabRear;
  const boxZ1 = halfL;
  const boxTop = d.roof;
  const boxStations: Station[] = [];
  const bn = 6;
  for (let i = 0; i <= bn; i++) {
    const z = boxZ0 + ((boxZ1 - boxZ0) * i) / bn;
    const t = i / bn;
    boxStations.push({
      z,
      halfW: hw * (0.94 + 0.06 * smooth01(Math.min(1, t * 5))),
      yLow: d.clearance + 0.02,
      yHigh: d.beltline + (boxTop - d.beltline) * smooth01(Math.min(1, t * 5)) + (boxTop - d.beltline) * 0.0,
      box: 1,
      taperTop: 0.02,
      wear: 0.15,
    });
  }
  // Force the box to full height immediately after the cab.
  for (let i = 1; i < boxStations.length; i++) boxStations[i].yHigh = boxTop;
  b.loft("paint", boxStations, 18, false, true, cut);

  // Ribs down the flanks — the thing that stops a box truck reading as a brick.
  for (let z = boxZ0 + 0.5; z < boxZ1 - 0.3; z += 0.62) {
    for (const sx of [-1, 1] as const) {
      b.box("paint", sx * (hw * 0.96), (d.clearance + boxTop) * 0.5, z, 0.04, boxTop - d.clearance - 0.1, 0.07, 0.35);
    }
  }
  b.box("paint", 0, boxTop + 0.02, (boxZ0 + boxZ1) * 0.5, hw * 1.9, 0.05, boxZ1 - boxZ0 - 0.1, 0.25);

  for (const a of axleLayout(d)) {
    for (const sx of [-1, 1] as const) b.arch(d.wheelRadius + 0.02, a.z, d.wheelRadius * 1.26, hw * 0.95, sx, 0.18);
  }

  // Cab glass: a big upright screen and two door windows.
  const belt = d.beltline;
  const roofC = Math.min(d.roof, d.beltline + 0.72);
  const gh = hw - 0.04;
  b.plate("glass",
    [-gh * 0.92, belt, -halfL + 0.16], [gh * 0.92, belt, -halfL + 0.16],
    [gh * 0.86, roofC, -halfL + 0.42], [-gh * 0.86, roofC, -halfL + 0.42], 0.1);
  b.plate("paint",
    [-gh * 0.86, roofC, -halfL + 0.42], [gh * 0.86, roofC, -halfL + 0.42],
    [gh * 0.9, roofC, cabRear], [-gh * 0.9, roofC, cabRear], 0.2);
  for (const sx of [-1, 1] as const) {
    const dz0 = d.cabinFrontZ + 0.1;
    const dz1 = Math.min(cabRear - 0.06, d.cabinRearZ);
    b.plate("glassSide",
      [sx * gh, belt, dz0], [sx * gh, belt, dz1],
      [sx * gh * 0.96, roofC - 0.04, dz1], [sx * gh * 0.96, roofC - 0.04, dz0], 0.1, true);
  }

  buildInterior(b, d);
  buildLamps(b, d);
  buildTrim(b, d);
  buildDoors(b, d);

  if (d.ladder) {
    // Aerial ladder on a turntable — two nested box sections.
    const p = b.part("ladder", 0, d.roof + 0.26, 0.4);
    b.box("chrome", 0, 0, 0.4, 0.42, 0.16, 6.4, 0.4);
    b.box("chrome", 0, 0.2, 1.4, 0.32, 0.14, 5.2, 0.4);
    b.box("trim", 0, -0.14, -1.2, 0.9, 0.2, 0.9, 0.5);
    void p;
    b.body();
    // Pump panel + hose bed detail down the flanks.
    for (const sx of [-1, 1] as const) {
      for (let z = -0.6; z < halfL - 0.6; z += 0.9) {
        b.box("chrome", sx * (hw * 0.97), d.beltline * 0.72, z, 0.03, 0.5, 0.72, 0.3);
      }
    }
  }
}

/** MUNI coach: long, flat-fronted, lots of glass, trolley poles. */
function buildBus(b: ModelBuilder, d: VehicleDef): void {
  b.body();
  const halfL = d.length * 0.5;
  const hw = d.width * 0.5;
  const cut = makeCut(d);
  const stations: Station[] = [];
  const zs: number[] = [];
  for (let i = 0; i <= 16; i++) zs.push(-halfL + (d.length * i) / 16);
  for (const a of axleLayout(d)) {
    for (const o of [-1.1, -0.6, 0, 0.6, 1.1]) zs.push(a.z + o * d.wheelRadius * 1.26);
  }
  zs.sort((x, y) => x - y);
  for (const z of zs) {
    if (z < -halfL || z > halfL) continue;
    const f = Math.abs(z) / halfL;
    const plan = 1 - 0.14 * Math.pow(Math.max(0, (f - 0.86) / 0.14), 1.4);
    stations.push({
      z, halfW: hw * plan, yLow: d.clearance + 0.02, yHigh: d.roof,
      box: 1, taperTop: 0.1, wear: 0.2,
    });
  }
  b.loft("paint", stations, 22, true, true, cut);

  for (const a of axleLayout(d)) {
    for (const sx of [-1, 1] as const) b.arch(d.wheelRadius + 0.02, a.z, d.wheelRadius * 1.24, hw * 0.99, sx, 0.2);
  }

  // Glazing: full-length side bands plus a two-piece screen.
  const belt = d.beltline;
  const gTop = d.roof - 0.28;
  for (const sx of [-1, 1] as const) {
    let z = -halfL + 0.9;
    while (z < halfL - 1.0) {
      const w = Math.min(1.75, halfL - 1.0 - z);
      const skip = d.doors.some((dd) => dd.side === sx && z + w > dd.z0 && z < dd.z1);
      if (!skip) {
        b.plate("glassSide",
          [sx * (hw - 0.03), belt, z], [sx * (hw - 0.03), belt, z + w],
          [sx * (hw - 0.06), gTop, z + w], [sx * (hw - 0.06), gTop, z], 0.15, true);
        b.box("trim", sx * (hw - 0.02), (belt + gTop) * 0.5, z + w + 0.06, 0.05, gTop - belt, 0.12, 0.3);
      } else {
        // Door glass, in two leaves.
        b.plate("glassSide",
          [sx * (hw - 0.03), d.clearance + 0.5, z], [sx * (hw - 0.03), d.clearance + 0.5, z + w],
          [sx * (hw - 0.05), gTop, z + w], [sx * (hw - 0.05), gTop, z], 0.2, true);
      }
      z += w + 0.12;
    }
  }
  b.plate("glass",
    [-hw * 0.92, belt - 0.35, -halfL + 0.05], [hw * 0.92, belt - 0.35, -halfL + 0.05],
    [hw * 0.9, gTop, -halfL + 0.3], [-hw * 0.9, gTop, -halfL + 0.3], 0.12);
  b.plate("glass",
    [-hw * 0.9, gTop, halfL - 0.3], [hw * 0.9, gTop, halfL - 0.3],
    [hw * 0.92, belt - 0.2, halfL - 0.05], [-hw * 0.92, belt - 0.2, halfL - 0.05], 0.12);

  // Passenger bench seats — visible through all that glass.
  for (let z = -halfL + 2.4; z < halfL - 1.2; z += 1.0) {
    for (const sx of [-1, 1] as const) {
      b.box("interior", sx * (hw - 0.42), d.clearance + 0.78, z, 0.72, 0.1, 0.45, 0.4);
      b.box("interior", sx * (hw - 0.16), d.clearance + 1.06, z + 0.2, 0.2, 0.56, 0.45, 0.4);
    }
  }
  b.box("interior", 0, d.clearance + 0.4, 0, hw * 1.8, 0.05, d.length * 0.88, 0.7);
  buildInterior(b, d);
  buildLamps(b, d);
  buildTrim(b, d);
  buildDoors(b, d);

  if (d.trolleyPoles) {
    b.body();
    // Two poles laid back along the roof, plus the base pivot.
    for (const sx of [-1, 1] as const) {
      b.box("trim", sx * 0.35, d.roof + 0.26, halfL - 2.4, 0.09, 0.09, 4.4, 0.4);
      b.box("trim", sx * 0.35, d.roof + 0.1, halfL - 0.4, 0.24, 0.3, 0.5, 0.5);
    }
    // Roof hatches and a destination sign.
    b.box("lampHead", 0, d.roof - 0.42, -halfL + 0.03, hw * 1.3, 0.28, 0.05, 0);
    b.box("trim", 0, d.roof + 0.06, -halfL + 2.2, hw * 1.2, 0.12, 1.0, 0.4);
  }
}

/** The Powell & Hyde car: open sides, running boards, a grip lever. */
function buildCableCar(b: ModelBuilder, d: VehicleDef): void {
  b.body();
  const halfL = d.length * 0.5;
  const hw = d.width * 0.5;
  const floorY = d.clearance + 0.5;

  // Underframe and floor.
  b.box("trim", 0, d.clearance + 0.18, 0, d.width * 0.86, 0.28, d.length * 0.94, 0.8);
  b.box("paint", 0, floorY, 0, d.width * 0.96, 0.12, d.length * 0.96, 0.6);

  // Closed end sections, open middle — the real thing's defining shape.
  for (const sign of [-1, 1] as const) {
    const z0 = sign * 1.5;
    const z1 = sign * halfL;
    const cz = (z0 + z1) * 0.5;
    const len = Math.abs(z1 - z0);
    b.box("paint", 0, floorY + 0.85, cz, d.width * 0.96, 1.5, len, 0.4, 0.04);
    // End glazing.
    b.plate("glass",
      [-hw * 0.82, floorY + 0.55, sign * (halfL - 0.05)], [hw * 0.82, floorY + 0.55, sign * (halfL - 0.05)],
      [hw * 0.82, floorY + 1.45, sign * (halfL - 0.05)], [-hw * 0.82, floorY + 1.45, sign * (halfL - 0.05)], 0.15, true);
    for (const sx of [-1, 1] as const) {
      b.plate("glassSide",
        [sx * (hw - 0.03), floorY + 0.62, cz - len * 0.36], [sx * (hw - 0.03), floorY + 0.62, cz + len * 0.36],
        [sx * (hw - 0.03), floorY + 1.42, cz + len * 0.36], [sx * (hw - 0.03), floorY + 1.42, cz - len * 0.36], 0.2, true);
    }
  }

  // Roof on posts over the open middle.
  b.box("paint", 0, d.roof, 0, d.width * 1.02, 0.09, d.length * 0.99, 0.35);
  for (const sx of [-1, 1] as const) {
    for (const z of [-1.4, -0.5, 0.5, 1.4]) {
      b.box("trim", sx * (hw - 0.04), (floorY + d.roof) * 0.5, z, 0.07, d.roof - floorY, 0.07, 0.5);
    }
    // Running boards + grab rails.
    b.box("trim", sx * (hw + 0.16), floorY - 0.06, 0, 0.36, 0.08, d.length * 0.9, 0.95);
    b.box("chrome", sx * (hw + 0.2), d.roof - 0.2, 0, 0.05, 0.05, d.length * 0.88, 0.3);
  }

  // Outward-facing bench along the open section, plus the grip lever.
  for (const sx of [-1, 1] as const) {
    b.box("interior", sx * (hw - 0.36), floorY + 0.44, 0, 0.62, 0.1, 2.6, 0.5);
    b.box("interior", sx * (hw - 0.1), floorY + 0.7, 0, 0.14, 0.5, 2.6, 0.5);
  }
  b.box("chrome", 0, floorY + 0.62, -2.5, 0.07, 1.1, 0.07, 0.3);
  b.box("chrome", 0, floorY + 0.5, 2.5, 0.07, 0.9, 0.07, 0.3);
  b.box("trim", 0, floorY + 1.16, -2.5, 0.28, 0.08, 0.08, 0.2);

  buildLamps(b, d);
  // Wooden slat texture cue: shallow ribs across the flanks.
  for (let z = -halfL + 0.4; z < halfL; z += 0.44) {
    for (const sx of [-1, 1] as const) {
      if (Math.abs(z) < 1.5) continue;
      b.box("paint", sx * (hw + 0.005), floorY + 1.62, z, 0.02, 0.5, 0.05, 0.3);
    }
  }
}

function buildBike(b: ModelBuilder, d: VehicleDef): void {
  b.body();
  const y = d.clearance;
  // Frame spine, tank, seat, tail.
  b.box("paint", 0, y + 0.52, -0.05, 0.2, 0.26, 1.0, 0.3, 0.05);
  b.box("paint", 0, y + 0.66, -0.2, 0.34, 0.3, 0.6, 0.2, 0.08);
  b.box("interior", 0, y + 0.72, 0.28, 0.28, 0.12, 0.52, 0.3, 0.04);
  b.box("paint", 0, y + 0.78, 0.6, 0.24, 0.16, 0.3, 0.25, 0.05);
  // Engine block + exhaust + swingarm.
  b.box("trim", 0, y + 0.3, 0.06, 0.36, 0.34, 0.42, 0.5);
  b.cyl("chrome", "z", 0.14, y + 0.24, 0.5, 0.05, 0.9, 10, 0.5);
  b.box("trim", 0, y + 0.3, 0.46, 0.12, 0.1, 0.7, 0.6);
  // Forks + bars + headlamp.
  for (const sx of [-1, 1] as const) {
    b.cyl("chrome", "y", sx * 0.12, y + 0.62, d.frontZ + 0.06, 0.026, 0.72, 8, 0.2);
  }
  b.box("trim", 0, y + 1.0, d.frontZ + 0.14, 0.62, 0.05, 0.06, 0.2);
  b.box("lampHead", 0, y + 0.86, d.frontZ - 0.04, 0.2, 0.2, 0.1, 0);
  b.box("lampTail", 0, y + 0.8, d.rearZ + 0.24, 0.12, 0.1, 0.06, 0);
  b.box("lampIndL", -0.2, y + 0.9, d.frontZ + 0.02, 0.07, 0.07, 0.07, 0);
  b.box("lampIndR", 0.2, y + 0.9, d.frontZ + 0.02, 0.07, 0.07, 0.07, 0);
  // Mudguards.
  b.box("paint", 0, y + 0.62, d.frontZ, 0.18, 0.04, 0.5, 0.7);
  b.box("paint", 0, y + 0.66, d.rearZ, 0.2, 0.04, 0.56, 0.8);
}

function buildHeli(b: ModelBuilder, d: VehicleDef): void {
  b.body();
  const halfL = d.length * 0.5;
  const hw = d.width * 0.5;
  const noseZ = -halfL;
  const cabinRear = d.cabinRearZ;

  // Fuselage: a fat cabin tapering into a slim tail boom.
  const stations: Station[] = [];
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const z = noseZ + t * d.length;
    let w: number;
    let yl: number;
    let yh: number;
    if (z < cabinRear) {
      const u = clamp01((z - noseZ) / (cabinRear - noseZ));
      const bell = Math.sin(Math.min(1, u * 1.25) * Math.PI * 0.86);
      w = hw * (0.3 + 0.7 * bell);
      yl = d.clearance + 0.2 - 0.14 * bell;
      yh = d.beltline + (d.roof - d.beltline) * bell * 0.86;
    } else {
      const u = clamp01((z - cabinRear) / (halfL - cabinRear));
      w = hw * (0.62 - 0.44 * u);
      yl = d.clearance + 0.72 + 0.2 * u;
      yh = d.beltline + 0.36 - 0.16 * u;
    }
    stations.push({ z, halfW: Math.max(0.08, w), yLow: yl, yHigh: Math.max(yl + 0.12, yh), box: 0.24, taperTop: 0.22, wear: 0.1 });
  }
  b.loft("paint", stations, 22, true, true);

  // Bubble canopy: two side plates and a swept nose glass.
  const gy0 = d.clearance + 0.55;
  const gy1 = d.roof - 0.14;
  b.plate("glass",
    [-hw * 0.6, gy0, noseZ + 0.1], [hw * 0.6, gy0, noseZ + 0.1],
    [hw * 0.62, gy1, noseZ + 1.5], [-hw * 0.62, gy1, noseZ + 1.5], 0.08);
  for (const sx of [-1, 1] as const) {
    b.plate("glassSide",
      [sx * hw * 0.9, gy0, noseZ + 0.35], [sx * hw * 0.9, gy0, noseZ + 1.9],
      [sx * hw * 0.7, gy1, noseZ + 1.9], [sx * hw * 0.7, gy1, noseZ + 0.35], 0.08, true);
    b.plate("glassSide",
      [sx * hw * 0.94, gy0 + 0.2, noseZ + 2.0], [sx * hw * 0.94, gy0 + 0.2, cabinRear - 0.1],
      [sx * hw * 0.8, gy1 - 0.05, cabinRear - 0.1], [sx * hw * 0.8, gy1 - 0.05, noseZ + 2.0], 0.1, true);
  }

  // Tail: vertical fin, horizontal stabiliser, tail rotor gearbox.
  const tailZ = halfL - 0.35;
  b.plate("paint",
    [-0.045, d.clearance + 1.0, tailZ - 0.9], [0.045, d.clearance + 1.0, tailZ - 0.9],
    [0.045, d.clearance + 2.15, tailZ + 0.25], [-0.045, d.clearance + 2.15, tailZ + 0.25], 0.2, true);
  b.box("paint", 0, d.clearance + 1.0, tailZ - 0.55, 2.4, 0.07, 0.44, 0.25);
  b.box("paint", 0, d.clearance + 2.05, tailZ + 0.1, 0.16, 0.42, 0.5, 0.2);

  // Skids (helicopter) — two tubes on four struts.
  for (const sx of [-1, 1] as const) {
    b.cyl("chrome", "z", sx * hw * 0.78, d.clearance * 0.4, noseZ + d.length * 0.22, 0.05, d.length * 0.34, 10, 0.4);
    for (const z of [noseZ + d.length * 0.12, noseZ + d.length * 0.32]) {
      b.box("chrome", sx * hw * 0.6, d.clearance * 0.4 + 0.28, z, 0.05, 0.56, 0.06, 0.3);
    }
  }

  // Mast + rotor head.
  const mastY = d.roof + 0.24;
  b.cyl("chrome", "y", 0, (d.roof + mastY) * 0.5, d.cabinFrontZ + 1.2, 0.1, 0.5, 10, 0.2);
  const rotor = b.part("rotorMain", 0, mastY, d.cabinFrontZ + 1.2);
  const blades = d.kind === "gunship" ? 4 : 3;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const R = d.rotorRadius;
    const k = rotor.chunk("trim");
    const w = 0.17;
    const pts = [
      [ca * 0.3 - sa * w, 0, sa * 0.3 + ca * w],
      [ca * R - sa * w * 0.7, -0.02, sa * R + ca * w * 0.7],
      [ca * R + sa * w * 0.7, -0.02, sa * R - ca * w * 0.7],
      [ca * 0.3 + sa * w, 0, sa * 0.3 - ca * w],
    ];
    const ids = pts.map((p, j) => k.v(p[0], p[1] + 0.02, p[2], j & 1, j >> 1, 0.2));
    k.quad(ids[0], ids[1], ids[2], ids[3]);
    k.quad(ids[3], ids[2], ids[1], ids[0]);
  }
  b.use(rotor);
  b.box("chrome", 0, 0, 0, 0.4, 0.16, 0.4, 0.1);

  // Tail rotor on its own pivot, spinning about X.
  const tr = b.part("rotorTail", hw * 0.3, d.clearance + 2.05, tailZ + 0.16);
  const tk = tr.chunk("trim");
  for (let i = 0; i < 2; i++) {
    const a = (i / 2) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const R = d.tailRotorRadius;
    const w = 0.07;
    const pts = [
      [0, ca * 0.08 - sa * w, sa * 0.08 + ca * w],
      [0, ca * R - sa * w, sa * R + ca * w],
      [0, ca * R + sa * w, sa * R - ca * w],
      [0, ca * 0.08 + sa * w, sa * 0.08 - ca * w],
    ];
    const ids = pts.map((p, j) => tk.v(p[0], p[1], p[2], j & 1, j >> 1, 0.2));
    tk.quad(ids[0], ids[1], ids[2], ids[3]);
    tk.quad(ids[3], ids[2], ids[1], ids[0]);
  }

  b.body();
  buildInterior(b, d);
  // Nav lights: red port, green starboard, white tail, plus a landing light.
  b.box("lampIndL", -hw * 0.92, d.beltline, d.cabinFrontZ + 0.4, 0.07, 0.07, 0.14, 0);
  b.box("lampIndR", hw * 0.92, d.beltline, d.cabinFrontZ + 0.4, 0.07, 0.07, 0.14, 0);
  b.box("lampTail", 0, d.clearance + 2.2, tailZ + 0.2, 0.08, 0.08, 0.08, 0);
  b.box("lampHead", 0, d.clearance + 0.24, noseZ + 0.5, 0.2, 0.14, 0.1, 0);

  if (d.chinGun) {
    const turret = b.part("turret", 0, d.clearance + 0.28, noseZ + 0.55);
    b.box("trim", 0, 0, 0, 0.44, 0.34, 0.44, 0.4);
    b.cyl("trim", "z", 0, 0, -0.6, 0.055, 1.1, 8, 0.3);
    b.cyl("trim", "z", 0.05, 0.05, -0.6, 0.03, 1.2, 6, 0.3);
    void turret;
    b.body();
  }
  if (d.rocketPods) {
    for (const sx of [-1, 1] as const) {
      // Stub wing plus a 7-tube rocket pod and a missile rail.
      b.box("paint", sx * (hw + 0.5), d.beltline - 0.2, d.cabinFrontZ + 1.3, 1.1, 0.12, 0.9, 0.3);
      b.cyl("trim", "z", sx * (hw + 0.95), d.beltline - 0.36, d.cabinFrontZ + 1.3, 0.24, 1.35, 12, 0.35);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        b.cyl("interior", "z", sx * (hw + 0.95) + Math.cos(a) * 0.13, d.beltline - 0.36 + Math.sin(a) * 0.13,
          d.cabinFrontZ + 0.65, 0.045, 0.06, 6, 0.4);
      }
    }
  }
}

function buildPlane(b: ModelBuilder, d: VehicleDef): void {
  b.body();
  const halfL = d.length * 0.5;
  const hw = d.width * 0.5;
  const noseZ = -halfL;

  // Fuselage.
  const stations: Station[] = [];
  const n = 18;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const z = noseZ + t * d.length;
    const bell = Math.sin(Math.pow(clamp01(t * 1.05), 0.7) * Math.PI * 0.92);
    const w = hw * (0.34 + 0.66 * bell);
    const yc = d.clearance + 0.95 + 0.12 * (1 - bell);
    const h = 0.42 + 0.5 * bell;
    stations.push({ z, halfW: Math.max(0.09, w), yLow: yc - h, yHigh: yc + h, box: 0.22, taperTop: 0.3, wear: 0.12 });
  }
  b.loft("paint", stations, 20, true, true);

  // Wings with dihedral, plus flaps and wingtip lights.
  const span = d.wingSpan * 0.5;
  const wingZ = -0.2;
  for (const sx of [-1, 1] as const) {
    b.plate("paint",
      [sx * hw * 0.7, d.clearance + 0.72, wingZ - 0.9],
      [sx * span, d.clearance + 1.05, wingZ - 0.35],
      [sx * span, d.clearance + 1.05, wingZ + 0.45],
      [sx * hw * 0.7, d.clearance + 0.72, wingZ + 1.2], 0.2, true);
    b.box("paint", sx * span * 0.55, d.clearance + 0.88, wingZ + 0.1, span * 0.9, 0.12, 1.3, 0.2);
    b.box(sx < 0 ? "lampIndL" : "lampIndR", sx * span, d.clearance + 1.06, wingZ, 0.08, 0.07, 0.16, 0);
    // Underwing hardpoint + drop tank.
    if (d.rocketPods) {
      b.cyl("trim", "z", sx * span * 0.55, d.clearance + 0.72, wingZ + 0.1, 0.16, 1.5, 10, 0.3);
      b.box("trim", sx * span * 0.55, d.clearance + 0.82, wingZ + 0.1, 0.1, 0.16, 0.5, 0.3);
    }
  }
  // Tail: fin plus tailplane.
  const tz = halfL - 0.6;
  b.plate("paint",
    [-0.05, d.clearance + 1.5, tz - 0.4], [0.05, d.clearance + 1.5, tz - 0.4],
    [0.05, d.clearance + 3.0, tz + 0.55], [-0.05, d.clearance + 3.0, tz + 0.55], 0.2, true);
  b.box("paint", 0, d.clearance + 1.42, tz + 0.1, 3.6, 0.1, 0.9, 0.2);

  // Canopy: framed bubble over the tandem cockpit.
  const cy0 = d.beltline - 0.05;
  const cy1 = d.roof;
  b.plate("glass",
    [-hw * 0.62, cy0, d.cabinFrontZ - 0.5], [hw * 0.62, cy0, d.cabinFrontZ - 0.5],
    [hw * 0.5, cy1, d.cabinFrontZ + 0.25], [-hw * 0.5, cy1, d.cabinFrontZ + 0.25], 0.08);
  for (const sx of [-1, 1] as const) {
    b.plate("glassSide",
      [sx * hw * 0.68, cy0, d.cabinFrontZ + 0.2], [sx * hw * 0.68, cy0, d.cabinRearZ + 0.4],
      [sx * hw * 0.42, cy1, d.cabinRearZ + 0.2], [sx * hw * 0.42, cy1, d.cabinFrontZ + 0.2], 0.08, true);
  }
  b.plate("paint",
    [-hw * 0.42, cy1, d.cabinRearZ + 0.2], [hw * 0.42, cy1, d.cabinRearZ + 0.2],
    [hw * 0.4, cy1 - 0.25, d.cabinRearZ + 1.4], [-hw * 0.4, cy1 - 0.25, d.cabinRearZ + 1.4], 0.15);

  // Spinner + propeller on its own pivot, spinning about Z.
  b.cyl("chrome", "z", 0, d.clearance + 0.95, noseZ + 0.16, 0.22, 0.42, 12, 0.15, true, 0.05);
  const prop = b.part("propeller", 0, d.clearance + 0.95, noseZ - 0.06);
  const pk = prop.chunk("trim");
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const R = d.propRadius;
    const w = 0.11;
    const pts = [
      [ca * 0.14 - sa * w, sa * 0.14 + ca * w, 0],
      [ca * R - sa * w * 0.6, sa * R + ca * w * 0.6, -0.03],
      [ca * R + sa * w * 0.6, sa * R - ca * w * 0.6, 0.03],
      [ca * 0.14 + sa * w, sa * 0.14 - ca * w, 0],
    ];
    const ids = pts.map((p, j) => pk.v(p[0], p[1], p[2], j & 1, j >> 1, 0.2));
    pk.quad(ids[0], ids[1], ids[2], ids[3]);
    pk.quad(ids[3], ids[2], ids[1], ids[0]);
  }

  b.body();
  buildInterior(b, d);
  b.box("lampHead", 0, d.clearance + 0.6, noseZ + 0.5, 0.16, 0.12, 0.08, 0);
  b.box("lampTail", 0, d.clearance + 3.0, tz + 0.5, 0.08, 0.08, 0.08, 0);
  if (d.chinGun) {
    for (const sx of [-1, 1] as const) {
      b.cyl("trim", "z", sx * hw * 0.5, d.clearance + 0.55, noseZ + 0.9, 0.05, 0.9, 8, 0.3);
    }
  }
}

function buildBoat(b: ModelBuilder, d: VehicleDef): void {
  b.body();
  const halfL = d.length * 0.5;
  const hw = d.width * 0.5;

  // Hull: a deep-V forward flattening into a planing surface aft.
  const stations: Station[] = [];
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const z = -halfL + t * d.length;
    const bow = smooth01(clamp01(t * 2.4));
    const w = hw * (0.16 + 0.84 * bow);
    const keel = -d.hullDraft * (1 - 0.35 * t);
    const deck = d.beltline * (0.55 + 0.45 * (1 - t * 0.4));
    stations.push({
      z, halfW: Math.max(0.06, w), yLow: keel, yHigh: deck,
      box: 0.28 + 0.5 * t, taperTop: -0.1, wear: 0.3,
    });
  }
  b.loft("paint", stations, 20, true, true);

  // Deck + gunwale + cockpit tub.
  b.box("interior", 0, d.beltline * 0.62, halfL * 0.2, hw * 1.5, 0.06, d.length * 0.5, 0.4);
  for (const sx of [-1, 1] as const) {
    b.box("chrome", sx * (hw - 0.05), d.beltline * 0.78, 0, 0.05, 0.05, d.length * 0.8, 0.35);
  }

  if (d.kind === "speedboat") {
    // Windscreen + a small hard top over the console.
    b.plate("glass",
      [-hw * 0.72, d.beltline * 0.72, d.cabinFrontZ], [hw * 0.72, d.beltline * 0.72, d.cabinFrontZ],
      [hw * 0.6, d.beltline * 1.25, d.cabinFrontZ + 0.5], [-hw * 0.6, d.beltline * 1.25, d.cabinFrontZ + 0.5], 0.1, true);
    b.box("paint", 0, d.beltline * 0.9, d.cabinFrontZ - 0.5, hw * 1.5, 0.5, 1.2, 0.3, 0.08);
    b.box("trim", 0, d.roof, d.cabinFrontZ + 0.4, hw * 1.4, 0.06, 1.4, 0.25);
    for (const sx of [-1, 1] as const) {
      b.box("chrome", sx * hw * 0.6, (d.beltline * 1.25 + d.roof) * 0.5, d.cabinFrontZ + 0.9, 0.05, d.roof - d.beltline * 1.25, 0.05, 0.2);
    }
    // Outboard/stern drive + prop.
    b.box("trim", 0, -0.1, halfL - 0.1, 0.34, 0.7, 0.4, 0.5);
    b.cyl("chrome", "z", 0, -0.35, halfL + 0.12, 0.16, 0.1, 8, 0.4);
    b.box("lampHead", 0, d.beltline * 1.3, d.cabinFrontZ - 1.0, 0.16, 0.1, 0.08, 0);
    b.box("lampIndL", -hw * 0.85, d.beltline * 0.8, -halfL * 0.55, 0.07, 0.08, 0.1, 0);
    b.box("lampIndR", hw * 0.85, d.beltline * 0.8, -halfL * 0.55, 0.07, 0.08, 0.1, 0);
  } else {
    // Jet ski: seat, bars, and a jet nozzle.
    b.box("interior", 0, d.beltline * 0.82, 0.25, 0.42, 0.14, 0.9, 0.3, 0.05);
    b.box("trim", 0, d.beltline * 1.15, -0.45, 0.5, 0.05, 0.06, 0.2);
    b.box("paint", 0, d.beltline * 0.95, -0.72, 0.36, 0.3, 0.5, 0.2, 0.06);
    b.cyl("trim", "z", 0, -0.06, halfL - 0.05, 0.13, 0.3, 10, 0.4);
    b.box("lampHead", 0, d.beltline * 1.02, -halfL + 0.16, 0.14, 0.08, 0.08, 0);
  }
  buildInterior(b, d);
}

/* ================================================================== *
 * Materials
 * ================================================================== */

const NOISE_GLSL = /* glsl */ `
float vhash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(vhash(i), vhash(i + vec2(1,0)), f.x),
             mix(vhash(i + vec2(0,1)), vhash(i + vec2(1,1)), f.x), f.y);
}
float vfbm(vec2 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
`;

const VERT_HEAD = /* glsl */ `
attribute float aWear;
attribute float aDent;
varying vec3 vLocalP;
varying float vWear;
varying float vDent;
`;

const VERT_BODY = /* glsl */ `
  vLocalP = position;
  vWear = aWear;
  vDent = aDent;
`;

function injectVertex(shader: { vertexShader: string }): void {
  shader.vertexShader = VERT_HEAD + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace(
    "#include <begin_vertex>",
    `#include <begin_vertex>\n${VERT_BODY}`,
  );
}

/** Uniform block shared by every surface material on one vehicle. */
export interface VehicleUniforms {
  uPaint: { value: THREE.Color };
  uPaint2: { value: THREE.Color };
  uLivery: { value: number };
  uSeed: { value: number };
  uGrime: { value: number };
  uBurn: { value: number };
  uWet: { value: number };
  uBounds: { value: THREE.Vector3 };
}

function makeUniforms(paint: THREE.Color, paint2: THREE.Color, livery: number, seed: number, bounds: THREE.Vector3): VehicleUniforms {
  return {
    uPaint: { value: paint },
    uPaint2: { value: paint2 },
    uLivery: { value: livery },
    uSeed: { value: seed },
    uGrime: { value: 0.22 },
    uBurn: { value: 0 },
    uWet: { value: 0 },
    uBounds: { value: bounds },
  };
}

const LIVERY_INDEX: Record<LiveryKind, number> = {
  none: 0, police: 1, taxi: 2, ambulance: 3, fire: 4, muni: 5, swat: 6, military: 7, cablecar: 8,
};

/**
 * Automotive paint.
 *
 * Four layers, in the order a paint shop applies them: base coat (the instance
 * colour), metallic flake, a livery mask evaluated from the local position, and
 * a clearcoat whose roughness picks up orange peel. On top of that sit the two
 * things that make a car look *used* rather than rendered — road film pooling
 * along the sills and around the arches, and creased, cracked paint wherever
 * the dent channel is raised.
 */
function makePaintMaterial(u: VehicleUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.28,
    metalness: 0.82,
    dithering: true,
  });
  m.customProgramCacheKey = () => "sf-veh-paint-v1";
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    injectVertex(shader);
    shader.fragmentShader = `
      uniform vec3 uPaint; uniform vec3 uPaint2; uniform float uLivery;
      uniform float uSeed; uniform float uGrime; uniform float uBurn; uniform float uWet;
      uniform vec3 uBounds;
      varying vec3 vLocalP; varying float vWear; varying float vDent;
      ${NOISE_GLSL}
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      /* glsl */ `#include <emissivemap_fragment>
      {
        vec3 base = uPaint;
        vec2 sp = vLocalP.xz * 2.4 + vLocalP.y * 1.1 + uSeed;

        // ---- livery. Evaluated from position, so no UVs and no textures.
        float ny = (vLocalP.y + uBounds.y) / max(0.001, 2.0 * uBounds.y);
        float nz = (vLocalP.z + uBounds.z) / max(0.001, 2.0 * uBounds.z);
        if (uLivery > 0.5 && uLivery < 1.5) {
          // Police: black doors, white everything else, a thin gold stripe.
          float band = step(0.22, nz) * step(nz, 0.62) * step(ny, 0.66);
          base = mix(base, vec3(0.03, 0.035, 0.045), band);
          float stripe = smoothstep(0.02, 0.0, abs(ny - 0.62));
          base = mix(base, vec3(0.55, 0.42, 0.08), stripe * 0.85);
        } else if (uLivery < 2.5) {
          // Taxi: a chequer band along the flank.
          float chk = mod(floor(nz * 26.0) + floor(ny * 5.0), 2.0);
          float band = step(0.48, ny) * step(ny, 0.62);
          base = mix(base, mix(vec3(0.02), vec3(0.92), chk), band);
        } else if (uLivery < 3.5) {
          // Ambulance: orange belt + blue chevrons on the tail.
          float belt = step(0.44, ny) * step(ny, 0.56);
          base = mix(base, vec3(0.85, 0.28, 0.03), belt);
          float chev = step(0.86, nz) * step(0.4, fract((ny + nz) * 6.0));
          base = mix(base, vec3(0.05, 0.12, 0.5), chev * 0.9);
        } else if (uLivery < 4.5) {
          // Fire: gold coach stripe and a white roof cap.
          float stripe = smoothstep(0.025, 0.0, abs(ny - 0.52));
          base = mix(base, vec3(0.72, 0.58, 0.16), stripe);
          base = mix(base, vec3(0.86), smoothstep(0.86, 0.95, ny));
        } else if (uLivery < 5.5) {
          // MUNI: cream lower body, maroon upper, silver skirt.
          base = mix(vec3(0.86, 0.84, 0.78), base, smoothstep(0.42, 0.5, ny));
          base = mix(vec3(0.28, 0.3, 0.32), base, smoothstep(0.14, 0.2, ny));
        } else if (uLivery < 6.5) {
          base = mix(base, base * 0.55, step(0.5, ny));
        } else if (uLivery < 7.5) {
          // Military: three-tone blotch camo from layered noise.
          float c1 = vfbm(vLocalP.xz * 0.55 + uSeed);
          float c2 = vfbm(vLocalP.zy * 0.42 + 13.0 + uSeed);
          base = mix(base, base * 0.62, step(0.52, c1));
          base = mix(base, vec3(0.19, 0.18, 0.14), step(0.62, c2) * 0.85);
        } else if (uLivery > 7.5) {
          // Cable car: maroon body, cream window band, gold pinstripe.
          base = mix(base, vec3(0.85, 0.81, 0.71), step(0.62, ny));
          base = mix(base, vec3(0.66, 0.52, 0.16), smoothstep(0.012, 0.0, abs(ny - 0.6)));
        }

        // ---- metallic flake + clearcoat orange peel
        float flake = vnoise(sp * 220.0);
        float peel = vfbm(sp * 9.0);
        base *= 0.94 + flake * 0.12;
        float rough = 0.16 + peel * 0.09;

        // ---- road film: heaviest along the sills and behind the wheels
        float grime = clamp(vWear * (0.55 + uGrime) + vfbm(sp * 5.5) * 0.28 - 0.16, 0.0, 1.0);
        base = mix(base, base * 0.42 + vec3(0.09, 0.085, 0.078), grime * 0.8);
        rough = mix(rough, 0.72, grime * 0.75);

        // ---- damage: creased metal, cracked lacquer, bare primer
        float crease = vfbm(sp * 16.0);
        float dmg = clamp(vDent * (0.55 + crease * 0.9), 0.0, 1.0);
        base = mix(base, vec3(0.19, 0.185, 0.18), dmg * 0.75);
        rough = mix(rough, 0.88, dmg);
        float rust = smoothstep(0.55, 1.0, dmg) * step(0.5, crease);
        base = mix(base, vec3(0.24, 0.11, 0.05), rust * 0.7);

        // ---- burnt out
        base = mix(base, vec3(0.035, 0.032, 0.03) * (0.6 + vfbm(sp * 22.0) * 0.8), uBurn);
        rough = mix(rough, 0.95, uBurn);

        // ---- rain: wet paint is darker and much smoother
        base *= 1.0 - uWet * 0.22;
        rough = mix(rough, 0.06, uWet * 0.7);

        diffuseColor.rgb *= base;
        roughnessFactor = clamp(rough, 0.04, 1.0);
        metalnessFactor = mix(0.86, 0.25, max(dmg * 0.7, uBurn));
      }`,
    );
  };
  return m;
}

function makeTrimMaterial(u: VehicleUniforms, chrome: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: chrome ? 0xd6dade : 0x2a2d31,
    roughness: chrome ? 0.16 : 0.62,
    metalness: chrome ? 0.95 : 0.35,
  });
  m.customProgramCacheKey = () => (chrome ? "sf-veh-chrome-v1" : "sf-veh-trim-v1");
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    injectVertex(shader);
    shader.fragmentShader = `
      uniform float uSeed; uniform float uGrime; uniform float uBurn; uniform float uWet;
      varying vec3 vLocalP; varying float vWear; varying float vDent;
      ${NOISE_GLSL}
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      /* glsl */ `#include <emissivemap_fragment>
      {
        vec2 sp = vLocalP.xz * 3.1 + vLocalP.y * 1.7 + uSeed;
        float grime = clamp(vWear * (0.6 + uGrime) + vfbm(sp * 6.0) * 0.3 - 0.2, 0.0, 1.0);
        vec3 tint = vec3(1.0) * (0.85 + vnoise(sp * 40.0) * 0.3);
        tint = mix(tint, vec3(0.32, 0.3, 0.27), grime);
        tint = mix(tint, vec3(0.05), uBurn);
        diffuseColor.rgb *= tint;
        roughnessFactor = clamp(mix(roughnessFactor, 0.85, max(grime * 0.8, vDent)), 0.05, 1.0);
        roughnessFactor = mix(roughnessFactor, 0.08, uWet * 0.6);
        metalnessFactor = mix(metalnessFactor, 0.1, max(grime * 0.5, uBurn));
      }`,
    );
  };
  return m;
}

function makeRubberMaterial(u: VehicleUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x121315, roughness: 0.94, metalness: 0.0 });
  m.customProgramCacheKey = () => "sf-veh-rubber-v1";
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    injectVertex(shader);
    shader.fragmentShader = `
      uniform float uSeed; uniform float uWet; uniform float uBurn;
      varying vec3 vLocalP; varying float vWear; varying float vDent;
      ${NOISE_GLSL}
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      /* glsl */ `#include <emissivemap_fragment>
      {
        // Tread blocks around the circumference, sidewall lettering as noise.
        float ang = atan(vLocalP.y, vLocalP.z);
        float tread = step(0.45, fract(ang * 11.0 + vLocalP.x * 3.0));
        float side = smoothstep(0.02, 0.05, abs(vLocalP.x));
        vec3 tint = vec3(1.0) * (0.82 + tread * 0.22 * (1.0 - side));
        tint *= 0.9 + vnoise(vLocalP.zy * 60.0 + uSeed) * 0.2;
        tint = mix(tint, vec3(0.4), uBurn * 0.5);
        diffuseColor.rgb *= tint;
        roughnessFactor = mix(0.95, 0.42, uWet);
      }`,
    );
  };
  return m;
}

function makeGlassMaterial(u: VehicleUniforms): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0x0a0e10,
    roughness: 0.045,
    metalness: 0.0,
    transparent: true,
    opacity: 0.34,
    transmission: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    ior: 1.52,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  m.customProgramCacheKey = () => "sf-veh-glass-v1";
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.uniforms.uCrack = { value: 0 };
    // Stash the compiled shader so `breakGlass()` can reach its uniform later.
    // three does not expose per-material uniforms on a non-Shader material, and
    // a second material variant purely to carry one float is a waste of a
    // program slot.
    (m as unknown as { userData: Record<string, unknown> }).userData.shader = shader;
    injectVertex(shader);
    shader.fragmentShader = `
      uniform float uSeed; uniform float uCrack; uniform float uGrime; uniform float uBurn;
      varying vec3 vLocalP; varying float vWear; varying float vDent;
      ${NOISE_GLSL}
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      /* glsl */ `#include <emissivemap_fragment>
      {
        // A hint of green in the laminate, plus wiper-swept grime at the base.
        vec3 tint = vec3(0.72, 0.9, 0.82);
        float dirt = vfbm(vLocalP.xz * 6.0 + uSeed) * 0.35 + vWear * 0.4;
        tint = mix(tint, vec3(0.5, 0.5, 0.46), dirt * uGrime * 1.4);
        // Shatter: radial crack web from the impact, worley-ish from cell noise.
        if (uCrack > 0.001) {
          vec2 q = vLocalP.xy * 22.0 + uSeed;
          float w = abs(vnoise(q) - vnoise(q + 0.35)) * 6.0;
          float web = 1.0 - smoothstep(0.0, 0.35, w);
          tint = mix(tint, vec3(1.1), web * uCrack);
          roughnessFactor = mix(roughnessFactor, 0.55, web * uCrack);
        }
        tint = mix(tint, vec3(0.06), uBurn);
        diffuseColor.rgb *= tint;
      }`,
    );
  };
  return m;
}

function makeInteriorMaterial(u: VehicleUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x2a2724, roughness: 0.82, metalness: 0.05 });
  m.customProgramCacheKey = () => "sf-veh-interior-v1";
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    injectVertex(shader);
    shader.fragmentShader = `
      uniform float uSeed; uniform float uBurn;
      varying vec3 vLocalP; varying float vWear; varying float vDent;
      ${NOISE_GLSL}
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      /* glsl */ `#include <emissivemap_fragment>
      {
        // Woven cloth: two orthogonal high-frequency bands, plus vinyl grain.
        vec2 sp = vLocalP.xz * 46.0 + uSeed;
        float weave = 0.5 + 0.5 * sin(sp.x * 3.14159) * sin(sp.y * 3.14159);
        float grain = vnoise(vLocalP.xy * 90.0 + uSeed);
        vec3 tint = vec3(0.86 + weave * 0.24) * (0.92 + grain * 0.16);
        tint = mix(tint, vec3(0.05), uBurn);
        diffuseColor.rgb *= tint;
        roughnessFactor = clamp(0.78 + grain * 0.15, 0.2, 1.0);
      }`,
    );
  };
  return m;
}

function makeLampMaterial(color: number, emissive: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color,
    emissive: new THREE.Color(emissive),
    emissiveIntensity: 0,
    roughness: 0.12,
    metalness: 0.1,
  });
  return m;
}

export interface VehicleMaterialSet {
  paint: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  chrome: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  glassSide: THREE.MeshPhysicalMaterial;
  interior: THREE.MeshStandardMaterial;
  lampHead: THREE.MeshStandardMaterial;
  lampTail: THREE.MeshStandardMaterial;
  lampRev: THREE.MeshStandardMaterial;
  lampIndL: THREE.MeshStandardMaterial;
  lampIndR: THREE.MeshStandardMaterial;
  sirenA: THREE.MeshStandardMaterial;
  sirenB: THREE.MeshStandardMaterial;
  uniforms: VehicleUniforms;
}

function makeMaterials(d: VehicleDef, paint: THREE.Color, seed: number, bounds: THREE.Vector3): VehicleMaterialSet {
  const paint2 = paint.clone().multiplyScalar(0.55);
  const u = makeUniforms(paint, paint2, LIVERY_INDEX[d.livery], seed, bounds);
  const glass = makeGlassMaterial(u);
  const glassSide = makeGlassMaterial(u);
  return {
    paint: makePaintMaterial(u),
    trim: makeTrimMaterial(u, false),
    chrome: makeTrimMaterial(u, true),
    rubber: makeRubberMaterial(u),
    glass,
    glassSide,
    interior: makeInteriorMaterial(u),
    lampHead: makeLampMaterial(0x8d9296, 0xfff4e0),
    lampTail: makeLampMaterial(0x3a0805, 0xff1a08),
    lampRev: makeLampMaterial(0x9aa0a4, 0xffffff),
    lampIndL: makeLampMaterial(0x4a2c02, 0xff8c10),
    lampIndR: makeLampMaterial(0x4a2c02, 0xff8c10),
    sirenA: makeLampMaterial(0x400604, 0xff1408),
    sirenB: makeLampMaterial(0x040f40, 0x1060ff),
    uniforms: u,
  };
}

/* ================================================================== *
 * Geometry cache
 * ================================================================== */

interface BakedPart {
  name: string;
  px: number;
  py: number;
  pz: number;
  geo: Map<Channel, THREE.BufferGeometry>;
}

interface BakedModel {
  parts: BakedPart[];
  bounds: THREE.Box3;
  originY: number;
}

const geoCache = new Map<VehicleKind, BakedModel>();

function computeNormals(k: Chunk): void {
  const p = k.pos;
  const n = k.nrm;
  for (let i = 0; i < k.idx.length; i += 3) {
    const a = k.idx[i] * 3;
    const b = k.idx[i + 1] * 3;
    const c = k.idx[i + 2] * 3;
    const ax = p[b] - p[a], ay = p[b + 1] - p[a + 1], az = p[b + 2] - p[a + 2];
    const bx = p[c] - p[a], by = p[c + 1] - p[a + 1], bz = p[c + 2] - p[a + 2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
    n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
    n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
}

function bake(kind: VehicleKind): BakedModel {
  const cached = geoCache.get(kind);
  if (cached) return cached;
  const d = VEHICLE_DEFS[kind];
  const b = new ModelBuilder();

  switch (d.klass) {
    case "bike": buildBike(b, d); break;
    case "bus": buildBus(b, d); break;
    case "rail": buildCableCar(b, d); break;
    case "heli": buildHeli(b, d); break;
    case "plane": buildPlane(b, d); break;
    case "boat": buildBoat(b, d); break;
    case "truck": buildBoxy(b, d); break;
    default:
      if (d.boxBody) buildBoxy(b, d);
      else buildCar(b, d);
      break;
  }

  // Wheels, as their own parts, authored around the origin.
  const axles = axleLayout(d);
  const halfTrack = (d.track || d.width * 0.8) * 0.5;
  for (let i = 0; i < axles.length; i++) {
    for (const sign of [-1, 1] as const) {
      if (d.klass === "bike" && sign > 0) continue;
      b.part(`wheel${i}${sign < 0 ? "L" : "R"}`, sign * (d.klass === "bike" ? 0 : halfTrack), d.wheelRadius, axles[i].z);
      b.wheel(d.wheelRadius, d.wheelWidth, d.klass === "car" ? 20 : 16, d.kind !== "boxtruck" && d.kind !== "semi");
    }
  }
  // Motorcycles need two wheels but only one track position; the loop above
  // emitted the left-hand pair only, which for a bike is the whole set.

  // Light bar, as its own part so the two halves can flash independently.
  if (d.lightbar) {
    const z = d.cabinFrontZ + 0.55;
    b.part("lightbar", 0, d.roof + 0.09, z);
    b.box("trim", 0, 0, 0, d.width * 0.8, 0.13, 0.28, 0.2, 0.03);
    b.box("sirenA", -d.width * 0.22, 0.02, 0, d.width * 0.3, 0.11, 0.24, 0);
    b.box("sirenB", d.width * 0.22, 0.02, 0, d.width * 0.3, 0.11, 0.24, 0);
    b.box("chrome", 0, -0.08, 0, d.width * 0.5, 0.05, 0.2, 0.2);
  }

  const originY = chassisMetrics(d).originY;
  const parts: BakedPart[] = [];
  const bounds = new THREE.Box3();
  for (const p of b.parts) {
    const geo = new Map<Channel, THREE.BufferGeometry>();
    for (const ch of CHANNELS) {
      const k = p.chunks.get(ch);
      if (!k || k.idx.length === 0) continue;
      computeNormals(k);
      const g = new THREE.BufferGeometry();
      // Shift into part-local space and drop the model onto the chassis origin.
      const pos = new Float32Array(k.pos.length);
      for (let i = 0; i < k.pos.length; i += 3) {
        pos[i] = k.pos[i] - p.px;
        pos[i + 1] = k.pos[i + 1] - p.py;
        pos[i + 2] = k.pos[i + 2] - p.pz;
      }
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(k.nrm, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(k.uv, 2));
      g.setAttribute("aWear", new THREE.Float32BufferAttribute(k.wear, 1));
      g.setAttribute("aDent", new THREE.BufferAttribute(new Float32Array(k.count), 1));
      g.setIndex(k.idx);
      g.computeBoundingSphere();
      geo.set(ch, g);
    }
    if (geo.size === 0) continue;
    parts.push({ name: p.name, px: p.px, py: p.py - originY, pz: p.pz, geo });
    for (const [, g] of geo) {
      g.computeBoundingBox();
      const bb = g.boundingBox!.clone();
      bb.translate(new THREE.Vector3(p.px, p.py - originY, p.pz));
      bounds.union(bb);
    }
  }

  const model: BakedModel = { parts, bounds, originY };
  geoCache.set(kind, model);
  return model;
}

/** Drop every cached geometry. Call on level teardown. */
export function disposeVehicleAssets(): void {
  for (const [, m] of geoCache) {
    for (const p of m.parts) for (const [, g] of p.geo) g.dispose();
  }
  geoCache.clear();
}

/* ================================================================== *
 * The runtime rig
 * ================================================================== */

export interface LampState {
  /** 0..1 headlamps + running lights. */
  head: number;
  /** 0..1 brake lamps, over the top of the running lights. */
  brake: number;
  reverse: number;
  /** −1 left, +1 right, 0 off; hazards use 2. */
  indicator: number;
  /** 0..1 siren bar; the two halves alternate on their own phase. */
  siren: number;
  /** Extra full-beam / spotlight. */
  highBeam: number;
}

export interface WheelVisual {
  /** Suspension length actually measured this step, metres. */
  suspension: number;
  /** Accumulated spin, radians. */
  spin: number;
  /** Steering angle, radians. */
  steer: number;
  /** 0..1 — a shot-out tyre squats and loses its sidewall. */
  flat: number;
}

/** Everything the paint shell knows about how badly it has been treated. */
export interface DamageVisual {
  /** 0..1 aggregate structural damage — drives dents and paint. */
  integrity01: number;
  /** 0..1 charring. */
  burn: number;
  /** 0..1 rain wetness. */
  wet: number;
  /** 0..1 general road grime. */
  grime: number;
}

const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();

export interface BuildOptions {
  paint?: THREE.ColorRepresentation;
  seed?: number;
  /** Cast shadows from the shell. Lamps and glass never do. */
  castShadow?: boolean;
  /** Attach real spot lights to the headlamps (player vehicle only). */
  realLights?: boolean;
}

/**
 * One hero vehicle rig: a `THREE.Group` you parent to the scene and drive by
 * writing its transform, plus the handful of setters the runtime needs.
 *
 * Geometry is shared with every other instance of the same kind — except the
 * paint shell and the glass, which are cloned so this vehicle's dents belong to
 * this vehicle. Materials are always per-instance (they carry the paint colour
 * and the damage uniforms) but share a compiled program, so the extra cost is
 * a uniform block, not a shader recompile.
 */
export class VehicleModel {
  readonly kind: VehicleKind;
  readonly def: VehicleDef;
  readonly root = new THREE.Group();
  readonly materials: VehicleMaterialSet;
  readonly bounds: THREE.Box3;

  /** Part groups by name, for anything that needs to reach in. */
  readonly partByName = new Map<string, THREE.Group>();
  private wheelGroups: THREE.Group[] = [];
  private doorGroups: THREE.Group[] = [];
  private rotorMain: THREE.Group | null = null;
  private rotorTail: THREE.Group | null = null;
  private propeller: THREE.Group | null = null;
  private turret: THREE.Group | null = null;
  private ladder: THREE.Group | null = null;
  private lightbar: THREE.Group | null = null;

  /** Cloned, dentable geometry — only these get written by `applyImpact`. */
  private deformable: THREE.BufferGeometry[] = [];
  private ownedGeo: THREE.BufferGeometry[] = [];
  private glassMeshes = new Map<string, THREE.Mesh>();
  private headSpots: THREE.SpotLight[] = [];

  private hardPointY: number;
  private indicatorPhase = 0;
  private sirenPhase = 0;
  private disposed = false;

  constructor(kind: VehicleKind, opts: BuildOptions = {}) {
    this.kind = kind;
    this.def = VEHICLE_DEFS[kind];
    const baked = bake(kind);
    this.bounds = baked.bounds.clone();
    const seed = opts.seed ?? 0.37;
    const paint = new THREE.Color(opts.paint ?? this.def.palette[0]);
    // sRGB palette entries have to be converted or every car reads washed out
    // in a linear-workflow renderer.
    paint.convertSRGBToLinear();
    const half = new THREE.Vector3();
    baked.bounds.getSize(half).multiplyScalar(0.5);
    this.materials = makeMaterials(this.def, paint, seed, half);
    this.hardPointY = this.def.wheelRadius + this.def.suspension - baked.originY;

    this.root.name = `sf-vehicle-${kind}`;
    const cast = opts.castShadow !== false;

    for (const p of baked.parts) {
      const g = new THREE.Group();
      g.position.set(p.px, p.py, p.pz);
      g.name = p.name;
      const dentable = p.name === "body" || p.name.startsWith("door");
      for (const [ch, src] of p.geo) {
        let geo = src;
        if (dentable && (ch === "paint" || ch === "glass" || ch === "glassSide")) {
          geo = src.clone();
          this.ownedGeo.push(geo);
          if (ch === "paint") this.deformable.push(geo);
        }
        const mesh = new THREE.Mesh(geo, this.materials[ch]);
        mesh.name = `${p.name}:${ch}`;
        const lamp = ch.startsWith("lamp") || ch.startsWith("siren");
        mesh.castShadow = cast && !lamp && ch !== "glass" && ch !== "glassSide";
        mesh.receiveShadow = !lamp;
        // Glass draws after everything and never writes depth, so the interior
        // behind it is not culled away by its own windows.
        if (ch === "glass" || ch === "glassSide") {
          mesh.renderOrder = 4;
          this.glassMeshes.set(`${p.name}:${ch}`, mesh);
        }
        g.add(mesh);
      }
      this.root.add(g);
      this.partByName.set(p.name, g);
      if (p.name.startsWith("wheel")) this.wheelGroups.push(g);
      else if (p.name.startsWith("door")) this.doorGroups.push(g);
      else if (p.name === "rotorMain") this.rotorMain = g;
      else if (p.name === "rotorTail") this.rotorTail = g;
      else if (p.name === "propeller") this.propeller = g;
      else if (p.name === "turret") this.turret = g;
      else if (p.name === "ladder") this.ladder = g;
      else if (p.name === "lightbar") this.lightbar = g;
    }

    if (opts.realLights) this.attachHeadlightSpots();
  }

  /* -------------------- per-frame drivers -------------------- */

  /**
   * Place one wheel. `suspension` is the length Rapier measured this step, so
   * the visual travel is the *real* travel — the outside wheel unloading on a
   * Lombard hairpin is something you can see.
   */
  setWheel(i: number, w: WheelVisual): void {
    const g = this.wheelGroups[i];
    if (!g) return;
    g.position.y = this.hardPointY - w.suspension;
    g.rotation.set(w.spin, w.steer, 0, "YXZ");
    // A flat tyre squats onto its rim and loses its round silhouette.
    const squat = 1 - w.flat * 0.34;
    g.scale.set(1, squat, 1);
  }

  /** Number of wheel groups — the runtime uses this to size its loops. */
  get wheelCount(): number {
    return this.wheelGroups.length;
  }

  /**
   * Lamps. Brake lamps sit on top of the running lights rather than replacing
   * them, indicators run on their own 1.5 Hz square wave, and the light bar
   * alternates at 2.6 Hz with a per-instance offset so a convoy is not a chorus
   * line.
   */
  setLights(s: LampState, dt: number): void {
    const m = this.materials;
    m.lampHead.emissiveIntensity = s.head * 2.6 + s.highBeam * 3.4;
    m.lampTail.emissiveIntensity = s.head * 0.8 + s.brake * 5.5;
    m.lampRev.emissiveIntensity = s.reverse * 3.2;

    this.indicatorPhase += dt * 1.5;
    const blink = this.indicatorPhase % 1 < 0.55 ? 1 : 0;
    const hazard = s.indicator === 2;
    m.lampIndL.emissiveIntensity = (hazard || s.indicator < 0 ? blink : 0) * 4.2;
    m.lampIndR.emissiveIntensity = (hazard || s.indicator > 0 ? blink : 0) * 4.2;

    if (s.siren > 0.01) {
      this.sirenPhase += dt * 2.6;
      const a = this.sirenPhase % 1 < 0.5 ? 1 : 0;
      m.sirenA.emissiveIntensity = a * 7 * s.siren;
      m.sirenB.emissiveIntensity = (1 - a) * 7 * s.siren;
    } else {
      m.sirenA.emissiveIntensity = 0;
      m.sirenB.emissiveIntensity = 0;
    }

    for (const l of this.headSpots) l.intensity = (s.head * 26 + s.highBeam * 44);
  }

  /** 0 = shut, 1 = fully open. Sliding doors translate instead of swinging. */
  setDoor(i: number, t: number): void {
    const g = this.doorGroups[i];
    const dd = this.def.doors[i];
    if (!g || !dd) return;
    const k = clamp01(t);
    if (dd.slide) {
      g.position.z = (dd.hinge === "front" ? 1 : -1) * k * (dd.z1 - dd.z0) * 0.92;
      return;
    }
    if (dd.hinge === "top") {
      g.rotation.x = -k * dd.max;
      return;
    }
    const dir = dd.side === 0 ? 1 : dd.side;
    g.rotation.y = (dd.hinge === "front" ? -dir : dir) * k * dd.max;
  }

  get doorCount(): number {
    return this.doorGroups.length;
  }

  /** Rotor / propeller angles. `blur` fades the blades toward a disc. */
  setRotors(mainAngle: number, tailAngle: number, blur: number): void {
    if (this.rotorMain) {
      this.rotorMain.rotation.y = mainAngle;
      this.rotorMain.scale.setScalar(1);
      this.rotorMain.visible = blur < 0.995;
    }
    if (this.rotorTail) this.rotorTail.rotation.x = tailAngle;
    if (this.propeller) this.propeller.rotation.z = mainAngle;
  }

  /** Aim the chin turret, in vehicle-local yaw/pitch. */
  setTurret(yaw: number, pitch: number): void {
    if (!this.turret) return;
    this.turret.rotation.set(pitch, yaw, 0, "YXZ");
  }

  /** Fire engine ladder: rotation about the turntable and elevation. */
  setLadder(yaw: number, pitch: number, extend: number): void {
    if (!this.ladder) return;
    this.ladder.rotation.set(-pitch, yaw, 0, "YXZ");
    this.ladder.scale.z = 1 + clamp01(extend) * 0.8;
  }

  /** Damage uniforms — the cheap half of the damage model. */
  setDamage(d: DamageVisual): void {
    const u = this.materials.uniforms;
    u.uBurn.value = d.burn;
    u.uWet.value = d.wet;
    u.uGrime.value = 0.18 + d.grime * 0.8;
  }

  /**
   * The expensive half: crush real geometry.
   *
   * Vertices inside `radius` of the local-space impact point are pushed along
   * the impact direction with a smooth falloff, and their dent channel is
   * raised so the shader can crease and crack the paint over the deformation.
   * Normals are recomputed for the whole shell — O(n) on a few thousand
   * vertices, and it only ever happens on a collision, so it is far cheaper
   * than the alternative of a second "damaged" mesh nobody can afford to load.
   */
  applyImpact(
    lx: number, ly: number, lz: number,
    dx: number, dy: number, dz: number,
    energy: number,
  ): void {
    if (this.disposed) return;
    const radius = 0.5 + Math.min(1.6, energy * 0.9);
    const depth = Math.min(0.34, energy * 0.22);
    if (depth < 0.004) return;
    const r2 = radius * radius;
    const len = Math.hypot(dx, dy, dz) || 1;
    const nx = dx / len;
    const ny = dy / len;
    const nz = dz / len;

    for (const g of this.deformable) {
      const pos = g.getAttribute("position") as THREE.BufferAttribute;
      const dent = g.getAttribute("aDent") as THREE.BufferAttribute;
      if (!pos || !dent) continue;
      const pa = pos.array as Float32Array;
      const da = dent.array as Float32Array;
      let touched = false;
      for (let i = 0, v = 0; i < pa.length; i += 3, v++) {
        const ddx = pa[i] - lx;
        const ddy = pa[i + 1] - ly;
        const ddz = pa[i + 2] - lz;
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d2 > r2) continue;
        const f = 1 - Math.sqrt(d2) / radius;
        const w = f * f * (3 - 2 * f);
        pa[i] += nx * depth * w;
        pa[i + 1] += ny * depth * w * 0.6;
        pa[i + 2] += nz * depth * w;
        if (da[v] < w) da[v] = Math.min(1, w * (0.4 + energy * 0.5));
        touched = true;
      }
      if (touched) {
        pos.needsUpdate = true;
        dent.needsUpdate = true;
        g.computeVertexNormals();
        g.computeBoundingSphere();
      }
    }
  }

  /** Blow a window out. Hides the pane and cracks whatever is left. */
  breakGlass(which: "front" | "rear" | "side" | "all" = "all"): void {
    for (const [name, mesh] of this.glassMeshes) {
      const isSide = name.endsWith("glassSide");
      if (which === "all" || (which === "side" && isSide) || (which !== "side" && !isSide)) {
        mesh.visible = false;
      }
    }
    const gu = (this.materials.glass as unknown as { userData: Record<string, unknown> });
    void gu;
    for (const m of [this.materials.glass, this.materials.glassSide]) {
      // The crack uniform lives on the compiled shader, added in onBeforeCompile.
      const s = (m as unknown as { userData?: { shader?: { uniforms: Record<string, { value: number }> } } }).userData?.shader;
      if (s && s.uniforms.uCrack) s.uniforms.uCrack.value = 1;
      m.opacity = 0.5;
      m.roughness = 0.42;
      m.needsUpdate = false;
    }
  }

  /** Total loss: charred paint, no glass, flat tyres, doors hanging open. */
  setWrecked(on: boolean): void {
    this.setDamage({ integrity01: on ? 1 : 0, burn: on ? 1 : 0, wet: 0, grime: on ? 1 : 0.3 });
    if (!on) return;
    this.breakGlass("all");
    for (let i = 0; i < this.doorGroups.length; i++) {
      // Not every door flies open — an asymmetric wreck reads as an accident,
      // a symmetric one reads as a pose.
      this.setDoor(i, (i * 37) % 5 < 2 ? 0.75 + (i % 3) * 0.08 : 0);
    }
    for (const g of this.wheelGroups) g.scale.set(1, 0.7, 1);
    if (this.rotorMain) this.rotorMain.rotation.z = 0.22;
  }

  /* -------------------- attachment points -------------------- */

  /** Driver seat position in vehicle-local space. */
  seatLocal(index: number, out: THREE.Vector3): THREE.Vector3 {
    const s = this.def.seats[Math.min(index, this.def.seats.length - 1)];
    const originY = this.def.wheelRadius + this.def.suspension - this.hardPointY;
    if (!s) return out.set(0, 0, 0);
    return out.set(s.x, s.y - originY + 0.62, s.z);
  }

  /** Where the exhaust exits, vehicle-local. */
  exhaustLocal(out: THREE.Vector3): THREE.Vector3 {
    const d = this.def;
    const originY = d.wheelRadius + d.suspension - this.hardPointY;
    const ex = d.klass === "truck" || d.klass === "bus" ? 0 : d.width * 0.3;
    return out.set(ex, d.clearance + 0.06 - originY, d.length * 0.5);
  }

  /** Where the engine bay is — the origin of smoke and fire. */
  engineLocal(out: THREE.Vector3): THREE.Vector3 {
    const d = this.def;
    const originY = d.wheelRadius + d.suspension - this.hardPointY;
    if (d.klass === "heli" || d.klass === "plane") return out.set(0, d.beltline - originY, d.cabinRearZ);
    return out.set(0, d.bonnet - 0.12 - originY, d.frontZ - 0.2);
  }

  /** Roof centre, in local space — where a hijacker stands. */
  roofLocal(out: THREE.Vector3): THREE.Vector3 {
    const d = this.def;
    const originY = d.wheelRadius + d.suspension - this.hardPointY;
    return out.set(0, d.roof - originY, (d.cabinFrontZ + d.cabinRearZ) * 0.5);
  }

  /** Convert a world-space point into this model's local space. */
  worldToLocal(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    _v3a.set(x, y, z);
    this.root.updateWorldMatrix(true, false);
    _mat4.copy(this.root.matrixWorld).invert();
    return out.copy(_v3a).applyMatrix4(_mat4);
  }

  private attachHeadlightSpots(): void {
    const d = this.def;
    const originY = d.wheelRadius + d.suspension - this.hardPointY;
    const y = Math.max(d.clearance + 0.34, d.bonnet - 0.28) - originY;
    for (const sx of [-1, 1] as const) {
      const l = new THREE.SpotLight(0xfff0dc, 0, 90, 0.42, 0.55, 1.4);
      l.position.set(sx * d.width * 0.31, y, -d.length * 0.5 + 0.1);
      l.target.position.set(sx * d.width * 0.2, y - 2.4, -d.length * 0.5 - 26);
      l.castShadow = false;
      this.root.add(l);
      this.root.add(l.target);
      this.headSpots.push(l);
    }
  }

  /** Approximate world-space radius, for culling and audio falloff. */
  get radius(): number {
    this.bounds.getSize(_v3b);
    return _v3b.length() * 0.5;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const g of this.ownedGeo) g.dispose();
    this.ownedGeo.length = 0;
    this.deformable.length = 0;
    for (const key of CHANNELS) {
      const m = this.materials[key] as THREE.Material;
      m.dispose();
    }
    for (const l of this.headSpots) l.dispose();
    this.headSpots.length = 0;
    this.root.clear();
    this.partByName.clear();
    this.glassMeshes.clear();
    this.wheelGroups.length = 0;
    this.doorGroups.length = 0;
  }
}

/** Build a hero rig. Geometry is cached, so the second one is nearly free. */
export function buildVehicleModel(kind: VehicleKind, opts: BuildOptions = {}): VehicleModel {
  return new VehicleModel(kind, opts);
}

/* ================================================================== *
 * Paint selection
 * ================================================================== */

/**
 * A seeded paint colour with a little variance around the palette entry, so a
 * street of silver saloons is a street of *slightly different* silver saloons.
 * Livery vehicles get their exact colour, because a slightly-off fire engine
 * looks like a mistake rather than like variety.
 */
export function paintFor(kind: VehicleKind, rng: Rng): number {
  const d = VEHICLE_DEFS[kind];
  const base = d.palette[Math.floor(rng.next() * d.palette.length) % d.palette.length];
  if (d.livery !== "none") return base;
  const c = new THREE.Color(base);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(
    (hsl.h + rng.range(-0.012, 0.012) + 1) % 1,
    clamp01(hsl.s * rng.range(0.85, 1.15)),
    clamp01(hsl.l * rng.range(0.86, 1.14)),
  );
  return c.getHex();
}

/** Convenience: a paint colour from a stable string seed. */
export function paintForSeed(kind: VehicleKind, seed: string): number {
  return paintFor(kind, makeRng(seed));
}
