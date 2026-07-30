/**
 * game/director.ts — the dynamic mission director.
 *
 * The director's real job is *pacing*, not content. Content already exists:
 * thirty-odd authored activities and a hundred discoveries sit on the map
 * whether or not anyone is watching. What the director does is decide, every
 * few seconds, what the world should be doing *right now* — and, crucially,
 * when it should be doing nothing at all.
 *
 * The intensity model
 * -------------------
 * `intensity` is a measurement, not a dial: it is what the world currently
 * feels like, blended from the wanted level, the last minute of chaos, and
 * whatever mission is running. The director watches it and moves through four
 * phases:
 *
 *     CALM ──► BUILD ──► PEAK ──► COOLDOWN ──► CALM
 *
 *   CALM      Nothing is happening and that is fine. The director offers
 *             exploration-flavoured activities (courses, races, discoveries)
 *             and seeds only atmospheric events — fog, a distant siren.
 *   BUILD     Something has started. Ambient events get louder and closer,
 *             offers skew toward combat.
 *   PEAK      Held deliberately for a bounded time. No *new* event families
 *             are seeded during a peak; adding a fire to a level-4 chase does
 *             not make it more exciting, it makes it illegible.
 *   COOLDOWN  A hard, enforced valley. Ambient seeding is off. This is the
 *             phase most sandbox games skip, and skipping it is exactly why
 *             they turn into constant undifferentiated noise after an hour.
 *             You cannot feel a peak you never came down from.
 *
 * Offer scoring
 * -------------
 * Candidate activities are scored on distance (a sweet band, not "nearest"),
 * intensity fit against what the phase wants, novelty (kind and district you
 * have not touched lately), playstyle affinity read off the progression stats,
 * and heat — the director will not send you into the district you are
 * currently being hunted in.
 *
 * Everything random here comes from a seeded stream forked off the world seed
 * and advanced by an event counter, so a given sequence of player actions
 * always produces the same sequence of events. The screenshot harness requires
 * that; so does being able to reproduce a bug report.
 *
 * Public API
 * ----------
 *   director.tick(dt)                   run on a budget from GameDirector
 *   director.offers                     current ranked activity offers
 *   director.accept(index | id)         start one
 *   director.intensity / phase
 *   director.events                     live ambient events (for renderers)
 *   director.onAmbient(fn)              subscribe to ambient event start/stop
 *   director.forceEvent(kind)           debug / scripted beats
 */
import { WORLD_SEED } from "../config";
import { frame, useSfStore } from "../state/store";
import { clamp01, makeRng, type Rng } from "../math/rng";
import {
  DISTRICTS,
  MARKET_STREET,
  districtAt,
  fromGridSpace,
  gridAt,
  isWater,
  toGridSpace,
  walkableHeight,
} from "../geo/sfGeo";
import { enemyForce } from "../ai/enemies";
import { pedestrians } from "../ai/pedestrians";
import { emitNoise, emitSiren } from "../ai/perception";
import { igniteFire } from "../vfx/fire";
import { setWeather } from "../vfx/environmental";
import { chaos, chaosRankIndex, refreshChaosHooks } from "./chaos";
import { discoveries, nearestUndiscovered, type Discovery } from "./discoveries";
import { gameHeat } from "./heat";
import { MISSIONS, MISSION_KIND_LABEL, missions, type MissionDef, type MissionKind } from "./missions";
import { progression } from "./progression";

/* ================================================================== *
 * Phases
 * ================================================================== */

export type DirectorPhase = "calm" | "build" | "peak" | "cooldown";

/** How long a peak is allowed to run before the director forces a valley. */
const PEAK_MAX = 95;
/** Minimum enforced valley. Long enough to hear the city again. */
const COOLDOWN_MIN = 55;
const COOLDOWN_MAX = 110;
/** Intensity thresholds for the phase machine. */
const BUILD_AT = 0.22;
const PEAK_AT = 0.62;
const CALM_AT = 0.12;

/* ================================================================== *
 * Ambient events
 * ================================================================== */

export type AmbientKind = "police-chase" | "structure-fire" | "protest" | "fog-bank" | "ambush";

export interface AmbientEvent {
  id: number;
  kind: AmbientKind;
  label: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  startedAt: number;
  endsAt: number;
  /** 0..1 how much this event contributes to perceived intensity. */
  weight: number;
  /** Per-event mutable scratch (fire slot, siren clock, fog target…). */
  data: Record<string, number>;
}

