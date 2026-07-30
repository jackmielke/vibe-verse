/**
 * game/heat.ts — the *scoring* side of trouble.
 *
 * `ai/heat.ts` already owns the wanted-level state machine: what level you are
 * at, where the search circle is, how evasion fills. That is the response
 * side, and this module does not duplicate a line of it. What lives here is
 * everything the game layer needs on top:
 *
 *   PROVOCATION ROUTING   one typed entry point that missions, destructibles
 *                         and the chaos economy call, which fans out to
 *                         `aiHeat.reportCrime` with the right witness flag.
 *   AMBIENT PRESSURE      a rampage summons police even when no single act was
 *                         "witnessed". Sustained chaos-per-minute is converted
 *                         into periodic crime reports so the city responds to
 *                         the *scale* of what you are doing, not just to
 *                         individual events.
 *   DISTRICT MEMORY       a decaying pressure field over the 24 real districts.
 *                         Hit the Mission four times in ten minutes and the
 *                         Mission stays touchy; the Presidio does not care.
 *                         The director reads this to place activities, and the
 *                         spawner could read it to thicken patrols.
 *   TERRAIN ASSIST        hiding actually works, and *where* you hide matters.
 *                         Water, parks, Sutro forest and empty hillsides bleed
 *                         heat faster than standing in Union Square. This is
 *                         applied as extra decay on `aiHeat.points`, never by
 *                         reimplementing the level maths.
 *   PURSUIT LEDGER        pursuit duration, peak level, escapes, time at each
 *                         level — the numbers challenges and the save file
 *                         care about, plus the escape payout.
 *
 * Public API
 * ----------
 *   gameHeat.provoke(kind, x, z, witnessed?)
 *   gameHeat.tick(dt, now)                 call once per frame, AFTER ai heat
 *   gameHeat.pressureAt(x, z) -> 0..1
 *   gameHeat.notoriety -> 0..1             smoothed "how hot is this session"
 *   gameHeat.snapshot()                    for the HUD / debug overlay
 *   gameHeat.stats / gameHeat.reset()
 */
import { CHAOS } from "../config";
import { frame, useSfStore } from "../state/store";
import { heat as aiHeat, type CrimeKind } from "../ai/heat";
import {
  DISTRICTS,
  districtAt,
  isPark,
  isWater,
  landSDF,
  terrainHeight,
} from "../geo/sfGeo";
import { clamp01 } from "../math/rng";
import { chaos } from "./chaos";

/** Everything the game layer can do that the city objects to. */
export type Provocation =
  | CrimeKind
  /** Attacking a landmark: the city treats it as a bigger deal than a parked car. */
  | "landmark-attack"
  /** Breaching a restricted zone — Alcatraz, the Presidio armoury, a convoy. */
  | "trespass"
  /** Interfering with a police or military asset without killing anyone. */
  | "sabotage";

/** Extra weights for the provocations `ai/heat` does not know about. */
const EXTRA_WEIGHT: Record<string, { crime: CrimeKind; scale: number }> = {
  "landmark-attack": { crime: "explosion", scale: 1.4 },
  trespass: { crime: "assault", scale: 0.7 },
  sabotage: { crime: "property", scale: 1.6 },
};

/* ------------------------------------------------------------------ *
 * District pressure
 * ------------------------------------------------------------------ */

/** Seconds for district pressure to halve. Long enough to feel like memory. */
const PRESSURE_HALFLIFE = 150;
/** Pressure added per unit of "provocation weight". */
const PRESSURE_PER_WEIGHT = 0.006;
/** Above this, the district is considered actively hostile. */
export const PRESSURE_HOSTILE = 0.55;

/* ------------------------------------------------------------------ *
 * Ambient pressure from chaos rate
 * ------------------------------------------------------------------ */

/**
 * Chaos-per-minute at which the city starts responding on its own. Below this
 * you are noise; above it you are an event. Tuned so that a steady stream of
 * small props does *not* trip it but two vehicles and a fuel tank does.
 */
