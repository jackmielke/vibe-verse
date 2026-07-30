/**
 * game/chaos.ts — the chaos economy.
 *
 * Chaos is the currency of the whole game. Everything else — heat, unlocks,
 * what the director offers you next — is denominated in it. So the economy has
 * exactly one job: make the difference between "I blew up a car" and "I blew
 * up a car *while hanging off a helicopter*" legible, immediate, and worth
 * chasing. Three layers do that:
 *
 *   BASE     what the thing was worth. Object class only. `CHAOS.points` in
 *            config.ts is the source of truth; this file extends it for the
 *            classes the config does not name (aircraft, boats, officers).
 *   COMBO    what *rhythm* you were in. A chain of events inside a rolling
 *            window multiplies everything. The window is short (a few seconds)
 *            and each event extends it, so the multiplier is a statement about
 *            momentum rather than about the last five minutes.
 *   STYLE    what you were *doing* at the time. Read off `frame` — airborne,
 *            wingsuiting, tethered, surfing a car roof, 200 m out — plus tags
 *            the caller supplies that only it can know (headshot, chain
 *            reaction). Style pays a flat bonus *and* pushes the multiplier,
 *            which is what makes a stylish small kill beat a boring big one.
 *
 * Why the multiplier curve is tiered rather than linear: a linear ramp gives
 * you no moment. Tiers give you a threshold to cross, a name on screen when
 * you cross it, and a thing to protect. The player can feel "two more and I'm
 * at Unhinged" in a way they cannot feel "my multiplier is 1.83".
 *
 * Integration
 * -----------
 * `installChaosEconomy()` wraps the store's own `addChaos` action, so every
 * existing call site in the AI, vehicle and weapon stacks routes through the
 * economy without any of them knowing it exists. It also subscribes to the
 * destruction system's events (which carry object class and position, so they
 * can be scored properly) and chains the AI's kill callbacks without stealing
 * them. Call the returned disposer on unmount; it restores everything.
 *
 * Public API
 * ----------
 *   chaos.report(kind, x, y, z, opts?)   score a classified event
 *   chaos.award(points, label, x?, z?)   score a raw award (goes through combo)
 *   chaos.tick(dt)                       decay the combo, roll the rate window
 *   chaos.combo / chaos.multiplier / chaos.rate / chaos.stats
 *   chaosRank(total) / rankProgress(total)
 *   installChaosEconomy(): () => void
 */
import { CHAOS } from "../config";
import { frame, useSfStore } from "../state/store";
import {
  onDestructionStage,
  onExplosion,
  type DestructionEvent,
  type ExplosionEvent,
} from "../physics/destruction";
import { enemyForce, type Enemy } from "../ai/enemies";
import { pedestrians } from "../ai/pedestrians";

/* ================================================================== *
 * Object classes and base values
 * ================================================================== */

export type ChaosClass =
  /* --- from CHAOS.points in config.ts --- */
  | "prop"
  | "vehicle"
  | "fuelTank"
  | "generator"
  | "tower"
  | "billboard"
  /* --- extensions the config does not name --- */
  | "helicopter"
  | "aircraft"
  | "boat"
  | "roadblock"
  | "structure"
  | "landmark"
  | "enemy"
  | "elite"
  | "officer"
  | "civilian";

/**
 * Base points. The config's numbers are authoritative for the classes it
 * declares — this table must never drift from them, so it reads them rather
 * than restating them.
 *
 * The extension values are calibrated against that scale: a helicopter is
 * worth three fuel tanks because bringing one down takes about that much
 * effort and reads about that much better. A civilian is worth *negative*
 * chaos: killing bystanders is not chaos, it is noise, and the economy should
 * say so out loud rather than rewarding a player for mowing down a crowd.
 */
const BASE: Record<ChaosClass, number> = {
  prop: CHAOS.points.prop,
  vehicle: CHAOS.points.vehicle,
  fuelTank: CHAOS.points.fuelTank,
  generator: CHAOS.points.generator,
  tower: CHAOS.points.tower,
  billboard: CHAOS.points.billboard,

  helicopter: 360,
  aircraft: 420,
  boat: 140,
  roadblock: 160,
  structure: 260,
  landmark: 900,
  enemy: 55,
  elite: 90,
  officer: 70,
  civilian: -30,
};

