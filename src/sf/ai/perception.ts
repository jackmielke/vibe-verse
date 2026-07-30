/**
 * ai/perception.ts — the world's nervous system.
 *
 * Everything the AI can *notice* arrives here: gunshots, explosions, car
 * crashes, sirens, a body hitting the pavement, the player being seen. One
 * ring buffer, one spatial query, consumed by pedestrians, traffic, soldiers
 * and the police response alike. The alternative — each system subscribing to
 * each other — is how you end up with a crowd that panics at explosions but
 * not at gunfire because someone forgot a callback.
 *
 * Two design decisions worth stating:
 *
 * 1. Events are *stamped and retained*, not dispatched. A pedestrian updating
 *    at 4 Hz in the SIMPLE band would miss a dispatched callback; instead it
 *    asks "what happened near me since I last looked", which is both cheaper
 *    and correct under any tick rate. Retention is 6 s, which is longer than
 *    any reaction window in the game.
 *
 * 2. Loudness is a radius in metres, not a decibel scale, and it is attenuated
 *    by nothing. Occlusion for *hearing* is a trap: a gunshot in the next room
 *    should absolutely be heard, and paying for a raycast per listener per shot
 *    buys you a worse game at a higher price. Sight is occluded; sound is not.
 *
 * Public API
 * ----------
 *   emitNoise / emitGunshot / emitExplosion / emitCrash / emitSiren
 *   forEachEventNear(x, z, since, cb)
 *   perceptionTick(now)
 *   lastGunshotTime / eventCount
 */
import type { Faction } from "./types";

export type NoiseKind =
  | "gunshot"
  | "explosion"
  | "crash"
  | "siren"
  | "scream"
  | "impact"
  | "horn"
  | "shout";

export interface NoiseEvent {
  kind: NoiseKind;
  x: number;
  y: number;
  z: number;
  /** Audible radius, metres. */
  radius: number;
  /** Sim time the event happened. */
  time: number;
  /** Who made it. Civilians panic at hostile noise; soldiers investigate it. */
  source: Faction;
  /** Entity that produced it, or 0. */
  sourceId: number;
  /**
   * 0..1 threat weight. A car horn is 0.05 and does not empty a sidewalk; a
   * rifle burst is 1.0 and does.
   */
  threat: number;
}

/**
 * A fixed ring. 192 slots at ~6 s retention is far more than a firefight
 * generates, and a fixed ring means zero allocation in the hot path — the
 * weapon stack calls `emitGunshot` up to fifteen times a second.
 */
const CAPACITY = 192;
const RETENTION = 6.0;

const ring: NoiseEvent[] = new Array(CAPACITY);
for (let i = 0; i < CAPACITY; i++) {
  ring[i] = {
    kind: "impact",
    x: 0,
    y: 0,
    z: 0,
    radius: 0,
    time: -1e9,
    source: "civilian",
    sourceId: 0,
    threat: 0,
  };
}

let head = 0;
/** Sim time of the most recent event of each kind — cheap "is it kicking off". */
const lastByKind: Partial<Record<NoiseKind, number>> = {};
let simNow = 0;

/** Default audible radii, metres. Tuned against SF's street canyon reverb. */
const DEFAULT_RADIUS: Record<NoiseKind, number> = {
  gunshot: 130,
  explosion: 340,
  crash: 90,
  siren: 220,
  scream: 55,
  impact: 30,
  horn: 45,
  shout: 40,
};

const DEFAULT_THREAT: Record<NoiseKind, number> = {
  gunshot: 1.0,
  explosion: 1.0,
  crash: 0.45,
  siren: 0.25,
  scream: 0.6,
  impact: 0.12,
  horn: 0.05,
  shout: 0.3,
};

/** Advance the module's notion of "now". Called once per frame by the driver. */
export function perceptionTick(now: number): void {
  simNow = now;
}

/** Current perception clock — modules stamp their "last looked" against this. */
export function perceptionNow(): number {
  return simNow;
}

/**
 * Record a noise. Overwrites the oldest slot; nothing allocates.
 *
 * `radius` and `threat` default per kind, which is what almost every caller
 * wants — the weapon stack should not have to know how far a 9 mm carries.
 */
export function emitNoise(
  kind: NoiseKind,
  x: number,
  y: number,
  z: number,
  source: Faction = "civilian",
  sourceId = 0,
  radius = DEFAULT_RADIUS[kind],
  threat = DEFAULT_THREAT[kind],
): void {
  const e = ring[head];
  head = (head + 1) % CAPACITY;
  e.kind = kind;
  e.x = x;
  e.y = y;
  e.z = z;
  e.radius = radius;
  e.time = simNow;
  e.source = source;
  e.sourceId = sourceId;
  e.threat = threat;
  lastByKind[kind] = simNow;
}