const AMBIENT_CPM_FLOOR = 400;
const AMBIENT_CPM_CEIL = 4500;
/** Seconds between ambient reports at full rate. */
const AMBIENT_MIN_INTERVAL = 3.2;
const AMBIENT_MAX_INTERVAL = 14;

/* ------------------------------------------------------------------ *
 * Terrain assist
 * ------------------------------------------------------------------ */

/** Extra heat points per second bled off in ideal cover. */
const COVER_BLEED = 14;

class GameHeat {
  /** Per-district decaying pressure, index-aligned with DISTRICTS. */
  readonly pressure = new Float32Array(DISTRICTS.length);

  /** Smoothed 0..1 "how hot is this session" — drives director intensity. */
  notoriety = 0;

  /* --- pursuit ledger --- */
  /** Sim time the current pursuit began, or -1. */
  pursuitStart = -1;
  /** Highest level reached in the current pursuit. */
  pursuitPeak = 0;
  /** Longest pursuit survived, seconds. */
  longestPursuit = 0;
  /** Successful escapes from level >= 2. */
  escapes = 0;
  /** Times the player has been killed while wanted. */
  busted = 0;
  /** Seconds spent at each wanted level, 0..5. */
  readonly timeAtLevel = new Float64Array(6);
  /** Highest wanted level ever reached. */
  peakLevelEver = 0;

  private prevLevel = 0;
  private ambientClock = 0;
  private lastProvocation = -1e9;

  /* ---------------- provocation ---------------- */

  /**
   * Report something the city cares about. `witnessed` defaults to true; pass
   * false for silenced work in an empty alley — `ai/heat` charges a third of
   * the weight and does not re-pin the search circle.
   */
  provoke(kind: Provocation, x: number, z: number, witnessed = true): void {
    const extra = EXTRA_WEIGHT[kind];
    const crime: CrimeKind = extra ? extra.crime : (kind as CrimeKind);
    const scale = extra ? extra.scale : 1;

    aiHeat.reportCrime(crime, x, z, witnessed);
    // `reportCrime` applies its own weight for the crime it knows about. The
    // game-layer provocations are scaled by adjusting the resulting pressure
    // directly rather than by reporting twice, which would double-pin the
    // search circle and double-award the crime's chaos.
    if (scale !== 1) {
      aiHeat.points = Math.max(0, aiHeat.points * (1 + (scale - 1) * 0.5));
    }

    this.lastProvocation = frame.time;
    this.bumpPressure(x, z, 26 * scale * (witnessed ? 1 : 0.34));
  }

  /** Raise the pressure field around a point. */
  bumpPressure(x: number, z: number, weight: number): void {
    const add = weight * PRESSURE_PER_WEIGHT;
    // Weighted across neighbours so a provocation on a district boundary
    // heats both sides — districts are a lookup convenience, not a fence.
    for (let i = 0; i < DISTRICTS.length; i++) {
      const d = DISTRICTS[i];
      const dist = Math.hypot(x - d.x, z - d.z);
      if (dist > d.radius * 1.6) continue;
      const w = 1 - clamp01(dist / (d.radius * 1.6));
      this.pressure[i] = Math.min(1.6, this.pressure[i] + add * w * w);
    }
  }

  /** 0..1 blended pressure at a world point. */
  pressureAt(x: number, z: number): number {
    let sum = 0;
    let wsum = 0;
    for (let i = 0; i < DISTRICTS.length; i++) {
      const d = DISTRICTS[i];
      const dist = Math.hypot(x - d.x, z - d.z);
      if (dist > d.radius * 1.6) continue;
      const w = 1 - clamp01(dist / (d.radius * 1.6));
      sum += this.pressure[i] * w;
      wsum += w;
    }
    return wsum > 0 ? clamp01(sum / wsum) : 0;
  }

  /** The district index with the most pressure, or -1 if the city is calm. */
  hottestDistrict(): number {
    let best = -1;
    let bestV = 0.12;
    for (let i = 0; i < DISTRICTS.length; i++) {
      if (this.pressure[i] > bestV) {
        bestV = this.pressure[i];
        best = i;
      }
    }
    return best;
  }

