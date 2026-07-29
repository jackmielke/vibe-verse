/**
 * ai/spawner.ts — population streaming.
 *
 * The city is 9.5 km on a side. At real San Francisco density that is somewhere
 * north of two hundred thousand people, which is not a number any budget
 * survives, so the population is a *travelling bubble*: a few hundred agents
 * that live around the player, are created behind their shoulder, and are
 * retired once they are far enough away and out of view.
 *
 * The three things this module actually decides:
 *
 *   HOW MANY   from `QUALITY[tier].crowdDensity`, the local district density
 *              and the hour of day. A quiet Sunday morning in the Sunset gets
 *              a dozen people; Market at six gets the full budget.
 *   WHERE      in an annulus around the player: never inside `minDist` (you
 *              would see them appear), never beyond `maxDist` (you would never
 *              see them at all). Biased behind the view direction.
 *   HOW MUCH   per-frame spawn and despawn budgets, so a fast-travel or a
 *              wingsuit run that crosses six districts refills gradually
 *              instead of hitching for 40 ms on one frame.
 *
 * There is also a hard agent cap that degrades in a defined order under load:
 *   pedestrians shed first (there are the most of them and they matter least
 *   individually), then ambient traffic, and *never* the opposition, because
 *   despawning the soldier who is shooting at you to save a millisecond is not
 *   a trade anyone would accept.
 *
 * Public API
 * ----------
 *   spawner.setQuality(tier)
 *   spawner.update(dt, now, px, py, pz, fx, fz)
 *   spawner.stats
 */
import { QUALITY, type QualityTier } from "../config";
import { frame } from "../state/store";
import { enemyForce } from "./enemies";
import { heat } from "./heat";
import { navGraph } from "./navigation";
import { Pedestrians, pedestrians } from "./pedestrians";
import { trafficSim } from "./traffic";

/** Distance bands, metres. Everything in this file is tuned against them. */
export const BAND_FULL = 90;
export const BAND_SIMPLE = 240;
export const BAND_FROZEN = 520;

interface Budget {
  /** Population ceilings at 1.0 crowd density. */
  peds: number;
  vehicles: number;
  enemies: number;
  /** Streaming radii. */
  pedRadius: number;
  vehicleRadius: number;
  /** Spawn attempts per frame. */
  spawnsPerFrame: number;
  despawnsPerFrame: number;
}

const BUDGETS: Record<QualityTier, Budget> = {
  low: {
    peds: 55,
    vehicles: 34,
    enemies: 18,
    pedRadius: 130,
    vehicleRadius: 240,
    spawnsPerFrame: 1,
    despawnsPerFrame: 3,
  },
  medium: {
    peds: 110,
    vehicles: 62,
    enemies: 26,
    pedRadius: 170,
    vehicleRadius: 320,
    spawnsPerFrame: 2,
    despawnsPerFrame: 4,
  },
  high: {
    peds: 210,
    vehicles: 110,
    enemies: 40,
    pedRadius: 210,
    vehicleRadius: 420,
    spawnsPerFrame: 3,
    despawnsPerFrame: 6,
  },
  ultra: {
    peds: 330,
    vehicles: 160,
    enemies: 56,
    pedRadius: 260,
    vehicleRadius: 520,
    spawnsPerFrame: 4,
    despawnsPerFrame: 8,
  },
};

class Spawner {
  private tier: QualityTier = "high";
  private budget: Budget = BUDGETS.high;
  /** 0..1 load-shedding factor applied on top of everything else. */
  private relief = 1;
  private cullPhase = 0;
  private lastMoveX = 0;
  private lastMoveZ = 0;

  stats = {
    peds: 0,
    pedTarget: 0,
    vehicles: 0,
    vehicleTarget: 0,
    enemies: 0,
    spawnedThisSecond: 0,
    relief: 1,
  };

  setQuality(tier: QualityTier): void {
    this.tier = tier;
    this.budget = BUDGETS[tier] ?? BUDGETS.high;
    this.apply();
  }

  private apply(): void {
    const density = QUALITY[this.tier].crowdDensity;
    pedestrians.max = Math.round(this.budget.peds * density * this.relief);
    trafficSim.maxVehicles = Math.round(this.budget.vehicles * density * this.relief);
    enemyForce.maxEnemies = this.budget.enemies;
  }

