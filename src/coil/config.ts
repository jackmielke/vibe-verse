/**
 * COIL — every number the game is made of.
 *
 * Same idea as `src/blob/config.ts` one world over: one file, one constant per
 * argument anybody could have, and a sentence next to each saying what it buys.
 *
 * The genre this belongs to is *not* the one BLOB belongs to, and almost every
 * number below follows from that one fact. In BLOB, size is safety: a big blob
 * eats a small one and nothing a small one does can change that. Here size is
 * only ever a liability — length is score and score is a longer thing to steer,
 * and the smallest snake in the arena can kill the biggest by getting in front
 * of it. So there is no mass ratio anywhere in this file. There is a head, a
 * body, and the rule that heads lose.
 */

// ---------------------------------------------------------------------------
// The arena
// ---------------------------------------------------------------------------

/**
 * A circle, not a square.
 *
 * Partly because the genre's arenas are round, but mostly because a round wall
 * is a fair wall: every point on it is the same distance from the middle, so
 * "hug the edge" is a strategy with one constant risk rather than a corner you
 * can be herded into and killed in.
 */
export const ARENA_R = 2100;
/* Sized against the roster and the viewport rather than picked: at this radius
   a screenful is about a twentieth of the arena, so with twenty-six snakes —
   each dragging several hundred pixels of lethal line — there is nearly always
   somebody's body in view, which is the game. */

/**
 * Orbs the arena tries to keep scattered.
 *
 * A density decision, not a count: what matters is how many are on screen,
 * which is this over the arena's area times the viewport. The first pass had
 * 2600 in an arena three times this size, and the result was a minute of
 * grazing before you saw another snake — the same "car park" mistake BLOB made,
 * and the same fix.
 */
export const ORB_TARGET = 1450;
export const ORB_REGROW = 48;
/** What an ordinary orb is worth. One point of score is one point of length. */
export const ORB_VALUE = 1;

// ---------------------------------------------------------------------------
// The snake
// ---------------------------------------------------------------------------

export const START_SCORE = 10;

/** Cruise, and what boost multiplies it by. */
export const SPEED = 232;
export const BOOST_MULT = 1.85;

/**
 * How fast you can turn, in radians per second.
 *
 * This *is* the game. Speed over turn rate is your turning circle — at these
 * numbers about seventy pixels, a bit over two body widths early on — and the
 * whole skill of the genre is knowing whether you can get your head around
 * somebody before they get theirs around yours. Faster and you can escape
 * anything by spinning on the spot; slower and encircling somebody stops being
 * a thing a person can do on purpose.
 */
export const TURN_RATE = 3.5;
/** Boosting straightens you out a little, so a boost is a commitment. */
export const BOOST_TURN_SCALE = 0.78;

/** Score burned per second while boosting, and how often that becomes an orb
 *  somebody behind you can pick up. Boosting feeds the person chasing you. */
export const BOOST_DRAIN = 5.5;
export const BOOST_ORB_INTERVAL = 0.22;
/** Below this you simply cannot boost — otherwise a snake can burn itself to
 *  nothing and the arena fills with snakes that are three segments long. */
export const BOOST_MIN_SCORE = 14;

/** Body radius from score. Deliberately shallow: doubling your length must not
 *  double your width, or the late game is two dinner plates in a bathtub. */
export const radiusOf = (score: number): number =>
  Math.min(40, 9 + Math.sqrt(Math.max(0, score)) * 0.58);

/**
 * Body length in world pixels, from score.
 *
 * Linear, so every orb is worth the same amount of visible snake. The cap is a
 * frame-rate decision rather than a design one — past about this much there is
 * no readable difference and there is a real cost to drawing it.
 */
export const lengthOf = (score: number): number =>
  Math.min(2600, 150 + Math.max(0, score) * 3.4);

/** Distance between drawn body circles, as a fraction of the radius. Small
 *  enough that the body reads as one continuous thing. */
export const DRAW_SPACING = 0.4;
/** ...and between the circles used for collision, which can be much coarser:
 *  a circle every 0.9 radii still leaves no gap a head could fit through. */
export const HIT_SPACING = 0.9;
/**
 * How much of the body a head has to actually reach to die on it.
 *
 * Slightly forgiving, because a near miss at these speeds should feel like a
 * near miss. At 1.0 the two circles merely touching is fatal, and the game
 * reads as though it is killing you for things you did not do.
 */
export const HIT_COVER = 0.82;

/** Orbs dropped along the corpse, and what each is worth relative to the
 *  score that died. Dying feeds the arena, which is what keeps a long match
 *  from starving. */
export const CORPSE_ORB_SPACING = 26;
export const CORPSE_VALUE_SHARE = 0.62;

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/** Visible half-height, keyed to body radius so you stay about the same
 *  apparent size and it is the arena that shrinks around you. */
export const VIEW_SPAN = 15;
export const VIEW_MIN = 360;
/** Past about two-thirds of the arena there is nothing left to reveal. */
export const VIEW_MAX = 1100;

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export type SkillId = "cruise" | "standard" | "swarm";

export interface Skill {
  id: SkillId;
  label: string;
  blurb: string;
  snakes: number;
  /** How well bots see a cut coming, and how willingly they try one. */
  wit: number;
  daring: number;
}

export const SKILLS: Record<SkillId, Skill> = {
  cruise: {
    id: "cruise",
    label: "Cruise",
    blurb: "Sixteen others, mostly grazing. Somewhere to learn the turning circle.",
    snakes: 16,
    wit: 0.4,
    daring: 0.12,
  },
  standard: {
    id: "standard",
    label: "Standard",
    blurb: "Twenty-four others. They will cut you off if you give them the line.",
    snakes: 24,
    wit: 0.75,
    daring: 0.45,
  },
  swarm: {
    id: "swarm",
    label: "Swarm",
    blurb: "Thirty others who boost, circle, and go for the head-on.",
    snakes: 30,
    wit: 1,
    daring: 0.9,
  },
};

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export const TICK_HZ = 60;
export const TICK = 1 / TICK_HZ;
export const MAX_FRAME = 0.25;
