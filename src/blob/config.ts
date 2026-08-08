/**
 * BLOB — every number the game is made of, in one file.
 *
 * The sim, the bots, the renderer and the tests all read from here, which is
 * the only reason a tuning pass is a five-line diff rather than an archaeology
 * expedition. Anything that could reasonably be argued about — how fast a big
 * cell is, how much of you has to be inside something before you eat it — is a
 * constant with a sentence next to it explaining what it is buying.
 *
 * The units are world pixels and seconds throughout. Mass is the score: one
 * point of mass is one point on the leaderboard, so there is never a conversion
 * between "what the sim thinks you are" and "what the HUD says you are".
 */

// ---------------------------------------------------------------------------
// The dish
// ---------------------------------------------------------------------------

/**
 * The dish is square and this is its side, in world pixels.
 *
 * Sized against the roster rather than picked: twenty-four rivals in a 6400
 * dish is one blob per two and a half screens, and the first version of this
 * played like a walk across a car park. At 5200 you meet somebody in the first
 * ten seconds, which is the game.
 */
export const WORLD = 5200;

/**
 * How many pellets the dish tries to keep on the table.
 *
 * This is a *density* decision, not a count: what matters is how many are on
 * screen at once, which is `FOOD_TARGET / WORLD²` times the visible area. At
 * the numbers here that is around sixty at the opening zoom, which is the
 * difference between hoovering a field and hunting for crumbs.
 */
export const FOOD_TARGET = 2800;
/** Pellets respawned per second once something has been eaten. Comfortably
 *  above what the whole roster can eat, so the dish stays at `FOOD_TARGET`
 *  rather than being slowly stripped by a busy match. */
export const FOOD_REGROW = 95;
/**
 * What a pellet is worth.
 *
 * Small relative to `START_MASS` on purpose — the early game should be a
 * hundred tiny wins — but not *too* small: at 1.35 the leader of a two-minute
 * match topped out around 500 mass, which is a game where nothing ever feels
 * like it is happening. Roughly a twelfth of a starting cell per pellet puts a
 * good run at a few hundred inside a minute.
 */
export const FOOD_MASS = 2.2;

/** Viruses on the table. Enough that a big cell has to look where it is going. */
export const VIRUS_TARGET = 26;
export const VIRUS_MASS = 130;
/** Ejected pellets a virus has to eat before it spits a new one out. */
export const VIRUS_FEED = 7;
/** How hard a fed virus launches its child. */
export const VIRUS_SHOT_SPEED = 620;

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

export const START_MASS = 26;
/** Below this you cannot split — halves would be too small to be worth having. */
export const MIN_SPLIT_MASS = 36;
/** The classic cap. Sixteen pieces is the ceiling on how greedy one split can be. */
export const MAX_CELLS = 16;

/** Mass burned by an eject, and how much of it survives as a pellet. The gap is
 *  the point: feeding a virus, or a friend, costs you something. */
export const EJECT_COST = 20;
export const EJECT_MASS = 14;
export const EJECT_SPEED = 740;

/** Speed of the shove a split gives the new half, and how fast that shove dies.
 *  `BOOST_DAMP` is e-folds per second, so ~3.4 means the lunge is over in about
 *  a second — long enough to cross a gap, short enough that you cannot fly. */
export const SPLIT_SPEED = 810;
export const BOOST_DAMP = 3.4;

/**
 * How much bigger you have to be to eat something, and how far inside you it
 * has to be.
 *
 * The ratio alone is not enough — with only a ratio, two cells that graze each
 * other swap a whole life, and the game feels like it is played by the physics
 * rather than by you. Requiring the smaller cell's centre to be well inside the
 * bigger one is what makes a near miss *feel* like a near miss.
 */
export const EAT_RATIO = 1.18;
export const EAT_COVER = 0.35;

/**
 * Big cells rot.
 *
 * Without this the endgame is a stalemate: the leader parks in a corner, eats
 * nothing, and stays the leader forever. A fifth of a percent a second means a
 * two-thousand-mass whale bleeds four a second and has to keep hunting to stay
 * ahead — which it comfortably can, at about twelve a second of pellets.
 *
 * The floor is where it is so the tax lands only on the people it is aimed at.
 * At 220 it was charging mid-sized players for existing, which is the opposite
 * of the point.
 */
