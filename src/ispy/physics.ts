/**
 * I SPY — physics.
 *
 * One exported function does the whole simulation: `step`. It takes a player
 * state, one tick of input, and a world, and returns the next state. It reads
 * nothing outside its arguments and writes nothing outside the state it was
 * given, which is what lets `bot.ts` run thousands of speculative futures per
 * second through the exact same code the player is playing.
 *
 * Tuning follows Geometry Dash closely enough that muscle memory transfers: a
 * 1× cube jump is 2.6 blocks tall, covers 5 blocks of ground, and takes half a
 * second — which at 120 BPM is exactly one beat. That coincidence is not a
 * coincidence; see `BEAT` in build.ts.
 */
import type { Boost, Grav, Input, Level, Obj, PlayerState, Tuning } from "./types";

/** The classic tuning, kept as a named thing so tests can reason about it. */
export const CLASSIC: Tuning = { bpm: 120, blocksPerBeat: 5, apex: 2.6 };

export interface Derived {
  tuning: Tuning;
  /** Seconds per beat. */
  beatSecs: number;
  /** Blocks per second. */
  speed: number;
  /** Cube takeoff velocity and gravity. */
  jump: number;
  gravity: number;
  ballGravity: number;
  shipGravity: number;
  shipThrust: number;
  shipVmax: number;
  waveSlope: number;
  boost: Record<Boost, number>;
  terminal: number;
}

/**
 * Everything the simulation needs, solved from the three numbers a level
 * chooses. The flying modes are expressed as ratios of the cube's gravity
 * rather than as absolute numbers, so a low-gravity level gets a floaty ship
 * and a heavy one gets a ship that drops like a brick — which is the whole
 * point of letting a level pick its own gravity.
 */
export function derive(tuning: Tuning): Derived {
  const T = 60 / tuning.bpm;
  const speed = tuning.blocksPerBeat / T;
  const jump = (4 * tuning.apex) / T;
  const gravity = (8 * tuning.apex) / (T * T);
  return {
    tuning,
    beatSecs: T,
    speed,
    jump,
    gravity,
    ballGravity: gravity * 1.2,
    shipGravity: gravity * 0.506,
    shipThrust: gravity * 1.012,
    shipVmax: speed * 1.3,
    waveSlope: 0.95,
    boost: {
      yellow: jump,
      pink: jump * 0.702,
      blue: jump,
      green: jump * 1.178,
    },
    terminal: speed * 2.6,
  };
}

/**
 * Hitboxes, in Geometry Dash's own units.
 *
 * A block there is 30×30 px and 1×1 here, so every number below is the
 * documented pixel figure over 30. Two boxes per player, as in the original:
 * the **solid** box is what stands on blocks and dies on their sides, and the
 * smaller **hazard** box is what spikes test — which is why clipping the
 * corner of a spike by a hair is survivable and always has been.
 */
export const HITBOX = {
  /** 30×30. The whole tile. */
  cubeSolid: 1,
  /** 18×18, centred. */
  cubeHazard: 0.6,
  /** 30×20 — the ship is wider than it is tall. */
  shipSolid: 1,
  /** 15×15, centred on the hull. */
  shipHazard: 0.5,
  /** The wave is a dart: 12 wide, and it dies on contact with anything. */
  waveSolid: 0.4,
  waveHazard: 0.32,
  /** 30×30 like the cube; it rolls on the same surfaces. */
  ballSolid: 1,
  ballHazard: 0.6,
  /** A spike is 12×18 at the base centre of its tile, not the whole tile. */
  spike: [0.4, 0.62] as const,
  /** A sawblade kills inside ~56% of its drawn diameter. */
  saw: 0.56,
} as const;

/**
 * Degrees the cube turns per jump.
 *
 * This is the whole reason the cube lands flat. A fixed spin rate stops
 * wherever the arc happens to end — usually on a corner, which looks broken —
 * so instead the spin is solved from the jump: half a turn over exactly the
 * predicted air time. Land on the ground you left and you arrive at 180°, flat
 * on a side. Land early on a platform and `settle()` snaps the remainder.
 */
const CUBE_SPIN = 180;
/** Degrees per second the cube rights itself over after an early landing. */
const SETTLE_RATE = 1100;

/** Half-width of the player's *lethal* box, after the difficulty's scaling. */
function dangerHalf(p: PlayerState): number {
  const base =
    p.mode === "wave" ? HITBOX.waveHazard : p.mode === "ship" ? HITBOX.shipHazard : HITBOX.cubeHazard;
  return (base / 2) * p.hazardScale;
}

/** Half-width of the player's *solid* box: what lands on blocks. */
function solidHalf(p: PlayerState): number {
  return (p.mode === "wave" ? HITBOX.waveSolid : HITBOX.cubeSolid) / 2;
}

