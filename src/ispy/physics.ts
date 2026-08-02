/**
 * I SPY — physics.
 *
 * One exported function does the whole simulation: `step`. It takes a player
 * state, one tick of input, and a world, and returns the next state. It reads
 * nothing outside its arguments and writes nothing outside the state it was
 * given, which is what lets `bot.ts` run thousands of speculative futures per
 * second through the exact same code the player is playing.
 *
 * Tuning follows Geometry Dash closely enough that muscle memory transfers:
 * a 1× cube jump is 2.6 blocks tall and covers 5.2 blocks of ground.
 */
import type { Grav, Input, Level, Obj, PlayerState } from "./types";

/** Blocks per second, by speed portal. 1× is the default. */
export const SPEEDS = { half: 8.6, one: 10.4, two: 12.9, three: 15.6 } as const;

export const CUBE_GRAVITY = 83;
export const CUBE_JUMP = 20.8;
const BALL_GRAVITY = 100;
const BALL_JUMP = 15.5;
const SHIP_GRAVITY = 42;
const SHIP_THRUST = 84;
const SHIP_VMAX = 13;
const WAVE_SLOPE = 0.95; // vertical blocks per horizontal block while waving

/** Boost strengths, in the same units as CUBE_JUMP. */
const BOOST = {
  yellow: 20.8,
  pink: 14.6,
  blue: 20.8, // blue also flips gravity
  green: 24.5,
} as const;

/** Half-width of the player's *lethal* box. Smaller than its solid box, so
    clipping a spike's corner by a hair is survivable — as in the real game. */
function dangerHalf(p: PlayerState): number {
  if (p.mode === "wave") return 0.16;
  if (p.mode === "ship") return 0.26;
  return 0.3;
}

/** Half-width of the player's *solid* box: what lands on blocks. */
function solidHalf(p: PlayerState): number {
  return p.mode === "wave" ? 0.2 : 0.5;
}

/**
 * Column index. Objects are bucketed by integer x so a tick only ever tests
 * the handful of things standing next to the player instead of all 1,400.
 */
export class World {
  readonly objects: Obj[];
  readonly length: number;
  private readonly columns = new Map<number, number[]>();

  constructor(level: Level) {
    this.objects = level.objects;
    this.length = level.length;
    level.objects.forEach((o, i) => {
      if (o.decoy || o.back || o.kind === "glyph") return;
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
    dead: false,
    usedOrbs: new Set(),
  };
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
    return [o.x + o.w * 0.5 - 0.18 * o.w, o.y + o.h * 0.1, 0.36 * o.w, o.h * 0.62];
  }
  // saw
  return [o.x + o.w * 0.22, o.y + o.h * 0.22, o.w * 0.56, o.h * 0.56];
}

function jump(p: PlayerState, strength: number) {
  p.vy = strength * p.grav;
  p.onGround = false;
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
  if (p.mode === "cube") {
    if (input.hold && p.onGround) jump(p, CUBE_JUMP);
    p.vy -= CUBE_GRAVITY * p.grav * dt;
    p.rot += (p.onGround ? 0 : 420) * dt * p.grav;
  } else if (p.mode === "ball") {
    if (input.tap && p.onGround) {
      p.grav = (p.grav === 1 ? -1 : 1) as Grav;
      p.vy = BALL_JUMP * p.grav * 0.35;
      p.onGround = false;
    }
    p.vy -= BALL_GRAVITY * p.grav * dt;
    p.rot += 300 * dt * p.grav;
  } else if (p.mode === "ship") {
    const accel = (input.hold ? SHIP_THRUST - SHIP_GRAVITY : -SHIP_GRAVITY) * p.grav;
    p.vy += accel * dt;
    p.vy = Math.max(-SHIP_VMAX, Math.min(SHIP_VMAX, p.vy));
    p.rot = Math.max(-32, Math.min(32, (p.vy / SHIP_VMAX) * 32 * p.grav));
  } else {
    // wave: no inertia at all, just a 45° line you steer with one button
    p.vy = (input.hold ? 1 : -1) * p.grav * p.speed * WAVE_SLOPE;
    p.rot = input.hold === (p.grav === 1) ? -45 : 45;
  }

  // Terminal velocity, so a long fall can still be recovered from.
  const vmax = p.mode === "ship" ? SHIP_VMAX : 26;
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
    if (p.mode === "wave") { p.dead = true; return; }
    p.y = FLOOR - inset;
    p.vy = 0;
    if (p.grav === 1) p.onGround = true;
  }
  if (py + ph > ROOF) {
    if (p.mode === "wave") { p.dead = true; return; }
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
      if (p.mode === "wave") { p.dead = true; return; }
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
        p.dead = true;
        return;
      }
      continue;
    }

    if (o.kind === "spike" || o.kind === "saw") {
      const dh = dangerHalf(p);
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
      jump(p, BOOST[b]);
      continue;
    }

    if (o.kind === "orb") {
      if (!input.tap || p.usedOrbs.has(i)) continue;
      p.usedOrbs.add(i);
      const b = o.boost ?? "yellow";
      if (b === "blue") p.grav = (p.grav === 1 ? -1 : 1) as Grav;
      jump(p, BOOST[b]);
      continue;
    }
  }
}
