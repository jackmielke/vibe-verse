/**
 * I SPY — shared vocabulary.
 *
 * Everything in the level lives on a grid of 1×1 blocks. The player is one
 * block. `x` grows to the right forever; `y` grows upward and the floor of the
 * world is y = 0. Nothing here knows about pixels — the renderer is the only
 * file that multiplies by a scale.
 */

/** The four ways the level can be flying you through itself. */
export type Mode = "cube" | "ship" | "ball" | "wave";

/** Gravity sign: 1 pulls toward y = 0, -1 pulls toward the ceiling. */
export type Grav = 1 | -1;

export type ObjKind =
  | "block" // solid. Land on it, die on its side.
  | "spike" // kills. Small forgiving hitbox in the middle.
  | "saw" // kills. Round, spins, drawn as the red pinwheel.
  | "pad" // step on it, get launched
  | "orb" // tap while touching it, get launched
  | "portal" // changes mode / gravity / speed
  | "checkpoint" // banks the run. Watched by the engine, not the physics
  | "coin" // one of three. Also watched by the engine, never by the physics
  | "glyph"; // pure paint: the pink "?" that gave the level its name

export type Boost = "yellow" | "pink" | "blue" | "green";

export interface Obj {
  kind: ObjKind;
  /** Bottom-left corner, in blocks. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Visual rotation in degrees. Hitboxes stay axis-aligned — as in the real game. */
  rot?: number;
  /** Override the section palette. Decoys use this to lie convincingly. */
  color?: string;
  /**
   * A decoy is drawn exactly like the real thing and collides with nothing.
   * This one flag is the entire level. Roughly two thirds of what you can see
   * at any moment is a decoy, which is why the spy pulse exists.
   */
  decoy?: boolean;
  /** Drawn behind the play layer and dimmed — scenery, never solid. */
  back?: boolean;
  /**
   * Draw without the per-object outline. The wave tube is emitted a column at
   * a time so its centreline can wander; outlining every column would draw a
   * grid of boxes where the player should see one continuous wall.
   */
  plain?: boolean;
  /**
   * A girder: the horizontal bar a row of hanging teeth is bolted to. Spans
   * rather than stands, which is the one shape allowed to do that — a row of
   * spikes hanging off nothing reads as a bug, and a row hanging off a beam
   * reads as a level.
   */
  mount?: boolean;
  /**
   * 0..1 draw opacity for objects that are real. A few genuinely lethal
   * spikes sit at 0.06 and you are expected to learn them by dying to them,
   * or to spend a pulse. Nothing that can kill you is ever fully invisible.
   */
  alpha?: number;
  /** portal: what it switches you to. */
  to?: Mode;
  grav?: Grav;
  speed?: number;
  /** pad / orb flavour. */
  boost?: Boost;
}

/** A stretch of level with its own look. Palettes cross-fade at the seam. */
export interface Section {
  /** Left edge, in blocks. Sections are sorted and cover the level end to end. */
  x: number;
  name: string;
  /** Background gradient, top to bottom. */
  bg: [string, string];
  /** Default fill for solid geometry. */
  solid: string;
  /** Default fill for things that kill. */
  hazard: string;
  /** Signal colour — orbs, the progress bar, the glow. */
  accent: string;
  /** 0..1 — how hard the background strobes on the beat. */
  strobe: number;
  /** Ground stripe colour. */
  ground: string;
}

/**
 * The three numbers that define how a level *feels*, and from which every
 * other constant is derived.
 *
 * One jump is one beat is `blocksPerBeat` blocks. Given a tempo and an apex
 * height, that identity forces the rest — with T = 60/bpm seconds per beat:
 *
 *     speed = blocksPerBeat / T        blocks per second
 *     v0    = 4 · apex / T             takeoff velocity
 *     g     = 8 · apex / T²            gravity
 *
 * Feed it 120 BPM, 5 blocks and a 2.6-block apex and it hands back exactly the
 * speed 10 / v0 20.8 / g 83 that the first level was hand-tuned to, which is
 * how we know the derivation is the same shape the game already had. Change
 * any of the three and a level gets its own gravity and its own tempo while
 * every jump still lands on a downbeat.
 */
export interface Tuning {
  bpm: number;
  blocksPerBeat: number;
  /** Apex height of a cube jump, in blocks. */
  apex: number;
}

export interface Level {
  /** Stable id, used in the URL and in save keys. */
  id: string;
  name: string;
  /** Which corner of the vibeverse this one is set in. */
  world: string;
  tagline: string;
  tuning: Tuning;
  objects: Obj[];
  sections: Section[];
  /** x of the end wall. Reaching it is 100%. */
  length: number;
  /** Where the run starts, and what it starts as. */
  start: { mode: Mode; speed: number; grav: Grav; y: number };
}

/** Live player state. Copied wholesale by the bot to simulate futures. */
export interface PlayerState {
  x: number;
  y: number;
  vy: number;
  mode: Mode;
  grav: Grav;
  speed: number;
  /** Touching a surface *in the current gravity direction*. */
  onGround: boolean;
  /** Visual rotation, degrees. Cosmetic, but the bot copies it anyway. */
  rot: number;
  /** Degrees per second the cube is currently turning. Solved at takeoff so
      that the jump ends on a flat face — see `CUBE_SPIN` in physics.ts. */
  rotVel: number;
  /**
   * Multiplier on the player's *lethal* box, from the difficulty. 1 is the
   * original's 18×18; easier modes shrink it, and 0 means nothing can touch
   * you. It lives on the state rather than in a module global so that the
   * solver copies it along with everything else and can be run at any
   * difficulty without the physics knowing which one is "real".
   */
  hazardScale: number;
  /** Nothing kills. Walls are passed through rather than died against. */
  chill: boolean;
  dead: boolean;
  /** Orbs already used this attempt, by object index — an orb fires once. */
  usedOrbs: Set<number>;
}

/** One physics tick's worth of input. */
export interface Input {
  /** Button is down this tick. */
  hold: boolean;
  /** Button went down *this* tick — orbs and cube jumps want the edge. */
  tap: boolean;
}