/** Human-readable name used in the kill feed. */
const CLASS_LABEL: Record<ChaosClass, string> = {
  prop: "Property damage",
  vehicle: "Vehicle destroyed",
  fuelTank: "Fuel tank detonated",
  generator: "Generator destroyed",
  tower: "Tower toppled",
  billboard: "Billboard wrecked",
  helicopter: "Helicopter downed",
  aircraft: "Aircraft downed",
  boat: "Boat sunk",
  roadblock: "Roadblock smashed",
  structure: "Structure levelled",
  landmark: "Landmark defaced",
  enemy: "Hostile down",
  elite: "Elite down",
  officer: "Officer down",
  civilian: "Civilian killed",
};

/* ================================================================== *
 * Style
 * ================================================================== */

export type StyleTag =
  /** Detected from `frame` — the player's own situation at the moment of the kill. */
  | "airborne"
  | "wingsuit"
  | "parachute"
  | "tethered"
  | "tether-combo"
  | "vehicle-surf"
  | "driving"
  | "high-altitude"
  | "freefall"
  /** Supplied by the caller — only the weapon/vehicle stack knows these. */
  | "headshot"
  | "long-shot"
  | "point-blank"
  | "chain-reaction"
  | "double"
  | "environmental"
  | "grapple-kill";

interface StyleDef {
  /** Flat points added before the multiplier. */
  bonus: number;
  /** Added to the combo multiplier for this one event. */
  mult: number;
  label: string;
}

/**
 * Style values are deliberately small in absolute terms and large in
 * multiplier terms. The bonus keeps a stylish kill on a cheap target from
 * feeling pointless; the multiplier is what actually pays, and it only pays
 * if you are already in a chain. That coupling is the entire design: style
 * without momentum is a shrug, momentum without style plateaus at x2.
 */
const STYLE: Record<StyleTag, StyleDef> = {
  airborne: { bonus: 15, mult: 0.15, label: "Airborne" },
  wingsuit: { bonus: 40, mult: 0.35, label: "Wingsuit" },
  parachute: { bonus: 20, mult: 0.15, label: "Under canopy" },
  tethered: { bonus: 25, mult: 0.25, label: "On the wire" },
  "tether-combo": { bonus: 90, mult: 0.55, label: "Tether combo" },
  "vehicle-surf": { bonus: 70, mult: 0.5, label: "Car surfing" },
  driving: { bonus: 10, mult: 0.1, label: "Drive-by" },
  "high-altitude": { bonus: 45, mult: 0.3, label: "High altitude" },
  freefall: { bonus: 55, mult: 0.4, label: "FREE FALL" },
  headshot: { bonus: 25, mult: 0.2, label: "Headshot" },
  "long-shot": { bonus: 60, mult: 0.35, label: "Long shot" },
  "point-blank": { bonus: 15, mult: 0.15, label: "Point blank" },
  "chain-reaction": { bonus: 50, mult: 0.4, label: "Chain reaction" },
  double: { bonus: 35, mult: 0.25, label: "Double" },
  environmental: { bonus: 45, mult: 0.3, label: "Environmental" },
  "grapple-kill": { bonus: 80, mult: 0.5, label: "Grapple kill" },
};

export const STYLE_TAGS = Object.keys(STYLE) as StyleTag[];

/** Points threshold above which a long shot counts, metres. */
const LONG_SHOT_RANGE = 150;
/** AGL above which "high altitude" applies, metres. */
const HIGH_ALTITUDE = 90;
/** Downward speed that reads as genuine free fall, m/s. */
const FREEFALL_SPEED = 26;

/* ================================================================== *
 * Combo tiers
 * ================================================================== */

export interface ComboTier {
  /** Chain length at which this tier starts. */
  at: number;
  mult: number;
  label: string;
}

/**
 * The escalation the player actually reads. Note the gaps widen: 3, 6, 10,
 * 16, 24. Early tiers should be reachable by accident so a new player
 * discovers the system exists; the last one should require a plan.
 */
