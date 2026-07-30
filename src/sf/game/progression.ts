/**
 * game/progression.ts — unlocks, challenges, and the stat ledger.
 *
 * Three jobs, deliberately in one module because they are the same loop seen
 * from three angles:
 *
 *   STATS       everything the game quietly counts. Integrated from `frame`
 *               once per director tick — distance by movement mode, air time,
 *               top speed, the longest fall survived — plus counters other
 *               systems push in. This is the substrate; nothing else works
 *               without it.
 *   CHALLENGES  named goals over those stats. They are the game telling you
 *               what it thinks is fun before you have worked it out yourself:
 *               "survive a 200 metre fall", "hold a x3 combo", "fly a kilometre
 *               without touching the ground".
 *   UNLOCKS     the reward layer. Weapons, grapple tethers, wingsuit lift.
 *               Unlocks arrive from three sources — career rank (automatic),
 *               mission reward tokens, and challenges — and all three funnel
 *               through `grant()` so the notification, the save write and the
 *               recomputed tuning happen in exactly one place.
 *
 * The upgrade values live in `upgrades`, a plain mutable object recomputed on
 * every grant. Player systems read it directly:
 *
 *     import { upgrades } from "@/sf/game/progression";
 *     const range = upgrades.grappleRange;      // metres, already scaled
 *     const tethers = upgrades.maxTethers;
 *
 * That is the whole contract. No events to subscribe to, no React, and no
 * per-frame cost — reading a number off an object is free, and the object only
 * changes when something is unlocked.
 *
 * Public API
 * ----------
 *   progression.tick(dt) / install()
 *   progression.stats / upgrades / unlocked(id) / grant(id)
 *   progression.recordTime(missionId, seconds) -> improved?
 *   progression.bestTime(missionId)
 *   CHALLENGES / UNLOCKS
 */
import { GRAPPLE, PLAYER, WINGSUIT } from "../config";
import { frame, useSfStore } from "../state/store";
import { chaos, chaosRankIndex } from "./chaos";
import { discoveries } from "./discoveries";
import { gameHeat } from "./heat";
import { MISSIONS, missions } from "./missions";

/* ================================================================== *
 * Unlocks
 * ================================================================== */

export type UnlockCategory = "weapon" | "grapple" | "wingsuit" | "vehicle" | "utility";

export interface UnlockDef {
  id: string;
  name: string;
  description: string;
  category: UnlockCategory;
  /**
   * Career rank index at which this is granted automatically. -1 means it is
   * only obtainable from a mission reward or a challenge — which is what makes
   * the mission list worth working through rather than grinding chaos.
   */
  rank: number;
}

