/**
 * VIBE CUP — the rules.
 *
 * Five-a-side arcade soccer, pure and deterministic: a `Game` is plain data,
 * `step(game, dt)` advances it, and nothing in here touches the DOM, a clock
 * or `Math.random` (the rng is a seeded LCG carried in the state). That is
 * what lets `src/test/vibeCup.test.ts` play whole matches in node and what
 * lets `window.__vibecup.settle()` fast-forward the real page with no GPU.
 *
 * The pitch is in metres, x along the length (team 0 attacks +x), y across,
 * z up. The boards round the pitch are walls, like an indoor five-a-side
 * cage, so there are no throw-ins or corners to stop the game: the ball is
 * always live, which is the arcade part.
 *
 * Possession is a model, not physics: the player who has the ball carries it
 * a stride ahead of their feet. Losing it is a tackle, a pass, a shot or
 * somebody else's slide. A loose ball is real physics again (gravity, bounce,
 * roll, curve) until somebody's feet are under it.
 *
 * Controls are two buttons, the classic layout:
 *   A: with the ball, pass (tap for along the ground, hold for a lofted one).
 *      Without it, switch to the team-mate nearest the ball.
 *   B: with the ball, shoot (hold to charge; a full bar is a SUPER SHOT).
 *      Without it, slide tackle.
 *   Sprint: hold. It drains a stamina bar and comes back when you walk.
 */

// ---------------------------------------------------------------------------
// Pitch and clubs
// ---------------------------------------------------------------------------

export const L = 52; // length, goal line to goal line
export const W = 32; // width, board to board
export const GOAL_W = 7;
export const GOAL_H = 2.44;
export const GOAL_D = 1.8;
export const BOX_L = 8; // the keeper's area, from the goal line
export const BOX_W = 16;
export const BALL_R = 0.22;
/** Real seconds in a match, shown as 0' to 90'. */
export const MATCH_SECONDS = 150;
/** If level at 90', golden goal for this long, then it is a draw. */
export const GOLDEN_SECONDS = 60;

export interface Club {
  id: string;
  name: string;
  short: string;
  emoji: string;
  shirt: string;
  trim: string;
  shorts: string;
  /** Number and outline colour on the shirt. */
  ink: string;
}

/** All original clubs from around the Vibe Verse. */
export const CLUBS: Club[] = [
  { id: "volts", name: "Vibe City Volts", short: "VOLTS", emoji: "⚡", shirt: "#1fd1b0", trim: "#0b3b5c", shorts: "#0b3b5c", ink: "#0b2233" },
  { id: "rovers", name: "Harbour Rovers", short: "ROVERS", emoji: "⚓", shirt: "#ff7a2e", trim: "#ffffff", shorts: "#ffffff", ink: "#ffffff" },
  { id: "comets", name: "Cloud Island Comets", short: "COMETS", emoji: "☄️", shirt: "#8b5cf6", trim: "#f5f3ff", shorts: "#2e1065", ink: "#ffffff" },
  { id: "mechanics", name: "Mort's Mechanics", short: "MORT'S", emoji: "🔧", shirt: "#b91c3c", trim: "#facc15", shorts: "#3b0d18", ink: "#facc15" },
  { id: "pineapples", name: "Palm Court Pineapples", short: "PINES", emoji: "🍍", shirt: "#facc15", trim: "#166534", shorts: "#166534", ink: "#14361f" },
];

export const clubById = (id: string) => CLUBS.find((c) => c.id === id) ?? CLUBS[0];