export const COMBO_TIERS: readonly ComboTier[] = [
  { at: 0, mult: 1.0, label: "" },
  { at: 3, mult: 1.3, label: "ROWDY" },
  { at: 6, mult: 1.7, label: "RECKLESS" },
  { at: 10, mult: 2.2, label: "UNHINGED" },
  { at: 16, mult: 3.0, label: "CATASTROPHIC" },
  { at: 24, mult: 4.0, label: "FREE FALL" },
];

/** Base seconds a chain survives without a new event. */
const COMBO_WINDOW = 3.6;
/** Each event pushes the window out by this much, capped. */
const COMBO_WINDOW_MAX = 6.0;

function tierFor(chain: number): ComboTier {
  let t = COMBO_TIERS[0];
  for (let i = 1; i < COMBO_TIERS.length; i++) {
    if (chain >= COMBO_TIERS[i].at) t = COMBO_TIERS[i];
    else break;
  }
  return t;
}

/* ================================================================== *
 * Career ranks — the long escalation curve
 * ================================================================== */

export interface ChaosRank {
  /** Total career chaos needed. */
  at: number;
  name: string;
  /** Short flavour shown on the unlock card. */
  blurb: string;
}

/**
 * Roughly geometric with a ratio near 2.3. That ratio is the sweet spot for a
 * sandbox: each rank takes about twice as long as the last, which keeps early
 * ranks arriving fast enough to teach the loop while the late ones stay
 * meaningful for a player who has been at it for hours. The absolute numbers
 * are tuned against an observed ~900 chaos/minute during an average rampage.
 */
export const CHAOS_RANKS: readonly ChaosRank[] = [
  { at: 0, name: "Tourist", blurb: "Nobody has filed a report yet." },
  { at: 600, name: "Nuisance", blurb: "The Chronicle ran two column inches." },
  { at: 1800, name: "Person of Interest", blurb: "SFPD opened a file." },
  { at: 4500, name: "Public Menace", blurb: "You made the evening broadcast." },
  { at: 11000, name: "City Problem", blurb: "The mayor's office is taking questions." },
  { at: 26000, name: "Statewide Alert", blurb: "CHP is closing the bridges." },
  { at: 58000, name: "Federal Case", blurb: "Suits at the Ferry Building." },
  { at: 125000, name: "Act of God", blurb: "Insurers have stopped writing policies." },
  { at: 260000, name: "FREE FALL", blurb: "San Francisco is yours." },
];

/** Career rank index for a total. */
export function chaosRankIndex(total: number): number {
  let idx = 0;
  for (let i = 1; i < CHAOS_RANKS.length; i++) if (total >= CHAOS_RANKS[i].at) idx = i;
  return idx;
}

export function chaosRank(total: number): ChaosRank {
  return CHAOS_RANKS[chaosRankIndex(total)];
}

/** 0..1 progress through the current rank; 1 at the final rank. */
export function rankProgress(total: number): number {
  const i = chaosRankIndex(total);
  if (i >= CHAOS_RANKS.length - 1) return 1;
  const a = CHAOS_RANKS[i].at;
  const b = CHAOS_RANKS[i + 1].at;
  return Math.max(0, Math.min(1, (total - a) / (b - a)));
}

/* ================================================================== *
 * Event options
 * ================================================================== */

export interface ChaosReportOptions {
  /** Override the class's base value (a big rig is worth more than a hatchback). */
  base?: number;
  /** Caller-known style tags. Frame-derived ones are added automatically. */
  styles?: readonly StyleTag[];
  /** Distance from the player to the target, metres — drives "long shot". */
  range?: number;
  /** Suppress the kill-feed line (used for bulk awards). */
  silent?: boolean;
  /** Override the feed label. */
  label?: string;
  /** Do not extend or increment the combo (ambient/mission payouts). */
  noCombo?: boolean;
}

export interface ChaosAward {
  /** Final points added to the career total (may be negative). */
  points: number;
  base: number;
  bonus: number;
  multiplier: number;
  chain: number;
  tier: ComboTier;
  /** Styles that actually applied. */
  styles: StyleTag[];
}