export const UNLOCKS: readonly UnlockDef[] = [
  /* ---- weapons ---- */
  { id: "weapon-sidearm", name: "Sidearm", description: "Always with you.", category: "weapon", rank: 0 },
  { id: "weapon-smg", name: "SMG", description: "Close work, high rate, forgiving spread.", category: "weapon", rank: 1 },
  { id: "weapon-rifle", name: "Assault Rifle", description: "The default answer to most problems.", category: "weapon", rank: 1 },
  { id: "weapon-shotgun", name: "Shotgun", description: "Doorways, stairwells, helicopters at bad range.", category: "weapon", rank: -1 },
  { id: "weapon-battle", name: "Battle Rifle", description: "Fewer, heavier rounds. Punches through cover.", category: "weapon", rank: -1 },
  { id: "weapon-sniper", name: "Sniper Rifle", description: "Reach out across the bay.", category: "weapon", rank: 3 },
  { id: "weapon-lmg", name: "Light Machine Gun", description: "Suppression, from the hip, forever.", category: "weapon", rank: 4 },
  { id: "weapon-gl", name: "Grenade Launcher", description: "Arcing 40mm. Learn the drop.", category: "weapon", rank: -1 },
  { id: "weapon-rpg", name: "Rocket Launcher", description: "For structures, convoys and helicopters.", category: "weapon", rank: -1 },
  { id: "weapon-sticky", name: "Sticky Charges", description: "Place, walk away, press the button.", category: "weapon", rank: -1 },
  { id: "weapon-grenade", name: "Frag Grenades", description: "Cheap chaos with a four second fuse.", category: "weapon", rank: 2 },

  /* ---- grapple ---- */
  {
    id: "grapple-tether-3",
    name: "Third Tether",
    description: "A third independent hook. Two anchors and a target is a physics problem you get to author.",
    category: "grapple",
    rank: -1,
  },
  {
    id: "grapple-tether-4",
    name: "Fourth Tether",
    description: "Four live tethers. Bring a building down with the other three still attached.",
    category: "grapple",
    rank: -1,
  },
  { id: "grapple-range-2", name: "Extended Line", description: "Hook range +45%.", category: "grapple", rank: -1 },
  { id: "grapple-range-3", name: "Long Line", description: "Hook range +90%. Twin Peaks to the ridge below.", category: "grapple", rank: 5 },
  { id: "grapple-reel-2", name: "Fast Reel", description: "Reel acceleration and top reel speed +35%.", category: "grapple", rank: -1 },
  { id: "grapple-reel-3", name: "Winch", description: "Reel acceleration and top reel speed +75%.", category: "grapple", rank: 6 },

  /* ---- wingsuit ---- */
  { id: "wingsuit-boost-2", name: "Boost Cells", description: "Boost fuel +60%.", category: "wingsuit", rank: -1 },
  { id: "wingsuit-boost-3", name: "Deep Cells", description: "Boost fuel +130%, faster refill.", category: "wingsuit", rank: 5 },
  { id: "wingsuit-lift-2", name: "Cambered Wing", description: "Lift +15%, stall speed down.", category: "wingsuit", rank: -1 },
  { id: "wingsuit-lift-3", name: "Competition Wing", description: "Lift +30%, stall speed down further.", category: "wingsuit", rank: 6 },

  /* ---- vehicles + utility ---- */
  { id: "vehicle-tuning", name: "Street Tune", description: "Hijacked vehicles run 12% faster and corner harder.", category: "vehicle", rank: -1 },
  { id: "utility-parachute-flare", name: "Canopy Flare", description: "Stronger air brake under canopy.", category: "utility", rank: 2 },
  { id: "utility-armour", name: "Plate Carrier", description: "+25 max health.", category: "utility", rank: 3 },
  { id: "utility-fast-regen", name: "Field Medicine", description: "Health regeneration starts sooner and runs faster.", category: "utility", rank: 4 },
];

export const UNLOCK_BY_ID: Record<string, UnlockDef> = Object.fromEntries(
  UNLOCKS.map((u) => [u.id, u]),
);

/* ================================================================== *
 * Derived tuning
 * ================================================================== */

export interface Upgrades {
  /** Live tether count, 2..4. */
  maxTethers: number;
  /** Grapple range in metres, already scaled. */
  grappleRange: number;
  reelAcceleration: number;
  maxReelSpeed: number;
  /** Wingsuit. */
  boostFuel: number;
  boostRefill: number;
  lift: number;
  stallSpeed: number;
  /** Parachute flare multiplier. */
  flareStrength: number;
  /** Vehicle handling/top speed multiplier. */
  vehicleTune: number;
  /** Max health, including armour. */
  maxHealth: number;
  regenDelay: number;
  regenRate: number;
  /** Weapon keys currently available, in registry order. */
  weapons: string[];
}

/**
 * Recomputed from the unlocked set on every grant. Absolute values, not
 * multipliers, so the consumer never has to know what the base was.
 */
export const upgrades: Upgrades = {
  maxTethers: GRAPPLE.maxTethers,
  grappleRange: GRAPPLE.maxRange,
  reelAcceleration: GRAPPLE.reelAcceleration,
  maxReelSpeed: GRAPPLE.maxReelSpeed,
  boostFuel: WINGSUIT.boostFuel,
  boostRefill: WINGSUIT.boostRefill,
  lift: WINGSUIT.lift,
  stallSpeed: WINGSUIT.stallSpeed,
  flareStrength: 0.35,
  vehicleTune: 1,
  maxHealth: PLAYER.maxHealth,
  regenDelay: PLAYER.regenDelay,
  regenRate: PLAYER.regenRate,
  weapons: ["sidearm"],
};

