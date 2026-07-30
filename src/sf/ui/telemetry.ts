/**
 * The HUD's 60 Hz input channel.
 *
 * `frame` in state/store.ts carries what the *simulation* needs; this carries
 * what the *interface* needs and nothing else — crosshair bloom, magazine
 * state mid-reload, the vehicle's tacho, whether the last round connected.
 * Those are presentation facts, they change every frame, and they have no
 * business in either zustand (React churn) or `frame` (which other systems
 * would then have to know about).
 *
 * Contract for producers (weapons, vehicles, player, AI):
 *   - Mutate `hudTelemetry` in place from inside your own frame loop.
 *   - Fire one-shot events through `hudEvents`; they are pooled and the HUD
 *     drains them. Never allocate an event object yourself.
 *   - Everything degrades: if nobody writes a field, the HUD falls back to
 *     deriving it from `frame` and `useSfStore`, so the interface is never
 *     blank while a subsystem is still being built.
 */
import { frame } from "../state/store";

/* ------------------------------------------------------------------ *
 * Continuous state
 * ------------------------------------------------------------------ */

export interface VehicleTelemetry {
  /** True while the player is in a driver seat. */
  active: boolean;
  name: string;
  /** m/s. The HUD converts. */
  speed: number;
  /** 0..1 of redline. */
  rpm: number;
  /** -1 reverse, 0 neutral, 1..n forward. */
  gear: number;
  gearCount: number;
  /** 0..1. */
  health: number;
  /** 0..1. */
  fuel: number;
  /** 0..1 nitrous/boost reserve, if the vehicle has one. */
  boost: number;
  /** True while the vehicle is on fire / about to cook off. */
  critical: boolean;
  /** "car" | "bike" | "boat" | "heli" | "plane" — drives the dial layout. */
  kind: string;
  /** Metres AGL, for aircraft. */
  altitude: number;
}

export interface Contact {
  x: number;
  z: number;
  /** Radians, world yaw. -1 when unknown. */
  heading: number;
  kind: "enemy" | "police" | "civilian" | "vehicle" | "objective" | "pickup";
  /** 0..1 alert level — drives the pulse on the minimap. */
  alert: number;
}

export interface HudTelemetry {
  /* ---- weapon ---- */
  /** Current cone half-angle in degrees. The crosshair is a direct read of it. */
  spreadDegrees: number;
  /** 0..1 ADS blend. Crosshairs shrink and scoped weapons hand over to optics. */
  ads: number;
  /** 0..1 through the reload animation. */
  reloadProgress: number;
  /** 0..1 barrel heat, for the LMG's cook-off warning. */
  weaponHeat: number;
  /** Rounds currently in the magazine — mirrored here so the pip strip can
   *  animate mid-reload without a store write per round. */
  magazine: number;
  magazineSize: number;
  reserve: number;
  /** True while the weapon can actually be fired (not switching/reloading). */
  ready: boolean;
  /** Metres to whatever the crosshair is over. -1 when nothing is hit. */
  aimDistance: number;
  /** True when the aim ray is on a hostile — the crosshair turns hot. */
  aimHostile: boolean;

  /* ---- traversal ---- */
  /** Live tethers, 0..2. */
  tethers: number;
  /** 0..1 grapple recharge, 1 = ready. */
  grappleCharge: number;
  /** 0..1 wingsuit boost fuel. */
  boostFuel: number;
  /** m/s true airspeed (as opposed to `frame.speed`, which includes vertical). */
  airspeed: number;
  /** Metres per second of descent, positive down. */
  descentRate: number;
  /** 0..1 canopy integrity while under a parachute. */
  canopy: number;

  /* ---- world ---- */
  vehicle: VehicleTelemetry;
  /** Nearby contacts for the minimap. Producers own the array contents; the
   *  HUD only reads `contactCount` entries so the array can be pooled. */
  contacts: Contact[];
  contactCount: number;
  /** 0..1 "someone is looking at you" — drives the detection pip. */
  detection: number;
  /** Interaction prompt text, empty when there is nothing to press. */
  promptKey: string;
  promptText: string;

  /* ---- meta ---- */
  /** Seconds of continuous chaos combo; resets when the multiplier lapses. */
  comboTime: number;
  comboMultiplier: number;
}

function makeVehicle(): VehicleTelemetry {
  return {
    active: false,
    name: "",
    speed: 0,
    rpm: 0,
    gear: 0,
    gearCount: 6,
    health: 1,
    fuel: 1,
    boost: 0,
    critical: false,
    kind: "car",
    altitude: 0,
  };
}

