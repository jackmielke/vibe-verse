/**
 * MORT'S MAZE — the rules.
 *
 * Pure and deterministic: a `Game` is plain data, `step(game, dt)` advances
 * it, and nothing in here touches the DOM, a clock or `Math.random` (the rng
 * is a seeded LCG carried in the state). That is what lets the test suite
 * play whole lives in node, and what lets `window.__mortmaze.settle()` fast
 * forward the real page in a browser with no GPU.
 *
 * Positions are in tiles, with integers at tile centres. Everything moves
 * along a corridor and only decides where to go next when it arrives at a
 * centre, which is the whole trick of a grid chase: no physics, no
 * collisions with walls, just a choice at every junction.
 */
import {
  BALLOON, BONUS_TILE, buildMaze, COIN, FLOOR, GATE, MAZE_H, MAZE_W, NOTHING, PEN,
  PEN_CENTER, PEN_EXIT, PLAYER_START, TUNNEL_ROW, WALL, type BuiltMaze,
} from "./mazes";

/** 0 up, 1 right, 2 down, 3 left, -1 standing still. */
export type Dir = -1 | 0 | 1 | 2 | 3;
export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];
const opposite = (d: Dir): Dir => (d < 0 ? -1 : (((d + 2) % 4) as Dir));

export type ChaserId = "mort" | "linda" | "hank" | "ray";
export type ChaserMode = "pen" | "leaving" | "active" | "soaked" | "eyes";

export interface ChaserInfo {
  id: ChaserId;
  name: string;
  color: string;
  /** One line for the start screen. */
  bio: string;
}

/** Mad Mort and his junkyard crew. Order is release order. */
export const CREW: ChaserInfo[] = [
  { id: "mort", name: "Mad Mort", color: "#ff4d5e", bio: "Comes straight at you. Always." },
  { id: "linda", name: "Lunatic Linda", color: "#ff5cc8", bio: "Heads for where you are going." },
  { id: "hank", name: "Hubcap Hank", color: "#ffa23a", bio: "Wanders, until he spots you." },
  { id: "ray", name: "Rusty Ray", color: "#8cff5a", bio: "Gets everything backwards." },
];

export interface Mover {
  x: number;
  y: number;
  dir: Dir;
}

export interface Chaser extends Mover {
  id: ChaserId;
  mode: ChaserMode;
  /** Seconds left in the pen before stepping out. */
  penTimer: number;
  home: { x: number; y: number };
  corner: { x: number; y: number };
}

export interface Player extends Mover {
  /** The buffered turn: taken at the first junction that allows it. */
  want: Dir;
  /** Did Vibey move this step? Drives the chomp. */
  moving: boolean;
  /** Distance travelled, for the chomp animation. */
  odometer: number;
}

export type Phase = "ready" | "play" | "snack" | "dying" | "clear" | "over";

export type GameEvent =
  | { type: "coin" }
  | { type: "balloon" }
  | { type: "bonk"; x: number; y: number; points: number }
  | { type: "bonus"; x: number; y: number; points: number }
  | { type: "die" }
  | { type: "clear" }
  | { type: "life" }
  | { type: "ready" }
  | { type: "over" };

export interface Popup {
  x: number;
  y: number;
  text: string;
  t: number;
}

export const SNACKS = [
  { emoji: "🍍", name: "Pineapple", points: 100 },
  { emoji: "🥥", name: "Coconut", points: 300 },
  { emoji: "🥧", name: "Pumpkin pie", points: 500 },
  { emoji: "🌮", name: "Taco", points: 700 },
  { emoji: "🍩", name: "Donut", points: 1000 },
  { emoji: "👑", name: "Crown", points: 2000 },
];