interface AmbientDef {
  kind: AmbientKind;
  label: string;
  /** Relative selection weight. */
  weight: number;
  /** Phases this event may be seeded in. */
  phases: readonly DirectorPhase[];
  /** Seconds before this kind may repeat. */
  cooldown: number;
  duration: [number, number];
  radius: number;
  /** Contribution to intensity while live. */
  intensity: number;
  /** Place it. Returns false if there is nowhere sensible. */
  place: (e: AmbientEvent, rng: Rng) => boolean;
  /** Called once when the event starts. */
  start?: (e: AmbientEvent) => void;
  /** Called every director tick while live. */
  update?: (e: AmbientEvent, dt: number) => void;
  /** Called once when it ends. */
  stop?: (e: AmbientEvent) => void;
}

/* --- placement helpers --------------------------------------------- */

/** Snap a point onto the nearest street centreline of whichever grid owns it. */
function snapToRoad(x: number, z: number): { x: number; z: number } {
  const g = gridAt(x, z);
  const { u, v } = toGridSpace(x, z, g);
  const du = Math.abs(u - Math.round(u)) * g.spacingU;
  const dv = Math.abs(v - Math.round(v)) * g.spacingV;
  // Snap along whichever axis we are already closest to, so the point slides
  // sideways onto a street rather than jumping to an intersection.
  return du < dv ? fromGridSpace(Math.round(u), v, g) : fromGridSpace(u, Math.round(v), g);
}

/** A land point at a random bearing and distance from the player. */
function pointNearPlayer(rng: Rng, minR: number, maxR: number, road: boolean): { x: number; z: number } | null {
  for (let i = 0; i < 20; i++) {
    const a = rng.next() * Math.PI * 2;
    const r = rng.range(minR, maxR);
    let x = frame.position.x + Math.cos(a) * r;
    let z = frame.position.z + Math.sin(a) * r;
    if (road) {
      const s = snapToRoad(x, z);
      x = s.x;
      z = s.z;
    }
    if (isWater(x, z)) continue;
    return { x, z };
  }
  return null;
}

/** A point along Market Street, biased toward the player's end of it. */
function pointOnMarket(rng: Rng): { x: number; z: number } {
  const px = frame.position.x;
  const pz = frame.position.z;
  const dx = MARKET_STREET.bx - MARKET_STREET.ax;
  const dz = MARKET_STREET.bz - MARKET_STREET.az;
  const len2 = dx * dx + dz * dz;
  const tPlayer = clamp01(((px - MARKET_STREET.ax) * dx + (pz - MARKET_STREET.az) * dz) / len2);
  const t = clamp01(tPlayer + rng.range(-0.18, 0.18));
  return { x: MARKET_STREET.ax + dx * t, z: MARKET_STREET.az + dz * t };
}

/* --- the event catalogue ------------------------------------------- */