/** The single mutable telemetry record. Import it; do not clone it. */
export const hudTelemetry: HudTelemetry = {
  spreadDegrees: 1.6,
  ads: 0,
  reloadProgress: 0,
  weaponHeat: 0,
  magazine: -1,
  magazineSize: -1,
  reserve: -1,
  ready: true,
  aimDistance: -1,
  aimHostile: false,

  tethers: 0,
  grappleCharge: 1,
  boostFuel: 1,
  airspeed: 0,
  descentRate: 0,
  canopy: 1,

  vehicle: makeVehicle(),
  contacts: [],
  contactCount: 0,
  detection: 0,
  promptKey: "",
  promptText: "",

  comboTime: 0,
  comboMultiplier: 1,
};

/** Called on respawn / level load. */
export function resetTelemetry(): void {
  const t = hudTelemetry;
  t.spreadDegrees = 1.6;
  t.ads = 0;
  t.reloadProgress = 0;
  t.weaponHeat = 0;
  t.magazine = -1;
  t.magazineSize = -1;
  t.reserve = -1;
  t.ready = true;
  t.aimDistance = -1;
  t.aimHostile = false;
  t.tethers = 0;
  t.grappleCharge = 1;
  t.boostFuel = 1;
  t.airspeed = 0;
  t.descentRate = 0;
  t.canopy = 1;
  t.contactCount = 0;
  t.detection = 0;
  t.promptKey = "";
  t.promptText = "";
  t.comboTime = 0;
  t.comboMultiplier = 1;
  Object.assign(t.vehicle, makeVehicle());
}

/**
 * Fill the telemetry fields nobody has claimed yet from `frame`, so the HUD
 * shows something true even before the traversal and weapon systems are
 * wired. Called once per HUD frame, before any widget reads.
 */
export function deriveTelemetry(): void {
  const t = hudTelemetry;
  // Airspeed: horizontal magnitude reads better in a wingsuit than the raw
  // speed, which is dominated by the dive component.
  const vx = frame.velocity.x;
  const vy = frame.velocity.y;
  const vz = frame.velocity.z;
  t.airspeed = Math.sqrt(vx * vx + vz * vz);
  t.descentRate = -vy;
  if (t.tethers === 0) {
    let live = 0;
    for (const th of frame.tethers) if (th.active) live++;
    t.tethers = live;
  }
}

/* ------------------------------------------------------------------ *
 * One-shot events (pooled)
 * ------------------------------------------------------------------ */

export type HudEventKind =
  | "hit"
  | "headshot"
  | "kill"
  | "damage"
  | "pickup"
  | "chaos"
  | "shake";

export interface HudEvent {
  kind: HudEventKind;
  /** World-space bearing in radians for directional events (damage, hits). */
  direction: number;
  /** Magnitude: damage amount, chaos points, shake strength. */
  amount: number;
  /** Free label — enemy name, pickup name. */
  label: string;
  /** Seconds since the loop started, stamped by the emitter. */
  at: number;
}

const POOL_SIZE = 64;
const pool: HudEvent[] = Array.from({ length: POOL_SIZE }, () => ({
  kind: "hit" as HudEventKind,
  direction: 0,
  amount: 0,
  label: "",
  at: 0,
}));
let head = 0;
let tail = 0;

function push(kind: HudEventKind, direction: number, amount: number, label: string) {
  const e = pool[head];
  e.kind = kind;
  e.direction = direction;
  e.amount = amount;
  e.label = label;
  e.at = frame.time;
  head = (head + 1) % POOL_SIZE;
  // Overrun: drop the oldest. A HUD that falls behind should lose history,
  // never stall the producer.
  if (head === tail) tail = (tail + 1) % POOL_SIZE;
}

/**
 * The producer-facing API. All of these are allocation-free and safe to call
 * from inside a `useFrame`.
 */
export const hudEvents = {
  /** A round connected. `crit` promotes it to the headshot marker + tone. */
  hit(crit = false, direction = 0): void {
    push(crit ? "headshot" : "hit", direction, 0, "");
  },
  /** A target died. Feeds the kill marker and the kill feed. */
  kill(label = "", direction = 0): void {
    push("kill", direction, 0, label);
  },
  /** The player took damage from a world-space bearing (radians, 0 = north). */
  damage(amount: number, direction: number): void {
    push("damage", direction, amount, "");
  },
  pickup(label: string): void {
    push("pickup", 0, 0, label);
  },
  /** Chaos scored at a world bearing, for the floating score pop. */
  chaos(points: number, label = "", direction = 0): void {
    push("chaos", direction, points, label);
  },
  /** Screen shake request, 0..1. The HUD applies it to its own layers only;
   *  camera shake belongs to the camera rig. */
  shake(strength: number): void {
    push("shake", 0, strength, "");
  },
};

/**
 * Drain the queue. The HUD root calls this once per frame and dispatches to
 * the widgets; individual widgets must NOT drain it themselves or they will
 * starve each other.
 */
export function drainHudEvents(sink: (e: HudEvent) => void): void {
  while (tail !== head) {
    sink(pool[tail]);
    tail = (tail + 1) % POOL_SIZE;
  }
}

/** Discard anything queued — used on respawn so old hits do not replay. */
export function clearHudEvents(): void {
  tail = head;
}