/* ================================================================== *
 * The economy
 * ================================================================== */

/** Rolling-rate ring buffer: 96 slots at 0.625 s each = 60 s of history. */
const RATE_SLOTS = 96;
const RATE_SLOT_SECONDS = 60 / RATE_SLOTS;

class ChaosEconomy {
  /** Chain length inside the current combo window. */
  chain = 0;
  /** Sim time the current window expires. */
  windowEnds = -1;
  /** Points banked inside the current chain — reported when it ends. */
  chainPoints = 0;
  /** Highest chain reached this session. */
  peakChain = 0;
  /** Chaos scored since the level loaded (career total lives in the store). */
  sessionChaos = 0;
  /** Last tier label announced, so we only announce transitions. */
  private announcedTier = 0;

  /** Rolling 60 s rate history. */
  private rate = new Float32Array(RATE_SLOTS);
  private rateSlot = 0;
  private rateClock = 0;
  /** Cached sum of `rate`, kept incrementally so `chaosPerMinute` is free. */
  private rateSum = 0;

  /** Position of the last scored event — the director uses it as a heat centre. */
  lastX = 0;
  lastZ = 0;
  lastTime = -1e9;

  /** Per-class tallies for the stats screen. */
  readonly tally: Record<string, number> = Object.create(null);

  /** Listeners for scored events (HUD pop-ups, audio stingers). */
  private listeners: ((a: ChaosAward, x: number, y: number, z: number, label: string) => void)[] = [];

  /* --- scratch, hoisted so scoring never allocates --- */
  private styleScratch: StyleTag[] = [];
  private awardScratch: ChaosAward = {
    points: 0,
    base: 0,
    bonus: 0,
    multiplier: 1,
    chain: 0,
    tier: COMBO_TIERS[0],
    styles: [],
  };

  /** The store's original action, captured by `installChaosEconomy`. */
  rawAdd: ((points: number, label?: string) => void) | null = null;

  /* ---------------- queries ---------------- */

  get multiplier(): number {
    return tierFor(this.chain).mult;
  }

  get tier(): ComboTier {
    return tierFor(this.chain);
  }

  /** 0..1 how much of the combo window is left — the HUD drains a ring with this. */
  get comboFraction(): number {
    if (this.chain <= 0) return 0;
    const left = this.windowEnds - frame.time;
    return Math.max(0, Math.min(1, left / COMBO_WINDOW_MAX));
  }

  /** Chaos scored in the last 60 seconds. The director's main tension input. */
  get chaosPerMinute(): number {
    return this.rateSum;
  }

  /** Career total, straight from the store. */
  get total(): number {
    return useSfStore.getState().chaos;
  }

  get stats() {
    return {
      chain: this.chain,
      peakChain: this.peakChain,
      multiplier: this.multiplier,
      tier: this.tier.label,
      session: Math.round(this.sessionChaos),
      perMinute: Math.round(this.rateSum),
      total: Math.round(this.total),
      rank: chaosRank(this.total).name,
    };
  }

  /* ---------------- listeners ---------------- */