const AMBIENT: readonly AmbientDef[] = [
  {
    kind: "police-chase",
    label: "Pursuit passing through",
    weight: 1.0,
    phases: ["calm", "build"],
    cooldown: 95,
    duration: [22, 40],
    radius: 240,
    intensity: 0.18,
    place(e, rng) {
      const p = pointNearPlayer(rng, 140, 480, true);
      if (!p) return false;
      e.x = p.x;
      e.z = p.z;
      e.y = walkableHeight(p.x, p.z) + 1;
      // Give it a heading so the sirens actually travel past you rather than
      // sitting in one spot going wooo.
      const a = rng.next() * Math.PI * 2;
      e.data.vx = Math.cos(a) * 22;
      e.data.vz = Math.sin(a) * 22;
      e.data.clock = 0;
      return true;
    },
    start(e) {
      useSfStore.getState().notify("Sirens — a pursuit is passing through", "info");
      emitSiren(e.x, e.y, e.z, 0);
    },
    update(e, dt) {
      // Drive the source along its heading, snapping back onto the grid so it
      // reads as a car on streets and not a ghost through buildings.
      e.x += e.data.vx * dt;
      e.z += e.data.vz * dt;
      const s = snapToRoad(e.x, e.z);
      e.x += (s.x - e.x) * Math.min(1, dt * 2);
      e.z += (s.z - e.z) * Math.min(1, dt * 2);
      e.y = walkableHeight(e.x, e.z) + 1;
      e.data.clock += dt;
      if (e.data.clock > 1.1) {
        e.data.clock = 0;
        emitSiren(e.x, e.y, e.z, 0);
      }
    },
  },

  {
    kind: "structure-fire",
    label: "Structure fire",
    weight: 0.85,
    phases: ["calm", "build", "cooldown"],
    cooldown: 150,
    duration: [60, 130],
    radius: 90,
    intensity: 0.12,
    place(e, rng) {
      const p = pointNearPlayer(rng, 90, 420, false);
      if (!p) return false;
      const d = districtAt(p.x, p.z);
      // Fires belong where there is something to burn.
      if (d.density < 0.4) return false;
      e.x = p.x;
      e.z = p.z;
      e.y = walkableHeight(p.x, p.z) + rng.range(2, 14);
      return true;
    },
    start(e) {
      // A real fire in the VFX system, not a marker: it lights the street,
      // makes smoke, and the pedestrian AI hears it.
      e.data.slot = igniteFire(e.x, e.y, e.z, {
        radius: 2.6,
        duration: e.endsAt - e.startedAt,
        intensity: 1,
        smoke: 1,
      });
      emitNoise("explosion", e.x, e.y, e.z, "civilian", 0, 180, 0.5);
      useSfStore.getState().notify(`Fire in ${districtAt(e.x, e.z).name}`, "info");
    },
  },

  {
    kind: "protest",
    label: "Protest on Market Street",
    weight: 0.7,
    phases: ["calm", "cooldown"],
    cooldown: 260,
    duration: [90, 180],
    radius: 120,
    intensity: 0.08,
    place(e, rng) {
      const p = pointOnMarket(rng);
      // Only worth staging if the player is anywhere near Market.
      if (Math.hypot(p.x - frame.position.x, p.z - frame.position.z) > 900) return false;
      e.x = p.x;
      e.z = p.z;
      e.y = walkableHeight(p.x, p.z) + 1;
      return true;
    },
    start(e) {
      const now = frame.time;
      const hour = frame.timeOfDay;
      // A crowd, made of the same pedestrians the city already simulates —
      // they walk, they react to gunfire, and they scatter when it starts.
      let spawned = 0;
      for (let i = 0; i < 26; i++) {
        if (pedestrians.spawnNear(e.x, e.z, 3, 55, hour, now) >= 0) spawned++;
      }
      e.data.crowd = spawned;
      e.data.clock = 0;
      useSfStore.getState().notify("A march is blocking Market Street", "info");
    },
    update(e, dt) {
      e.data.clock += dt;
      if (e.data.clock > 3.5) {
        e.data.clock = 0;
        // Crowd noise: loud, harmless, and it masks your own footsteps.
        emitNoise("shout", e.x, e.y, e.z, "civilian", 0, 150, 0.22);
      }
    },
  },

  {
    kind: "fog-bank",
    label: "Fog rolling in",
    weight: 0.9,
    phases: ["calm", "cooldown", "build"],
    cooldown: 300,
    duration: [140, 300],
    radius: 4000,
    intensity: 0.05,
    place(e) {
      // The marine layer comes through the Gate: always from the west, and
      // never when it is already thick.
      if (frame.fogDensity > 0.6) return false;
      e.x = frame.position.x;
      e.z = frame.position.z;
      e.y = frame.position.y;
      e.data.from = frame.fogDensity;
      e.data.to = Math.min(0.92, frame.fogDensity + 0.45);
      return true;
    },
    start(e) {
      useSfStore.getState().notify("Fog coming through the Gate", "info");
      e.data.t = 0;
    },
    update(e, dt) {
      const total = e.endsAt - e.startedAt;
      e.data.t += dt;
      // Ramp in over the first third, hold, ramp out over the last quarter.
      const p = clamp01(e.data.t / total);
      const shape =
        p < 0.33 ? p / 0.33 : p > 0.76 ? 1 - (p - 0.76) / 0.24 : 1;
      frame.fogDensity = e.data.from + (e.data.to - e.data.from) * clamp01(shape);
      setWeather({ groundFog: clamp01(frame.fogDensity * 0.8) });
    },
    stop(e) {
      frame.fogDensity = e.data.from;
      setWeather({ groundFog: clamp01(e.data.from * 0.6) });
    },
  },

  {
    kind: "ambush",
    label: "Contractors moving in",
    weight: 0.8,
    phases: ["build", "peak"],
    cooldown: 130,
    duration: [40, 70],
    radius: 160,
    intensity: 0.28,
    place(e, rng) {
      // Only ambush a player who has been making trouble; jumping a tourist is
      // not a beat, it is a mugging.
      if (gameHeat.notoriety < 0.28) return false;
      const p = pointNearPlayer(rng, 70, 190, false);
      if (!p) return false;
      e.x = p.x;
      e.z = p.z;
      e.y = walkableHeight(p.x, p.z);
      return true;
    },
    start(e) {
      const now = frame.time;
      const size = 3 + Math.round(gameHeat.notoriety * 3);
      enemyForce.spawnSquad(e.x, e.z, size, "cartel", "soldier", "rifle", now);
      enemyForce.alertArea(e.x, e.z, 120, now);
      useSfStore.getState().notify("Contractors moving in", "damage");
    },
  },
];

