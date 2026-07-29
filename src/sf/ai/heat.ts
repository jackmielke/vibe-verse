/**
 * ai/heat.ts — how much trouble you are in, and how you get out of it.
 *
 * The wanted system is the spine of an open-world sandbox: it is the thing that
 * converts "I did something" into "the world does something back". Getting it
 * right is mostly about the *losing* of heat, not the gaining. Everyone can
 * make sirens appear. What makes a chase good is that breaking line of sight,
 * putting distance and buildings between you and the search, and then holding
 * still for twenty seconds actually works — and that you can feel it working.
 *
 * Two coupled quantities:
 *
 *   CHAOS   the persistent score. Never decays. Drives progression, and its
 *           thresholds (`CHAOS.heatThresholds`) set the *ceiling* on how hard
 *           the city can come at you.
 *   HEAT    the live wanted level 0–5. Rises with fresh crime, decays with
 *           time-since-incident, and is *held* as long as anyone with a badge
 *           can see you.
 *
 * The search model is the part players actually read:
 *
 *   - While seen, the search circle is pinned to you and is small.
 *   - The moment line of sight breaks, the circle freezes at your last known
 *     position and starts growing — the police are searching outward, not
 *     tracking you. Leave the circle and you are winning.
 *   - `evasion` fills while you are unseen and outside the circle. When it
 *     fills, one level comes off and the circle resets around the new estimate.
 *   - A fresh crime instantly re-pins everything, which is why shooting your
 *     way out of a search is a bad idea and hiding is a good one.
 *
 * Public API
 * ----------
 *   heat.update(dt, now)
 *   heat.reportCrime(kind, x, z)
 *   heat.notifySeen(x, z, now) / heat.level / heat.searchCentre / heat.searchRadius
 */
import { CHAOS } from "../config";
import { frame, useSfStore } from "../state/store";
import { emitNoise } from "./perception";

export type CrimeKind =
  | "gunfire"
  | "assault"
  | "civilian-kill"
  | "officer-kill"
  | "vehicle-theft"
  | "vehicle-destroyed"
  | "property"
  | "explosion"
  | "reckless";

/** Immediate wanted pressure per crime, in "heat points". */
const CRIME_WEIGHT: Record<CrimeKind, number> = {
  gunfire: 22,
  assault: 30,
  "civilian-kill": 130,
  "officer-kill": 260,
  "vehicle-theft": 45,
  "vehicle-destroyed": 70,
  property: 26,
  explosion: 150,
  reckless: 6,
};

/** Chaos score awarded per crime, folded into the persistent total. */
const CRIME_CHAOS: Partial<Record<CrimeKind, number>> = {
  "vehicle-destroyed": CHAOS.points.vehicle,
  explosion: CHAOS.points.fuelTank,
  property: CHAOS.points.prop,
};

/**
 * Heat points needed to *reach* each level. Deliberately independent of the
 * chaos thresholds: chaos is a career, heat is an afternoon.
 */
const LEVEL_POINTS = [0, 40, 150, 400, 900, 1800];

/** How far a search circle has grown after this many seconds unseen, metres. */
const SEARCH_GROWTH = 9.5;
const SEARCH_MIN = 26;
const SEARCH_MAX = 340;

class HeatSystem {
  /** Live wanted pressure, decays. */
  points = 0;
  /** Current wanted level, 0–5. */
  level = 0;
  /** Highest level reached this incident — used for the "escaped" message. */
  peak = 0;

  /** Where the police believe the player is. */
  searchX = 0;
  searchZ = 0;
  searchRadius = SEARCH_MIN;
  /** True while at least one hostile unit currently has eyes on the player. */
  seen = false;
  /** Sim time of the last confirmed sighting. */
  lastSeen = -1e9;
  /** Sim time of the last crime of any kind. */
  lastCrime = -1e9;
  /** 0..1 progress toward shedding a level. */
  evasion = 0;

  /** Ceiling imposed by the chaos score — you cannot summon the army on day one. */
  get maxLevel(): number {
    const chaos = useSfStore.getState().chaos;
    let cap = 1;
    for (let i = 1; i < CHAOS.heatThresholds.length; i++) {
      if (chaos >= CHAOS.heatThresholds[i]) cap = i + 1;
    }
    return Math.min(5, Math.max(2, cap));
  }

  reset(): void {
    this.points = 0;
    this.level = 0;
    this.peak = 0;
    this.evasion = 0;
    this.seen = false;
    this.lastSeen = -1e9;
    this.lastCrime = -1e9;
    this.searchRadius = SEARCH_MIN;
    useSfStore.getState().setHeat(0);
  }