  /**
   * Shed load. Called by the driver when the frame budget is being missed.
   * `factor` 1 is full population, 0.5 is half. Applied to crowds only —
   * the opposition is never thinned.
   */
  setRelief(factor: number): void {
    const f = Math.max(0.25, Math.min(1, factor));
    if (Math.abs(f - this.relief) < 0.02) return;
    this.relief = f;
    this.apply();
    this.stats.relief = f;
  }

  reset(): void {
    this.relief = 1;
    this.cullPhase = 0;
    this.apply();
  }

  /* ---------------- the tick ---------------- */

  update(
    dt: number,
    now: number,
    px: number,
    py: number,
    pz: number,
    fx: number,
    fz: number,
  ): void {
    const density = QUALITY[this.tier].crowdDensity * this.relief;
    const hour = frame.timeOfDay;

    // Make sure the street graph exists a little ahead of where the player is
    // going, not just where they are — at wingsuit speed that is the whole
    // difference between streets that exist and streets that pop in.
    const lead = Math.min(320, frame.speed * 6);
    navGraph.ensure(px + fx * lead, pz + fz * lead, this.budget.vehicleRadius * 0.7);

    /* ---- pedestrians ---- */
    const local = Pedestrians.crowdFactor(px, pz, hour);
    const pedTarget = Math.min(
      pedestrians.max,
      Math.round(this.budget.peds * density * local),
    );
    this.stats.pedTarget = pedTarget;

    let spawns = this.budget.spawnsPerFrame;
    while (spawns > 0 && pedestrians.count < pedTarget) {
      // Spawn in an annulus: close enough to be useful, far enough that the
      // appearance happens off-screen most of the time.
      const min = 34;
      const max = this.budget.pedRadius;
      if (pedestrians.spawnNear(px, pz, min, max, hour, now) < 0) break;
      spawns--;
    }

    /* ---- traffic ---- */
    // Traffic density follows the road hierarchy and the clock rather than the
    // pavement crowd — a freeway ramp at 3 am is empty of people and not of
    // cars.
    const trafficCurve = 0.35 + 0.65 * Math.max(0, Math.sin(((hour - 5) / 14) * Math.PI));
    const vehicleTarget = Math.min(
      trafficSim.maxVehicles,
      Math.round(this.budget.vehicles * density * trafficCurve),
    );
    this.stats.vehicleTarget = vehicleTarget;

    let vSpawns = Math.max(1, this.budget.spawnsPerFrame >> 1);
    while (vSpawns > 0 && trafficSim.vehicles.length < vehicleTarget) {
      if (!trafficSim.spawnNear(px, pz, 70, this.budget.vehicleRadius, now)) break;
      vSpawns--;
    }

    /* ---- culling, round-robin so no single frame pays for all of it ---- */
    this.cullPhase = (this.cullPhase + 1) % 3;
    if (this.cullPhase === 0) {
      pedestrians.cullFar(px, pz, fx, fz, this.budget.pedRadius * 1.5, now);
    } else if (this.cullPhase === 1) {
      trafficSim.cullFar(px, pz, this.budget.vehicleRadius * 1.4, now);
    } else {
      // Only cull the opposition when they have genuinely lost interest — a
      // squad still searching for you is not scenery.
      enemyForce.cullFar(px, pz, Math.max(420, heat.searchRadius * 1.8));
    }

    this.stats.peds = pedestrians.count;
    this.stats.vehicles = trafficSim.vehicles.length;
    this.stats.enemies = enemyForce.enemies.length;
    this.lastMoveX = px;
    this.lastMoveZ = pz;
  }

  /**
   * Sim LOD band for a distance. Exposed so every subsystem uses the same
   * thresholds and a pedestrian and a soldier standing side by side never
   * disagree about which band they are in.
   */
  static bandFor(dist2: number): 0 | 1 | 2 {
    if (dist2 < BAND_FULL * BAND_FULL) return 0;
    if (dist2 < BAND_SIMPLE * BAND_SIMPLE) return 1;
    return 2;
  }
}

export const spawner = new Spawner();
export { Spawner };