/** Nearest flat face, in degrees. A cube at rest is always on one. */
function flatFace(rot: number): number {
  return Math.round(rot / 90) * 90;
}

/**
 * Column index. Objects are bucketed by integer x so a tick only ever tests
 * the handful of things standing next to the player instead of all 1,400.
 */
export class World {
  readonly objects: Obj[];
  readonly length: number;
  /** Every physics constant this level runs on. */
  readonly t: Derived;
  private readonly columns = new Map<number, number[]>();

  constructor(level: Level) {
    this.objects = level.objects;
    this.length = level.length;
    this.t = derive(level.tuning);
    level.objects.forEach((o, i) => {
      // Decoys, scenery, paint and checkpoints are never collidable. The
      // renderer draws them; nothing here ever sees them again.
      if (
        o.decoy || o.back ||
        o.kind === "glyph" || o.kind === "checkpoint" || o.kind === "coin"
      ) return;
      for (let c = Math.floor(o.x) - 1; c <= Math.floor(o.x + o.w) + 1; c++) {
        const bucket = this.columns.get(c);
        if (bucket) bucket.push(i);
        else this.columns.set(c, [i]);
      }
    });
  }

  /** Every collidable object index within a block or two of `x`. */
  near(x: number): number[] {
    const a = this.columns.get(Math.floor(x) - 1);
    const b = this.columns.get(Math.floor(x));
    const c = this.columns.get(Math.floor(x) + 1);
    if (!a && !b && !c) return EMPTY;
    const out: number[] = [];
    if (a) out.push(...a);
    if (b) for (const i of b) if (!out.includes(i)) out.push(i);
    if (c) for (const i of c) if (!out.includes(i)) out.push(i);
    return out;
  }
}

const EMPTY: number[] = [];

export function initialState(level: Level): PlayerState {
  return {
    x: 0,
    y: level.start.y,
    vy: 0,
    mode: level.start.mode,
    grav: level.start.grav,
    speed: level.start.speed,
    onGround: true,
    rot: 0,
    rotVel: 0,
    hazardScale: 1,
    chill: false,
    dead: false,
    usedOrbs: new Set(),
  };
}

/** Rotate the last few degrees onto a flat face after an early landing. */
function settle(p: PlayerState, dt: number) {
  const target = flatFace(p.rot);
  const delta = target - p.rot;
  const stepBy = SETTLE_RATE * dt;
  p.rot = Math.abs(delta) <= stepBy ? target : p.rot + Math.sign(delta) * stepBy;
  p.rotVel = 0;
}

export function clonePlayer(p: PlayerState): PlayerState {
  return { ...p, usedOrbs: new Set(p.usedOrbs) };
}

function overlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/** A spike's kill box: the middle of the tile, not the tile. */
function hazardBox(o: Obj): [number, number, number, number] {
  if (o.kind === "spike") {
    const [hw, hh] = HITBOX.spike;
    return [o.x + o.w * (0.5 - hw / 2), o.y + o.h * 0.08, o.w * hw, o.h * hh];
  }
  const inset = (1 - HITBOX.saw) / 2;
  return [o.x + o.w * inset, o.y + o.h * inset, o.w * HITBOX.saw, o.h * HITBOX.saw];
}

function jump(p: PlayerState, strength: number, gravity: number) {
  p.vy = strength * p.grav;
  p.onGround = false;
  if (p.mode === "cube") {
    // Solve the spin from the arc: half a turn over the air time this launch
    // buys, so the cube arrives flat rather than stopping on a corner.
    const airTime = (2 * Math.abs(strength)) / gravity;
    p.rotVel = CUBE_SPIN / Math.max(airTime, 0.09);
  }
}

/**
 * Advance one tick. `dt` should be small and fixed — the engine runs this at
 * 240 Hz regardless of frame rate, so the level plays identically on a 60 Hz
 * laptop and a 144 Hz monitor.
 */