export interface Game {
  level: number;
  maze: BuiltMaze;
  items: Uint8Array;
  coinsLeft: number;
  coinsEaten: number;
  score: number;
  lives: number;
  /** Score at which the next extra life is given. */
  nextLifeAt: number;
  phase: Phase;
  /** Seconds spent in the current phase. */
  phaseT: number;
  player: Player;
  chasers: Chaser[];
  /** Seconds of soak left. 0 means no balloon is active. */
  powerT: number;
  /** Chasers splashed during this balloon: doubles the payout each time. */
  combo: number;
  /** Seconds into the scatter/chase schedule. */
  modeClock: number;
  bonus: { snack: number; t: number } | null;
  bonusesShown: number;
  popups: Popup[];
  /** Drained by the page each frame for sound and haptics. */
  events: GameEvent[];
  /** Total simulated seconds. Drives animation. */
  time: number;
  seed: number;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

export const START_LIVES = 3;
export const EXTRA_LIFE_EVERY = 10_000;
const READY_SECONDS = 2.2;
const DYING_SECONDS = 1.6;
const CLEAR_SECONDS = 2.2;
const SNACK_FREEZE = 0.55;
const BONUS_SECONDS = 9;
const BONUS_AT = [60, 140];
const HIT_RADIUS = 0.62;

export const playerSpeed = (level: number) => Math.min(9, 7.2 + (level - 1) * 0.3);
export const chaserSpeed = (level: number) => Math.min(9.4, 6.7 + (level - 1) * 0.4);
const SOAKED_SPEED = 4.2;
const EYES_SPEED = 14;
const LEAVING_SPEED = 4;
export const powerSeconds = (level: number) => Math.max(1.6, 7 - (level - 1) * 0.9);
const releaseAfter = (i: number, level: number) =>
  [0, 1.2, 4.5, 8][i] * Math.max(0.35, 1 - (level - 1) * 0.15);

/** Scatter, chase, scatter, chase, scatter, then chase for good. */
const SCHEDULE = [6, 20, 6, 20, 4];
function scheduleMode(clock: number): "scatter" | "chase" {
  let t = clock;
  for (let i = 0; i < SCHEDULE.length; i++) {
    if (t < SCHEDULE[i]) return i % 2 === 0 ? "scatter" : "chase";
    t -= SCHEDULE[i];
  }
  return "chase";
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const CORNERS: Record<ChaserId, { x: number; y: number }> = {
  mort: { x: MAZE_W - 2, y: -2 },
  linda: { x: 1, y: -2 },
  hank: { x: 1, y: MAZE_H + 1 },
  ray: { x: MAZE_W - 2, y: MAZE_H + 1 },
};

const HOMES: Record<ChaserId, { x: number; y: number }> = {
  mort: { ...PEN_EXIT },
  linda: { x: PEN_CENTER.x, y: PEN_CENTER.y },
  hank: { x: PEN_CENTER.x - 2, y: PEN_CENTER.y },
  ray: { x: PEN_CENTER.x + 2, y: PEN_CENTER.y },
};

function countCoins(items: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < items.length; i++) if (items[i] !== NOTHING) n++;
  return n;
}

function placeActors(g: Game) {
  g.player = {
    x: PLAYER_START.x, y: PLAYER_START.y, dir: 3, want: 3, moving: false, odometer: 0,
  };
  g.chasers = CREW.map((c, i) => ({
    id: c.id,
    x: HOMES[c.id].x,
    y: HOMES[c.id].y,
    dir: c.id === "mort" ? 3 : 0,
    mode: c.id === "mort" ? "active" : "pen",
    penTimer: releaseAfter(i, g.level),
    home: HOMES[c.id],
    corner: CORNERS[c.id],
  }));
  g.powerT = 0;
  g.combo = 0;
  g.modeClock = 0;
  g.bonus = null;
}

function loadLevel(g: Game) {
  g.maze = buildMaze(g.level - 1);
  g.items = g.maze.items.slice();
  g.coinsLeft = countCoins(g.items);
  g.coinsEaten = 0;
  g.bonusesShown = 0;
  placeActors(g);
}

export function newGame(seed = 1, level = 1): Game {
  const g = {
    level: Math.max(1, Math.floor(level)),
    score: 0,
    lives: START_LIVES,
    nextLifeAt: EXTRA_LIFE_EVERY,
    phase: "ready",
    phaseT: 0,
    popups: [],
    events: [{ type: "ready" }],
    time: 0,
    seed: seed >>> 0 || 1,
  } as unknown as Game;
  loadLevel(g);
  return g;
}

// ---------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------

const wrapX = (x: number) => ((x % MAZE_W) + MAZE_W) % MAZE_W;

export function cellAt(g: Game, x: number, y: number): number {
  if (y < 0 || y >= MAZE_H) return WALL;
  return g.maze.cells[y * MAZE_W + wrapX(x)];
}

function rand(g: Game): number {
  g.seed = (Math.imul(g.seed, 1664525) + 1013904223) >>> 0;
  return g.seed / 4294967296;
}

const canPlayerEnter = (g: Game, x: number, y: number) => cellAt(g, x, y) === FLOOR;

function canChaserEnter(g: Game, c: Chaser, x: number, y: number): boolean {
  const k = cellAt(g, x, y);
  if (k === FLOOR) return true;
  if (k === GATE || k === PEN) return c.mode === "leaving" || c.mode === "eyes" || c.mode === "pen";
  return false;
}

/**
 * Walk a mover `dist` tiles along its direction, stopping at each tile centre
 * to ask `choose` where to go next. Returns the distance actually covered.
 */
function advance(m: Mover, dist: number, choose: (cx: number, cy: number) => Dir): number {
  let moved = 0;
  let guard = 8;
  while (dist > 1e-9 && guard-- > 0) {
    const cx = Math.round(m.x);
    const cy = Math.round(m.y);
    const atCentre = Math.abs(m.x - cx) < 1e-6 && Math.abs(m.y - cy) < 1e-6;
    if (atCentre) {
      m.x = cx;
      m.y = cy;
      // The tunnel: arriving at a centre past either edge comes out the other.
      if (m.x < 0 || m.x > MAZE_W - 1) m.x = wrapX(m.x);
      m.dir = choose(Math.round(m.x), cy);
      if (m.dir < 0) break;
    }
    if (m.dir < 0) break;
    const dx = DX[m.dir];
    const dy = DY[m.dir];
    // Distance to the next centre in the direction of travel.
    let toNext: number;
    if (dx > 0) toNext = Math.floor(m.x + 1e-9) + 1 - m.x;
    else if (dx < 0) toNext = m.x - (Math.ceil(m.x - 1e-9) - 1);
    else if (dy > 0) toNext = Math.floor(m.y + 1e-9) + 1 - m.y;
    else toNext = m.y - (Math.ceil(m.y - 1e-9) - 1);
    if (toNext < 1e-9) toNext = 1;
    const step = Math.min(dist, toNext);
    m.x += dx * step;
    m.y += dy * step;
    if (Math.abs(step - toNext) < 1e-9) {
      m.x = Math.round(m.x);
      m.y = Math.round(m.y);
    }
    dist -= step;
    moved += step;
  }
  return moved;
}

/** Breadth-first distance to the pen centre, through the gate. */
const penDistCache = new WeakMap<BuiltMaze, Int16Array>();
function penDistances(g: Game): Int16Array {
  const hit = penDistCache.get(g.maze);
  if (hit) return hit;
  const d = new Int16Array(MAZE_W * MAZE_H).fill(-1);
  const q: number[] = [PEN_CENTER.y * MAZE_W + PEN_CENTER.x];
  d[q[0]] = 0;
  while (q.length) {
    const i = q.shift()!;
    const x = i % MAZE_W;
    const y = (i / MAZE_W) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = wrapX(x + DX[k]);
      const ny = y + DY[k];
      if (ny < 0 || ny >= MAZE_H) continue;
      const j = ny * MAZE_W + nx;
      if (d[j] >= 0 || g.maze.cells[j] === WALL) continue;
      d[j] = d[i] + 1;
      q.push(j);
    }
  }
  penDistCache.set(g.maze, d);
  return d;
}

