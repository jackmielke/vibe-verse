/**
 * Vibe Kart — who the seven rivals actually are.
 *
 * Two orthogonal dials, deliberately separated:
 *
 *   **Difficulty** is the global cc class. It moves pace, line quality,
 *   reaction time and how often a rival makes a recoverable error. It is the
 *   only thing the player picks.
 *
 *   **Personality** is per-character and never changes. It is what makes Volt
 *   recognisable as Volt over a three-lap race: he brakes late, dives for the
 *   inside and spends his shells the moment they are worth anything, while
 *   Grumbo leans on you through the corner and hoards a banana for four
 *   minutes. Personality is *shape*, not strength — a personality dial must
 *   never be a straight upgrade, or the roster collapses into a tier list.
 *
 * Both are read every plan tick rather than baked, so the debug overlay can
 * hot-swap a difficulty mid-race and see the field change on the next corner.
 */

export type AiDifficulty = "50cc" | "100cc" | "150cc" | "200cc";

export interface DifficultyPreset {
  id: AiDifficulty;
  label: string;
  /** Fraction of the tyres' lateral budget the AI trusts in a corner. */
  pace: number;
  /** Ceiling on straight-line throttle. Below 1 the terminal speed drops. */
  throttleCap: number;
  /**
   * Straight-line speed ceiling as a fraction of `TUNING.topSpeed`. This is the
   * cc class in one number, and it is the only difficulty dial the player will
   * consciously notice — everything else changes *how* they drive, this changes
   * how fast the scenery goes past.
   */
  speedCap: number;
  /** How much of the ideal line they drive; the rest is a lazy centre-hugger. */
  lineQuality: number;
  /** Seconds between re-plans. This *is* the reaction time. */
  reaction: number;
  /** Expected errors per second per rival: a lift, a wide entry, a missed apex. */
  mistakeRate: number;
  /** Appetite for the slide, and patience for a higher mini-turbo tier. */
  driftSkill: number;
  /** 0 fires an item the instant it lands, 1 waits for the shot. */
  itemSkill: number;
  /** Multiplier on TUNING.aiCatchup / aiFallback. */
  band: number;
  /** How hard they work to dodge a banana or a spun rival. */
  awareness: number;
}

export const DIFFICULTIES: Record<AiDifficulty, DifficultyPreset> = {
  // A demonstration lap. Wide of the apex, lifts early, drifts only where the
  // corner asks for it, and forgets to use half its items.
  "50cc": {
    id: "50cc",
    label: "50cc",
    speedCap: 0.8,
    pace: 0.72,
    throttleCap: 0.9,
    lineQuality: 0.62,
    reaction: 0.26,
    mistakeRate: 0.05,
    driftSkill: 0.35,
    itemSkill: 0.3,
    band: 0.55,
    awareness: 0.5,
  },
  "100cc": {
    id: "100cc",
    label: "100cc",
    speedCap: 0.9,
    pace: 0.85,
    throttleCap: 0.94,
    lineQuality: 0.8,
    reaction: 0.17,
    mistakeRate: 0.028,
    driftSkill: 0.6,
    itemSkill: 0.55,
    band: 0.8,
    awareness: 0.72,
  },
  // The default. A real race: the field drifts every corner that pays, uses
  // items with intent, and will absolutely put a shell through the back of you.
  "150cc": {
    id: "150cc",
    label: "150cc",
    speedCap: 1.0,
    pace: 0.95,
    throttleCap: 1,
    lineQuality: 0.94,
    reaction: 0.1,
    mistakeRate: 0.015,
    driftSkill: 0.85,
    itemSkill: 0.82,
    band: 1,
    awareness: 0.9,
  },
  // Everything sharper and a shorter fuse. Not superhuman — the same line, run
  // closer to the edge, with the mistakes mostly taken out.
  "200cc": {
    id: "200cc",
    label: "200cc",
    speedCap: 1.03,
    pace: 1.0,
    throttleCap: 1,
    lineQuality: 0.99,
    reaction: 0.065,
    mistakeRate: 0.005,
    driftSkill: 1,
    itemSkill: 0.95,
    band: 1.1,
    awareness: 1,
  },
};

export const DIFFICULTY_ORDER: readonly AiDifficulty[] = ["50cc", "100cc", "150cc", "200cc"];

export const DEFAULT_DIFFICULTY: AiDifficulty = "150cc";