  onAward(fn: (a: ChaosAward, x: number, y: number, z: number, label: string) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) {
        this.listeners[i] = this.listeners[this.listeners.length - 1];
        this.listeners.pop();
      }
    };
  }

  /* ---------------- style detection ---------------- */

  /**
   * Read the player's situation off `frame` and append the style tags it
   * implies. Writes into `out` and returns it; `out` is a hoisted scratch
   * array in the hot path, so callers must not retain it.
   */
  detectStyle(out: StyleTag[]): StyleTag[] {
    const m = frame.movement;
    const vy = frame.velocity.y;

    if (m === "wingsuit") out.push("wingsuit");
    else if (m === "parachute") out.push("parachute");
    else if (m === "airborne" || m === "grappling") {
      out.push("airborne");
      if (vy < -FREEFALL_SPEED) out.push("freefall");
    }

    let live = 0;
    for (let i = 0; i < frame.tethers.length; i++) {
      const t = frame.tethers[i];
      if (t.active && !t.flying) live++;
    }
    if (live >= 2) out.push("tether-combo");
    else if (live === 1) out.push("tethered");

    if (m === "vehicle") {
      // Standing on a moving vehicle instead of sitting in one: the vehicle
      // system leaves `vehicleId` null while you are only *on* the roof.
      if (frame.vehicleId === null) out.push("vehicle-surf");
      else out.push("driving");
    }

    if (frame.altitudeAGL > HIGH_ALTITUDE) out.push("high-altitude");
    return out;
  }

  /* ---------------- scoring ---------------- */

  /**
   * Score a classified event. This is the entry point everything that knows
   * *what* it destroyed should use.
   */
  report(
    kind: ChaosClass,
    x: number,
    y: number,
    z: number,
    opts?: ChaosReportOptions,
  ): ChaosAward {
    const base = opts?.base ?? BASE[kind] ?? 0;
    const styles = this.styleScratch;
    styles.length = 0;

    // Negative-value events (civilians) never earn style or combo. Rewarding
    // a stylish civilian kill would be exactly the wrong signal.
    if (base >= 0) {
      this.detectStyle(styles);
      const extra = opts?.styles;
      if (extra) for (let i = 0; i < extra.length; i++) styles.push(extra[i]);
      const range = opts?.range ?? 0;
      if (range >= LONG_SHOT_RANGE && styles.indexOf("long-shot") < 0) styles.push("long-shot");
      else if (range > 0 && range < 4 && styles.indexOf("point-blank") < 0) styles.push("point-blank");
    }

    this.tally[kind] = (this.tally[kind] ?? 0) + 1;
    const label = opts?.label ?? CLASS_LABEL[kind] ?? "Chaos";
    return this.score(base, styles, x, y, z, label, opts?.silent === true, opts?.noCombo === true);
  }

  /**
   * Score a raw award with no class. Used by the wrapped store action, so any
   * legacy `addChaos(n, "label")` call still gets combo and style treatment.
   */
  award(points: number, label = "Chaos", x = frame.position.x, y = frame.position.y, z = frame.position.z): ChaosAward {
    const styles = this.styleScratch;
    styles.length = 0;
    if (points >= 0) this.detectStyle(styles);
    return this.score(points, styles, x, y, z, label, false, false);
  }

  /**
   * A mission or challenge payout. Deliberately outside the combo system:
   * completing an objective should not inflate the multiplier you were riding,
   * and should not be inflated *by* it either — mission rewards are authored
   * numbers and must stay predictable.
   */
  payout(points: number, label: string): number {
    const add = this.rawAdd ?? useSfStore.getState().addChaos;
    const rounded = Math.round(points);
    this.sessionChaos += rounded;
    this.pushRate(rounded);
    add(rounded, label);
    return rounded;
  }

  private score(
    base: number,
    styles: StyleTag[],
    x: number,
    y: number,
    z: number,
    label: string,
    silent: boolean,
    noCombo: boolean,
  ): ChaosAward {
    const now = frame.time;

    if (!noCombo && base > 0) {
      // Window expiry is checked here as well as in tick() so a report that
      // arrives after a long pause opens a fresh chain even if tick() has not
      // run yet (loading hitches, paused frames).
      if (now > this.windowEnds) this.endChain(false);
      this.chain++;
      this.windowEnds = now + Math.min(COMBO_WINDOW_MAX, COMBO_WINDOW + this.chain * 0.12);
      if (this.chain > this.peakChain) this.peakChain = this.chain;
    }

    let bonus = 0;
    let mult = noCombo ? 1 : tierFor(this.chain).mult;
    for (let i = 0; i < styles.length; i++) {
      const s = STYLE[styles[i]];
      if (!s) continue;
      bonus += s.bonus;
      mult += s.mult;
    }

    const points = Math.round(base >= 0 ? (base + bonus) * mult : base);

    const a = this.awardScratch;
    a.points = points;
    a.base = base;
    a.bonus = bonus;
    a.multiplier = mult;
    a.chain = this.chain;
    a.tier = tierFor(this.chain);
    a.styles = styles;

    this.sessionChaos += points;
    this.chainPoints += Math.max(0, points);
    this.pushRate(points);
    this.lastX = x;
    this.lastZ = z;
    this.lastTime = now;

    const add = this.rawAdd ?? useSfStore.getState().addChaos;
    const text = this.feedLabel(label, styles, mult, silent);
    add(points, silent ? undefined : text);

    // Tier-up announcement. Only on the way up, and only once per tier, or the
    // feed turns into a strobe light.
    const tierIdx = COMBO_TIERS.indexOf(a.tier);
    if (tierIdx > this.announcedTier) {
      this.announcedTier = tierIdx;
      useSfStore.getState().notify(`${a.tier.label}  x${a.tier.mult.toFixed(1)}`, "chaos");
    }

    for (let i = 0; i < this.listeners.length; i++) this.listeners[i](a, x, y, z, text);
    return a;
  }

  /** Build the kill-feed string: "Fuel tank detonated — Wingsuit, Tether combo". */
  private feedLabel(label: string, styles: StyleTag[], mult: number, silent: boolean): string {
    if (silent || styles.length === 0) return label;
    let s = label;
    let n = 0;
    for (let i = 0; i < styles.length && n < 3; i++) {
      const def = STYLE[styles[i]];
      if (!def) continue;
      s += n === 0 ? "  ·  " : ", ";
      s += def.label;
      n++;
    }
    if (mult >= 1.3) s += `  x${mult.toFixed(1)}`;
    return s;
  }

  private pushRate(points: number): void {
    if (points <= 0) return;
    this.rate[this.rateSlot] += points;
    this.rateSum += points;
  }

  /** Close the current chain, optionally announcing the total. */
  private endChain(announce: boolean): void {
    if (announce && this.chain >= COMBO_TIERS[2].at && this.chainPoints > 0) {
      useSfStore
        .getState()
        .notify(`${this.chain} chain ended`, "chaos", Math.round(this.chainPoints));
    }
    this.chain = 0;
    this.chainPoints = 0;
    this.announcedTier = 0;
  }

  /* ---------------- per-frame ---------------- */

  tick(dt: number): void {
    if (this.chain > 0 && frame.time > this.windowEnds) this.endChain(true);

    // Advance the rate ring. Slots are wide (0.625 s) so this costs one
    // subtract-and-zero a few times a second rather than a scan every frame.
    this.rateClock += dt;
    while (this.rateClock >= RATE_SLOT_SECONDS) {
      this.rateClock -= RATE_SLOT_SECONDS;
      this.rateSlot = (this.rateSlot + 1) % RATE_SLOTS;
      this.rateSum -= this.rate[this.rateSlot];
      this.rate[this.rateSlot] = 0;
    }
    if (this.rateSum < 0) this.rateSum = 0;
  }

  reset(): void {
    this.chain = 0;
    this.chainPoints = 0;
    this.peakChain = 0;
    this.sessionChaos = 0;
    this.announcedTier = 0;
    this.windowEnds = -1;
    this.rate.fill(0);
    this.rateSum = 0;
    this.rateSlot = 0;
    this.rateClock = 0;
    this.lastTime = -1e9;
    for (const k in this.tally) delete this.tally[k];
  }
}