const AMBIENT_BY_KIND: Record<string, AmbientDef> = Object.fromEntries(
  AMBIENT.map((a) => [a.kind, a]),
);

/* ================================================================== *
 * Offers
 * ================================================================== */

export interface ActivityOffer {
  def: MissionDef;
  distance: number;
  score: number;
  /** Best time, if this is a timed activity the player has already run. */
  best: number | null;
  repeat: boolean;
}

/** Distance band the director prefers: far enough to be a trip, near enough to bother. */
const DIST_SWEET_MIN = 250;
const DIST_SWEET_MAX = 2200;
const DIST_MAX = 5200;

/** Kinds that read as "calm" activities — the cooldown phase leans on these. */
const CALM_KINDS: readonly MissionKind[] = ["wingsuit-course", "grapple-course", "race"];

/* ================================================================== *
 * The director
 * ================================================================== */

let nextEventId = 1;

class MissionDirector {
  phase: DirectorPhase = "calm";
  /** Measured 0..1 world intensity. */
  intensity = 0;
  /** Seconds spent in the current phase. */
  phaseTime = 0;
  /** How long the current cooldown should last. */
  private cooldownLength = COOLDOWN_MIN;

  readonly events: AmbientEvent[] = [];
  offers: ActivityOffer[] = [];

  /** Seeded stream; advanced by an event counter so replays match. */
  private rng: Rng = makeRng(`${WORLD_SEED}:director`);
  private eventCount = 0;

  private nextSeedAt = 12;
  private seedClock = 0;
  private offerClock = 1e9;
  private lastKindAt: Record<string, number> = Object.create(null);
  /** Recently offered/played mission kinds, for variety scoring. */
  private lastPlayedKindAt: Record<string, number> = Object.create(null);
  private lastDistrictAt: Record<string, number> = Object.create(null);

  /** The discovery the director is currently pointing a bored player at. */
  nudge: Discovery | null = null;

  private ambientListeners: ((e: AmbientEvent, starting: boolean) => void)[] = [];
  private detach: (() => void)[] = [];

  /* ---------------- lifecycle ---------------- */

  install(): () => void {
    const off = missions.onEvent((e) => {
      if (e.type === "start") {
        this.lastPlayedKindAt[e.def.kind] = frame.time;
        this.lastDistrictAt[e.def.districtKey] = frame.time;
        this.clearNudge();
      }
      if (e.type === "complete" || e.type === "fail") {
        // Something just ended. Force a breather rather than immediately
        // offering the next thing — the beat after a mission is part of it.
        this.enterPhase("cooldown");
        this.offerClock = 1e9;
      }
    });
    this.detach = [off];
    return () => {
      for (const d of this.detach) d();
      this.detach = [];
      this.stopAllEvents();
    };
  }

  onAmbient(fn: (e: AmbientEvent, starting: boolean) => void): () => void {
    this.ambientListeners.push(fn);
    return () => {
      const i = this.ambientListeners.indexOf(fn);
      if (i >= 0) {
        this.ambientListeners[i] = this.ambientListeners[this.ambientListeners.length - 1];
        this.ambientListeners.pop();
      }
    };
  }

  /* ---------------- per-tick ---------------- */

  tick(dt: number): void {
    if (frame.paused) return;
    const now = frame.time;

    refreshChaosHooks();

    this.measureIntensity(dt);
    this.updatePhase(dt);
    this.updateEvents(dt, now);
    this.maybeSeedEvent(dt, now);
    this.updateOffers(dt);
  }

