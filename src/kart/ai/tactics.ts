/**
 * Vibe Kart — how the rivals spend what they pick up.
 *
 * The rule that makes an item AI feel like a player rather than a dispenser is
 * simple: *an item is only used when it buys something*. A green shell fired at
 * an empty road is a wasted shield. A mushroom lit halfway round the hairpin is
 * a mushroom thrown away. So every branch below asks for a reason, and the
 * default answer is to keep hold of it.
 *
 * The second rule is that holding is itself a tactic. A trailing banana is a
 * shield, and a leader dragging a green shell behind them is doing exactly what
 * a good player does. `patience` per personality decides how long they will sit
 * on something before they get bored, which is most of why Grumbo and Volt look
 * like different drivers with the same item.
 */
import type { ItemKind } from "../types";
import { clamp01 } from "./math";
import type { Personality } from "./profiles";

export interface RivalRef {
  /** Arc metres to them; positive is ahead of us. */
  dist: number;
  /** Their lateral minus ours, metres. Near zero means they are lined up. */
  offset: number;
  speed: number;
  invincible: boolean;
}

export interface ItemContext {
  item: ItemKind | null;
  itemCount: number;
  /** Seconds the item has been in the box. */
  held: number;
  place: number;
  fieldSize: number;
  speed: number;
  topSpeed: number;
  boosting: boolean;
  starTime: number;
  stunned: boolean;
  offRoad: boolean;
  /** Metres of near-straight road in front of us. */
  runway: number;
  onShortcut: boolean;
  /** Metres to the shortcut entry, or Infinity. */
  shortcutIn: number;
  finalLap: boolean;
  ahead: RivalRef | null;
  behind: RivalRef | null;
  /** How many rivals are within a shell's reach in front. */
  packAhead: number;
  profile: Personality;
  /** Difficulty's item skill, 0..1. */
  skill: number;
  random: number;
}

export interface ItemDecision {
  use: boolean;
  aimBack: boolean;
}

const HOLD: ItemDecision = { use: false, aimBack: false };
const FIRE: ItemDecision = { use: true, aimBack: false };
const DROP: ItemDecision = { use: true, aimBack: true };

/**
 * Decide whether to press the button this tick. Called at plan rate, so a
 * "yes" fires once and the caller is expected to debounce on `itemCount`.
 */
