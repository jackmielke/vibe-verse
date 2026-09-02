/**
 * BETTER FORTNITE — the data.
 *
 * The third game on the island. It is Drop Zero's bullets and health with the
 * four things that make a battle royale better to actually play, and every
 * number for all four lives here rather than in the systems that use them, for
 * the same reason `mode/water.ts` exists: a tuning pass touches one file, and a
 * test can read the whole design without booting a renderer.
 *
 *  1. AUGMENTS. A few times a match you are handed three perks and take one.
 *     The best idea a battle royale has had since building: it turns a loot
 *     lottery into a decision, and it means two players who found the same
 *     gun are not the same player.
 *
 *  2. THE GRAPPLE. Everyone has one, always. Mobility is fun and waiting to
 *     find mobility is not.
 *
 *  3. SECOND WIND. Your first down of the match is not the end of it: a short
 *     countdown and you are back on the glider over the circle, with your
 *     bag. Dying in the first ninety seconds and watching is the single worst
 *     thing about the genre and this removes it exactly once.
 *
 *  4. ISLAND EVENTS. Each circle brings something with it — a wave of supply
 *     drops, low gravity, nightfall, a shield rain, and at the end sudden
 *     death. The map should be doing things while the circle closes, not just
 *     getting smaller.
 *
 * Nothing in here imports THREE or a system. Pure data and pure functions.
 */

// ---------------------------------------------------------------------------
// Augments
// ---------------------------------------------------------------------------

import type { AugmentKey, IslandEventId } from "../types";

export interface AugmentDef {
  id: string;
  name: string;
  /** One line, in the voice of the card. */
  blurb: string;
  /** A glyph for the tray. Emoji is fine here: it is UI, not the world. */
  icon: string;
  /** Multipliers by key. Applied as a product across owned augments. */
  factors?: Partial<Record<AugmentKey, number>>;
  /** Additive values by key. Summed across owned augments. */
  bonuses?: Partial<Record<AugmentKey, number>>;
  /** Card accent, so the three on offer read as three things. */
  accent: number;
}

/**
 * The pool. Ten, which is enough that a match never offers the same three
 * twice and few enough that a player learns them.
 *
 * Every number here is a multiplier on a constant that already ships, so the
 * balance argument for each is short: what does the classic number become?
 */
export const AUGMENTS: readonly AugmentDef[] = [
  {
    id: "spring",
    name: "Spring Boots",
    blurb: "One more jump, in the air.",
    icon: "🦘",
    bonuses: { airJumps: 1 },
    accent: 0x7ef0a0,
  },
  {
    id: "quickhands",
    name: "Quick Hands",
    blurb: "Reload 40% faster.",
    icon: "⚡",
    factors: { reload: 0.6 },
    accent: 0xffd766,
  },
  {
    id: "mason",
    name: "Mason",
    blurb: "Every piece costs half.",
    icon: "🧱",
    factors: { buildCost: 0.5 },
    accent: 0xe8a26a,
  },
  {
    id: "stormwalker",
    name: "Storm Walker",
    blurb: "The storm hurts 65% less.",
    icon: "🌩️",
    factors: { stormDamage: 0.35 },
    accent: 0xc78bff,
  },
  {
    id: "vampire",
    name: "Vampire",
    blurb: "+30 health on every elimination.",
    icon: "🩸",
    bonuses: { healOnElim: 30 },
    accent: 0xff6f8a,
  },
  {
    id: "bulwark",
    name: "Bulwark",
    blurb: "+50 max shield, filled now.",
    icon: "🛡️",
    bonuses: { maxShield: 50 },
    accent: 0x6fc3ff,
  },
  {
    id: "feather",
    name: "Featherfall",
    blurb: "No fall damage. Ever.",
    icon: "🪶",
    factors: { fallDamage: 0 },
    accent: 0xf0f0ff,
  },
  {
    id: "sprinter",
    name: "Sprinter",
    blurb: "Move 15% faster.",
    icon: "👟",
    factors: { speed: 1.15 },
    accent: 0x9dff6a,
  },
  {
    id: "spider",
    name: "Spider Rig",
    blurb: "Grapple cooldown cut to a third.",
    icon: "🕸️",
    factors: { grappleCooldown: 0.34 },
    accent: 0xd6d6d6,
  },
  {
    id: "hollowpoint",
    name: "Hollow Point",
    blurb: "+12% weapon damage.",
    icon: "🎯",
    factors: { damage: 1.12 },
    accent: 0xff9a4a,
  },
];

export function augment(id: string): AugmentDef | null {
  return AUGMENTS.find((a) => a.id === id) ?? null;
}

/**
 * When offers happen, in seconds of LIVE match time.
 *
 * The first comes early enough to matter for the first fight and late enough
 * that you have landed and looted; after that one every ~two minutes, which is
 * roughly one per circle. Four is the cap: a fifth is a build, not a choice.
 */
export const OFFER_SCHEDULE = Object.freeze({
  firstAt: 70,
  every: 115,
  max: 4,
  /** Elimination counts that hand out a bonus offer on top of the clock. */
  elimMilestones: [3, 6] as readonly number[],
  /** How many cards an offer shows. */
  cards: 3,
});

/**
 * Roll an offer: `cards` distinct ids the player does not own.
 *
 * Pure, so the test can prove it never repeats an owned augment and never
 * repeats within a hand. `rng` is the caller's — the augments system passes
 * the world's deterministic one, so a seed replays the same offers.
 */