  /**
   * Intensity is measured from the world, not chosen. Three inputs, weighted
   * so that a wanted level dominates (it is the loudest thing that can be
   * happening), chaos rate matters, and live ambient events nudge.
   */
  private measureIntensity(dt: number): void {
    let ambient = 0;
    for (let i = 0; i < this.events.length; i++) {
      const d = AMBIENT_BY_KIND[this.events[i].kind];
      if (d) ambient += d.intensity;
    }
    const missionLoad = missions.state === "active" && missions.active ? missions.active.intensity * 0.55 : 0;
    const target = clamp01(
      gameHeat.notoriety * 0.8 + Math.min(0.35, ambient) + missionLoad,
    );
    // Asymmetric smoothing: the world gets loud quickly and quietens slowly,
    // which is how tension actually decays for a player.
    const rate = target > this.intensity ? 1.6 : 0.28;
    this.intensity += (target - this.intensity) * Math.min(1, rate * dt);
  }

  private updatePhase(dt: number): void {
    this.phaseTime += dt;
    switch (this.phase) {
      case "calm":
        if (this.intensity > BUILD_AT) this.enterPhase("build");
        break;
      case "build":
        if (this.intensity > PEAK_AT) this.enterPhase("peak");
        else if (this.intensity < CALM_AT && this.phaseTime > 20) this.enterPhase("calm");
        break;
      case "peak":
        // A peak ends when the world quietens *or* when it has run long
        // enough. The time cap is the important half: without it a player who
        // keeps the heat at 5 never gets a valley and stops noticing peaks.
        if (this.intensity < PEAK_AT * 0.75 || this.phaseTime > PEAK_MAX) {
          this.enterPhase("cooldown");
        }
        break;
      case "cooldown":
        if (this.phaseTime > this.cooldownLength) {
          this.enterPhase(this.intensity > BUILD_AT ? "build" : "calm");
        }
        break;
    }
  }

  private enterPhase(p: DirectorPhase): void {
    if (p === this.phase) return;
    this.phase = p;
    this.phaseTime = 0;
    if (p === "cooldown") {
      this.cooldownLength = this.rng.range(COOLDOWN_MIN, COOLDOWN_MAX);
      // Nothing new gets seeded during a valley, and the atmospheric events
      // that are already running are allowed to finish.
      this.nextSeedAt = this.cooldownLength * 0.75;
      this.seedClock = 0;
    } else {
      this.nextSeedAt = this.rng.range(18, 46);
      this.seedClock = 0;
    }
    // Re-rank offers immediately: what is worth doing changes with the phase.
    this.offerClock = 1e9;
  }

  /* ---------------- ambient events ---------------- */