/** Weapon registry keys in the order the HUD should list them. */
const WEAPON_ORDER = [
  "sidearm",
  "smg",
  "shotgun",
  "rifle",
  "battle",
  "sniper",
  "lmg",
  "gl",
  "rpg",
  "sticky",
  "grenade",
];

/* ================================================================== *
 * Stats
 * ================================================================== */

export interface PlayerStats {
  /* distances, metres */
  distanceOnFoot: number;
  distanceWingsuit: number;
  distanceParachute: number;
  distanceGrappling: number;
  distanceDriving: number;
  distanceSwimming: number;
  distanceTotal: number;

  /* durations, seconds */
  timeAirborne: number;
  timeWingsuit: number;
  timeGrappling: number;
  timeDriving: number;
  timePlayed: number;

  /* extremes */
  topSpeed: number;
  highestAltitude: number;
  longestFallSurvived: number;
  longestWingsuitFlight: number;
  bestCombo: number;

  /* counters, pushed in by other systems */
  kills: number;
  headshots: number;
  vehiclesDestroyed: number;
  propsDestroyed: number;
  explosions: number;
  deaths: number;
  hijacks: number;

  /* derived from other modules, refreshed each tick */
  chaosTotal: number;
  missionsCompleted: number;
  discoveriesFound: number;
  escapes: number;
}

function blankStats(): PlayerStats {
  return {
    distanceOnFoot: 0,
    distanceWingsuit: 0,
    distanceParachute: 0,
    distanceGrappling: 0,
    distanceDriving: 0,
    distanceSwimming: 0,
    distanceTotal: 0,
    timeAirborne: 0,
    timeWingsuit: 0,
    timeGrappling: 0,
    timeDriving: 0,
    timePlayed: 0,
    topSpeed: 0,
    highestAltitude: 0,
    longestFallSurvived: 0,
    longestWingsuitFlight: 0,
    bestCombo: 0,
    kills: 0,
    headshots: 0,
    vehiclesDestroyed: 0,
    propsDestroyed: 0,
    explosions: 0,
    deaths: 0,
    hijacks: 0,
    chaosTotal: 0,
    missionsCompleted: 0,
    discoveriesFound: 0,
    escapes: 0,
  };
}

/* ================================================================== *
 * Challenges
 * ================================================================== */

export interface Challenge {
  id: string;
  name: string;
  detail: string;
  /** Target value of `metric`. */
  goal: number;
  /** Pulled from stats (and friends) each evaluation. */
  metric: (s: PlayerStats) => number;
  /** Chaos paid on completion. */
  reward: number;
  /** Optional unlock token. */
  unlock?: string;
  /** Formatter for the progress readout. */
  format?: (v: number) => string;
}

const m = (v: number) => `${Math.round(v)} m`;
const km = (v: number) => `${(v / 1000).toFixed(1)} km`;
const s = (v: number) => `${Math.round(v)} s`;