export function step(p: PlayerState, world: World, dt: number, input: Input): void {
  if (p.dead) return;

  const prevY = p.y;
  const prevBottom = prevY;
  const prevTop = prevY + 1;

  // ── Vertical intent ────────────────────────────────────────────────────
  const T = world.t;
  if (p.mode === "cube") {
    if (input.hold && p.onGround) jump(p, T.jump, T.gravity);
    p.vy -= T.gravity * p.grav * dt;
    if (p.onGround) settle(p, dt);
    else p.rot += p.rotVel * dt * p.grav;
  } else if (p.mode === "ball") {
    if (input.tap && p.onGround) {
      p.grav = (p.grav === 1 ? -1 : 1) as Grav;
      p.vy = T.jump * 0.745 * p.grav * 0.35;
      p.onGround = false;
    }
    p.vy -= T.ballGravity * p.grav * dt;
    p.rot += 300 * dt * p.grav;
  } else if (p.mode === "ship") {
    const accel = (input.hold ? T.shipThrust - T.shipGravity : -T.shipGravity) * p.grav;
    p.vy += accel * dt;
    p.vy = Math.max(-T.shipVmax, Math.min(T.shipVmax, p.vy));
    p.rot = Math.max(-32, Math.min(32, (p.vy / T.shipVmax) * 32 * p.grav));
  } else {
    // wave: no inertia at all, just a 45° line you steer with one button
    p.vy = (input.hold ? 1 : -1) * p.grav * p.speed * T.waveSlope;
    p.rot = input.hold === (p.grav === 1) ? -45 : 45;
  }

  // Terminal velocity, so a long fall can still be recovered from.
  const vmax = p.mode === "ship" ? T.shipVmax : T.terminal;
  p.vy = Math.max(-vmax, Math.min(vmax, p.vy));

  p.x += p.speed * dt;
  p.y += p.vy * dt;

  // The floor and the ceiling of the world. Ship and ball ride them; the wave
  // dies on them, which is what makes wave corridors corridors.
  const FLOOR = 0;
  const ROOF = 40;
  p.onGround = false;

  // Solid box: p.y is always the bottom of a 1-block cell, whatever the mode.
  const sh = solidHalf(p);
  const px = p.x - sh;
  const pw = sh * 2;
  const py = p.mode === "wave" ? p.y + 0.25 : p.y;
  const ph = p.mode === "wave" ? 0.5 : 1;
  const inset = py - p.y;

  if (py < FLOOR) {
    if (p.mode === "wave" && !p.chill) { p.dead = true; return; }
    p.y = FLOOR - inset;
    p.vy = 0;
    if (p.grav === 1) p.onGround = true;
  }
  if (py + ph > ROOF) {
    if (p.mode === "wave" && !p.chill) { p.dead = true; return; }
    p.y = ROOF - ph - inset;
    p.vy = 0;
    if (p.grav === -1) p.onGround = true;
  }

  // ── Collisions ─────────────────────────────────────────────────────────
  for (const i of world.near(p.x)) {
    const o = world.objects[i];

    if (o.kind === "block") {
      if (!overlap(px, p.y + inset, pw, ph, o.x, o.y, o.w, o.h)) continue;
      // The wave dies on anything it touches. That is the whole wave.
      if (p.mode === "wave") {
        if (p.chill) continue;
        p.dead = true;
        return;
      }
      const top = o.y + o.h;
      const landedOnTop = prevBottom >= top - 0.02 && p.vy <= 0;
      const landedOnBottom = prevTop <= o.y + 0.02 && p.vy >= 0;
      if (landedOnTop) {
        // Standing on it, or — upside down — bonking your head on it. Neither
        // kills: only the *side* of a block kills, exactly as in the original.
        p.y = top;
        p.vy = 0;
        if (p.grav === 1) p.onGround = true;
      } else if (landedOnBottom) {
        p.y = o.y - 1;
        p.vy = 0;
        if (p.grav === -1) p.onGround = true;
      } else {
        // Ran into a wall. In chill it is not there.
        if (p.chill) continue;
        p.dead = true;
        return;
      }
      continue;
    }

    if (o.kind === "spike" || o.kind === "saw") {
      if (p.chill) continue;
      const dh = dangerHalf(p);
      if (dh <= 0) continue;
      const [hx, hy, hw, hh] = hazardBox(o);
      const cy = p.y + 0.5;
      if (overlap(p.x - dh, cy - dh, dh * 2, dh * 2, hx, hy, hw, hh)) {
        p.dead = true;
        return;
      }
      continue;
    }

    if (!overlap(px, p.y + inset, pw, ph, o.x, o.y, o.w, o.h)) continue;

    if (o.kind === "portal") {
      if (o.to && o.to !== p.mode) {
        p.mode = o.to;
        p.vy = o.to === "wave" ? 0 : p.vy * 0.5;
      }
      if (o.grav !== undefined) p.grav = o.grav;
      if (o.speed !== undefined) p.speed = o.speed;
      continue;
    }

    if (o.kind === "pad") {
      const b = o.boost ?? "yellow";
      if (b === "blue") p.grav = (p.grav === 1 ? -1 : 1) as Grav;
      jump(p, T.boost[b], T.gravity);
      continue;
    }

    if (o.kind === "orb") {
      if (!input.tap || p.usedOrbs.has(i)) continue;
      p.usedOrbs.add(i);
      const b = o.boost ?? "yellow";
      if (b === "blue") p.grav = (p.grav === 1 ? -1 : 1) as Grav;
      jump(p, T.boost[b], T.gravity);
      continue;
    }
  }
}