  private updateEvents(dt: number, now: number): void {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      const def = AMBIENT_BY_KIND[e.kind];
      if (now >= e.endsAt) {
        def?.stop?.(e);
        for (const l of this.ambientListeners) l(e, false);
        this.events[i] = this.events[this.events.length - 1];
        this.events.pop();
        continue;
      }
      def?.update?.(e, dt);
    }
  }

  private maybeSeedEvent(dt: number, now: number): void {
    this.seedClock += dt;
    if (this.seedClock < this.nextSeedAt) return;
    this.seedClock = 0;
    this.nextSeedAt = this.rng.range(24, 62);

    // A hard cap on simultaneous events. Three things happening at once is a
    // busy city; five is a slot machine.
    if (this.events.length >= 3) return;

    // Weighted pick among the events legal in this phase and off cooldown.
    let total = 0;
    const legal: AmbientDef[] = [];
    for (const def of AMBIENT) {
      if (def.phases.indexOf(this.phase) < 0) continue;
      if (now - (this.lastKindAt[def.kind] ?? -1e9) < def.cooldown) continue;
      if (this.events.some((e) => e.kind === def.kind)) continue;
      legal.push(def);
      total += def.weight;
    }
    if (legal.length === 0) return;

    let roll = this.rng.next() * total;
    let chosen = legal[legal.length - 1];
    for (const def of legal) {
      roll -= def.weight;
      if (roll <= 0) {
        chosen = def;
        break;
      }
    }
    this.spawnEvent(chosen, now);
  }

  private spawnEvent(def: AmbientDef, now: number): AmbientEvent | null {
    // Fork per event so an event's own randomness cannot desynchronise the
    // director's stream from a different number of placement retries.
    const rng = this.rng.fork(`event:${this.eventCount++}`);
    const duration = rng.range(def.duration[0], def.duration[1]);
    const e: AmbientEvent = {
      id: nextEventId++,
      kind: def.kind,
      label: def.label,
      x: 0,
      y: 0,
      z: 0,
      radius: def.radius,
      startedAt: now,
      endsAt: now + duration,
      weight: def.intensity,
      data: Object.create(null),
    };
    if (!def.place(e, rng)) return null;
    this.lastKindAt[def.kind] = now;
    this.events.push(e);
    def.start?.(e);
    for (const l of this.ambientListeners) l(e, true);
    return e;
  }

  /** Debug / scripted-beat hook: fire a specific ambient event now. */
  forceEvent(kind: AmbientKind): AmbientEvent | null {
    const def = AMBIENT_BY_KIND[kind];
    if (!def) return null;
    return this.spawnEvent(def, frame.time);
  }

  private stopAllEvents(): void {
    for (const e of this.events) {
      AMBIENT_BY_KIND[e.kind]?.stop?.(e);
      for (const l of this.ambientListeners) l(e, false);
    }
    this.events.length = 0;
  }

  /* ---------------- offers ---------------- */

  private updateOffers(dt: number): void {
    this.offerClock += dt;
    if (this.offerClock < 6) return;
    this.offerClock = 0;
    this.rankOffers();
    this.updateNudge();
  }

  /** Score every eligible activity and keep the best few. */
  rankOffers(): ActivityOffer[] {
    const px = frame.position.x;
    const pz = frame.position.z;
    const rank = chaosRankIndex(chaos.total);
    const now = frame.time;
    // What the current phase *wants* the next thing to feel like.
    const desired =
      this.phase === "cooldown" ? 0.2 : this.phase === "calm" ? 0.35 : this.phase === "build" ? 0.7 : 0.9;

    const scored: ActivityOffer[] = [];
    for (const def of MISSIONS) {
      if (def.minRank > rank) continue;
      const dist = Math.hypot(def.x - px, def.z - pz);
      if (dist > DIST_MAX) continue;

      let score = 100;

      // Distance: a flat sweet band with falloff either side. Nearest-first
      // scoring makes a director that keeps handing you the same three things.
      if (dist < DIST_SWEET_MIN) score -= (DIST_SWEET_MIN - dist) * 0.05;
      else if (dist > DIST_SWEET_MAX) score -= (dist - DIST_SWEET_MAX) * 0.016;

      // Intensity fit.
      score -= Math.abs(def.intensity - desired) * 55;

      // Cooldown wants quiet things specifically.
      if (this.phase === "cooldown" && CALM_KINDS.indexOf(def.kind) >= 0) score += 22;
      if (this.phase === "peak" && def.intensity < 0.5) score -= 30;

      // Novelty: kind and district you have not touched recently.
      const kindAge = now - (this.lastPlayedKindAt[def.kind] ?? -1e9);
      score += Math.min(30, kindAge * 0.06);
      const distAge = now - (this.lastDistrictAt[def.districtKey] ?? -1e9);
      score += Math.min(18, distAge * 0.04);

      // Replays are allowed but never preferred, except for timed runs where
      // beating your own time *is* the content.
      const done = missions.isComplete(def.id);
      if (done) score -= def.timed ? 26 : 70;

      // Do not send the player into a district that is currently hunting them
      // (unless the activity is itself a fight, in which case, fine).
      const pressure = gameHeat.pressureAt(def.x, def.z);
      score -= pressure * (def.intensity > 0.7 ? 8 : 42);

      // Playstyle affinity — the director notices what you actually enjoy.
      score += this.affinity(def.kind) * 18;

      scored.push({
        def,
        distance: dist,
        score,
        best: progression.bestTime(def.id),
        repeat: done,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    // Never offer three of the same kind: variety is the whole point.
    const out: ActivityOffer[] = [];
    const kinds = new Set<MissionKind>();
    for (const o of scored) {
      if (kinds.has(o.def.kind) && out.length < 3) continue;
      kinds.add(o.def.kind);
      out.push(o);
      if (out.length >= 4) break;
    }
    this.offers = out;
    return out;
  }

  /**
   * -1..1 preference for a mission kind, derived from how the player actually
   * spends their time. Someone with 40 km of wingsuit and no driving should be
   * offered courses, not races.
   */
  private affinity(kind: MissionKind): number {
    const s = progression.stats;
    const total = Math.max(1, s.distanceTotal);
    const air = (s.distanceWingsuit + s.distanceParachute) / total;
    const wire = s.distanceGrappling / total;
    const drive = s.distanceDriving / total;
    const fight = Math.min(1, s.kills / 240);

    switch (kind) {
      case "wingsuit-course":
        return air * 2 - 0.35;
      case "grapple-course":
        return wire * 2.4 - 0.3;
      case "race":
        return drive * 2.4 - 0.35;
      case "convoy":
        return (drive + fight) * 0.9 - 0.3;
      case "liberation":
      case "assault":
      case "destruction":
        return fight - 0.25;
      case "escort":
        return fight * 0.6 - 0.2;
      case "chaos-run":
        return clamp01(chaos.chaosPerMinute / 3000) - 0.2;
      default:
        return 0;
    }
  }

  /** Start an offer. Accepts an index into `offers` or a mission id. */
  accept(which: number | string = 0): boolean {
    const id = typeof which === "string" ? which : this.offers[which]?.def.id;
    if (!id) return false;
    return missions.start(id);
  }

  /** The nearest activity the player could start right now. */
  nearestActivity(): MissionDef | null {
    const rank = chaosRankIndex(chaos.total);
    let best: MissionDef | null = null;
    let bestD = Infinity;
    for (const def of MISSIONS) {
      if (def.minRank > rank) continue;
      const d = Math.hypot(def.x - frame.position.x, def.z - frame.position.z);
      if (d < bestD) {
        bestD = d;
        best = def;
      }
    }
    return best;
  }

  /* ---------------- discovery nudges ---------------- */

  /**
   * When nothing is happening and nothing is running, point the player at the
   * nearest thing they have not seen. This is the quietest tool the director
   * has and it is the one that does the most work: the answer to "I don't know
   * what to do" should never be an explosion.
   */
  private updateNudge(): void {
    if (missions.state === "active" || this.phase === "peak" || this.phase === "build") {
      this.clearNudge();
      return;
    }
    const d = nearestUndiscovered(frame.position.x, frame.position.z, undefined, 1400);
    if (!d) {
      this.clearNudge();
      return;
    }
    if (this.nudge && this.nudge.key === d.key) return;
    this.clearNudge();
    this.nudge = d;
    useSfStore.getState().addObjective({
      id: "director:nudge",
      title: d.kind === "viewpoint" ? "Viewpoint" : d.kind === "hidden" ? "Something hidden" : "Landmark",
      detail: d.name,
      x: d.x,
      y: d.y,
      z: d.z,
      complete: false,
      progress: 0,
    });
  }

  private clearNudge(): void {
    if (!this.nudge) return;
    this.nudge = null;
    useSfStore.setState((s) => ({
      objectives: s.objectives.filter((o) => o.id !== "director:nudge"),
    }));
  }

  /* ---------------- introspection ---------------- */

  get stats() {
    return {
      phase: this.phase,
      phaseTime: Math.round(this.phaseTime),
      intensity: Number(this.intensity.toFixed(2)),
      events: this.events.map((e) => e.kind),
      offers: this.offers.map((o) => `${MISSION_KIND_LABEL[o.def.kind]}: ${o.def.name}`),
      nudge: this.nudge?.name ?? null,
      discovered: `${discoveries.found}/${discoveries.total}`,
    };
  }

  reset(): void {
    this.stopAllEvents();
    this.clearNudge();
    this.phase = "calm";
    this.phaseTime = 0;
    this.intensity = 0;
    this.seedClock = 0;
    this.nextSeedAt = 12;
    this.offerClock = 1e9;
    this.eventCount = 0;
    this.rng = makeRng(`${WORLD_SEED}:director`);
    this.offers = [];
    this.lastKindAt = Object.create(null);
    this.lastPlayedKindAt = Object.create(null);
    this.lastDistrictAt = Object.create(null);
  }
}

export const director = new MissionDirector();

/** Districts sorted by how much of their content is still untouched. */
export function unexploredDistricts(limit = 5): { key: string; name: string; left: number }[] {
  const out = DISTRICTS.map((d) => {
    let left = 0;
    for (const m of MISSIONS) if (m.districtKey === d.key && !missions.isComplete(m.id)) left++;
    return { key: d.key, name: d.name, left };
  });
  out.sort((a, b) => b.left - a.left);
  return out.slice(0, limit);
}