/** Squad names, so a commentator line can say who scored. */
const SQUADS: Record<string, string[]> = {
  volts: ["Sparky", "Ohm", "Watts", "Jolt", "Flux"],
  rovers: ["Big Sal", "Dizzy", "Marlo", "Anchor", "Gull"],
  comets: ["Nimbus", "Halley", "Wisp", "Nova", "Drizzle"],
  mechanics: ["Mad Mort", "Rusty Ray", "Hubcap Hank", "Linda", "Spanner"],
  pineapples: ["Coco", "Pina", "Mango", "Lime", "Kiwi"],
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Role = "gk" | "df" | "mf" | "fw";
export type TeamId = 0 | 1;
export type Difficulty = "easy" | "normal" | "hard";

export interface Player {
  i: number;
  team: TeamId;
  num: number;
  name: string;
  role: Role;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Facing, radians (0 = +x). */
  face: number;
  /** Formation spot, as if team 0 (attacking +x). */
  fx: number;
  fy: number;
  /** Knocked over: seconds left. */
  stun: number;
  /** Mid slide: seconds left. */
  slide: number;
  /** Cannot touch the ball again yet (just passed or shot). */
  cool: number;
  /** Seconds of a kick animation left. */
  kick: number;
  stamina: number;
  /** Keeper holding the ball, seconds. */
  hold: number;
  /** Running animation phase. */
  stride: number;
}

export interface Ball {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Curve: sideways acceleration per unit speed, decays. */
  spin: number;
  owner: number;
  lastTeam: TeamId;
  lastPlayer: number;
  /** A super shot in flight: draws a flame and keepers struggle. */
  fire: number;
  /** Who a pass in flight is meant for: team-mates let it run past. */
  target: number;
}

export interface Input {
  /** Stick, world space, each -1..1. */
  mx: number;
  my: number;
  a: boolean;
  b: boolean;
  sprint: boolean;
}

export interface Controller {
  team: TeamId;
  /** Which player this controller drives. */
  active: number;
  input: Input;
  prevA: boolean;
  prevB: boolean;
  holdA: number;
  holdB: number;
  /** Shot charge 0..1 while B is held with the ball. */
  charge: number;
  /** The last way the stick pointed, and how long ago: a tap of A often lands as the thumb lets go. */
  aim: number | null;
  aimAge: number;
  /** Seconds this controller's player has been off the edge of the screen. */
  far: number;
}

export type Phase = "kickoff" | "play" | "goal" | "over";

export type GameEvent =
  | { type: "kick"; power: number }
  | { type: "pass" }
  | { type: "shot"; power: number; fire: boolean }
  | { type: "save"; team: TeamId; name: string; caught: boolean }
  | { type: "post" }
  | { type: "bounce"; power: number }
  | { type: "tackle"; team: TeamId; name: string }
  | { type: "goal"; team: TeamId; name: string; fire: boolean; own: boolean }
  | { type: "whistle"; long: boolean }
  | { type: "golden" }
  | { type: "fulltime"; winner: TeamId | null };

export interface Game {
  seed: number;
  t: number;
  phase: Phase;
  phaseT: number;
  /** Real seconds played. */
  clock: number;
  golden: boolean;
  score: [number, number];
  clubs: [Club, Club];
  difficulty: Difficulty;
  players: Player[];
  ball: Ball;
  ctrls: Controller[];
  kickoffTeam: TeamId;
  events: GameEvent[];
  /** Last goal, for the banner. */
  lastGoal: { team: TeamId; name: string; fire: boolean; own: boolean; minute: number } | null;
  /** Screen shake, seconds. */
  shake: number;
  stats: { shots: [number, number]; saves: [number, number]; tackles: [number, number] };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const rnd = (g: Game) => {
  g.seed = (g.seed * 1664525 + 1013904223) >>> 0;
  return g.seed / 4294967296;
};

/** Team 0's formation: keeper, two at the back, one in the middle, one up front. */
const FORMATION: Array<{ role: Role; x: number; y: number; num: number }> = [
  { role: "gk", x: -L / 2 + 1.4, y: 0, num: 1 },
  { role: "df", x: -15, y: -6.5, num: 4 },
  { role: "df", x: -15, y: 6.5, num: 5 },
  { role: "mf", x: -7, y: 0, num: 8 },
  { role: "fw", x: -2.2, y: 3.5, num: 9 },
];

/** World position of a formation spot, for team `t`. */
const spot = (t: TeamId, fx: number, fy: number) => (t === 0 ? { x: fx, y: fy } : { x: -fx, y: -fy });
/** Direction team `t` attacks in: +1 or -1 along x. */
export const attackDir = (t: TeamId) => (t === 0 ? 1 : -1);
const goalX = (t: TeamId) => (attackDir(t) * L) / 2;

export interface NewGameOpts {
  seed?: number;
  clubs?: [string, string];
  difficulty?: Difficulty;
  /** Teams driven by a person: [0] for one player, [0, 1] for versus, [] to watch. */
  humans?: TeamId[];
}

export function newGame(o: NewGameOpts = {}): Game {
  const clubs: [Club, Club] = [clubById(o.clubs?.[0] ?? "volts"), clubById(o.clubs?.[1] ?? "rovers")];
  const players: Player[] = [];
  for (const t of [0, 1] as TeamId[]) {
    const squad = SQUADS[clubs[t].id] ?? SQUADS.volts;
    FORMATION.forEach((f, k) => {
      const p = spot(t, f.x, f.y);
      players.push({
        i: players.length,
        team: t,
        num: f.num,
        name: squad[k],
        role: f.role,
        x: p.x,
        y: p.y,
        vx: 0,
        vy: 0,
        face: t === 0 ? 0 : Math.PI,
        fx: f.x,
        fy: f.y,
        stun: 0,
        slide: 0,
        cool: 0,
        kick: 0,
        stamina: 1,
        hold: 0,
        stride: k * 1.3,
      });
    });
  }
  const g: Game = {
    seed: (o.seed ?? 1) >>> 0 || 1,
    t: 0,
    phase: "kickoff",
    phaseT: 0,
    clock: 0,
    golden: false,
    score: [0, 0],
    clubs,
    difficulty: o.difficulty ?? "normal",
    players,
    ball: { x: 0, y: 0, z: BALL_R, vx: 0, vy: 0, vz: 0, spin: 0, owner: -1, lastTeam: 0, lastPlayer: -1, fire: 0, target: -1 },
    ctrls: (o.humans ?? [0]).map((team) => ({
      team,
      active: forwardOf(players, team),
      input: { mx: 0, my: 0, a: false, b: false, sprint: false },
      prevA: false,
      prevB: false,
      holdA: 0,
      holdB: 0,
      charge: 0,
      aim: null,
      aimAge: 0,
      far: 0,
    })),
    kickoffTeam: 0,
    events: [],
    lastGoal: null,
    shake: 0,
    stats: { shots: [0, 0], saves: [0, 0], tackles: [0, 0] },
  };
  resetKickoff(g, 0);
  g.events.push({ type: "whistle", long: false });
  return g;
}

function forwardOf(players: Player[], team: TeamId) {
  return players.find((p) => p.team === team && p.role === "fw")!.i;
}

function resetKickoff(g: Game, team: TeamId) {
  g.kickoffTeam = team;
  for (const p of g.players) {
    const s = spot(p.team, p.fx, p.fy);
    p.x = s.x;
    p.y = s.y;
    p.vx = p.vy = 0;
    p.stun = p.slide = p.kick = p.hold = 0;
    p.cool = 0.3;
    p.face = p.team === 0 ? 0 : Math.PI;
  }
  // The kicking-off forward stands on the ball.
  const fw = g.players[forwardOf(g.players, team)];
  fw.x = -attackDir(team) * 0.5;
  fw.y = 0;
  Object.assign(g.ball, { x: 0, y: 0, z: BALL_R, vx: 0, vy: 0, vz: 0, spin: 0, owner: fw.i, lastTeam: team, lastPlayer: fw.i, fire: 0, target: -1 });
  // With two people on a side (online), each gets a different player.
  const order = (t: TeamId) => (t === team ? ["fw", "mf", "df", "df"] : ["mf", "fw", "df", "df"]) as Role[];
  const taken = new Set<number>();
  for (const c of g.ctrls) {
    const roles = order(c.team);
    const pick = roles.map((r) => g.players.find((p) => p.team === c.team && p.role === r && !taken.has(p.i))).find(Boolean) ?? g.players.find((p) => p.team === c.team && p.role !== "gk")!;
    c.active = pick.i;
    taken.add(pick.i);
    c.charge = 0;
  }
  g.phase = "kickoff";
  g.phaseT = 0;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const RUN = 6.6;
const SPRINT = 9.2;
const CARRY = 0.93; // speed while carrying, as a fraction
const SLIDE_SPEED = 12;
const SLIDE_TIME = 0.42;
const DIFF = {
  easy: { speed: 0.86, tackle: 0.9, react: 0.55, shoot: 0.7, keeper: 0.8 },
  normal: { speed: 0.95, tackle: 1.6, react: 0.32, shoot: 1, keeper: 1 },
  hard: { speed: 1.07, tackle: 3.2, react: 0.16, shoot: 1.25, keeper: 1.3 },
};

/** Roughly what a phone shows around the ball, in metres: beyond this ellipse your player is off screen. */
export const OFFSCREEN_X = 15;
export const OFFSCREEN_Y = 9.5;

const humanOf = (g: Game, i: number) => g.ctrls.find((c) => c.active === i) ?? null;
const isHumanTeam = (g: Game, t: TeamId) => g.ctrls.some((c) => c.team === t);
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const angDiff = (a: number, b: number) => {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};

export const minute = (g: Game) => Math.min(90, Math.floor((g.clock / MATCH_SECONDS) * 90));
export const clockLabel = (g: Game) => (g.golden ? "GOLDEN GOAL" : `${minute(g)}'`);

// ---------------------------------------------------------------------------
// Touches: pass, shoot, tackle
// ---------------------------------------------------------------------------

function release(g: Game, p: Player) {
  const b = g.ball;
  b.owner = -1;
  b.lastTeam = p.team;
  b.lastPlayer = p.i;
  p.cool = 0.28;
  p.kick = 0.22;
}

/** The team-mate a pass in direction `aim` should go to, or null. */
export function passTarget(g: Game, p: Player, aim: number | null): Player | null {
  let best: Player | null = null;
  let bestScore = -Infinity;
  const dir = aim ?? (attackDir(p.team) > 0 ? 0 : Math.PI);
  for (const q of g.players) {
    if (q.team !== p.team || q === p || q.stun > 0) continue;
    const d = dist(p.x, p.y, q.x, q.y);
    if (d < 3 || d > 30) continue;
    const a = Math.atan2(q.y - p.y, q.x - p.x);
    const off = Math.abs(angDiff(a, dir));
    if (aim !== null && off > 1.35) continue;
    // Open: nobody from the other side near the line of the pass.
    let blocked = 0;
    for (const o of g.players) {
      if (o.team === p.team) continue;
      const t = clamp(((o.x - p.x) * (q.x - p.x) + (o.y - p.y) * (q.y - p.y)) / (d * d), 0, 1);
      const cx = p.x + (q.x - p.x) * t;
      const cy = p.y + (q.y - p.y) * t;
      const od = dist(o.x, o.y, cx, cy);
      if (od < 1.6) blocked += 1.6 - od;
    }
    const forward = ((q.x - p.x) * attackDir(p.team)) / d;
    const score = -off * 2.2 - Math.abs(d - 12) * 0.08 - blocked * 1.4 + forward * 0.6 - (q.role === "gk" ? 3 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = q;
    }
  }
  return best;
}

function doPass(g: Game, p: Player, aim: number | null, lofted: number) {
  const q = passTarget(g, p, aim);
  const b = g.ball;
  let tx: number;
  let ty: number;
  if (q) {
    const d = dist(p.x, p.y, q.x, q.y);
    const lead = d / 16;
    tx = q.x + q.vx * lead;
    ty = q.y + q.vy * lead;
  } else {
    const a = aim ?? p.face;
    tx = p.x + Math.cos(a) * 12;
    ty = p.y + Math.sin(a) * 12;
  }
  const d = Math.max(1, dist(b.x, b.y, tx, ty));
  const a = Math.atan2(ty - b.y, tx - b.x) + (rnd(g) - 0.5) * 0.06;
  if (lofted > 0) {
    // A lob: time of flight from the distance, so it drops on the runner.
    const T = clamp(0.55 + d * 0.035, 0.7, 1.6) * (0.85 + lofted * 0.3);
    const sp = d / T / 1.08;
    b.vx = Math.cos(a) * sp;
    b.vy = Math.sin(a) * sp;
    b.vz = 4.9 * T;
  } else {
    const sp = clamp(7 + d * 0.75, 9, 22);
    b.vx = Math.cos(a) * sp;
    b.vy = Math.sin(a) * sp;
    b.vz = 0.4;
  }
  b.spin = 0;
  b.fire = 0;
  release(g, p);
  b.target = q ? q.i : -1;
  g.events.push({ type: "pass" });
  // Control follows the ball to whoever it was meant for.
  if (q && !humanOf(g, q.i)) for (const c of g.ctrls) if (c.team === p.team && c.active === p.i) c.active = q.i;
}

function doShoot(g: Game, p: Player, charge: number, aimY: number | null, curve: number) {
  const b = g.ball;
  const gx = goalX(p.team);
  const keeper = g.players.find((k) => k.team !== p.team && k.role === "gk")!;
  // Aim: the stick picks the side, otherwise away from the keeper.
  let ty: number;
  if (aimY !== null && Math.abs(aimY) > 0.2) ty = Math.sign(aimY) * (GOAL_W / 2) * (0.55 + Math.abs(aimY) * 0.3);
  else ty = (keeper.y > b.y ? -1 : 1) * GOAL_W * 0.3;
  const d = dist(b.x, b.y, gx, ty);
  const fire = charge >= 0.97;
  const err = (0.03 + d * 0.004) * (1.2 - charge * 0.5) * (fire ? 0.5 : 1);
  ty += (rnd(g) - 0.5) * err * d;
  const a = Math.atan2(ty - b.y, gx - b.x);
  const sp = fire ? 31 : 15 + charge * 13;
  b.vx = Math.cos(a) * sp;
  b.vy = Math.sin(a) * sp;
  // Loft: enough to clear a body, and a charged one from close in rises over the bar.
  const rise = (2.2 + charge * 3.4) * (fire ? 0.55 : 1);
  b.vz = rise * clamp(d / 14, 0.5, 1.4) + (rnd(g) - 0.5) * 0.8;
  b.spin = clamp(curve, -1, 1) * 0.55;
  b.fire = fire ? 1 : 0;
  release(g, p);
  b.target = -1;
  p.kick = 0.32;
  g.stats.shots[p.team]++;
  g.events.push({ type: "shot", power: sp, fire });
  if (fire) g.shake = Math.max(g.shake, 0.25);
}

function startSlide(p: Player, dir: number) {
  if (p.slide > 0 || p.stun > 0) return;
  p.slide = SLIDE_TIME;
  p.face = dir;
  p.vx = Math.cos(dir) * SLIDE_SPEED;
  p.vy = Math.sin(dir) * SLIDE_SPEED;
}

/** `p` takes the ball off whoever has it. */
function steal(g: Game, p: Player, knock: boolean) {
  const b = g.ball;
  const victim = b.owner >= 0 ? g.players[b.owner] : null;
  if (victim) {
    victim.cool = 0.5;
    if (knock) victim.stun = 0.75;
  }
  g.stats.tackles[p.team]++;
  g.events.push({ type: "tackle", team: p.team, name: p.name });
  if (p.slide > 0) {
    // A slide pokes it on, loose, the way the slide was going.
    b.owner = -1;
    b.vx = Math.cos(p.face) * 7 + p.vx * 0.2;
    b.vy = Math.sin(p.face) * 7 + p.vy * 0.2;
    b.vz = 1;
    b.lastTeam = p.team;
    b.lastPlayer = p.i;
    p.cool = 0.15;
  } else {
    gain(g, p);
  }
}

function gain(g: Game, p: Player) {
  const b = g.ball;
  const had = b.owner >= 0 ? g.players[b.owner].team : b.lastTeam;
  b.owner = p.i;
  b.lastTeam = p.team;
  b.lastPlayer = p.i;
  b.target = -1;
  b.spin = 0;
  b.fire = 0;
  b.vz = 0;
  b.z = BALL_R;
  // The person on that team is now driving whoever has it. With two people on
  // a side, it is whichever of them was nearer, and only if nobody drives it already.
  if (p.role !== "gk" && !humanOf(g, p.i)) {
    let best: Controller | null = null;
    let bd = Infinity;
    for (const c of g.ctrls) {
      if (c.team !== p.team) continue;
      const q = g.players[c.active];
      const d = dist(q.x, q.y, p.x, p.y);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    if (best) best.active = p.i;
  }
  void had;
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

export function step(g: Game, dt: number) {
  dt = Math.min(dt, 0.05);
  g.t += dt;
  g.phaseT += dt;
  g.shake = Math.max(0, g.shake - dt);
  const b = g.ball;

  if (g.phase === "goal") {
    physics(g, dt, true);
    celebrate(g, dt);
    if (g.phaseT > 3) {
      if (g.golden) {
        endMatch(g);
      } else {
        resetKickoff(g, g.lastGoal!.team === 0 ? 1 : 0);
        g.events.push({ type: "whistle", long: false });
      }
    }
    return;
  }
  if (g.phase === "over") {
    celebrate(g, dt);
    physics(g, dt, true);
    return;
  }
  if (g.phase === "kickoff") {
    // Everybody holds still for a moment; the kicker may go as soon as they like.
    readControllers(g, dt, true);
    if (g.phaseT > 1.2 || b.owner < 0 || g.players[b.owner].i !== forwardOf(g.players, g.kickoffTeam)) {
      g.phase = "play";
      g.phaseT = 0;
    }
    if (g.phaseT > 1.0 && !isHumanTeam(g, g.kickoffTeam) && b.owner >= 0) {
      const p = g.players[b.owner];
      doPass(g, p, attackDir(p.team) > 0 ? Math.PI : 0, 0);
      g.phase = "play";
      g.phaseT = 0;
    }
    moveBodies(g, dt, true);
    carry(g);
    return;
  }

  // ---- Play -----------------------------------------------------------------
  g.clock += dt;
  if (!g.golden && g.clock >= MATCH_SECONDS) {
    if (g.score[0] === g.score[1]) {
      g.golden = true;
      g.events.push({ type: "golden" }, { type: "whistle", long: false });
    } else {
      endMatch(g);
      return;
    }
  } else if (g.golden && g.clock >= MATCH_SECONDS + GOLDEN_SECONDS) {
    endMatch(g);
    return;
  }

  readControllers(g, dt, false);
  think(g, dt);
  moveBodies(g, dt, false);
  touches(g);
  carry(g);
  physics(g, dt, false);
}

function endMatch(g: Game) {
  g.phase = "over";
  g.phaseT = 0;
  const winner: TeamId | null = g.score[0] > g.score[1] ? 0 : g.score[1] > g.score[0] ? 1 : null;
  g.events.push({ type: "whistle", long: true }, { type: "fulltime", winner });
}

function readControllers(g: Game, dt: number, kickoff: boolean) {
  const b = g.ball;
  for (const c of g.ctrls) {
    const p = g.players[c.active];
    const inp = c.input;
    const pressA = inp.a && !c.prevA;
    const relA = !inp.a && c.prevA;
    const pressB = inp.b && !c.prevB;
    const relB = !inp.b && c.prevB;
    c.holdA = inp.a ? c.holdA + dt : c.holdA;
    c.holdB = inp.b ? c.holdB + dt : c.holdB;
    const has = b.owner === p.i;
    const live = Math.hypot(inp.mx, inp.my) > 0.25 ? Math.atan2(inp.my, inp.mx) : null;
    if (live !== null) {
      c.aim = live;
      c.aimAge = 0;
    } else c.aimAge += dt;
    const stick = live ?? (c.aimAge < 0.25 ? c.aim : null);
    if (has) {
      if (inp.b) c.charge = Math.min(1, c.holdB / 0.75);
      if (relA) doPass(g, p, stick, c.holdA > 0.24 ? Math.min(1, (c.holdA - 0.24) / 0.5) : 0);
      else if (relB) {
        // The stick across the goal picks a side; across the run it curls it.
        const ad = attackDir(p.team);
        doShoot(g, p, c.charge, stick === null ? null : inp.my * ad * ad, -inp.my * ad * 0.6);
      }
    } else if (!kickoff) {
      if (pressA) {
        // Switch to whoever on the team is nearest the ball.
        let best = -1;
        let bd = Infinity;
        for (const q of g.players) {
          if (q.team !== c.team || q.i === c.active || q.role === "gk" || humanOf(g, q.i)) continue;
          const d = dist(q.x, q.y, b.x, b.y);
          if (d < bd) {
            bd = d;
            best = q.i;
          }
        }
        if (best >= 0) c.active = best;
      }
      if (pressB) startSlide(p, stick ?? p.face);
    }
    // Never lose your player off the screen: the camera follows the ball, so a
    // person left behind by play is handed the free team-mate nearest to it.
    if (!kickoff && !has && c.active === p.i) {
      const ox = (p.x - b.x) / OFFSCREEN_X;
      const oy = (p.y - b.y) / OFFSCREEN_Y;
      c.far = ox * ox + oy * oy > 1 ? c.far + dt : 0;
      if (c.far > 0.45) {
        c.far = 0;
        let best = -1;
        let bd = dist(p.x, p.y, b.x, b.y);
        for (const q of g.players) {
          if (q.team !== c.team || q.role === "gk" || q.stun > 0 || humanOf(g, q.i)) continue;
          const d = dist(q.x, q.y, b.x, b.y);
          if (d < bd) {
            bd = d;
            best = q.i;
          }
        }
        if (best >= 0) c.active = best;
      }
    } else c.far = 0;
    if (!inp.a) c.holdA = 0;
    if (!inp.b) {
      c.holdB = 0;
      if (!has) c.charge = 0;
    }
    if (relB && has) c.charge = 0;
    c.prevA = inp.a;
    c.prevB = inp.b;
    if (b.owner !== c.active && !inp.b) c.charge = 0;
  }
}

/** The computer's half of every team. */
function think(g: Game, dt: number) {
  const b = g.ball;
  const D = DIFF[g.difficulty];
  const carrier = b.owner >= 0 ? g.players[b.owner] : null;
  for (const t of [0, 1] as TeamId[]) {
    const ad = attackDir(t);
    const mine = g.players.filter((p) => p.team === t);
    const ours = carrier?.team === t;
    // Where the ball will be soon, for chasing a loose one.
    const lead = carrier ? 0.1 : 0.35;
    const bx = b.x + b.vx * lead;
    const by = b.y + b.vy * lead;
    // The chaser: the outfielder nearest the ball, unless a person is driving one.
    const ctrl = g.ctrls.find((c) => c.team === t);
    const outfield = mine.filter((p) => p.role !== "gk" && p.stun <= 0);
    outfield.sort((p, q) => dist(p.x, p.y, bx, by) - dist(q.x, q.y, bx, by));
    let chaser: Player | undefined = outfield[0];
    if (chaser && humanOf(g, chaser.i)) chaser = undefined; // the person chases if they want to
    // A person's team still gets an AI presser when the people are far away.
    if (ctrl && chaser === undefined) {
      const free = outfield.find((p) => !humanOf(g, p.i));
      const near = g.ctrls.some((c) => c.team === t && dist(g.players[c.active].x, g.players[c.active].y, b.x, b.y) <= 9);
      if (free && !near) chaser = free;
    }
    const cover = outfield.find((p) => p !== chaser && !humanOf(g, p.i));
    // Defending: everybody else picks up a man, most dangerous first, goal side.
    const marks = new Map<number, Player>();
    if (!ours) {
      const own = -goalX(t);
      const threats = g.players
        .filter((o) => o.team !== t && o.role !== "gk" && o !== carrier && dist(o.x, o.y, own, 0) < 24 && dist(o.x, o.y, own, 0) < dist(b.x, b.y, own, 0) + 2)
        .sort((a, z) => dist(a.x, a.y, own, 0) - dist(z.x, z.y, own, 0));
      const free = mine.filter((p) => p.role !== "gk" && p !== chaser && p !== cover && !humanOf(g, p.i) && (p.role !== "fw" || dist(p.x, p.y, own, 0) < L * 0.45));
      for (const o of threats.slice(0, 2)) {
        let best: Player | null = null;
        let bd = Infinity;
        for (const p of free) {
          if (marks.has(p.i)) continue;
          const d = dist(p.x, p.y, o.x, o.y);
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
        if (best) marks.set(best.i, o);
      }
    }

    for (const p of mine) {
      if (humanOf(g, p.i) || p.stun > 0 || p.slide > 0) continue;
      let tx: number;
      let ty: number;
      let speed = RUN * D.speed;
      if (p.role === "gk") {
        keeperThink(g, p, dt);
        continue;
      }
      if (carrier === p) {
        carrierThink(g, p, dt);
        continue;
      }
      if (p === chaser && !ours) {
        tx = bx;
        ty = by;
        speed = SPRINT * D.speed;
        // Press the carrier from the goal side, and have a go when close.
        if (carrier) {
          const own = -goalX(t);
          const gx = own - carrier.x;
          const gy = -carrier.y;
          const gl = Math.hypot(gx, gy) || 1;
          tx = carrier.x + (gx / gl) * 0.8 + carrier.vx * 0.2;
          ty = carrier.y + (gy / gl) * 0.8 + carrier.vy * 0.2;
          const d = dist(p.x, p.y, carrier.x, carrier.y);
          if (d < 1.15 && p.cool <= 0 && rnd(g) < D.tackle * dt) {
            if (rnd(g) < 0.55) steal(g, p, false);
            else p.cool = 0.6; // missed
          } else if (d < 3.2 && d > 1.6 && p.cool <= 0 && rnd(g) < D.tackle * 0.22 * dt) {
            startSlide(p, Math.atan2(carrier.y + carrier.vy * 0.25 - p.y, carrier.x + carrier.vx * 0.25 - p.x));
            p.cool = 1.2;
          }
        }
      } else if (p === cover && !ours) {
        // Goal-side of the ball, tighter the nearer it is to our goal.
        const own = -goalX(t);
        const danger = clamp(1 - dist(b.x, b.y, own, 0) / 30, 0, 1);
        if (danger > 0.7) {
          // Close to goal: stand in the shooting lane, a couple of strides off the ball.
          const gx = own - b.x;
          const gy = -b.y;
          const gl = Math.hypot(gx, gy) || 1;
          const off = Math.min(gl * 0.5, 3);
          tx = b.x + (gx / gl) * off;
          ty = b.y + (gy / gl) * off;
          speed = SPRINT * D.speed;
        } else {
          tx = b.x + (own - b.x) * 0.35;
          ty = b.y * 0.6;
        }
      } else if (marks.has(p.i) && !ours) {
        // Marking: between the man and our goal, a stride off him, reading where he is going.
        const o = marks.get(p.i)!;
        const own = -goalX(t);
        const mx = o.x + o.vx * 0.3;
        const my = o.y + o.vy * 0.3;
        const gx = own - mx;
        const gy = -my;
        const gl = Math.hypot(gx, gy) || 1;
        const gap = clamp(dist(mx, my, b.x, b.y) * 0.12, 1.2, 3.5);
        tx = mx + (gx / gl) * gap;
        ty = my + (gy / gl) * gap;
        // Never so tight on a man that the middle opens up: lean towards the line from the ball to goal.
        const lx = own - b.x;
        const ly = -b.y;
        const ll = Math.hypot(lx, ly) || 1;
        const along = clamp(((tx - b.x) * lx + (ty - b.y) * ly) / ll, 0, ll);
        const px = b.x + (lx / ll) * along;
        const py = b.y + (ly / ll) * along;
        tx += (px - tx) * 0.45;
        ty += (py - ty) * 0.45;
        speed = (dist(p.x, p.y, tx, ty) > 3 ? SPRINT : RUN) * D.speed;
        if (!carrier && dist(p.x, p.y, b.x, b.y) < 4) {
          tx = bx;
          ty = by;
          speed = SPRINT * D.speed;
        }
      } else if (ours && carrier) {
        // Attacking without the ball: find a pocket of space the carrier can reach.
        const sp = findSpace(g, p, carrier);
        tx = sp.x;
        ty = sp.y;
        speed = (dist(p.x, p.y, tx, ty) > 4 ? SPRINT * 0.95 : RUN) * D.speed;
      } else {
        // Shape: the formation spot, pushed up or back with the ball, and
        // up the pitch when we have it.
        const s = spot(t, p.fx, p.fy);
        const push = ours ? 9 : -1;
        tx = clamp(s.x + ad * push + b.x * 0.45, -L / 2 + 3, L / 2 - 3);
        ty = clamp(s.y * 1.1 + b.y * 0.35, -W / 2 + 1.5, W / 2 - 1.5);
        if (ours && p.role === "fw") tx = clamp(b.x + ad * 8, -L / 2 + 4, L / 2 - 4);
        // When it is loose and near, attack it anyway.
        if (!carrier && dist(p.x, p.y, b.x, b.y) < 4) {
          tx = bx;
          ty = by;
          speed = SPRINT * D.speed;
        }
      }
      steer(p, tx, ty, speed, dt);
    }
  }
}

/** How far the nearest opponent is from a spot, capped at 6 m. */
function spaceAt(g: Game, team: TeamId, x: number, y: number) {
  let m = 6;
  for (const o of g.players) if (o.team !== team) m = Math.min(m, dist(o.x, o.y, x, y));
  return m;
}
const openness = (g: Game, p: Player) => spaceAt(g, p.team, p.x, p.y);

/** How much the other side gets in the way of a ball from `p` to (tx, ty). */
function laneBlock(g: Game, p: Player, tx: number, ty: number) {
  const d = Math.max(1, dist(p.x, p.y, tx, ty));
  let blocked = 0;
  for (const o of g.players) {
    if (o.team === p.team) continue;
    const t = clamp(((o.x - p.x) * (tx - p.x) + (o.y - p.y) * (ty - p.y)) / (d * d), 0, 1);
    const od = dist(o.x, o.y, p.x + (tx - p.x) * t, p.y + (ty - p.y) * t);
    if (od < 1.8) blocked += 1.8 - od;
  }
  return blocked;
}

/**
 * Where a team-mate without the ball should run: an ideal spot for their
 * role relative to the carrier, then the best of a handful of nearby spots
 * by how much space there is, whether the pass is on, and not crowding
 * anybody. Staying near where they already are keeps it from flickering.
 */
function findSpace(g: Game, p: Player, carrier: Player) {
  const ad = attackDir(p.team);
  const gx = goalX(p.team);
  const side = p.fy >= 0 ? 1 : -1;
  let bx: number;
  let by: number;
  if (p.role === "fw") {
    bx = Math.min((gx - carrier.x) * ad, 13) * ad + carrier.x;
    bx = clamp(bx, -L / 2 + 5, L / 2 - 5);
    by = clamp(carrier.y * 0.3 + side * 4, -9, 9);
  } else if (p.role === "mf") {
    bx = carrier.x + ad * 5;
    by = carrier.y + (carrier.y > 0 ? -7 : 7);
  } else {
    bx = carrier.x - ad * 7;
    by = side * 9 + carrier.y * 0.25;
  }
  let best = { x: bx, y: by };
  let bs = -Infinity;
  for (const [ox, oy] of [[0, 0], [0, 4], [0, -4], [3, 0], [-3, 0], [3, 4], [3, -4], [-3, 4], [-3, -4]]) {
    const x = clamp(bx + ox * ad, -L / 2 + 2.5, L / 2 - 2.5);
    const y = clamp(by + oy, -W / 2 + 1.5, W / 2 - 1.5);
    let crowd = 0;
    for (const q of g.players) if (q.team === p.team && q !== p) crowd += Math.max(0, 5 - dist(q.x, q.y, x, y));
    const score =
      spaceAt(g, p.team, x, y) * 1.0 -
      laneBlock(g, carrier, x, y) * 1.2 -
      crowd * 0.5 -
      dist(x, y, bx, by) * 0.12 -
      dist(x, y, p.x, p.y) * 0.06 +
      ((x - carrier.x) * ad > 0 ? 0.6 : 0);
    if (score > bs) {
      bs = score;
      best = { x, y };
    }
  }
  return best;
}

function carrierThink(g: Game, p: Player, dt: number) {
  const D = DIFF[g.difficulty];
  const ad = attackDir(p.team);
  const gx = goalX(p.team);
  const toGoal = dist(p.x, p.y, gx, 0);
  // Pressure: opponents near and in front.
  let press = 0;
  let threatY = 0;
  for (const o of g.players) {
    if (o.team === p.team || o.role === "gk") continue;
    const d = dist(p.x, p.y, o.x, o.y);
    const ahead = (o.x - p.x) * ad;
    if (d < 4 && ahead > -1) {
      press += 4 - d;
      threatY += (o.y - p.y) * (4 - d);
    }
  }
  // Decide, a few times a second.
  if (p.cool <= 0 && rnd(g) < dt / D.react) {
    const q = passTarget(g, p, null);
    const lane = laneBlock(g, p, gx, 0);
    // A real chance, not a hopeful punt that hands the other keeper the ball.
    const range = 12 + D.shoot * 3 + (p.role === "fw" ? 2 : 0);
    const inRange = Math.abs(p.y) < 10 && (toGoal < range || (toGoal < 21 && lane < 0.4 && rnd(g) < 0.25));
    // A team-mate in a better spot: clearly nearer goal, unmarked, and the pass is on.
    // Running into open grass beats a pass; only look up when somebody closes in.
    const better =
      q &&
      (press > 0.6 || lane > 1) &&
      dist(q.x, q.y, gx, 0) < toGoal - 5 &&
      openness(g, q) > 2.5 &&
      laneBlock(g, p, q.x, q.y) < 0.6;
    if (inRange && (lane < 1.8 || toGoal < 9 || !better)) {
      // Aim for the side the keeper is not covering.
      const keeper = g.players.find((k) => k.team !== p.team && k.role === "gk")!;
      const side = keeper.y > 0.3 ? -1 : keeper.y < -0.3 ? 1 : rnd(g) < 0.5 ? -1 : 1;
      doShoot(g, p, 0.45 + rnd(g) * 0.5, side, (rnd(g) - 0.5) * 0.8);
      return;
    }
    if (q && (press > 2.2 || (press > 0.8 && rnd(g) < 0.5) || better || (p.role === "df" && rnd(g) < 0.5))) {
      doPass(g, p, Math.atan2(q.y - p.y, q.x - p.x), dist(p.x, p.y, q.x, q.y) > 18 ? 0.5 : 0);
      return;
    }
  }
  // Dribble at goal, slipping away from whoever is closing in.
  const ty = clamp(-threatY * 0.9 + p.y * 0.3, -W / 2 + 2, W / 2 - 2);
  steer(p, gx, ty, SPRINT * D.speed * 0.9, dt);
}

function keeperThink(g: Game, p: Player, dt: number) {
  const b = g.ball;
  const D = DIFF[g.difficulty];
  const own = -goalX(p.team);
  const out = attackDir(p.team);
  if (b.owner === p.i) {
    // Hold it a moment, then roll it out to somebody open.
    p.hold += dt;
    steer(p, own + out * 2.5, clamp(p.y, -3, 3), RUN * 0.5, dt);
    if (p.hold > 1.1) {
      const q = passTarget(g, p, null);
      doPass(g, p, q ? Math.atan2(q.y - p.y, q.x - p.x) : out > 0 ? 0 : Math.PI, q && dist(p.x, p.y, q.x, q.y) > 16 ? 0.7 : 0);
      p.hold = 0;
      p.cool = 0.8;
    }
    return;
  }
  p.hold = 0;
  // Stand on the line between the ball and the middle of the goal.
  const bx = b.x - own;
  const by = b.y;
  const bl = Math.hypot(bx, by) || 1;
  const depth = clamp(bl * 0.12, 0.6, 2.4);
  let tx = own + (bx / bl) * depth;
  let ty = clamp((by / bl) * depth * 2.2, -GOAL_W / 2 + 0.4, GOAL_W / 2 - 0.4);
  // A shot coming: get across to where it will cross the line.
  if (b.owner < 0 && Math.sign(b.vx) === -out && Math.abs(b.vx) > 4) {
    const T = (own - b.x) / b.vx;
    if (T > 0 && T < 1.4) {
      const cy = b.y + b.vy * T;
      ty = clamp(cy, -GOAL_W / 2 - 0.3, GOAL_W / 2 + 0.3);
      tx = own + out * 0.6;
      if (T < 0.4 && Math.abs(cy - p.y) > 0.9 && p.slide <= 0 && p.cool <= 0) {
        // Dive.
        startSlide(p, Math.atan2(cy - p.y, 0) * 1);
        p.slide = 0.5;
        p.vx = 0;
        p.vy = Math.sign(cy - p.y) * 8.5 * D.keeper;
        p.cool = 0.9;
        return;
      }
    }
  }
  // Come out for a loose ball in the area.
  const inBox = Math.abs(b.x - own) < BOX_L && Math.abs(b.y) < BOX_W / 2;
  if (b.owner < 0 && inBox && Math.hypot(b.vx, b.vy) < 9) {
    tx = b.x;
    ty = b.y;
  }
  const carrier = b.owner >= 0 ? g.players[b.owner] : null;
  if (carrier && carrier.team !== p.team && dist(carrier.x, carrier.y, own, 0) < 7) {
    // Narrow the angle.
    tx = own + (carrier.x - own) * 0.35;
    ty = carrier.y * 0.35;
  }
  steer(p, tx, ty, SPRINT * 0.78 * D.keeper, dt);
}

function steer(p: Player, tx: number, ty: number, speed: number, dt: number) {
  const dx = tx - p.x;
  const dy = ty - p.y;
  const d = Math.hypot(dx, dy);
  const want = d > 0.08 ? Math.min(speed, d * 3.5) : 0;
  const wx = d > 0.08 ? (dx / d) * want : 0;
  const wy = d > 0.08 ? (dy / d) * want : 0;
  const k = Math.min(1, dt * 8);
  p.vx += (wx - p.vx) * k;
  p.vy += (wy - p.vy) * k;
}

function moveBodies(g: Game, dt: number, kickoff: boolean) {
  const b = g.ball;
  for (const c of g.ctrls) {
    const p = g.players[c.active];
    if (p.stun > 0 || p.slide > 0) continue;
    const inp = c.input;
    const mag = Math.min(1, Math.hypot(inp.mx, inp.my));
    const sprinting = inp.sprint && p.stamina > 0.05 && mag > 0.3;
    let speed = (sprinting ? SPRINT : RUN) * mag * (b.owner === p.i ? CARRY : 1);
    if (kickoff && b.owner !== p.i) speed = 0;
    const dir = Math.atan2(inp.my, inp.mx);
    const wx = mag > 0.05 ? Math.cos(dir) * speed : 0;
    const wy = mag > 0.05 ? Math.sin(dir) * speed : 0;
    const k = Math.min(1, dt * 10);
    p.vx += (wx - p.vx) * k;
    p.vy += (wy - p.vy) * k;
    p.stamina = clamp(p.stamina + (sprinting ? -0.32 : 0.18) * dt, 0, 1);
  }
  for (const p of g.players) {
    p.cool -= dt;
    p.kick = Math.max(0, p.kick - dt);
    if (p.stun > 0) {
      p.stun -= dt;
      p.vx *= 0.85;
      p.vy *= 0.85;
    }
    if (p.slide > 0) {
      p.slide -= dt;
      const f = Math.pow(0.08, dt);
      p.vx *= f;
      p.vy *= f;
      if (p.slide <= 0) p.stun = Math.max(p.stun, p.role === "gk" ? 0.35 : 0.3);
    }
    if (kickoff && !humanOf(g, p.i) && b.owner !== p.i) {
      p.vx *= 0.5;
      p.vy *= 0.5;
    }
    // Bodies push apart.
    for (const q of g.players) {
      if (q.i <= p.i) continue;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.7 && d > 1e-4) {
        const push = (0.7 - d) / 2;
        p.x -= (dx / d) * push;
        p.y -= (dy / d) * push;
        q.x += (dx / d) * push;
        q.y += (dy / d) * push;
      }
    }
    p.x = clamp(p.x + p.vx * dt, -L / 2 - (p.role === "gk" ? 0.5 : 0), L / 2 + (p.role === "gk" ? 0.5 : 0));
    p.y = clamp(p.y + p.vy * dt, -W / 2 + 0.4, W / 2 - 0.4);
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > 0.3 && p.slide <= 0 && p.stun <= 0) p.face += angDiff(Math.atan2(p.vy, p.vx), p.face) * Math.min(1, dt * 12);
    else if (sp <= 0.3 && b.owner !== p.i && p.stun <= 0) p.face += angDiff(Math.atan2(b.y - p.y, b.x - p.x), p.face) * Math.min(1, dt * 4);
    p.stride += dt * (1.5 + sp * 1.6);
  }
  // Kick-off: nobody but the kicker in the centre circle or the other half.
  if (kickoff) {
    for (const p of g.players) {
      if (b.owner === p.i) continue;
      const ad = attackDir(p.team);
      if (p.x * ad > -0.3) p.x = -ad * 0.3;
      if (p.team !== g.kickoffTeam && Math.hypot(p.x, p.y) < 4.5) {
        const d = Math.hypot(p.x, p.y) || 1;
        p.x = (p.x / d) * 4.5;
        p.y = (p.y / d) * 4.5;
      }
    }
  }
}

/** Feet meet ball: pick-ups, slides, blocks, headers, keeper saves. */
function touches(g: Game) {
  const b = g.ball;
  const D = DIFF[g.difficulty];
  if (b.owner >= 0) {
    // A slide into the carrier.
    const c = g.players[b.owner];
    for (const p of g.players) {
      if (p.team === c.team || p.slide <= 0 || c.role === "gk") continue;
      if (dist(p.x, p.y, b.x, b.y) < 0.95 || dist(p.x, p.y, c.x, c.y) < 0.85) {
        steal(g, p, true);
        return;
      }
    }
    return;
  }
  const sp = Math.hypot(b.vx, b.vy);
  let best: Player | null = null;
  let bd = Infinity;
  for (const p of g.players) {
    if (p.cool > 0 || p.stun > 0) continue;
    // A pass meant for somebody else on the team runs on past.
    if (b.target >= 0 && p.team === b.lastTeam && p.i !== b.target && sp > 5) continue;
    const d = dist(p.x, p.y, b.x, b.y);
    const gk = p.role === "gk";
    const reach = gk ? (p.slide > 0 ? 1.85 : 1.2) : p.slide > 0 ? 1.0 : 0.75;
    const high = gk ? 2.7 : 0.75;
    if (d < reach && b.z < high + (p.slide > 0 ? -0.3 : 0) && d < bd) {
      best = p;
      bd = d;
    }
    // A header: a dropping ball at head height.
    if (!gk && d < 0.8 && b.z > 1.2 && b.z < 2.3 && b.vz < 2 && p.cool <= 0) {
      header(g, p);
      return;
    }
  }
  if (!best) return;
  const p = best;
  if (p.role === "gk") {
    const ownGoal = -goalX(p.team);
    const towardGoal = Math.sign(b.vx) === Math.sign(ownGoal) && sp > 7;
    if (towardGoal) {
      // Shot-stopping: harder ones get through or are parried, not caught.
      const fire = b.fire > 0;
      const chance = (fire ? 0.35 : sp > 24 ? 0.55 : sp > 18 ? 0.75 : 0.92) * D.keeper * (isHumanTeam(g, p.team) ? 1 : 1);
      if (rnd(g) < chance) {
        const caught = sp < 17 && !fire && rnd(g) < 0.7;
        g.stats.saves[p.team]++;
        g.events.push({ type: "save", team: p.team, name: p.name, caught });
        if (caught) gain(g, p);
        else {
          // Parried away to the side.
          const side = b.y >= p.y ? 1 : -1;
          b.vx = -b.vx * 0.3;
          b.vy = side * (5 + rnd(g) * 4);
          b.vz = 2 + rnd(g) * 2;
          b.fire = 0;
          b.lastTeam = p.team;
          p.cool = 0.5;
        }
      } else {
        p.cool = 0.6; // beaten
      }
      return;
    }
    gain(g, p);
    return;
  }
  // An outfielder: a slow ball is taken; a fast one is a block or a deflection.
  if (sp < 16 || rnd(g) < 0.35) {
    if (b.lastTeam !== p.team && b.owner < 0 && sp > 12) {
      // Block.
      b.vx *= -0.35;
      b.vy *= -0.35;
      b.vz = 1.5;
      b.fire = 0;
      b.lastTeam = p.team;
      p.cool = 0.25;
      g.events.push({ type: "bounce", power: sp });
      return;
    }
    gain(g, p);
  }
}

function header(g: Game, p: Player) {
  const b = g.ball;
  const gx = goalX(p.team);
  const near = Math.abs(gx - p.x) < 16;
  const ty = near ? (rnd(g) - 0.5) * GOAL_W * 0.9 : p.y + (rnd(g) - 0.5) * 8;
  const tx = near ? gx : p.x + attackDir(p.team) * 12;
  const a = Math.atan2(ty - b.y, tx - b.x);
  const sp = near ? 15 : 10;
  b.vx = Math.cos(a) * sp;
  b.vy = Math.sin(a) * sp;
  b.vz = near ? 0.5 : 3;
  b.fire = 0;
  b.spin = 0;
  release(g, p);
  if (near) {
    g.stats.shots[p.team]++;
    g.events.push({ type: "shot", power: sp, fire: false });
  } else g.events.push({ type: "kick", power: sp });
}

/** The carrier's ball sits a stride ahead. */
function carry(g: Game) {
  const b = g.ball;
  if (b.owner < 0) return;
  const p = g.players[b.owner];
  const sp = Math.hypot(p.vx, p.vy);
  const ahead = p.role === "gk" ? 0.45 : 0.55 + Math.min(0.35, sp * 0.04) + Math.sin(p.stride * 2) * 0.06;
  b.x = clamp(p.x + Math.cos(p.face) * ahead, -L / 2 - 0.5, L / 2 + 0.5);
  b.y = clamp(p.y + Math.sin(p.face) * ahead, -W / 2 + BALL_R, W / 2 - BALL_R);
  b.z = p.role === "gk" ? 1 : BALL_R;
  b.vx = p.vx;
  b.vy = p.vy;
  b.vz = 0;
}

function physics(g: Game, dt: number, dead: boolean) {
  const b = g.ball;
  if (b.owner >= 0) return;
  const n = 3;
  const h = dt / n;
  for (let k = 0; k < n; k++) {
    // Curve: sideways, proportional to speed.
    if (Math.abs(b.spin) > 0.01) {
      const sp = Math.hypot(b.vx, b.vy) || 1;
      b.vx += (-b.vy / sp) * b.spin * sp * h;
      b.vy += (b.vx / sp) * b.spin * sp * h;
      b.spin *= Math.pow(0.5, h);
    }
    b.vz -= 9.8 * h;
    b.x += b.vx * h;
    b.y += b.vy * h;
    b.z += b.vz * h;
    if (b.z < BALL_R) {
      b.z = BALL_R;
      if (b.vz < -1.5) {
        b.vz = -b.vz * 0.5;
        if (!dead) g.events.push({ type: "bounce", power: Math.abs(b.vz) });
      } else b.vz = 0;
      const f = Math.pow(0.42, h);
      b.vx *= f;
      b.vy *= f;
    } else {
      const f = Math.pow(0.9, h);
      b.vx *= f;
      b.vy *= f;
    }
    b.fire = Math.hypot(b.vx, b.vy) > 18 ? b.fire : 0;

    // Goals: across the line, between the posts, under the bar.
    const over = Math.abs(b.x) > L / 2;
    const mouth = Math.abs(b.y) < GOAL_W / 2 - BALL_R;
    const inNet = over && Math.abs(b.y) < GOAL_W / 2 + 0.25 && b.z < GOAL_H;
    if (inNet) {
      if (mouth && !dead && g.phase === "play") scoreGoal(g, b.x > 0 ? 0 : 1);
      if (Math.abs(b.y) > GOAL_W / 2 - BALL_R) {
        b.y = Math.sign(b.y) * (GOAL_W / 2 - BALL_R);
        b.vy *= -0.3;
      }
      // The net.
      if (Math.abs(b.x) > L / 2 + GOAL_D) {
        b.x = Math.sign(b.x) * (L / 2 + GOAL_D);
        b.vx *= -0.15;
        b.vy *= 0.3;
      }
      if (b.z > GOAL_H - BALL_R) b.vz = -Math.abs(b.vz) * 0.3;
      continue;
    }
    // Posts and bar.
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const px = (sx * L) / 2;
        const py = (sy * GOAL_W) / 2;
        const dx = b.x - px;
        const dy = b.y - py;
        const d = Math.hypot(dx, dy);
        if (d < BALL_R + 0.06 && b.z < GOAL_H) {
          const nx = dx / (d || 1);
          const ny = dy / (d || 1);
          const vn = b.vx * nx + b.vy * ny;
          if (vn < 0) {
            b.vx -= 1.75 * vn * nx;
            b.vy -= 1.75 * vn * ny;
            if (!dead) g.events.push({ type: "post" });
            g.shake = Math.max(g.shake, 0.15);
          }
          b.x = px + nx * (BALL_R + 0.07);
          b.y = py + ny * (BALL_R + 0.07);
        }
      }
      // Crossbar: a ball arriving at the line at bar height.
      const crossing = Math.abs(b.x - (sx * L) / 2) < 0.2 && Math.abs(b.y) < GOAL_W / 2 && Math.abs(b.z - GOAL_H) < BALL_R + 0.05;
      if (crossing && Math.sign(b.vx) === sx) {
        b.vx *= -0.5;
        b.vz = b.z > GOAL_H ? Math.abs(b.vz) * 0.5 + 1 : -Math.abs(b.vz) * 0.5;
        if (!dead) g.events.push({ type: "post" });
        g.shake = Math.max(g.shake, 0.15);
      }
    }
    // The boards. A ball over the end line outside the goal comes back off them.
    if (Math.abs(b.x) > L / 2 + 0.6 && !(Math.abs(b.y) < GOAL_W / 2 && b.z < GOAL_H)) {
      b.x = Math.sign(b.x) * (L / 2 + 0.6);
      b.vx *= -0.6;
      if (!dead && Math.abs(b.vx) > 3) g.events.push({ type: "bounce", power: Math.abs(b.vx) });
    }
    if (Math.abs(b.y) > W / 2 - BALL_R) {
      b.y = Math.sign(b.y) * (W / 2 - BALL_R);
      b.vy *= -0.6;
      if (!dead && Math.abs(b.vy) > 3) g.events.push({ type: "bounce", power: Math.abs(b.vy) });
    }
    // Nothing goes over the boards into the crowd: a high ball drops back in.
    if (b.z > 9) b.vz = Math.min(b.vz, 0);
  }
}

function scoreGoal(g: Game, team: TeamId) {
  const b = g.ball;
  const scorer = b.lastPlayer >= 0 ? g.players[b.lastPlayer] : null;
  const own = !!scorer && scorer.team !== team;
  g.score[team]++;
  g.phase = "goal";
  g.phaseT = 0;
  g.lastGoal = { team, name: scorer ? scorer.name : g.clubs[team].name, fire: b.fire > 0, own, minute: minute(g) };
  g.shake = 0.6;
  g.events.push({ type: "goal", team, name: g.lastGoal.name, fire: b.fire > 0, own });
  for (const c of g.ctrls) c.charge = 0;
}

function celebrate(g: Game, dt: number) {
  const team = g.phase === "over" ? (g.score[0] >= g.score[1] ? 0 : 1) : g.lastGoal?.team ?? 0;
  for (const p of g.players) {
    if (p.team === team && p.role !== "gk") {
      // Run to the corner flag.
      const cx = attackDir(team) * (L / 2 - 4);
      const cy = (p.i % 2 ? 1 : -1) * (W / 2 - 4);
      steer(p, cx + Math.sin(p.i) * 2, cy, RUN, dt);
    } else steer(p, p.x, p.y, 0, dt);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > 0.3) p.face += angDiff(Math.atan2(p.vy, p.vx), p.face) * Math.min(1, dt * 10);
    p.stride += dt * (1.5 + sp * 1.6);
    p.stun = p.slide = 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers for the page
// ---------------------------------------------------------------------------

/** Feed a controller its input for this frame. */
export function setInput(g: Game, ctrl: number, input: Partial<Input>) {
  const c = g.ctrls[ctrl];
  if (c) Object.assign(c.input, input);
}

/** A simple autopilot for a person's team, so a test (or the card) can watch it play itself. */
export function autopilot(g: Game, ctrl: number): Input {
  const c = g.ctrls[ctrl];
  const p = g.players[c.active];
  const b = g.ball;
  const gx = goalX(c.team);
  const out: Input = { mx: 0, my: 0, a: false, b: false, sprint: false };
  if (b.owner === p.i) {
    const toGoal = dist(p.x, p.y, gx, 0);
    const dx = gx - p.x;
    const dy = -p.y;
    const l = Math.hypot(dx, dy) || 1;
    out.mx = dx / l;
    out.my = dy / l;
    out.sprint = true;
    // Inside 13 m: hold B for about half a bar, then let go.
    out.b = toGoal < 13 && c.holdB < 0.45;
  } else {
    const dx = b.x - p.x;
    const dy = b.y - p.y;
    const l = Math.hypot(dx, dy) || 1;
    out.mx = dx / l;
    out.my = dy / l;
    out.sprint = l > 3;
    out.b = l < 2 && b.owner >= 0 && g.players[b.owner].team !== c.team && !c.input.b && Math.floor(g.t * 2) % 3 === 0;
  }
  return out;
}