export function decideItem(c: ItemContext): ItemDecision {
  const kind = c.item;
  if (!kind || c.stunned) return HOLD;

  const p = c.profile;
  // Reaction: nobody fires the instant the roulette stops. Low-skill difficulty
  // dithers for longer, and a patient personality longer still.
  const fuse = 0.18 + (1 - c.skill) * 0.9 + p.patience * 0.35;
  if (c.held < fuse) return HOLD;

  const leading = c.place <= 1;
  const last = c.place >= c.fieldSize;
  // Bored of holding: past this the item goes, whatever the situation.
  const stale = c.held > 4 + p.patience * 3.5;

  switch (kind) {
    // --- defensive furniture ------------------------------------------------
    case "banana": {
      // A banana is a shield first and a trap second. Drop it when someone is
      // close enough to be inconvenienced, or when the road behind is about to
      // become somewhere they cannot avoid it.
      if (c.behind && c.behind.dist > -22 && !c.behind.invincible) return DROP;
      if (stale && c.runway < 30) return DROP;
      return HOLD;
    }

    case "greenShell": {
      // Straight line only. A green shell fired into a corner hits scenery, and
      // a rival who is lined up and slower is the one shot worth taking.
      if (c.ahead && c.ahead.dist < 34 && Math.abs(c.ahead.offset) < 2.6 + (1 - c.skill) * 3 && c.runway > 24) {
        return FIRE;
      }
      if (c.behind && c.behind.dist > -14 && !c.behind.invincible) return DROP;
      // Leading with nothing to shoot at: keep it spinning behind you.
      if (leading && !stale) return HOLD;
      return stale ? DROP : HOLD;
    }

    case "bobomb": {
      if (c.ahead && c.ahead.dist < 26 && Math.abs(c.ahead.offset) < 5) return FIRE;
      if (c.behind && c.behind.dist > -16) return DROP;
      return stale ? DROP : HOLD;
    }

    // --- homing -------------------------------------------------------------
    case "redShell": {
      if (c.ahead && c.ahead.dist < 70 && !c.ahead.invincible) {
        // Wait for them to be close enough that the shell will not be eaten by
        // a wall on the way — unless we are impatient by nature.
        const patienceRange = 26 + (1 - c.skill) * 44 + p.aggression * 22;
        if (c.ahead.dist < patienceRange) return FIRE;
      }
      if (c.behind && c.behind.dist > -12 && !c.behind.invincible) return DROP;
      return stale && !leading ? FIRE : HOLD;
    }

    case "blueShell": {
      // No reason on earth to sit on one unless you are the target.
      return leading ? HOLD : FIRE;
    }

    // --- speed --------------------------------------------------------------
    case "mushroom":
    case "tripleMushroom": {
      // Off-road recovery is what a mushroom is *for*.
      if (c.offRoad) return FIRE;
      if (c.onShortcut) return FIRE;
      // Lit just before the dirt cut, so the boost carries across the loose bit.
      if (c.shortcutIn < 22 && c.shortcutIn > 0) return FIRE;
      if (c.boosting) return HOLD;
      // Otherwise: on a straight, at less than terminal speed, where it is worth
      // the most. Triples get spent more freely — they are three of them.
      const needsIt = c.speed < c.topSpeed * 0.96;
      if (c.runway > 55 && needsIt) return FIRE;
      if (kind === "tripleMushroom" && c.runway > 30 && needsIt) return FIRE;
      return stale && c.runway > 25 ? FIRE : HOLD;
    }

    case "bullet": {
      // A bullet is a rescue, not a treat. Save it for a real deficit.
      if (c.place >= Math.ceil(c.fieldSize * 0.6) || last) return FIRE;
      return stale ? FIRE : HOLD;
    }

    case "star": {
      if (c.starTime > 0) return HOLD;
      // Best spent where there is somewhere to put the speed and someone to
      // knock out of the way. The Baron's profile hoards it for the last lap.
      const wantsPack = c.packAhead > 0 && c.ahead !== null && c.ahead.dist < 26;
      const hoarding = p.patience > 1.6 && !c.finalLap && c.held < 6 + p.patience * 2;
      if (hoarding && !wantsPack) return HOLD;
      if (wantsPack || c.runway > 45 || c.offRoad) return FIRE;
      return stale ? FIRE : HOLD;
    }

    // --- disruption ---------------------------------------------------------
    case "lightning": {
      // Worth the most when the field in front is spread out and airborne over
      // something — approximated by "there are people ahead and we are moving".
      if (!leading && c.packAhead >= 2) return FIRE;
      return stale && !leading ? FIRE : HOLD;
    }

    case "blooper": {
      if (!leading && c.packAhead >= 1) return FIRE;
      return stale ? FIRE : HOLD;
    }

    case "boo": {
      // Steal from someone worth stealing from.
      if (c.place >= 3 && c.random < 0.5 + p.aggression * 0.4) return FIRE;
      return stale ? FIRE : HOLD;
    }

    case "fireflower": {
      if (c.ahead && c.ahead.dist < 22) return FIRE;
      if (c.behind && c.behind.dist > -18) return FIRE;
      return stale ? FIRE : HOLD;
    }

    case "coin": {
      // Nothing to think about; coins are banked immediately.
      return FIRE;
    }

    default:
      return stale ? FIRE : HOLD;
  }
}

/**
 * Whether the dirt cut is worth taking this lap. Kept beside the item logic
 * because the answer depends heavily on whether there is a mushroom in the box.
 */
export function wantsShortcut(
  gain: number,
  gainBoosted: number,
  hasMushroom: boolean,
  behindBy: number,
  profile: Personality,
  skill: number,
  random: number,
): boolean {
  const effective = hasMushroom ? gainBoosted : gain;
  // Clearly faster: everyone with any sense takes it.
  if (effective > 0.55) return true;
  // Marginal: the bold ones, and anyone who has something to make up.
  if (effective > -0.15) {
    const desperation = clamp01(behindBy / 90) * 0.4;
    return random < profile.shortcutAppetite * (0.45 + skill * 0.55) + desperation;
  }
  return false;
}