export const chaos = new ChaosEconomy();

/* ================================================================== *
 * Wiring
 * ================================================================== */

/** Map a destructible's archetype string onto a chaos class. */
function classifyArchetype(archetype: string): ChaosClass {
  const a = archetype.toLowerCase();
  if (a.includes("fuel") || a.includes("tank") || a.includes("propane")) return "fuelTank";
  if (a.includes("generator") || a.includes("transformer")) return "generator";
  if (a.includes("billboard") || a.includes("sign")) return "billboard";
  if (a.includes("tower") || a.includes("antenna") || a.includes("mast")) return "tower";
  if (a.includes("crane") || a.includes("silo") || a.includes("water")) return "structure";
  if (a.includes("car") || a.includes("truck") || a.includes("van") || a.includes("bus")) return "vehicle";
  if (a.includes("boat") || a.includes("ferry")) return "boat";
  if (a.includes("barrier") || a.includes("barricade") || a.includes("roadblock")) return "roadblock";
  return "prop";
}

/**
 * Install the economy. Returns a disposer that puts everything back exactly
 * as it found it — important, because React strict mode will mount this twice
 * in development and a double-wrapped `addChaos` would double every score.
 */
export function installChaosEconomy(): () => void {
  const store = useSfStore.getState();
  const original = store.addChaos;

  // Guard against double-install: if `rawAdd` is already set, the store action
  // in place is ours and wrapping again would compound multipliers.
  if (chaos.rawAdd) return () => {};
  chaos.rawAdd = original;

  useSfStore.setState({
    addChaos: (points: number, label?: string) => {
      chaos.award(points, label ?? "Chaos");
    },
  });

  const offStage = onDestructionStage((e: DestructionEvent) => {
    if (e.stage !== "destroyed") return;
    const kind = classifyArchetype(e.target.desc.archetype ?? "");
    const declared = e.chaos > 0 ? e.chaos : undefined;
    const px = frame.position.x;
    const pz = frame.position.z;
    chaos.report(kind, e.x, e.y, e.z, {
      base: declared,
      range: Math.hypot(e.x - px, e.z - pz),
    });
  });

  // Chain reactions: a secondary blast is the pay-off for good target
  // selection, so it earns a style tag rather than just more base points.
  const offBoom = onExplosion((e: ExplosionEvent) => {
    if (e.chainDepth <= 0) return;
    chaos.report("prop", e.x, e.y, e.z, {
      base: Math.round(20 + e.radius * 3),
      styles: CHAIN_STYLE,
      label: "Chain reaction",
    });
  });

  // The AI owns its own kill callbacks and sets them in its own effect, whose
  // order relative to ours is not guaranteed. Rather than fight over the slot,
  // adopt whoever is there and call them; `refreshKillHooks` re-adopts if the
  // AI reinstalls after us.
  let prevEnemyKill: ((e: Enemy) => void) | null = null;
  let prevPedKill: ((x: number, y: number, z: number) => void) | null = null;

  const enemyHook = (e: Enemy) => {
    prevEnemyKill?.(e);
    const cls: ChaosClass =
      e.faction === "police" || e.faction === "military"
        ? "officer"
        : e.archetype === "swat" || e.archetype === "soldier"
          ? "elite"
          : "enemy";
    const range = Math.hypot(e.x - frame.position.x, e.z - frame.position.z);
    // The AI already awarded a flat value through `addChaos`, which our wrapper
    // scored. Report the *class* silently so tallies and style are right
    // without paying twice: base 0 means style bonus only.
    chaos.report(cls, e.x, e.y, e.z, { base: 0, range, silent: true, noCombo: true });
  };

  const pedHook = (x: number, y: number, z: number) => {
    prevPedKill?.(x, y, z);
    chaos.report("civilian", x, y, z, { silent: false, noCombo: true });
  };

  function refreshKillHooks(): void {
    if (enemyForce.onKilled !== enemyHook) {
      prevEnemyKill = enemyForce.onKilled;
      enemyForce.onKilled = enemyHook;
    }
    if (pedestrians.onKilled !== pedHook) {
      prevPedKill = pedestrians.onKilled;
      pedestrians.onKilled = pedHook;
    }
  }
  refreshKillHooks();
  chaosRefreshHooks = refreshKillHooks;

  return () => {
    offStage();
    offBoom();
    chaosRefreshHooks = null;
    if (enemyForce.onKilled === enemyHook) enemyForce.onKilled = prevEnemyKill;
    if (pedestrians.onKilled === pedHook) pedestrians.onKilled = prevPedKill;
    if (chaos.rawAdd) useSfStore.setState({ addChaos: chaos.rawAdd });
    chaos.rawAdd = null;
  };
}

const CHAIN_STYLE: readonly StyleTag[] = ["chain-reaction"];

/**
 * Re-adopt the AI kill callbacks if the AI reinstalled them after us. Called
 * once per director tick — an identity compare, not a hot path concern.
 */
let chaosRefreshHooks: (() => void) | null = null;
export function refreshChaosHooks(): void {
  chaosRefreshHooks?.();
}