// ---------------------------------------------------------------------------
// The crew's heads
// ---------------------------------------------------------------------------

function chaseTarget(g: Game, c: Chaser): { x: number; y: number } {
  const p = g.player;
  const px = Math.round(p.x);
  const py = Math.round(p.y);
  const pd = p.dir < 0 ? 3 : p.dir;
  switch (c.id) {
    case "mort":
      return { x: px, y: py };
    case "linda":
      return { x: px + DX[pd] * 4, y: py + DY[pd] * 4 };
    case "hank": {
      const far = Math.hypot(c.x - p.x, c.y - p.y) > 7;
      // Close up, Hank loses interest and goes back to poking around.
      return far ? { x: px, y: py } : { x: -99, y: -99 };
    }
    case "ray": {
      const near = Math.hypot(c.x - p.x, c.y - p.y) < 5;
      return near ? { x: px, y: py } : { x: MAZE_W - 1 - px, y: py };
    }
  }
}

function chooseChaserDir(g: Game, c: Chaser, cx: number, cy: number): Dir {
  if (c.mode === "leaving" && cx === PEN_EXIT.x && cy === PEN_EXIT.y) {
    c.mode = "active";
    return 3;
  }
  if (c.mode === "eyes" && cx === PEN_CENTER.x && cy === PEN_CENTER.y) {
    c.mode = "pen";
    c.penTimer = 0.5;
    return -1;
  }
  const back = opposite(c.dir);
  const options: Dir[] = [];
  for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
    if (d === back) continue;
    if (canChaserEnter(g, c, cx + DX[d], cy + DY[d])) options.push(d);
  }
  if (!options.length) return canChaserEnter(g, c, cx + DX[back], cy + DY[back]) ? back : -1;

  // Pen and home: follow the distance field, which never gets lost.
  if (c.mode === "eyes" || c.mode === "leaving") {
    const dist = penDistances(g);
    const here = (y: number, x: number) => dist[y * MAZE_W + wrapX(x)];
    let best = options[0];
    let bestScore = Infinity;
    for (const d of options) {
      const v = here(cy + DY[d], cx + DX[d]);
      // Leaving wants to get FURTHER from the centre until it reaches the exit,
      // but only through the gate: score by distance to the exit tile instead.
      const score = c.mode === "eyes"
        ? v
        : Math.hypot(cx + DX[d] - PEN_EXIT.x, cy + DY[d] - PEN_EXIT.y);
      if (score < bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  if (c.mode === "soaked") return options[Math.floor(rand(g) * options.length)];

  const target = scheduleMode(g.modeClock) === "scatter" ? c.corner : chaseTarget(g, c);
  if (target.x === -99) {
    // Hank poking around: a random turn at each junction.
    return options[Math.floor(rand(g) * options.length)];
  }
  let best = options[0];
  let bestD = Infinity;
  for (const d of options) {
    const nx = cx + DX[d];
    const ny = cy + DY[d];
    const dd = (nx - target.x) ** 2 + (ny - target.y) ** 2;
    if (dd < bestD - 1e-9) { bestD = dd; best = d; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

function addScore(g: Game, n: number) {
  g.score += n;
  while (g.score >= g.nextLifeAt) {
    g.lives += 1;
    g.nextLifeAt += EXTRA_LIFE_EVERY;
    g.events.push({ type: "life" });
  }
}

function setPhase(g: Game, p: Phase) {
  g.phase = p;
  g.phaseT = 0;
}

function eat(g: Game) {
  const p = g.player;
  const tx = wrapX(Math.round(p.x));
  const ty = Math.round(p.y);
  if (Math.abs(p.x - Math.round(p.x)) > 0.45 || Math.abs(p.y - ty) > 0.45) return;
  const i = ty * MAZE_W + tx;
  const item = g.items[i];
  if (item === COIN) {
    g.items[i] = NOTHING;
    addScore(g, 10);
    g.events.push({ type: "coin" });
  } else if (item === BALLOON) {
    g.items[i] = NOTHING;
    addScore(g, 50);
    g.events.push({ type: "balloon" });
    g.powerT = powerSeconds(g.level);
    g.combo = 0;
    for (const c of g.chasers) {
      if (c.mode === "active" || c.mode === "soaked") {
        if (c.mode === "active") c.dir = opposite(c.dir);
        c.mode = "soaked";
      }
    }
  } else {
    return;
  }
  g.coinsLeft -= 1;
  g.coinsEaten += 1;
  if (g.bonusesShown < BONUS_AT.length && g.coinsEaten >= BONUS_AT[g.bonusesShown]) {
    g.bonus = { snack: Math.min(SNACKS.length - 1, g.level - 1), t: BONUS_SECONDS };
    g.bonusesShown += 1;
  }
  if (g.coinsLeft <= 0) {
    setPhase(g, "clear");
    g.events.push({ type: "clear" });
  }
}

function speedFor(g: Game, c: Chaser): number {
  let s: number;
  switch (c.mode) {
    case "soaked": s = SOAKED_SPEED; break;
    case "eyes": return EYES_SPEED;
    case "leaving": return LEAVING_SPEED;
    case "pen": return 0;
    default: s = chaserSpeed(g.level);
  }
  // The tunnel is slow going for the crew, which is what makes it an escape.
  if (Math.round(c.y) === TUNNEL_ROW && (c.x < 2.5 || c.x > MAZE_W - 3.5)) s *= 0.55;
  return s;
}

function stepPlay(g: Game, dt: number) {
  const p = g.player;

  // A reverse never has to wait for a junction.
  if (p.want >= 0 && p.want === opposite(p.dir)) p.dir = p.want;

  const moved = advance(p, playerSpeed(g.level) * dt, (cx, cy) => {
    if (p.want >= 0 && canPlayerEnter(g, cx + DX[p.want], cy + DY[p.want])) return p.want;
    if (p.dir >= 0 && canPlayerEnter(g, cx + DX[p.dir], cy + DY[p.dir])) return p.dir;
    return -1;
  });
  p.moving = moved > 0;
  p.odometer += moved;
  // Stopped against a hedge: keep facing the way we were going.
  if (p.dir < 0) p.dir = p.want >= 0 ? p.want : 3;
  eat(g);
  if (g.phase !== "play") return;

  // Power and schedule clocks. The schedule pauses while the crew is soaked.
  if (g.powerT > 0) {
    g.powerT = Math.max(0, g.powerT - dt);
    if (g.powerT === 0) {
      for (const c of g.chasers) if (c.mode === "soaked") c.mode = "active";
    }
  } else {
    const before = scheduleMode(g.modeClock);
    g.modeClock += dt;
    if (scheduleMode(g.modeClock) !== before) {
      for (const c of g.chasers) if (c.mode === "active") c.dir = opposite(c.dir);
    }
  }

  if (g.bonus) {
    g.bonus.t -= dt;
    if (g.bonus.t <= 0) g.bonus = null;
    else if (Math.hypot(p.x - BONUS_TILE.x, p.y - BONUS_TILE.y) < 0.6) {
      const points = SNACKS[g.bonus.snack].points;
      addScore(g, points);
      g.popups.push({ x: BONUS_TILE.x, y: BONUS_TILE.y, text: String(points), t: 1.4 });
      g.events.push({ type: "bonus", x: BONUS_TILE.x, y: BONUS_TILE.y, points });
      g.bonus = null;
    }
  }

  for (const c of g.chasers) {
    if (c.mode === "pen") {
      c.penTimer -= dt;
      if (c.penTimer <= 0) {
        c.mode = "leaving";
        c.dir = -1;
      }
      continue;
    }
    advance(c, speedFor(g, c) * dt, (cx, cy) => chooseChaserDir(g, c, cx, cy));
  }

  // Touches.
  for (const c of g.chasers) {
    if (c.mode !== "active" && c.mode !== "soaked") continue;
    const dx = Math.abs(c.x - p.x);
    const ddx = Math.min(dx, MAZE_W - dx);
    if (Math.hypot(ddx, c.y - p.y) > HIT_RADIUS) continue;
    if (c.mode === "soaked") {
      const points = 200 * 2 ** Math.min(g.combo, 3);
      g.combo += 1;
      addScore(g, points);
      c.mode = "eyes";
      g.popups.push({ x: c.x, y: c.y, text: String(points), t: 1.2 });
      g.events.push({ type: "bonk", x: c.x, y: c.y, points });
      setPhase(g, "snack");
    } else {
      setPhase(g, "dying");
      g.events.push({ type: "die" });
      return;
    }
  }
}

export function step(g: Game, dt: number): void {
  g.time += dt;
  g.phaseT += dt;
  for (const pop of g.popups) pop.t -= dt;
  if (g.popups.length && g.popups[0].t <= 0) g.popups = g.popups.filter((p) => p.t > 0);

  switch (g.phase) {
    case "ready":
      if (g.phaseT >= READY_SECONDS) setPhase(g, "play");
      return;
    case "snack":
      if (g.phaseT >= SNACK_FREEZE) setPhase(g, "play");
      return;
    case "play":
      stepPlay(g, dt);
      return;
    case "dying":
      if (g.phaseT >= DYING_SECONDS) {
        g.lives -= 1;
        if (g.lives <= 0) {
          setPhase(g, "over");
          g.events.push({ type: "over" });
        } else {
          placeActors(g);
          setPhase(g, "ready");
          g.events.push({ type: "ready" });
        }
      }
      return;
    case "clear":
      if (g.phaseT >= CLEAR_SECONDS) {
        g.level += 1;
        loadLevel(g);
        setPhase(g, "ready");
        g.events.push({ type: "ready" });
      }
      return;
    case "over":
      return;
  }
}

/** Ask Vibey to go a way. Held until the maze allows it. */
export function steer(g: Game, d: Dir): void {
  if (d < 0) return;
  g.player.want = d;
}

/** Fixed-step driver: call with wall-clock dt, it slices it into small steps. */
export function run(g: Game, dt: number, slice = 1 / 120): void {
  let left = dt;
  while (left > 1e-9) {
    const s = Math.min(slice, left);
    step(g, s);
    left -= s;
  }
}

export { MAZE_W, MAZE_H, BONUS_TILE, PEN };

/**
 * A simple autopilot: head for the nearest coin by breadth-first search,
 * ignoring the crew entirely. It is what the `?shot` card art and the tests
 * play with. It is not good at the game, which is the point.
 */
export function autopilot(g: Game): Dir {
  const p = g.player;
  const sx = wrapX(Math.round(p.x));
  const sy = Math.round(p.y);
  const start = sy * MAZE_W + sx;
  const prev = new Int16Array(MAZE_W * MAZE_H).fill(-2);
  prev[start] = -1;
  const q = [start];
  for (let head = 0; head < q.length; head++) {
    const i = q[head];
    if (i !== start && g.items[i]) {
      let cur = i;
      while (prev[cur] !== start) cur = prev[cur];
      const cx = cur % MAZE_W;
      const cy = (cur / MAZE_W) | 0;
      if (cy < sy) return 0;
      if (cy > sy) return 2;
      const dx = cx - sx;
      return dx === 1 || dx < -1 ? 1 : 3;
    }
    const x = i % MAZE_W;
    const y = (i / MAZE_W) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = wrapX(x + DX[d]);
      const ny = y + DY[d];
      if (ny < 0 || ny >= MAZE_H) continue;
      const j = ny * MAZE_W + nx;
      if (prev[j] !== -2 || g.maze.cells[j] !== FLOOR) continue;
      prev[j] = i;
      q.push(j);
    }
  }
  return -1;
}