export const CHALLENGES: readonly Challenge[] = [
  {
    id: "ch-first-flight",
    name: "First Flight",
    detail: "Cover 1 km in the wingsuit.",
    goal: 1000,
    metric: (st) => st.distanceWingsuit,
    reward: 400,
    format: km,
  },
  {
    id: "ch-long-haul",
    name: "Long Haul",
    detail: "Cover 25 km in the wingsuit.",
    goal: 25000,
    metric: (st) => st.distanceWingsuit,
    reward: 2600,
    unlock: "wingsuit-lift-2",
    format: km,
  },
  {
    id: "ch-single-flight",
    name: "One Breath",
    detail: "Fly 2,500 m in a single wingsuit flight.",
    goal: 2500,
    metric: (st) => st.longestWingsuitFlight,
    reward: 2200,
    unlock: "wingsuit-boost-2",
    format: m,
  },
  {
    id: "ch-terminal",
    name: "Terminal",
    detail: "Survive a 200 m fall.",
    goal: 200,
    metric: (st) => st.longestFallSurvived,
    reward: 1400,
    format: m,
  },
  {
    id: "ch-ceiling",
    name: "Ceiling",
    detail: "Reach 900 m above sea level.",
    goal: 900,
    metric: (st) => st.highestAltitude,
    reward: 1200,
    format: m,
  },
  {
    id: "ch-speed",
    name: "Redline",
    detail: "Hit 90 m/s.",
    goal: 90,
    metric: (st) => st.topSpeed,
    reward: 1600,
    format: (v) => `${v.toFixed(0)} m/s`,
  },
  {
    id: "ch-swing",
    name: "On the Wire",
    detail: "Travel 10 km on the grapple.",
    goal: 10000,
    metric: (st) => st.distanceGrappling,
    reward: 2000,
    unlock: "grapple-reel-2",
    format: km,
  },
  {
    id: "ch-combo",
    name: "Unhinged",
    detail: "Reach a 10 event chain.",
    goal: 10,
    metric: (st) => st.bestCombo,
    reward: 1500,
  },
  {
    id: "ch-combo-max",
    name: "Free Fall",
    detail: "Reach a 24 event chain.",
    goal: 24,
    metric: (st) => st.bestCombo,
    reward: 5000,
    unlock: "grapple-range-2",
  },
  {
    id: "ch-vehicles",
    name: "Parking Enforcement",
    detail: "Destroy 100 vehicles.",
    goal: 100,
    metric: (st) => st.vehiclesDestroyed,
    reward: 2400,
  },
  {
    id: "ch-props",
    name: "Urban Renewal",
    detail: "Destroy 500 pieces of property.",
    goal: 500,
    metric: (st) => st.propsDestroyed,
    reward: 3000,
    unlock: "weapon-sticky",
  },
  {
    id: "ch-escapes",
    name: "Ghost",
    detail: "Escape 10 pursuits.",
    goal: 10,
    metric: (st) => st.escapes,
    reward: 2800,
    unlock: "utility-fast-regen",
  },
  {
    id: "ch-drive",
    name: "Cross Town",
    detail: "Drive 50 km.",
    goal: 50000,
    metric: (st) => st.distanceDriving,
    reward: 2000,
    unlock: "vehicle-tuning",
    format: km,
  },
  {
    id: "ch-walk",
    name: "Pedestrian",
    detail: "Walk 10 km. Somebody has to.",
    goal: 10000,
    metric: (st) => st.distanceOnFoot,
    reward: 900,
    format: km,
  },
  {
    id: "ch-discover-landmarks",
    name: "Tourist Board",
    detail: "Discover every landmark.",
    goal: 22,
    metric: () => discoveries.countOfKind("landmark"),
    reward: 6000,
    unlock: "grapple-range-3",
  },
  {
    id: "ch-discover-views",
    name: "Seven Hills",
    detail: "Stand on 10 summit viewpoints.",
    goal: 10,
    metric: () => discoveries.countOfKind("viewpoint"),
    reward: 3500,
    unlock: "wingsuit-boost-3",
  },
  {
    id: "ch-hidden",
    name: "Local Knowledge",
    detail: "Find 30 hidden caches.",
    goal: 30,
    metric: () => discoveries.countOfKind("hidden"),
    reward: 4000,
  },
  {
    id: "ch-missions",
    name: "Contractor",
    detail: "Complete 12 activities.",
    goal: 12,
    metric: (st) => st.missionsCompleted,
    reward: 5000,
    unlock: "grapple-tether-3",
  },
  {
    id: "ch-all-missions",
    name: "The Whole City",
    detail: `Complete all ${MISSIONS.length} activities.`,
    goal: MISSIONS.length,
    metric: (st) => st.missionsCompleted,
    reward: 20000,
    unlock: "grapple-reel-3",
  },
  {
    id: "ch-air-time",
    name: "Rarely Grounded",
    detail: "Spend an hour in the air.",
    goal: 3600,
    metric: (st) => st.timeAirborne,
    reward: 3200,
    format: s,
  },
];

export const CHALLENGE_BY_ID: Record<string, Challenge> = Object.fromEntries(
  CHALLENGES.map((c) => [c.id, c]),
);

/* ================================================================== *
 * The system
 * ================================================================== */

class Progression {
  readonly stats: PlayerStats = blankStats();
  private unlockedSet = new Set<string>();
  private doneChallenges = new Set<string>();
  /** Mission id → best time in seconds. */
  readonly bestTimes: Record<string, number> = Object.create(null);