/** A shot was fired. `loud` scales the audible radius (suppressor → 0.25). */
export function emitGunshot(
  x: number,
  y: number,
  z: number,
  source: Faction = "player",
  sourceId = 0,
  loud = 1,
): void {
  emitNoise("gunshot", x, y, z, source, sourceId, DEFAULT_RADIUS.gunshot * loud, Math.min(1, loud));
}

/** Something detonated. `power` is roughly the blast radius in metres. */
export function emitExplosion(
  x: number,
  y: number,
  z: number,
  power = 12,
  source: Faction = "player",
  sourceId = 0,
): void {
  emitNoise("explosion", x, y, z, source, sourceId, 160 + power * 14, 1);
}

/** Metal on metal. Loud enough to turn heads, not enough to empty a street. */
export function emitCrash(x: number, y: number, z: number, severity = 1): void {
  emitNoise(
    "crash",
    x,
    y,
    z,
    "civilian",
    0,
    DEFAULT_RADIUS.crash * (0.6 + severity * 0.7),
    Math.min(0.8, 0.25 + severity * 0.4),
  );
}

/** A siren pass — pedestrians look, traffic yields, nobody panics. */
export function emitSiren(x: number, y: number, z: number, sourceId = 0): void {
  emitNoise("siren", x, y, z, "police", sourceId, DEFAULT_RADIUS.siren, DEFAULT_THREAT.siren);
}

/**
 * Visit every live event whose audible disc contains (x, z) and which is newer
 * than `since`. The callback must not emit new events (the ring would shift
 * under the iteration); queue them and emit after the loop.
 *
 * Linear over 192 slots with an early cheap reject. At 300 listeners that is
 * 57k squared-distance tests a second in the worst case, which measures as
 * noise next to the pathfinder.
 */
export function forEachEventNear(
  x: number,
  z: number,
  since: number,
  cb: (e: NoiseEvent, distance: number) => void,
): void {
  const cutoff = Math.max(since, simNow - RETENTION);
  for (let i = 0; i < CAPACITY; i++) {
    const e = ring[i];
    if (e.time <= cutoff) continue;
    const dx = e.x - x;
    const dz = e.z - z;
    const d2 = dx * dx + dz * dz;
    const r = e.radius;
    if (d2 > r * r) continue;
    cb(e, Math.sqrt(d2));
  }
}

/**
 * The single loudest threat near a point since `since`, or null. Used by the
 * crowd, which only needs "should I be running, and away from what".
 */
export interface ThreatSample {
  x: number;
  z: number;
  threat: number;
  time: number;
  kind: NoiseKind;
}

const _threat: ThreatSample = { x: 0, z: 0, threat: 0, time: -1e9, kind: "impact" };

export function strongestThreatNear(x: number, z: number, since: number): ThreatSample | null {
  const cutoff = Math.max(since, simNow - RETENTION);
  let best = 0;
  let found = false;
  for (let i = 0; i < CAPACITY; i++) {
    const e = ring[i];
    if (e.time <= cutoff || e.threat <= 0.2) continue;
    const dx = e.x - x;
    const dz = e.z - z;
    const d2 = dx * dx + dz * dz;
    const r = e.radius;
    if (d2 > r * r) continue;
    // Closer and louder wins; a distant explosion still beats a nearby horn.
    const score = e.threat * (1 - Math.sqrt(d2) / r);
    if (score > best) {
      best = score;
      found = true;
      _threat.x = e.x;
      _threat.z = e.z;
      _threat.threat = e.threat;
      _threat.time = e.time;
      _threat.kind = e.kind;
    }
  }
  return found ? _threat : null;
}

/** Sim time of the last event of a kind, or −∞. */
export function lastEventTime(kind: NoiseKind): number {
  return lastByKind[kind] ?? -1e9;
}

/** How many events are still inside the retention window. Debug overlay. */
export function liveEventCount(): number {
  let n = 0;
  for (let i = 0; i < CAPACITY; i++) if (simNow - ring[i].time < RETENTION) n++;
  return n;
}

/** Wipe everything. Level reload only. */
export function clearPerception(): void {
  for (let i = 0; i < CAPACITY; i++) ring[i].time = -1e9;
  for (const k in lastByKind) delete lastByKind[k as NoiseKind];
  head = 0;
}