export const DECAY_FLOOR = 450;
export const DECAY_RATE = 0.0021;

/** Seconds before split halves may merge again: a base, plus a slice of mass,
 *  capped so a giant is not welded apart for a minute and a half. */
export const MERGE_BASE = 9;
export const MERGE_PER_MASS = 0.017;
export const MERGE_MAX = 26;

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/** Top speed of a cell at `START_MASS`, in world pixels per second. */
export const SPEED_REF = 348;
/**
 * How hard speed falls off with mass.
 *
 * This exponent *is* the game's balance. At 0 a whale outruns a pellet and
 * nothing else ever gets a turn; too high and getting big is a punishment.
 * 0.31 lands where the original does: a big cell covers its own radius in
 * roughly a second, so it is slow to arrive but terrifying when it does.
 */
export const SPEED_FALLOFF = 0.31;

/** Radius from mass. Area is proportional to mass, which is why eating someone
 *  your own size makes you noticeably — but not doubly — wider. */
export const radiusOf = (mass: number): number => Math.sqrt(mass) * 4;

/** Speed from mass, per `SPEED_FALLOFF` above. */
export const speedOf = (mass: number): number =>
  SPEED_REF * Math.pow(START_MASS / Math.max(mass, 1), SPEED_FALLOFF);

/** Seconds until two halves of `mass` are allowed to become one cell again. */
export const mergeDelay = (mass: number): number =>
  Math.min(MERGE_MAX, MERGE_BASE + mass * MERGE_PER_MASS);

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/**
 * How much dish fits on screen.
 *
 * Keyed to the radius the player would have if all their mass were one cell, so
 * you stay about the same apparent size forever and it is the *world* that
 * shrinks around you. That is the illusion the whole genre runs on.
 */
export const VIEW_SPAN = 6.0;
export const VIEW_MIN = 300;
/** Past half the dish there is nothing left to reveal, so zooming further only
 *  makes everything smaller for no information. */
export const VIEW_MAX = 2400;

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export type ModeId = "ffa" | "blitz";
export type SkillId = "chill" | "standard" | "frenzy";

export interface Mode {
  id: ModeId;
  label: string;
  blurb: string;
  /** Seconds on the clock, or 0 for "play until something eats you". */
  duration: number;
}

export const MODES: Record<ModeId, Mode> = {
  ffa: {
    id: "ffa",
    label: "Free for all",
    blurb: "No clock. Get as big as you can and stay that way.",
    duration: 0,
  },
  blitz: {
    id: "blitz",
    label: "Blitz",
    blurb: "Three minutes. Highest mass you ever reach is the score — so spend it.",
    duration: 180,
  },
};

export interface Skill {
  id: SkillId;
  label: string;
  blurb: string;
  /** How many bots share the dish with you. */
  bots: number;
  /** Scales how well bots aim, plan and notice you. 0 is oblivious, 1 is sharp. */
  wit: number;
  /** How often a bot will spend a split on a kill. */
  daring: number;
}

export const SKILLS: Record<SkillId, Skill> = {
  chill: {
    id: "chill",
    label: "Chill",
    blurb: "Sixteen slow rivals who mostly want a snack.",
    bots: 16,
    wit: 0.42,
    daring: 0.12,
  },
  standard: {
    id: "standard",
    label: "Standard",
    blurb: "Twenty-four rivals. They will chase you, and some of them can split.",
    bots: 24,
    wit: 0.72,
    daring: 0.42,
  },
  frenzy: {
    id: "frenzy",
    label: "Frenzy",
    blurb: "Thirty-two rivals who hunt, feed viruses and split on sight.",
    bots: 32,
    wit: 1,
    daring: 0.85,
  },
};

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

/** The sim runs at a fixed rate and the renderer interpolates between ticks, so
 *  a 144 Hz monitor and a 60 Hz laptop play exactly the same game. */
export const TICK_HZ = 60;
export const TICK = 1 / TICK_HZ;
/** Never simulate more than this much wall clock in one frame — a backgrounded
 *  tab returns with a two-minute delta, and catching up would freeze the page. */
export const MAX_FRAME = 0.25;