export interface Personality {
  /** Character id this belongs to, or "" for a ring fallback. */
  key: string;
  name: string;
  /** One line of driver-briefing text, for the debug overlay and the HUD. */
  note: string;
  /** Willingness to make contact and to take the inside line into a corner. */
  aggression: number;
  /** Multiplier on the difficulty's pace and line quality. Kept near 1. */
  skill: number;
  /** How eagerly they hop into a slide, and how long they hold it. */
  driftAppetite: number;
  /** Target mini-turbo tier they will wait for: 1 blue, 2 orange, 3 purple. */
  driftTier: 1 | 2 | 3;
  /** Seconds an item sits in the box before they even consider using it. */
  patience: number;
  /** Odds they take the dirt cut when it is merely *probably* worth it. */
  shortcutAppetite: number;
  /** Preferred lane, metres from the racing line. Keeps the field abreast. */
  lane: number;
  /** Metres of lap-periodic weave around that lane. */
  wander: number;
  /** Late braking. 1 is textbook, 1.2 is a lunge, 0.85 is a tidy driver. */
  bravery: number;
  /** How far they will move to dodge a hazard — low means they eat bananas. */
  caution: number;
}

/**
 * One profile per roster character. The player takes whichever seat the physics
 * gives them, so all eight are authored and the unused one simply never drives.
 */
const ROSTER_PROFILES: Personality[] = [
  {
    key: "zippa",
    name: "Zippa",
    note: "Darts for every gap. Drifts everything, including things that are not corners.",
    aggression: 0.62,
    skill: 1.0,
    driftAppetite: 1.0,
    driftTier: 2,
    patience: 0.5,
    shortcutAppetite: 0.85,
    lane: -1.6,
    wander: 1.1,
    bravery: 1.05,
    caution: 0.95,
  },
  {
    key: "bloop",
    name: "Bloop",
    note: "Tidy and unhurried. Wide entry, never off the road, sits on an item all lap.",
    aggression: 0.28,
    skill: 0.94,
    driftAppetite: 0.55,
    driftTier: 2,
    patience: 3.2,
    shortcutAppetite: 0.2,
    lane: 1.9,
    wander: 0.7,
    bravery: 0.86,
    caution: 1.15,
  },
  {
    key: "mikko",
    name: "Mikko",
    note: "Dive-bomber. Brakes late into the hairpin and apologises with a shell.",
    aggression: 0.82,
    skill: 0.97,
    driftAppetite: 0.8,
    driftTier: 1,
    patience: 0.35,
    shortcutAppetite: 0.7,
    lane: -2.4,
    wander: 0.9,
    bravery: 1.18,
    caution: 0.8,
  },
  {
    key: "rue",
    name: "Rue",
    note: "The benchmark. Textbook line, textbook drift, no surprises either way.",
    aggression: 0.5,
    skill: 1.0,
    driftAppetite: 0.75,
    driftTier: 2,
    patience: 1.4,
    shortcutAppetite: 0.5,
    lane: 0.2,
    wander: 0.8,
    bravery: 1.0,
    caution: 1.0,
  },
  {
    key: "volt",
    name: "Captain Volt",
    note: "The rival. Holds purple through the bowl and spends items the moment they pay.",
    aggression: 0.9,
    skill: 1.06,
    driftAppetite: 0.95,
    driftTier: 3,
    patience: 0.6,
    shortcutAppetite: 0.75,
    lane: -0.9,
    wander: 0.55,
    bravery: 1.12,
    caution: 1.05,
  },
  {
    key: "grumbo",
    name: "Grumbo",
    note: "A wall with a steering wheel. Leans on you through the corner and hoards bananas.",
    aggression: 1.0,
    skill: 0.88,
    driftAppetite: 0.35,
    driftTier: 1,
    patience: 4.5,
    shortcutAppetite: 0.3,
    lane: 2.6,
    wander: 1.3,
    bravery: 0.94,
    caution: 0.45,
  },
  {
    key: "sundae",
    name: "Sundae",
    note: "Defensive to a fault. Trails a shell for company and rarely fires it forwards.",
    aggression: 0.34,
    skill: 0.93,
    driftAppetite: 0.6,
    driftTier: 2,
    patience: 2.6,
    shortcutAppetite: 0.35,
    lane: 1.3,
    wander: 1.0,
    bravery: 0.9,
    caution: 1.2,
  },
  {
    key: "baron",
    name: "Baron Bolt",
    note: "Straight-line monster. Barely drifts, brakes late, saves the star for the last lap.",
    aggression: 0.76,
    skill: 1.04,
    driftAppetite: 0.45,
    driftTier: 3,
    patience: 2.0,
    shortcutAppetite: 0.45,
    lane: -0.4,
    wander: 0.45,
    bravery: 1.2,
    caution: 0.85,
  },
];

const FALLBACK_RING: Personality[] = ROSTER_PROFILES;

/**
 * Personality for a racer. Keyed by character first so a rival keeps their
 * temperament whatever grid slot they draw, and falls back to a ring walk when
 * the roster is something this module has never heard of.
 */
export function personalityFor(characterId: string | undefined, id: number): Personality {
  if (characterId) {
    const hit = ROSTER_PROFILES.find((p) => p.key === characterId);
    if (hit) return hit;
  }
  const ring = FALLBACK_RING[((id % FALLBACK_RING.length) + FALLBACK_RING.length) % FALLBACK_RING.length];
  return { ...ring, key: characterId ?? ring.key };
}

export { ROSTER_PROFILES };
