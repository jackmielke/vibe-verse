/**
 * BLOB — the shapes the sim moves around.
 *
 * Deliberately plain objects with no methods on them: the sim owns all the
 * behaviour, the renderer only reads, and the tests can build a cell out of a
 * literal without dragging a constructor in.
 */

/** One blob belonging to one player. A player is their list of these. */
export interface Cell {
  id: number;
  /** Which player owns it. Cells of one owner never eat each other; they merge. */
  owner: number;
  x: number;
  y: number;
  /** Position at the top of the current tick, so the renderer can interpolate. */
  px: number;
  py: number;
  /** Impulse velocity from a split or a pop. Steering is applied separately and
   *  does not live here — this is only the part that decays. */
  vx: number;
  vy: number;
  mass: number;
  /** Cached `radiusOf(mass)`. Kept in sync by the sim; never write it by hand. */
  r: number;
  /** Sim time this cell may merge with its siblings. */
  mergeAt: number;
  /** Sim time it was born, which the renderer uses to pop it into existence. */
  bornAt: number;
  /**
   * Where the wire last said a remote cell is heading.
   *
   * Only ever set on cells this client does not own. Packets arrive at 12 Hz
   * and frames at 60, so writing `x` directly would step a friend's blob across
   * the dish in visible jumps; the sim eases towards this instead.
   */
  tx?: number;
  ty?: number;
}

/** A pellet: the food you spend the first thirty seconds hoovering up. */
export interface Food {
  id: number;
  x: number;
  y: number;
  mass: number;
  /** Hue in degrees. Pellets are the only colour in the dish that is random. */
  hue: number;
  /** Phase offset so the pellet field breathes instead of pulsing in lockstep. */
  phase: number;
}

/** Mass somebody spat out on purpose: a virus feed, a gift, or a decoy. */
export interface Pellet {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  mass: number;
  hue: number;
  /** Who fired it — they cannot swallow it again for a moment, or W does nothing. */
  from: number;
  bornAt: number;
}

/** The spiky green ones. Small cells shelter under them; big cells burst. */
export interface Virus {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  mass: number;
  /** Pellets eaten so far. At `VIRUS_FEED` it shoots a new virus and resets. */
  fed: number;
  /** Direction the last feed came from — the child is launched the other way. */
  feedAngle: number;
  /** Render-only spin, so a field of viruses does not look stamped. */
  spin: number;
}

export interface BotBrain {
  /** 0–1 dials rolled once per bot, which is all "personality" is here. */
  aggression: number;
  caution: number;
  greed: number;
  /** Scaled by the skill setting: how good its decisions actually are. */
  wit: number;
  daring: number;
  /** Sim time of the next decision. Bots think ~7 times a second, not 60. */
  nextThink: number;
  /** Steering target it settled on last time it thought. */
  tx: number;
  ty: number;
  /** Set by the brain, consumed by the sim on the same tick. */
  wantSplit: boolean;
  wantEject: boolean;
}

export interface Player {
  id: number;
  name: string;
  /** Base hue. Everything about how the blob looks derives from this one number. */
  hue: number;
  isBot: boolean;
  /**
   * Somebody else's client owns this player, so this one must not simulate it.
   *
   * Set on friends in a room, and on *every bot* when you are not the host —
   * see `src/blob/net/README` in the net folder. A remote player's cells are
   * written straight from the wire: they do not move, eat, split, merge or rot
   * here, because doing any of that locally would fight the packets and produce
   * two clients that quietly disagree about who is bigger.
   *
   * They can still be eaten. That is the one thing that happens *to* them
   * locally, and only when the cell doing the eating is one this client owns.
   */
  remote?: boolean;
  /** Peer that owns a remote player, for routing kill messages back to them. */
  peerId?: string;
  cells: Cell[];
  /** World-space point this player is steering towards. */
  aimX: number;
  aimY: number;
  /** Biggest total mass this player has ever held — the Blitz score. */
  peak: number;
  /** How many other players they have eaten. */
  kills: number;
  /** Sim time they were last eaten, for the respawn timer and the death card. */
  diedAt: number;
  alive: boolean;
  brain?: BotBrain;
}

export type SimEvent =
  /** Somebody swallowed a pellet or a blob. `mass` is what it was worth.
   *  `victim`/`cell` are set only when the meal was another player's cell, and
   *  they are what the multiplayer layer puts on the wire. */
  | {
      type: "eat";
      x: number;
      y: number;
      mass: number;
      hue: number;
      by: number;
      victim?: number;
      cell?: number;
    }
  | { type: "split"; x: number; y: number; by: number }
  | { type: "eject"; x: number; y: number; by: number }
  /** A cell hit a virus and came apart. `virus` is the one that burst, which
   *  the multiplayer layer broadcasts so every client drops the same one. */
  | { type: "pop"; x: number; y: number; by: number; pieces: number; virus: number }
  /** One player finished another. */
  | { type: "kill"; killer: string; victim: string; hue: number; victimMass: number }
  /** A player ran out of cells. */
  | { type: "death"; id: number; name: string; mass: number };

/** One line of the leaderboard. */
export interface Standing {
  id: number;
  name: string;
  mass: number;
  hue: number;
  isBot: boolean;
}