export function rollOffer(owned: readonly string[], rng: () => number, cards = OFFER_SCHEDULE.cards): string[] {
  const pool = AUGMENTS.map((a) => a.id).filter((id) => !owned.includes(id));
  const out: string[] = [];
  while (out.length < cards && pool.length > 0) {
    const i = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

/** Product of a key across a set of owned ids. 1 with none. */
export function factorOf(owned: readonly string[], key: AugmentKey): number {
  let f = 1;
  for (const id of owned) {
    const v = augment(id)?.factors?.[key];
    if (typeof v === "number") f *= v;
  }
  return f;
}

/** Sum of a key across a set of owned ids. 0 with none. */
export function bonusOf(owned: readonly string[], key: AugmentKey): number {
  let b = 0;
  for (const id of owned) {
    const v = augment(id)?.bonuses?.[key];
    if (typeof v === "number") b += v;
  }
  return b;
}

// ---------------------------------------------------------------------------
// The grapple
// ---------------------------------------------------------------------------

export const GRAPPLE = Object.freeze({
  /** Reach, metres. Far enough to cross a street, not a POI. */
  range: 46,
  /** Pull speed the rope accelerates you toward, and how hard. */
  pullSpeed: 26,
  pullAccel: 62,
  /** The rope lets go this close to the anchor, so you arrive rather than slam. */
  arriveDistance: 2.6,
  /** And after this long regardless — a hook on a moving target is not a leash. */
  maxDuration: 2.4,
  /** Seconds between shots. Spider Rig multiplies this. */
  cooldown: 7,
  /** Upward kick at attach, so a flat shot lifts you off the ground. */
  liftKick: 5.5,
  /** Horizontal speed kept when the rope releases (1 = all of it). */
  carry: 0.82,
  /** Rope drawn as a thin tube of this radius, in the player's hand colour. */
  ropeRadius: 0.03,
  ropeColor: 0xf2e6c8,
  hookColor: 0x3b4252,
});

// ---------------------------------------------------------------------------
// Second wind
// ---------------------------------------------------------------------------

export const SECOND_WIND = Object.freeze({
  /** Seconds face-down before the redeploy. Long enough to feel it. */
  countdown: 6,
  /** Metres above the ground the redeploy begins. Below auto-deploy, above the treeline. */
  altitude: 190,
  /** Health you come back with. Shield is what you had. */
  health: 100,
  /** Only ever once. */
  uses: 1,
});

// ---------------------------------------------------------------------------
// Island events
// ---------------------------------------------------------------------------

export interface IslandEventDef {
  id: IslandEventId;
  name: string;
  /** The line under the banner. */
  sub: string;
  /** Seconds it lasts. 0 for an instant. */
  duration: number;
  /** Banner accent. */
  accent: number;
  /** The storm circle (1-indexed) whose *start* triggers it. */
  circle: number;
}

/**
 * One per circle, in circle order. The storm's phase table has seven, so the
 * last two circles are quiet on purpose: the end of a match should be about
 * the players in it, and sudden death at six is already a lot.
 */
export const ISLAND_EVENTS: readonly IslandEventDef[] = [
  {
    id: "supply-storm",
    name: "Supply Storm",
    sub: "Six drops, inside the circle. Go.",
    duration: 0,
    accent: 0xffc85c,
    circle: 2,
  },
  {
    id: "low-gravity",
    name: "Low Gravity",
    sub: "Jump high. Fall slow. Forty seconds.",
    duration: 40,
    accent: 0x9fd8ff,
    circle: 3,
  },
  {
    id: "nightfall",
    name: "Nightfall",
    sub: "The sun goes. Fifty seconds of dusk.",
    duration: 50,
    accent: 0xb48cff,
    circle: 4,
  },
  {
    id: "shield-rain",
    name: "Shield Rain",
    sub: "+40 shield to everyone still standing.",
    duration: 0,
    accent: 0x6fc3ff,
    circle: 5,
  },
  {
    id: "sudden-death",
    name: "Sudden Death",
    sub: "The storm hits twice as hard from here.",
    duration: 0,
    accent: 0xff6a6a,
    circle: 6,
  },
];

export function islandEvent(id: IslandEventId): IslandEventDef | null {
  return ISLAND_EVENTS.find((e) => e.id === id) ?? null;
}

export function eventForCircle(circle: number): IslandEventDef | null {
  return ISLAND_EVENTS.find((e) => e.circle === circle) ?? null;
}

export const EVENT_TUNING = Object.freeze({
  supplyDrops: 6,
  lowGravity: 0.48,
  shieldRain: 40,
  /** Storm damage multiplier once sudden death has fired. */
  suddenDeath: 2,
  /** Sky preset the island goes to and comes back from. */
  nightPreset: "dusk" as const,
  dayPreset: "golden" as const,
});

// ---------------------------------------------------------------------------
// Strings — everything the HUD, the page and the card say about this game
// ---------------------------------------------------------------------------

export const STRINGS = Object.freeze({
  modeName: "BETTER FORTNITE",
  tagline:
    "The island, the storm and the build loop — plus augments you pick mid-match, a grapple on every hip, a second wind after your first down, and an island that does things while the circle closes.",
  enter: "Drop in",
  augmentTitle: "Pick an augment",
  augmentHint: "1 · 2 · 3 — or tap",
  augmentTaken: "Augment taken",
  secondWindArmed: "Second wind is armed",
  secondWindTitle: "SECOND WIND",
  secondWindSub: "Back on the glider in",
  secondWindGone: "That was your one",
  grappleReady: "Grapple ready",
  grappleKey: "F",
  eventPrefix: "ISLAND EVENT",
});

export const BETTER = Object.freeze({
  strings: STRINGS,
  augments: AUGMENTS,
  offers: OFFER_SCHEDULE,
  grapple: GRAPPLE,
  secondWind: SECOND_WIND,
  events: ISLAND_EVENTS,
  eventTuning: EVENT_TUNING,
});