  /** The calmest district within `radius` of a point — where the director sends you to breathe. */
  coolestDistrictNear(x: number, z: number, radius: number): number {
    let best = -1;
    let bestV = Infinity;
    for (let i = 0; i < DISTRICTS.length; i++) {
      const d = DISTRICTS[i];
      if (Math.hypot(x - d.x, z - d.z) > radius) continue;
      if (this.pressure[i] < bestV) {
        bestV = this.pressure[i];
        best = i;
      }
    }
    return best;
  }

  /* ---------------- per-frame ---------------- */

  tick(dt: number, now: number): void {
    if (dt <= 0) return;

    // Exponential decay of the pressure field. One multiply per district per
    // frame across 24 districts is nothing, and doing it here rather than
    // lazily keeps `pressureAt` a pure read.
    const k = Math.pow(0.5, dt / PRESSURE_HALFLIFE);
    for (let i = 0; i < this.pressure.length; i++) this.pressure[i] *= k;

    const level = aiHeat.level;
    if (level >= 0 && level <= 5) this.timeAtLevel[level] += dt;
    if (level > this.peakLevelEver) this.peakLevelEver = level;

    this.trackPursuit(level, now);
    this.ambientPressure(dt, now);
    this.terrainAssist(dt, now);

    // Notoriety: a slow blend of wanted level and chaos rate. The director
    // wants a value that does not flicker when a level ticks over, so it is
    // smoothed hard in both directions but faster on the way up — the game
    // should feel like it noticed immediately and forgets slowly.
    const target = clamp01(
      level / 5 * 0.65 + clamp01(chaos.chaosPerMinute / AMBIENT_CPM_CEIL) * 0.35,
    );
    const rate = target > this.notoriety ? 0.55 : 0.11;
    this.notoriety += (target - this.notoriety) * Math.min(1, rate * dt);
  }

  /** Open/close pursuits and pay the escape bonus. */
  private trackPursuit(level: number, now: number): void {
    if (level > 0 && this.pursuitStart < 0) {
      this.pursuitStart = now;
      this.pursuitPeak = level;
    }
    if (level > this.pursuitPeak) this.pursuitPeak = level;

    if (level === 0 && this.pursuitStart >= 0) {
      const duration = now - this.pursuitStart;
      if (duration > this.longestPursuit) this.longestPursuit = duration;
      if (this.pursuitPeak >= 2) {
        this.escapes++;
        // Escaping is the other half of the loop and has to pay like it.
        // Quadratic in peak level so shaking a five is a genuine score event.
        const bonus = Math.round(140 * this.pursuitPeak * this.pursuitPeak);
        chaos.payout(bonus, `Escaped a level ${this.pursuitPeak} pursuit`);
      }
      this.pursuitStart = -1;
      this.pursuitPeak = 0;
    }

    if (this.prevLevel !== level) this.prevLevel = level;
  }

  /**
   * Convert sustained destruction into police interest. Without this you can
   * flatten a block with a silenced launcher from a rooftop and nobody comes,
   * which reads as the city being asleep rather than as you being clever.
   */
  private ambientPressure(dt: number, now: number): void {
    const cpm = chaos.chaosPerMinute;
    if (cpm < AMBIENT_CPM_FLOOR) {
      this.ambientClock = 0;
      return;
    }
    const t = clamp01((cpm - AMBIENT_CPM_FLOOR) / (AMBIENT_CPM_CEIL - AMBIENT_CPM_FLOOR));
    const interval = AMBIENT_MAX_INTERVAL + (AMBIENT_MIN_INTERVAL - AMBIENT_MAX_INTERVAL) * t;

    this.ambientClock += dt;
    if (this.ambientClock < interval) return;
    this.ambientClock = 0;

    // Report where the chaos actually happened, not where the player is now.
    // Setting a charge and walking away should send them to the charge.
    const fresh = now - chaos.lastTime < 12;
    const x = fresh ? chaos.lastX : frame.position.x;
    const z = fresh ? chaos.lastZ : frame.position.z;
    aiHeat.reportCrime(t > 0.55 ? "explosion" : "property", x, z, true);
    this.bumpPressure(x, z, 18 + 40 * t);
  }