  /** Career rank index last seen, so rank unlocks fire once. */
  private lastRank = -1;

  /* --- traversal integrators --- */
  private lastX = 0;
  private lastZ = 0;
  private lastY = 0;
  private hasLast = false;
  /** Highest Y reached since leaving the ground, for fall measurement. */
  private fallApex = -Infinity;
  private wingsuitRun = 0;

  private listeners: ((u: UnlockDef) => void)[] = [];

  /* ---------------- unlocks ---------------- */

  unlocked(id: string): boolean {
    return this.unlockedSet.has(id);
  }

  get unlockedIds(): string[] {
    return Array.from(this.unlockedSet);
  }

  onUnlock(fn: (u: UnlockDef) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) {
        this.listeners[i] = this.listeners[this.listeners.length - 1];
        this.listeners.pop();
      }
    };
  }

  /** Grant an unlock. Idempotent, and the only path that touches `upgrades`. */
  grant(id: string, announce = true): boolean {
    const def = UNLOCK_BY_ID[id];
    if (!def || this.unlockedSet.has(id)) return false;
    this.unlockedSet.add(id);
    this.recomputeUpgrades();
    if (announce) {
      useSfStore.getState().notify(`Unlocked: ${def.name}`, "unlock");
    }
    for (let i = 0; i < this.listeners.length; i++) this.listeners[i](def);
    return true;
  }

  private recomputeUpgrades(): void {
    const has = (id: string) => this.unlockedSet.has(id);

    upgrades.maxTethers = has("grapple-tether-4")
      ? 4
      : has("grapple-tether-3")
        ? 3
        : GRAPPLE.maxTethers;

    const rangeScale = has("grapple-range-3") ? 1.9 : has("grapple-range-2") ? 1.45 : 1;
    upgrades.grappleRange = GRAPPLE.maxRange * rangeScale;

    const reelScale = has("grapple-reel-3") ? 1.75 : has("grapple-reel-2") ? 1.35 : 1;
    upgrades.reelAcceleration = GRAPPLE.reelAcceleration * reelScale;
    upgrades.maxReelSpeed = GRAPPLE.maxReelSpeed * reelScale;

    const boostScale = has("wingsuit-boost-3") ? 2.3 : has("wingsuit-boost-2") ? 1.6 : 1;
    upgrades.boostFuel = WINGSUIT.boostFuel * boostScale;
    upgrades.boostRefill = WINGSUIT.boostRefill * (has("wingsuit-boost-3") ? 1.5 : 1);

    const liftScale = has("wingsuit-lift-3") ? 1.3 : has("wingsuit-lift-2") ? 1.15 : 1;
    upgrades.lift = WINGSUIT.lift * liftScale;
    upgrades.stallSpeed = WINGSUIT.stallSpeed * (has("wingsuit-lift-3") ? 0.82 : has("wingsuit-lift-2") ? 0.91 : 1);

    upgrades.flareStrength = has("utility-parachute-flare") ? 0.52 : 0.35;
    upgrades.vehicleTune = has("vehicle-tuning") ? 1.12 : 1;
    upgrades.maxHealth = PLAYER.maxHealth + (has("utility-armour") ? 25 : 0);
    upgrades.regenDelay = has("utility-fast-regen") ? PLAYER.regenDelay * 0.6 : PLAYER.regenDelay;
    upgrades.regenRate = has("utility-fast-regen") ? PLAYER.regenRate * 1.5 : PLAYER.regenRate;

    upgrades.weapons = WEAPON_ORDER.filter((w) => this.unlockedSet.has(`weapon-${w}`));
    if (upgrades.weapons.length === 0) upgrades.weapons = ["sidearm"];

    // The store owns max health for the HUD; keep it in step with the armour
    // unlock, and top the player up by the difference rather than healing them
    // to full (finding a plate carrier should not be a medkit).
    const store = useSfStore.getState();
    if (store.maxHealth !== upgrades.maxHealth) {
      const delta = upgrades.maxHealth - store.maxHealth;
      useSfStore.setState({
        maxHealth: upgrades.maxHealth,
        health: Math.max(0, Math.min(upgrades.maxHealth, store.health + Math.max(0, delta))),
      });
    }
  }

  /* ---------------- counters pushed in by other systems ---------------- */

  reportKill(headshot = false): void {
    this.stats.kills++;
    if (headshot) this.stats.headshots++;
  }
  reportVehicleDestroyed(): void {
    this.stats.vehiclesDestroyed++;
  }
  reportPropDestroyed(): void {
    this.stats.propsDestroyed++;
  }
  reportExplosion(): void {
    this.stats.explosions++;
  }
  reportDeath(): void {
    this.stats.deaths++;
  }
  reportHijack(): void {
    this.stats.hijacks++;
  }

  /* ---------------- best times ---------------- */

  bestTime(missionId: string): number | null {
    const t = this.bestTimes[missionId];
    return t == null ? null : t;
  }

  /** Returns true if this run beat the record (or set the first one). */
  recordTime(missionId: string, seconds: number): boolean {
    const prev = this.bestTimes[missionId];
    if (prev != null && prev <= seconds) return false;
    this.bestTimes[missionId] = seconds;
    return true;
  }

  /* ---------------- per-tick ---------------- */

  /**
   * Called at the director's rate, not every frame. Distance integration at
   * 8 Hz against the actual position delta is exact for our purposes — we are
   * measuring path length, and sampling the path more finely only adds noise
   * from the camera bob.
   */
  tick(dt: number): void {
    if (frame.paused || dt <= 0) return;
    const st = this.stats;
    st.timePlayed += dt;

    const x = frame.position.x;
    const y = frame.position.y;
    const z = frame.position.z;

    if (this.hasLast) {
      const d = Math.hypot(x - this.lastX, z - this.lastZ, y - this.lastY);
      // Ignore teleports (respawn, fast travel) — they are not distance.
      if (d < 400) {
        st.distanceTotal += d;
        switch (frame.movement) {
          case "wingsuit":
            st.distanceWingsuit += d;
            this.wingsuitRun += d;
            break;
          case "parachute":
            st.distanceParachute += d;
            break;
          case "grappling":
            st.distanceGrappling += d;
            break;
          case "vehicle":
            st.distanceDriving += d;
            break;
          case "swimming":
            st.distanceSwimming += d;
            break;
          case "grounded":
            st.distanceOnFoot += d;
            break;
          default:
            break;
        }
      }
    }
    this.lastX = x;
    this.lastY = y;
    this.lastZ = z;
    this.hasLast = true;

    switch (frame.movement) {
      case "wingsuit":
        st.timeWingsuit += dt;
        st.timeAirborne += dt;
        break;
      case "grappling":
        st.timeGrappling += dt;
        st.timeAirborne += dt;
        break;
      case "airborne":
      case "parachute":
        st.timeAirborne += dt;
        break;
      case "vehicle":
        st.timeDriving += dt;
        break;
      default:
        break;
    }

    if (frame.movement !== "wingsuit") {
      if (this.wingsuitRun > st.longestWingsuitFlight) st.longestWingsuitFlight = this.wingsuitRun;
      this.wingsuitRun = 0;
    }

    if (frame.speed > st.topSpeed) st.topSpeed = frame.speed;
    if (y > st.highestAltitude) st.highestAltitude = y;

    // Fall measurement: track the apex while off the ground, and bank the drop
    // the moment we land — but only if we survived it, which is the whole point
    // of the challenge.
    if (!frame.grounded && frame.movement !== "vehicle") {
      if (y > this.fallApex) this.fallApex = y;
    } else if (this.fallApex > -Infinity) {
      const drop = this.fallApex - y;
      if (drop > st.longestFallSurvived && useSfStore.getState().health > 0) {
        st.longestFallSurvived = drop;
      }
      this.fallApex = -Infinity;
    }

    if (chaos.peakChain > st.bestCombo) st.bestCombo = chaos.peakChain;

    // Mirrored from the modules that actually own these numbers.
    st.chaosTotal = chaos.total;
    st.missionsCompleted = missions.completedCount;
    st.discoveriesFound = discoveries.found;
    st.escapes = gameHeat.escapes;

    this.evaluateRank();
    this.evaluateChallenges();
  }

  /** Rank-gated unlocks. Fires once per rank crossing. */
  private evaluateRank(): void {
    const rank = chaosRankIndex(this.stats.chaosTotal);
    if (rank === this.lastRank) return;
    const first = this.lastRank < 0;
    this.lastRank = rank;
    for (const u of UNLOCKS) {
      if (u.rank < 0 || u.rank > rank) continue;
      // On the first evaluation of a loaded save, grant silently — the player
      // does not want twelve unlock cards on the loading screen.
      this.grant(u.id, !first);
    }
  }

  private evaluateChallenges(): void {
    for (let i = 0; i < CHALLENGES.length; i++) {
      const c = CHALLENGES[i];
      if (this.doneChallenges.has(c.id)) continue;
      if (c.metric(this.stats) < c.goal) continue;
      this.doneChallenges.add(c.id);
      useSfStore.getState().notify(`Challenge: ${c.name}`, "unlock", c.reward);
      chaos.payout(c.reward, c.name);
      if (c.unlock) this.grant(c.unlock);
    }
  }

  challengeProgress(id: string): { value: number; goal: number; done: boolean; text: string } | null {
    const c = CHALLENGE_BY_ID[id];
    if (!c) return null;
    const value = c.metric(this.stats);
    const fmt = c.format ?? ((v: number) => String(Math.round(v)));
    return {
      value,
      goal: c.goal,
      done: this.doneChallenges.has(id),
      text: `${fmt(Math.min(value, c.goal))} / ${fmt(c.goal)}`,
    };
  }

  get completedChallenges(): string[] {
    return Array.from(this.doneChallenges);
  }

  /* ---------------- wiring ---------------- */

  /**
   * Subscribe to mission completion so best times and reward tokens are
   * handled in one place. Returns a disposer.
   */
  install(): () => void {
    const off = missions.onEvent((e) => {
      if (e.type !== "complete") return;
      if (e.def.reward.unlock) this.grant(e.def.reward.unlock);
      if (e.def.timed) {
        const improved = this.recordTime(e.def.id, e.elapsed);
        if (improved) {
          useSfStore
            .getState()
            .notify(`New best: ${formatTime(e.elapsed)}`, "objective");
        }
      }
      this.stats.missionsCompleted = missions.completedCount;
    });
    // Everything with a rank gate that the player already qualifies for.
    this.evaluateRank();
    return off;
  }

  /* ---------------- save / load ---------------- */

  hydrate(save: {
    stats?: Partial<PlayerStats>;
    unlocks?: string[];
    challenges?: string[];
    bestTimes?: Record<string, number>;
  }): void {
    if (save.stats) Object.assign(this.stats, save.stats);
    if (save.unlocks) {
      for (const id of save.unlocks) if (UNLOCK_BY_ID[id]) this.unlockedSet.add(id);
    }
    if (save.challenges) {
      for (const id of save.challenges) if (CHALLENGE_BY_ID[id]) this.doneChallenges.add(id);
    }
    if (save.bestTimes) {
      for (const k in save.bestTimes) {
        const v = save.bestTimes[k];
        if (typeof v === "number" && isFinite(v)) this.bestTimes[k] = v;
      }
    }
    this.recomputeUpgrades();
    // Suppress the unlock spam on the first post-load evaluation.
    this.lastRank = -1;
  }

  serialize() {
    return {
      stats: { ...this.stats },
      unlocks: this.unlockedIds,
      challenges: this.completedChallenges,
      bestTimes: { ...this.bestTimes },
    };
  }

  reset(): void {
    Object.assign(this.stats, blankStats());
    this.unlockedSet.clear();
    this.doneChallenges.clear();
    for (const k in this.bestTimes) delete this.bestTimes[k];
    this.lastRank = -1;
    this.hasLast = false;
    this.fallApex = -Infinity;
    this.wingsuitRun = 0;
    this.recomputeUpgrades();
  }
}

export const progression = new Progression();

/** m:ss.t — the format every time trial in the game uses. */
export function formatTime(seconds: number): string {
  const mm = Math.floor(seconds / 60);
  const ss = seconds - mm * 60;
  return `${mm}:${ss < 10 ? "0" : ""}${ss.toFixed(1)}`;
}