  /**
   * Something happened. `x, z` is where — usually the player, but a bomb on a
   * timer is reported where the bomb was, which is what lets you set one and
   * walk away.
   */
  reportCrime(kind: CrimeKind, x: number, z: number, witnessed = true): void {
    const w = CRIME_WEIGHT[kind] ?? 10;
    const chaos = CRIME_CHAOS[kind];
    if (chaos) useSfStore.getState().addChaos(chaos);

    // An unwitnessed crime still raises heat, but only a third as much and it
    // does not re-pin the search. Silenced weapons and empty alleys matter.
    this.points += witnessed ? w : w * 0.34;
    this.lastCrime = frame.time;
    if (witnessed) {
      this.searchX = x;
      this.searchZ = z;
      this.searchRadius = Math.min(this.searchRadius, SEARCH_MIN * 1.6);
      this.evasion = 0;
    }
    this.recomputeLevel();
  }

  /** A police or military unit has confirmed eyes on the player. */
  notifySeen(x: number, z: number, now: number): void {
    this.seen = true;
    this.lastSeen = now;
    this.searchX = x;
    this.searchZ = z;
    this.searchRadius = SEARCH_MIN;
    this.evasion = 0;
  }

  private recomputeLevel(): void {
    const cap = this.maxLevel;
    let lvl = 0;
    for (let i = 1; i < LEVEL_POINTS.length; i++) {
      if (this.points >= LEVEL_POINTS[i]) lvl = i;
    }
    lvl = Math.min(lvl, cap);
    if (lvl !== this.level) {
      const rising = lvl > this.level;
      this.level = lvl;
      useSfStore.getState().setHeat(lvl);
      if (rising) {
        this.peak = Math.max(this.peak, lvl);
        useSfStore
          .getState()
          .notify(HEAT_LABELS[lvl] ?? `Wanted level ${lvl}`, "damage");
      } else if (lvl === 0) {
        useSfStore.getState().notify("You lost them.", "info");
        this.peak = 0;
      }
    }
  }

  /**
   * One tick. Called by the AI driver after perception has run, so `seen` is
   * this frame's answer rather than last frame's.
   */
  update(dt: number, now: number): void {
    if (this.level === 0 && this.points <= 0) {
      this.seen = false;
      return;
    }

    // Decay: heat bleeds off only once nothing has happened for a while. The
    // config's `heatDecaySeconds` is the grace period, and the bleed is scaled
    // so a level-5 rampage takes minutes to shake, not seconds.
    const quiet = now - this.lastCrime;
    if (quiet > CHAOS.heatDecaySeconds && !this.seen) {
      const rate = 6 + this.level * 5;
      this.points = Math.max(0, this.points - rate * dt);
    }

    if (this.seen) {
      this.searchRadius = SEARCH_MIN;
      this.evasion = 0;
    } else {
      const unseenFor = now - this.lastSeen;
      // The circle grows: they are searching outward from where you were.
      this.searchRadius = Math.min(SEARCH_MAX, SEARCH_MIN + unseenFor * SEARCH_GROWTH);
      const d = Math.hypot(frame.position.x - this.searchX, frame.position.z - this.searchZ);
      // Progress only while genuinely outside the search area *and* quiet.
      const outside = d > this.searchRadius * 0.85;
      if (outside && quiet > 4) {
        // Higher levels take longer to shed — a five is a helicopter and a
        // cordon, and it should not evaporate because you turned a corner.
        this.evasion += dt / (7 + this.level * 4.5);
      } else {
        this.evasion = Math.max(0, this.evasion - dt * 0.35);
      }
      if (this.evasion >= 1) {
        this.evasion = 0;
        this.points = Math.max(0, LEVEL_POINTS[Math.max(0, this.level - 1)] - 1);
        this.searchRadius = SEARCH_MIN * 2;
        // The next search starts from where they think you went, not from you.
        this.searchX = frame.position.x + (this.searchX - frame.position.x) * 0.55;
        this.searchZ = frame.position.z + (this.searchZ - frame.position.z) * 0.55;
        this.recomputeLevel();
      }
    }

    this.recomputeLevel();
    // Reset for the next frame's perception pass.
    this.seen = false;
  }

  /** Sirens the player can hear once the response is rolling. */
  ambientSiren(now: number, x: number, z: number): void {
    if (this.level < 1) return;
    emitNoise("siren", x, 4, z, "police", 0, 240, 0.2);
  }

  /** True if a point is inside the area currently being searched. */
  inSearchArea(x: number, z: number): boolean {
    const dx = x - this.searchX;
    const dz = z - this.searchZ;
    return dx * dx + dz * dz < this.searchRadius * this.searchRadius;
  }

  stats() {
    return {
      level: this.level,
      points: Math.round(this.points),
      radius: Math.round(this.searchRadius),
      evasion: this.evasion,
      seen: this.seen,
    };
  }
}

const HEAT_LABELS: Record<number, string> = {
  1: "SFPD responding",
  2: "Units converging — roadblocks up",
  3: "SWAT deployed",
  4: "Air support inbound",
  5: "National Guard mobilised",
};

export const heat = new HeatSystem();
export { HeatSystem };