  /**
   * Where you hide matters. This only ever *removes* heat points, never adds
   * them, and only while unseen and quiet — so it can never fight the wanted
   * system for control of the level, it can only make good hiding pay.
   */
  private terrainAssist(dt: number, now: number): void {
    if (aiHeat.level === 0) return;
    if (aiHeat.seen) return;
    if (now - aiHeat.lastCrime < CHAOS.heatDecaySeconds * 0.5) return;

    const x = frame.position.x;
    const z = frame.position.z;

    let cover = 0;
    // Open water: nobody is searching the bay on foot.
    if (isWater(x, z)) cover += 0.9;
    // Parks and forest: Sutro, Golden Gate Park, the Presidio.
    if (isPark(x, z)) cover += 0.55;
    // Distance from anything built — landSDF is negative offshore, positive
    // inland, so this catches beaches and the far edges of the map too.
    const sdf = landSDF(x, z);
    if (sdf < 60) cover += 0.2;
    // Altitude: a rooftop 80 m up is not where a search line looks first.
    const agl = frame.position.y - terrainHeight(x, z);
    if (agl > 40) cover += 0.35;
    // Fog is SF's own stealth field, and it should be worth using.
    cover += frame.fogDensity * 0.4;
    // A busy district cancels most of it — you cannot hide in the Financial
    // District at 5pm by standing still.
    const d = districtAt(x, z);
    cover -= d.density * 0.45;

    if (cover <= 0) return;
    aiHeat.points = Math.max(0, aiHeat.points - COVER_BLEED * Math.min(1.6, cover) * dt);
  }

  /* ---------------- reporting ---------------- */

  /** Called by the player system when the player dies while wanted. */
  onPlayerDown(): void {
    if (aiHeat.level > 0) {
      this.busted++;
      useSfStore.getState().notify("Busted", "damage");
    }
    this.pursuitStart = -1;
    this.pursuitPeak = 0;
  }

  snapshot() {
    return {
      level: aiHeat.level,
      points: Math.round(aiHeat.points),
      searchRadius: Math.round(aiHeat.searchRadius),
      evasion: aiHeat.evasion,
      seen: aiHeat.seen,
      notoriety: this.notoriety,
      pressure: this.pressureAt(frame.position.x, frame.position.z),
      pursuit: this.pursuitStart >= 0 ? frame.time - this.pursuitStart : 0,
      sinceProvocation: frame.time - this.lastProvocation,
    };
  }

  get stats() {
    return {
      escapes: this.escapes,
      busted: this.busted,
      longestPursuit: Math.round(this.longestPursuit),
      peakLevelEver: this.peakLevelEver,
      timeAtLevel: Array.from(this.timeAtLevel, (v) => Math.round(v)),
    };
  }

  /** Restore ledger fields from a save. Pressure is deliberately not saved. */
  hydrate(s: Partial<{
    escapes: number;
    busted: number;
    longestPursuit: number;
    peakLevelEver: number;
    timeAtLevel: number[];
  }>): void {
    if (s.escapes != null) this.escapes = s.escapes;
    if (s.busted != null) this.busted = s.busted;
    if (s.longestPursuit != null) this.longestPursuit = s.longestPursuit;
    if (s.peakLevelEver != null) this.peakLevelEver = s.peakLevelEver;
    if (s.timeAtLevel) {
      for (let i = 0; i < 6 && i < s.timeAtLevel.length; i++) {
        this.timeAtLevel[i] = s.timeAtLevel[i] ?? 0;
      }
    }
  }

  reset(): void {
    this.pressure.fill(0);
    this.notoriety = 0;
    this.pursuitStart = -1;
    this.pursuitPeak = 0;
    this.prevLevel = 0;
    this.ambientClock = 0;
    this.lastProvocation = -1e9;
  }
}

export const gameHeat = new GameHeat();
