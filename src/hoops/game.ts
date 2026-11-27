/**
 * VIBE HOOPS — the rules.
 *
 * Three on three, full court, in the Vibe Dome. Pure and seeded: nothing in
 * here touches the DOM or three.js, so `src/test/hoops.test.ts` plays whole
 * games in node, and an online room's referee runs exactly this.
 *
 * Coordinates: x runs along the court (baseline to baseline, team 0 attacks
 * +x), y runs across it (positive y is the near sideline, where the TV camera
 * sits), z is up. Metres and seconds.
 *
 * Every body on the floor is driven by an `Input`, whether a thumb or the
 * computer is behind it: `brain()` is the computer, and it presses the same
 * buttons a person would (holds shoot and lets go when the meter looks
 * right, taps pass, jumps). So the computer cannot do anything a person
 * cannot, and a person's teammates play by the same rules as everybody else.
 *
 * The ball is real physics once it leaves a hand: gravity, the rim as a ring
 * of steel, the glass, the floor. Whether a jump shot is aimed dead centre or
 * a few centimetres long is decided at the release from distance, timing and
 * how close the nearest hand is; everything after that (the rattle, the
 * rebound, the one that rolls round and drops) is the ball's own doing.
 */
import { clubById, lineup, type Baller, type Club } from "./teams";

// ---------------------------------------------------------------- the court

export const COURT_L = 28;
export const COURT_W = 15;
export const HALF_L = COURT_L / 2;
export const HALF_W = COURT_W / 2;
/** Rim centre, distance from half court. */
export const HOOP_X = 12.42;
export const RIM_H = 3.05;
export const RIM_R = 0.23;
export const RIM_TUBE = 0.012;
export const BALL_R = 0.12;
/** Front face of the glass. */
export const BOARD_X = 12.8;
export const BOARD_HW = 0.915;
export const BOARD_BOT = 2.9;
export const BOARD_TOP = 3.97;
export const THREE_R = 6.75;
export const CORNER_Y = 6.6;
export const KEY_W = 4.9;
export const KEY_L = 5.8;

export const GAME_SECONDS = 180;
export const SHOT_CLOCK = 14;
const G = 9.8;

export type TeamId = 0 | 1;
export type Difficulty = "easy" | "normal" | "hard";
export const attackDir = (t: TeamId) => (t === 0 ? 1 : -1);
/** The rim team `t` shoots at. */
export const hoopX = (t: TeamId) => attackDir(t) * HOOP_X;

// ---------------------------------------------------------------- types

export interface Input {
  /** Stick in court space: +x along the court, +y towards the camera. */
  mx: number;
  my: number;
  /** Pass / call for it / steal. */
  a: boolean;
  /** Shoot (hold, let go at the top) / jump to block. */
  b: boolean;
  /** Turbo. */
  sprint: boolean;
}

export type Act = "none" | "shoot" | "layup" | "dunk" | "hang" | "steal" | "jump" | "pass";
export const ACTS: Act[] = ["none", "shoot", "layup", "dunk", "hang", "steal", "jump", "pass"];

export interface Brain {
  think: number;
  /** Charge to let go of a jump shot at. */
  release: number;
  tx: number;
  ty: number;
  holdA: number;
  cut: number;
  jumpDelay: number;
}

export interface Player {
  i: number;
  team: TeamId;
  slot: number;
  who: Baller;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  face: number;
  act: Act;
  actT: number;
  /** Where a dunk or layup is heading, and where it left from. */
  ax: number;
  ay: number;
  sx: number;
  sy: number;
  charge: number;
  cool: number;
  /** Can't catch the ball again until this runs out (a passer, a shooter). */
  noCatch: number;
  stamina: number;
  /** Seconds left on "give it here!". */
  call: number;
  /** Controller driving this player, or -1 for the computer. */
  ctrl: number;
  brain: Brain;
  pts: number;
}

export type BallState = "held" | "pass" | "shot" | "loose";

export interface Shot {
  team: TeamId;
  shooter: number;
  pts: 2 | 3;
  kind: "jumper" | "layup" | "dunk";
  make: boolean;
  touched: boolean;
  perfect: boolean;
  /** The rim it is going at, +1 or -1. */
  side: number;
  age: number;
}

export interface Ball {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  state: BallState;
  owner: number;
  lastTeam: TeamId;
  lastPlayer: number;
  /** A pass's receiver, or -1. */
  target: number;
  lob: boolean;
  shot: Shot | null;
  age: number;
}

export interface Controller {
  /** The one player this controller drives, all game. */
  player: number;
  input: Input;
  prevA: boolean;
  prevB: boolean;
  holdA: number;
  holdB: number;
  /** The computer is playing this one for the person (tests, the attract mode). */
  auto: boolean;
}

/** What the computer decides for one body: a stick, plus the moves it makes this frame. */
export interface Intent extends Input {
  pass?: number;
  lob?: boolean;
  shoot?: boolean;
  jump?: boolean;
  steal?: boolean;
  call?: boolean;
}

export type Phase = "intro" | "tip" | "play" | "score" | "dead" | "over";

export type GameEvent =
  | { type: "pass"; lob: boolean }
  | { type: "catch"; i: number }
  | { type: "shot"; i: number; kind: Shot["kind"]; pts: number; perfect: boolean; q: number }
  | { type: "dunk"; i: number; alley: boolean }
  | { type: "rim"; power: number }
  | { type: "board"; power: number }
  | { type: "bounce"; power: number }
  | { type: "score"; team: TeamId; i: number; pts: number; kind: Shot["kind"]; swish: boolean; big: boolean; perfect: boolean; buzzer: boolean }
  | { type: "block"; i: number; victim: number }
  | { type: "steal"; i: number; victim: number }
  | { type: "turnover"; team: TeamId; why: "out" | "shotclock" }
  | { type: "tip"; team: TeamId }
  | { type: "whistle" }
  | { type: "buzzer" }
  | { type: "sudden" }
  | { type: "final"; winner: TeamId };

export interface Game {
  seed: number;
  t: number;
  phase: Phase;
  phaseT: number;
  phaseLen: number;
  clock: number;
  shotClock: number;
  sudden: boolean;
  score: [number, number];
  clubs: [Club, Club];
  difficulty: Difficulty;
  players: Player[];
  ball: Ball;
  ctrls: Controller[];
  /** Who gets the ball when the current dead spell ends. */
  next: { team: TeamId; x: number; y: number } | null;
  events: GameEvent[];
  lastScore: { team: TeamId; i: number; pts: number; kind: Shot["kind"]; big: boolean } | null;
  stats: { fg: [number, number]; fga: [number, number]; threes: [number, number]; dunks: [number, number]; steals: [number, number]; blocks: [number, number] };
  /** Seconds of slow motion the renderer should play (dunks, buzzer beaters). */
  slowmo: number;
  /** Set when the clock runs out with a shot in the air. */
  buzzerShot: boolean;
}

// ---------------------------------------------------------------- setup

export function rnd(g: Game): number {
  g.seed = (g.seed * 1664525 + 1013904223) >>> 0;
  return g.seed / 4294967296;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const hyp = Math.hypot;

export interface NewGameOpts {
  seed?: number;
  clubs?: [string, string];
  difficulty?: Difficulty;
  /** One entry per person: their team, and which roster id they play as (null: the club's first). */
  humans?: Array<{ team: TeamId; pick?: string | null }>;
  /** Skip the intro and tip (tests, quick restarts). */
  skipIntro?: boolean;
}

/** Spots the lineups walk out to for the opening tip, team 0 side. */
const TIP_SPOTS = [
  { x: -0.9, y: 0 },
  { x: -3.4, y: -3.8 },
  { x: -3.4, y: 3.8 },
];

export function newGame(o: NewGameOpts = {}): Game {
  const clubs: [Club, Club] = [clubById(o.clubs?.[0] ?? "volts"), clubById(o.clubs?.[1] ?? "junkyard")];
  const humans = o.humans ?? [];
  const players: Player[] = [];
  const ctrls: Controller[] = [];
  for (const t of [0, 1] as TeamId[]) {
    // Every person on this team gets their pick on the floor.
    const picks = humans.filter((h) => h.team === t).map((h) => h.pick ?? null);
    let five = lineup(clubs[t], picks[0] ?? null);
    for (const extra of picks.slice(1)) {
      if (!extra || five.some((p) => p.id === extra)) continue;
      const all = extra === "me" ? null : clubs[t].roster.find((p) => p.id === extra);
      if (all) five = [five[0], all, ...five.slice(1).filter((p) => p !== all)].slice(0, 3);
    }
    five.forEach((who, slot) => {
      const s = TIP_SPOTS[slot];
      const d = attackDir(t);
      players.push({
        i: players.length,
        team: t,
        slot,
        who,
        x: s.x * d,
        y: s.y * d,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        face: t === 0 ? 0 : Math.PI,
        act: "none",
        actT: 0,
        ax: 0,
        ay: 0,
        sx: 0,
        sy: 0,
        charge: 0,
        cool: 0,
        noCatch: 0,
        stamina: 1,
        call: 0,
        ctrl: -1,
        brain: { think: 0, release: 0.85, tx: 0, ty: 0, holdA: 0, cut: 0, jumpDelay: 0 },
        pts: 0,
      });
    });
  }
  // Seat each person on their pick (or the first free player of their team).
  humans.forEach((h, k) => {
    const team = players.filter((p) => p.team === h.team && p.ctrl < 0);
    const p = team.find((q) => q.who.id === (h.pick ?? "")) ?? team[0];
    if (!p) return;
    p.ctrl = k;
    ctrls.push({ player: p.i, input: { mx: 0, my: 0, a: false, b: false, sprint: false }, prevA: false, prevB: false, holdA: 0, holdB: 0, auto: false });
  });
  const g: Game = {
    seed: (o.seed ?? 1) >>> 0 || 1,
    t: 0,
    phase: o.skipIntro ? "tip" : "intro",
    phaseT: 0,
    phaseLen: o.skipIntro ? 1.3 : 4.2,
    clock: GAME_SECONDS,
    shotClock: SHOT_CLOCK,
    sudden: false,
    score: [0, 0],
    clubs,
    difficulty: o.difficulty ?? "normal",
    players,
    ball: { x: 0, y: 0, z: 1.2, vx: 0, vy: 0, vz: 0, state: "loose", owner: -1, lastTeam: 0, lastPlayer: -1, target: -1, lob: false, shot: null, age: 0 },
    ctrls,
    next: null,
    events: [],
    lastScore: null,
    stats: { fg: [0, 0], fga: [0, 0], threes: [0, 0], dunks: [0, 0], steals: [0, 0], blocks: [0, 0] },
    slowmo: 0,
    buzzerShot: false,
  };
  if (o.skipIntro) startTip(g);
  return g;
}

function startTip(g: Game) {
  g.phase = "tip";
  g.phaseT = 0;
  g.phaseLen = 1.3;
  const b = g.ball;
  b.state = "loose";
  b.owner = -1;
  b.x = 0;
  b.y = 0;
  b.z = 2.0;
  b.vx = b.vy = 0;
  b.vz = 6.2;
  b.shot = null;
  for (const p of g.players) {
    const s = TIP_SPOTS[p.slot];
    const d = attackDir(p.team);
    p.x = s.x * d;
    p.y = s.y * d;
    p.z = p.vz = p.vx = p.vy = 0;
    p.act = "none";
  }
}

// ---------------------------------------------------------------- helpers

export const ownerOf = (g: Game) => (g.ball.owner >= 0 ? g.players[g.ball.owner] : null);

/** Which team has the ball, counting a pass in the air. */
export function offence(g: Game): TeamId | null {
  const b = g.ball;
  if (b.owner >= 0) return g.players[b.owner].team;
  if (b.state === "pass") return b.lastTeam;
  if (b.state === "shot" && b.shot && !b.shot.touched) return b.shot.team;
  return null;
}

export const distToHoop = (g: Game, p: Player) => hyp(hoopX(p.team) - p.x, p.y);

/** Is this spot behind the three-point line for a team attacking `team`'s rim? */
export function isThree(team: TeamId, x: number, y: number): boolean {
  const hx = hoopX(team);
  const fromBase = HALF_L - Math.abs(x);
  if (Math.sign(x) === Math.sign(hx) && fromBase < 3 && Math.abs(y) >= CORNER_Y) return true;
  return hyp(hx - x, y) >= THREE_R;
}

/** The closest opponent to `p`, and how far. */
function nearestFoe(g: Game, p: Player): { foe: Player | null; d: number } {
  let foe: Player | null = null;
  let d = Infinity;
  for (const q of g.players) {
    if (q.team === p.team) continue;
    const e = hyp(q.x - p.x, q.y - p.y);
    if (e < d) {
      d = e;
      foe = q;
    }
  }
  return { foe, d };
}

/** How open a player is towards the rim: the nearest foe, weighted for being between them and it. */
function openness(g: Game, p: Player): number {
  const hx = hoopX(p.team);
  const tx = hx - p.x;
  const ty = -p.y;
  const tl = hyp(tx, ty) || 1;
  let best = 9;
  for (const q of g.players) {
    if (q.team === p.team) continue;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const d = hyp(dx, dy);
    const ahead = (dx * tx + dy * ty) / tl / (d || 1);
    best = Math.min(best, ahead > 0.2 ? d : d * 1.5);
  }
  return best;
}

/** Chance a shot from here goes in, before timing. */
export function shotOdds(g: Game, p: Player): number {
  const d = distToHoop(g, p);
  let base: number;
  if (d < 2.4) base = 0.74;
  else if (!isThree(p.team, p.x, p.y)) base = 0.7 - 0.035 * (d - 2.4);
  else base = 0.5 - 0.045 * (d - THREE_R);
  base += (p.who.shoot - 3) * 0.035;
  const open = openness(g, p);
  const contest = open < 0.9 ? 0.5 : open < 1.6 ? 0.74 : open < 2.4 ? 0.9 : 1;
  return clamp(base * contest, 0.03, 0.92);
}

/** Expected points of shooting now, for the computer's choices. */
const shotValue = (g: Game, p: Player) => shotOdds(g, p) * (isThree(p.team, p.x, p.y) ? 3 : 2);

const STOOD_REACH = 2.35;

// ---------------------------------------------------------------- the step

const DT_MAX = 1 / 30;

export function step(g: Game, dtIn: number) {
  const dt = Math.min(dtIn, DT_MAX);
  g.t += dt;
  g.phaseT += dt;
  if (g.slowmo > 0) g.slowmo = Math.max(0, g.slowmo - dt);

  if (g.phase === "intro") {
    for (const p of g.players) idle(p, dt);
    if (g.phaseT >= g.phaseLen) startTip(g);
    return;
  }

  if (g.phase === "play" && !g.buzzerShot && !g.sudden) {
    g.clock -= dt;
    g.shotClock -= dt;
    if (g.clock <= 0) {
      g.clock = 0;
      g.events.push({ type: "buzzer" });
      const b = g.ball;
      if (b.state === "shot" && b.shot && !b.shot.touched) {
        // The ball is in the air at the horn: let it land.
        g.buzzerShot = true;
      } else {
        endOfTime(g);
        return;
      }
    } else if (g.shotClock <= 0) {
      const off = offence(g);
      const b = g.ball;
      if (off !== null && !(b.state === "shot")) {
        g.events.push({ type: "turnover", team: off, why: "shotclock" });
        const o = ownerOf(g);
        deadBall(g, (1 - off) as TeamId, o ? o.x : b.x, o ? o.y : b.y);
      } else g.shotClock = SHOT_CLOCK;
    }
  }

  // Inputs: people from their controllers, everybody else from a brain.
  const human = (p: Player) => p.ctrl >= 0 && g.phase === "play" && !g.ctrls[p.ctrl].auto;
  const inputs: Intent[] = g.players.map((p) => (human(p) ? g.ctrls[p.ctrl].input : brain(g, p, dt)));
  g.players.forEach((p, k) => drive(g, p, inputs[k], dt, human(p)));
  for (const c of g.ctrls) {
    c.prevA = c.input.a;
    c.prevB = c.input.b;
  }
  separate(g);
  moveBall(g, dt);

  if (g.phase === "tip") {
    if (g.phaseT >= g.phaseLen) {
      // The two in the middle go up for it; the better hands win, with a coin in it.
      const a = g.players.find((p) => p.team === 0 && p.slot === 0)!;
      const c = g.players.find((p) => p.team === 1 && p.slot === 0)!;
      const edge = (a.who.dunk - c.who.dunk) * 0.08;
      const won: TeamId = rnd(g) < 0.5 + edge ? 0 : 1;
      g.events.push({ type: "tip", team: won });
      const to = g.players.find((p) => p.team === won && p.slot === 1)!;
      give(g, to);
      g.phase = "play";
      g.phaseT = 0;
      g.shotClock = SHOT_CLOCK;
      g.events.push({ type: "whistle" });
    } else if (g.phaseT > 0.75) {
      for (const p of g.players) if (p.slot === 0 && p.z === 0 && p.act === "none") jump(p, 4.4);
    }
    return;
  }

  if (g.phase === "score" || g.phase === "dead") {
    if (g.phaseT >= g.phaseLen && g.next) {
      const n = g.next;
      g.next = null;
      // The nearest of that team takes it where it went dead.
      const team = g.players.filter((p) => p.team === n.team);
      team.sort((a, c) => hyp(a.x - n.x, a.y - n.y) - hyp(c.x - n.x, c.y - n.y));
      const p = team[0];
      p.x = clamp(n.x, -HALF_L + 0.3, HALF_L - 0.3);
      p.y = clamp(n.y, -HALF_W + 0.3, HALF_W - 0.3);
      give(g, p);
      g.phase = "play";
      g.phaseT = 0;
      g.shotClock = SHOT_CLOCK;
    }
    return;
  }

}

function endOfTime(g: Game) {
  if (g.score[0] === g.score[1]) {
    if (!g.sudden) {
      g.sudden = true;
      g.events.push({ type: "sudden" });
    }
    // Next basket wins: the clock stops mattering.
    g.clock = 0;
    return;
  }
  const winner: TeamId = g.score[0] > g.score[1] ? 0 : 1;
  g.phase = "over";
  g.phaseT = 0;
  g.events.push({ type: "final", winner });
}

function give(g: Game, p: Player) {
  const b = g.ball;
  const changed = b.lastTeam !== p.team || b.state === "loose";
  b.state = "held";
  b.owner = p.i;
  b.target = -1;
  b.lob = false;
  b.shot = null;
  b.age = 0;
  if (b.lastTeam !== p.team) g.shotClock = SHOT_CLOCK;
  b.lastTeam = p.team;
  b.lastPlayer = p.i;
  if (changed) p.call = 0;
  holdBall(p, b);
}

function deadBall(g: Game, team: TeamId, x: number, y: number, len = 1.3) {
  const b = g.ball;
  b.state = "loose";
  b.owner = -1;
  b.shot = null;
  b.target = -1;
  g.phase = "dead";
  g.phaseT = 0;
  g.phaseLen = len;
  g.next = { team, x, y };
  g.events.push({ type: "whistle" });
  for (const p of g.players) if (p.act === "shoot") p.act = "none";
}

function idle(p: Player, dt: number) {
  p.vx *= 0.8;
  p.vy *= 0.8;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
}

function jump(p: Player, v: number) {
  p.vz = v;
  p.z = 0.001;
}

// ---------------------------------------------------------------- one body

function drive(g: Game, p: Player, inp: Intent, dt: number, human: boolean) {
  const c = p.ctrl >= 0 ? g.ctrls[p.ctrl] : null;
  const b = g.ball;
  const has = b.owner === p.i;
  const live = g.phase === "play";
  p.cool = Math.max(0, p.cool - dt);
  p.noCatch = Math.max(0, p.noCatch - dt);
  p.call = Math.max(0, p.call - dt);
  p.actT += dt;

  // What this body does this frame: from a person's button edges, or the computer's intent.
  let passNow = false;
  let lob = false;
  let passTo: number | undefined;
  let shootNow = false;
  let jumpNow = false;
  let stealNow = false;
  let callNow = false;
  let letGo = false;
  if (human && c) {
    const aDown = inp.a && !c.prevA;
    const aUp = !inp.a && c.prevA;
    const bDown = inp.b && !c.prevB;
    const bUp = !inp.b && c.prevB;
    if (inp.a) c.holdA += dt;
    const heldA = c.holdA;
    if (!inp.a) c.holdA = 0;
    c.holdB = inp.b ? c.holdB + dt : 0;
    if (has) {
      passNow = aUp;
      lob = heldA >= 0.24;
      shootNow = bDown;
    } else {
      callNow = aDown && offence(g) === p.team;
      stealNow = aDown && offence(g) !== p.team && offence(g) !== null;
      jumpNow = bDown;
    }
    letGo = bUp;
  } else {
    passNow = inp.pass !== undefined;
    passTo = inp.pass;
    lob = !!inp.lob;
    shootNow = !!inp.shoot;
    jumpNow = !!inp.jump;
    stealNow = !!inp.steal;
    callNow = !!inp.call;
  }

  // ---- acts that own the body
  if (p.act === "dunk") return dunking(g, p, dt);
  if (p.act === "hang") {
    p.z = Math.max(0.9, p.z);
    if (p.actT > 0.32) {
      p.act = "none";
      p.vz = 0;
    }
    return;
  }
  if (p.act === "layup") return layingUp(g, p, dt);

  // ---- airborne: momentum only
  if (p.z > 0 || p.vz > 0) {
    p.vz -= G * dt;
    p.z += p.vz * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.z <= 0) {
      p.z = 0;
      p.vz = 0;
      if (p.act === "jump" || p.act === "steal") p.act = "none";
      if (p.act === "shoot") {
        // Landed without letting go: it goes up anyway, late.
        if (has) release(g, p, Math.max(p.charge, 1.05));
        p.act = "none";
      }
    }
    if (p.act === "shoot" && has) {
      p.charge = p.actT / 0.6;
      const auto = human ? p.charge >= 1.12 : p.charge >= p.brain.release;
      if ((letGo && human && p.actT > 0.16) || auto) release(g, p, p.charge);
    }
    clampCourt(p);
    if (b.owner === p.i) holdBall(p, b);
    return;
  }

  // ---- on the floor: run
  let mx = inp.mx;
  let my = inp.my;
  const ml = hyp(mx, my);
  if (ml > 1) {
    mx /= ml;
    my /= ml;
  }
  const turbo = inp.sprint && p.stamina > 0.05 && ml > 0.3;
  p.stamina = clamp(p.stamina + (turbo ? -0.32 : 0.16) * dt, 0, 1);
  const top = (turbo ? 8.0 : 6.0) * (has ? 0.94 : 1) * (p.act === "steal" ? 0.6 : 1);
  const ax = mx * top - p.vx;
  const ay = my * top - p.vy;
  const k = Math.min(1, dt * (ml > 0.1 ? 9 : 12));
  p.vx += ax * k;
  p.vy += ay * k;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  if (ml > 0.15) p.face = Math.atan2(my, mx);
  else if (has || offence(g) === p.team) p.face = turnTo(p.face, Math.atan2(-p.y, hoopX(p.team) - p.x), dt * 6);
  else {
    const o = ownerOf(g) ?? b;
    p.face = turnTo(p.face, Math.atan2(o.y - p.y, o.x - p.x), dt * 6);
  }
  clampCourt(p);
  if (p.act === "steal" && p.actT > 0.3) p.act = "none";
  if (p.act === "pass" && p.actT > 0.25) p.act = "none";

  if (!live) {
    if (has) holdBall(p, b);
    return;
  }

  if (has) {
    holdBall(p, b);
    // A person passes on the let-go of A; a long hold is a lob.
    if (passNow && p.act !== "shoot") passBall(g, p, inp, lob, passTo);
    else if (shootNow && (p.act === "none" || p.act === "pass")) startShot(g, p, inp);
  } else {
    if (callNow) p.call = 1.6;
    if (stealNow && p.cool <= 0) steal(g, p);
    if (jumpNow && p.cool <= 0) {
      p.act = "jump";
      p.actT = 0;
      p.cool = 0.55;
      jump(p, 4.6 + (p.who.dunk - 3) * 0.18);
    }
  }
}

const turnTo = (a: number, target: number, k: number) => {
  let d = target - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(1, k);
};

function clampCourt(p: Player) {
  p.x = clamp(p.x, -HALF_L - 0.6, HALF_L + 0.6);
  p.y = clamp(p.y, -HALF_W - 0.6, HALF_W + 0.6);
  // Nobody walks through the stanchion.
  for (const s of [-1, 1]) {
    const dx = p.x - s * (HALF_L + 0.6);
    if (Math.abs(dx) < 0.9 && Math.abs(p.y) < 0.9) p.x = s * (HALF_L - 0.3);
  }
}

/** Where a held ball sits: in front and to the side, at dribble height (the renderer bounces it). */
function holdBall(p: Player, b: Ball) {
  const up = p.act === "shoot" || p.act === "layup" || p.act === "dunk";
  const fx = Math.cos(p.face);
  const fy = Math.sin(p.face);
  const side = up ? 0 : 0.28;
  b.x = p.x + fx * (up ? 0.18 : 0.36) - fy * side;
  b.y = p.y + fy * (up ? 0.18 : 0.36) + fx * side;
  b.z = p.z + (up ? 2.25 : 0.95);
  b.vx = p.vx;
  b.vy = p.vy;
  b.vz = p.vz;
}

function separate(g: Game) {
  const ps = g.players;
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i];
      const c = ps[j];
      const dx = c.x - a.x;
      const dy = c.y - a.y;
      const d = hyp(dx, dy);
      const min = 0.62;
      if (d > 0 && d < min && Math.abs(a.z - c.z) < 1.2) {
        const push = (min - d) / 2;
        const nx = dx / d;
        const ny = dy / d;
        const aLocked = a.act === "dunk" || a.act === "hang" || a.act === "layup";
        const cLocked = c.act === "dunk" || c.act === "hang" || c.act === "layup";
        if (!aLocked) {
          a.x -= nx * push * (cLocked ? 2 : 1);
          a.y -= ny * push * (cLocked ? 2 : 1);
        }
        if (!cLocked) {
          c.x += nx * push * (aLocked ? 2 : 1);
          c.y += ny * push * (aLocked ? 2 : 1);
        }
      }
    }
}

// ---------------------------------------------------------------- passing

/** The teammate a pass goes to: the one in the stick's direction, or the most open. */
export function passTarget(g: Game, p: Player, mx: number, my: number): Player | null {
  const mates = g.players.filter((q) => q.team === p.team && q !== p);
  if (!mates.length) return null;
  const ml = hyp(mx, my);
  let best: Player | null = null;
  let score = -Infinity;
  for (const q of mates) {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const d = hyp(dx, dy) || 1;
    let s = -d * 0.05 + openness(g, q) * 0.25 + (q.call > 0 ? 2 : 0);
    if (ml > 0.3) s += ((dx * mx + dy * my) / d / ml) * 3;
    if (s > score) {
      score = s;
      best = q;
    }
  }
  return best;
}

function passBall(g: Game, p: Player, inp: Input, lob: boolean, to?: number) {
  const q = to !== undefined ? g.players[to] : passTarget(g, p, inp.mx, inp.my);
  if (!q) return;
  const b = g.ball;
  const d0 = hyp(q.x - p.x, q.y - p.y);
  const speed = lob ? 9.5 : 16;
  let tf = clamp(d0 / speed, 0.18, 1.3);
  // Lead the receiver.
  const tx = clamp(q.x + q.vx * tf * 0.8, -HALF_L, HALF_L);
  const ty = clamp(q.y + q.vy * tf * 0.8, -HALF_W, HALF_W);
  const d = hyp(tx - b.x, ty - b.y);
  tf = clamp(d / speed, 0.18, 1.3);
  const nearRim = hyp(hoopX(q.team) - tx, ty) < 3.6;
  const tz = lob && nearRim ? 3.2 : 1.25;
  b.state = "pass";
  b.owner = -1;
  b.target = q.i;
  b.lob = lob;
  b.age = 0;
  b.lastTeam = p.team;
  b.lastPlayer = p.i;
  b.vx = (tx - b.x) / tf;
  b.vy = (ty - b.y) / tf;
  b.vz = (tz - b.z + 0.5 * G * tf * tf) / tf + (lob ? 1.2 : 0);
  p.noCatch = 0.3;
  p.act = "pass";
  p.actT = 0;
  g.events.push({ type: "pass", lob });
}

// ---------------------------------------------------------------- shooting

function startShot(g: Game, p: Player, inp: Input) {
  const d = distToHoop(g, p);
  const hx = hoopX(p.team);
  const turbo = inp.sprint && p.stamina > 0.05;
  const dunkRange = 2.0 + p.who.dunk * 0.35 + (turbo ? 0.9 : 0);
  // Dunk from in close, or from further on turbo, if nothing is right in the way.
  if (d < dunkRange && d > 0.4) {
    const ahead = blockerAhead(g, p);
    if (!ahead || d < 1.6 || p.who.dunk >= 4) return startDunk(g, p, false);
  }
  if (d < 2.6) {
    p.act = "layup";
    p.actT = 0;
    p.sx = p.x;
    p.sy = p.y;
    const ux = (hx - p.x) / (d || 1);
    const uy = -p.y / (d || 1);
    p.ax = p.x + ux * Math.min(1.1, d - 0.6);
    p.ay = p.y + uy * Math.min(1.1, d - 0.6);
    p.face = Math.atan2(uy, ux);
    return;
  }
  p.act = "shoot";
  p.actT = 0;
  p.charge = 0;
  p.vx *= 0.2;
  p.vy *= 0.2;
  p.face = Math.atan2(-p.y, hx - p.x);
  jump(p, 3.4);
}

function blockerAhead(g: Game, p: Player): Player | null {
  const hx = hoopX(p.team);
  for (const q of g.players) {
    if (q.team === p.team) continue;
    const t = projT(p.x, p.y, hx, 0, q.x, q.y);
    if (t <= 0 || t >= 1) continue;
    const px = p.x + (hx - p.x) * t;
    const py = p.y + (0 - p.y) * t;
    if (hyp(q.x - px, q.y - py) < 0.75) return q;
  }
  return null;
}

const projT = (ax: number, ay: number, bx: number, by: number, px: number, py: number) => {
  const dx = bx - ax;
  const dy = by - ay;
  const l = dx * dx + dy * dy || 1;
  return ((px - ax) * dx + (py - ay) * dy) / l;
};

function startDunk(g: Game, p: Player, alley: boolean) {
  const hx = hoopX(p.team);
  const d = hyp(hx - p.x, p.y) || 1;
  p.act = "dunk";
  p.actT = 0;
  p.sx = p.x;
  p.sy = p.y;
  // Finish just in front of the rim, on the line you came in on.
  p.ax = hx + ((p.x - hx) / d) * 0.55;
  p.ay = (p.y / d) * 0.55;
  p.face = Math.atan2(-p.y, hx - p.x);
  p.stamina = Math.max(0, p.stamina - 0.12);
  g.slowmo = 1.1;
  g.events.push({ type: "dunk", i: p.i, alley });
  g.stats.fga[p.team]++;
}

const DUNK_T = 0.78;

function dunking(g: Game, p: Player, dt: number) {
  const t = p.actT / DUNK_T;
  const e = Math.min(1, t / 0.62);
  const s = e * e * (3 - 2 * e);
  p.x = p.sx + (p.ax - p.sx) * s;
  p.y = p.sy + (p.ay - p.sy) * s;
  p.z = Math.sin(Math.min(1, t / 0.62) * Math.PI * 0.5) * (1.05 + p.who.dunk * 0.06);
  p.vx = p.vy = 0;
  const b = g.ball;
  if (b.owner === p.i) holdBall(p, b);
  if (t >= 0.62 && b.owner === p.i) {
    // At the top: a big man under the rim gets a hand on some of them.
    const hx = hoopX(p.team);
    const guard = g.players.find((q) => q.team !== p.team && q.z > 0.35 && hyp(q.x - hx, q.y) < 1.6);
    if (guard && rnd(g) < 0.12 + guard.who.hands * 0.03) {
      blocked(g, guard, p);
      p.act = "none";
      p.vz = -1;
      return;
    }
    const side = Math.sign(hx);
    b.state = "shot";
    b.owner = -1;
    b.x = hx - side * 0.05;
    b.y = 0;
    b.z = RIM_H + 0.3;
    b.vx = 0;
    b.vy = 0;
    b.vz = -6;
    b.age = 0;
    b.shot = { team: p.team, shooter: p.i, pts: 2, kind: "dunk", make: true, touched: false, perfect: true, side, age: 0 };
    p.noCatch = 0.6;
    p.act = "hang";
    p.actT = 0;
    p.z = RIM_H - 2.05;
    return;
  }
  void dt;
}

const LAYUP_T = 0.55;

function layingUp(g: Game, p: Player, dt: number) {
  const t = p.actT / LAYUP_T;
  const e = Math.min(1, t);
  p.x = p.sx + (p.ax - p.sx) * e;
  p.y = p.sy + (p.ay - p.sy) * e;
  p.z = Math.sin(Math.min(1, t) * Math.PI) * 0.8;
  const b = g.ball;
  if (b.owner === p.i) holdBall(p, b);
  if (t >= 0.55 && b.owner === p.i) release(g, p, 0.85);
  if (t >= 1) {
    p.act = "none";
    p.z = 0;
    p.vz = 0;
  }
  void dt;
}

/** Let go of a jump shot or a layup with `charge` on the meter (0.85 is perfect). */
function release(g: Game, p: Player, charge: number) {
  const b = g.ball;
  const kind: Shot["kind"] = p.act === "layup" ? "layup" : "jumper";
  const hx = hoopX(p.team);
  const side = Math.sign(hx);
  const d = hyp(hx - p.x, p.y);
  const pts: 2 | 3 = kind === "jumper" && isThree(p.team, p.x, p.y) ? 3 : 2;
  const miss = Math.abs(charge - 0.85);
  const q = kind === "layup" ? 0.9 : clamp(1 - miss / 0.42, 0, 1);
  const perfect = kind === "jumper" && miss < 0.065;

  // A hand in the face: a defender in the air, close and between.
  for (const o of g.players) {
    if (o.team === p.team || o.z < 0.25) continue;
    const dd = hyp(o.x - p.x, o.y - p.y);
    if (dd > 1.25) continue;
    const toward = ((o.x - p.x) * (hx - p.x) + (o.y - p.y) * -p.y) / (dd || 1) / (d || 1);
    if (toward < -0.2) continue;
    if (rnd(g) < 0.16 + o.who.hands * 0.03 + (o.z > 0.6 ? 0.08 : 0)) {
      g.stats.fga[p.team]++;
      blocked(g, o, p);
      p.act = p.z > 0 ? "jump" : "none";
      return;
    }
  }

  let odds = shotOdds(g, p) * (0.3 + 0.7 * q);
  if (perfect) odds = Math.min(0.95, odds * 1.32 + 0.08);
  const make = rnd(g) < odds;
  g.stats.fga[p.team]++;

  // Aim: dead centre for a make, a rim's width off for a miss.
  let tx = hx - side * 0.03;
  let ty = 0;
  if (!make) {
    const a = rnd(g) * Math.PI * 2;
    const r = RIM_R + BALL_R * (0.05 + rnd(g) * 0.75);
    tx = hx + Math.cos(a) * r;
    ty = Math.sin(a) * r;
  }
  const tf = kind === "layup" ? 0.5 : 0.62 + 0.085 * d;
  holdBall(p, b);
  b.state = "shot";
  b.owner = -1;
  b.age = 0;
  b.vx = (tx - b.x) / tf;
  b.vy = (ty - b.y) / tf;
  b.vz = (RIM_H - b.z + 0.5 * G * tf * tf) / tf;
  b.shot = { team: p.team, shooter: p.i, pts, kind, make, touched: false, perfect, side, age: 0 };
  b.lastTeam = p.team;
  b.lastPlayer = p.i;
  p.noCatch = 0.5;
  p.charge = 0;
  if (p.act === "shoot") p.act = "jump";
  g.events.push({ type: "shot", i: p.i, kind, pts, perfect, q });
}

function blocked(g: Game, by: Player, victim: Player) {
  const b = g.ball;
  b.state = "loose";
  b.owner = -1;
  b.shot = null;
  b.age = 0;
  const dx = victim.x - by.x;
  const dy = victim.y - by.y;
  const d = hyp(dx, dy) || 1;
  b.vx = (dx / d) * 5 + (rnd(g) - 0.5) * 3;
  b.vy = (dy / d) * 5 + (rnd(g) - 0.5) * 3;
  b.vz = 2.5;
  b.z = Math.max(b.z, 2.4);
  b.lastTeam = by.team;
  b.lastPlayer = by.i;
  victim.noCatch = 0.5;
  g.stats.blocks[by.team]++;
  g.events.push({ type: "block", i: by.i, victim: victim.i });
}

function steal(g: Game, p: Player) {
  p.act = "steal";
  p.actT = 0;
  p.cool = 0.85;
  const o = ownerOf(g);
  if (!o || o.team === p.team) return;
  const d = hyp(o.x - p.x, o.y - p.y);
  if (d > 1.35 || o.act === "dunk" || o.z > 0.3) return;
  const chance = 0.12 + p.who.hands * 0.025 + (o.act === "shoot" ? 0.1 : 0);
  if (rnd(g) < chance) {
    const b = g.ball;
    b.state = "loose";
    b.owner = -1;
    b.age = 0;
    const dx = p.x - o.x;
    const dy = p.y - o.y;
    const l = hyp(dx, dy) || 1;
    b.vx = (dx / l) * 2.4;
    b.vy = (dy / l) * 2.4;
    b.vz = 1.4;
    b.lastTeam = p.team;
    b.lastPlayer = p.i;
    o.noCatch = 0.45;
    g.stats.steals[p.team]++;
    g.events.push({ type: "steal", i: p.i, victim: o.i });
  }
}

// ---------------------------------------------------------------- the ball

function moveBall(g: Game, dt: number) {
  const b = g.ball;
  b.age += dt;
  if (b.state === "held") return;
  if (g.phase === "dead") {
    // A dead ball rolls to a stop and is not anybody's.
    integrate(g, b, dt);
    return;
  }
  const prevZ = b.z;
  integrate(g, b, dt);
  const s = b.shot;
  if (s) {
    s.age += dt;
    // Through the hoop: falling through the rim's plane inside the ring.
    const hx = s.side * HOOP_X;
    if (prevZ >= RIM_H && b.z < RIM_H && b.vz < 0 && hyp(b.x - hx, b.y) < RIM_R - 0.03) {
      scored(g, s);
      return;
    }
    if (s.age > 3.2 || (s.touched && b.z < 1.6)) {
      b.shot = null;
      b.state = "loose";
      if (g.buzzerShot) {
        g.buzzerShot = false;
        endOfTime(g);
        return;
      }
    }
  }
  if (g.phase !== "play" && g.phase !== "tip") return;

  // Out of bounds, once it is on the floor.
  if (b.z < 0.6 && (Math.abs(b.x) > HALF_L + 0.05 || Math.abs(b.y) > HALF_W + 0.05) && g.phase === "play") {
    const team = (1 - b.lastTeam) as TeamId;
    g.events.push({ type: "turnover", team: b.lastTeam, why: "out" });
    deadBall(g, team, clamp(b.x, -HALF_L + 0.4, HALF_L - 0.4), clamp(b.y, -HALF_W + 0.4, HALF_W - 0.4));
    return;
  }

  // Catches: the closest player who can reach it.
  if (g.phase === "tip") return;
  let best: Player | null = null;
  let bd = Infinity;
  for (const p of g.players) {
    if (p.noCatch > 0 || p.act === "dunk" || p.act === "hang") continue;
    if (b.state === "shot" && s && !s.touched && b.z > 2.7) continue;
    if (b.state === "shot" && s && s.make && !s.touched) continue;
    const d = hyp(b.x - p.x, b.y - p.y);
    const reach = STOOD_REACH + p.z + 0.15;
    // A pass is the receiver's unless somebody is right in its path.
    const r = b.state === "pass" ? (b.target === p.i ? 0.95 : 0.42) : 0.72;
    if (d < r && b.z < reach && b.z > 0 && d < bd) {
      best = p;
      bd = d;
    }
  }
  if (best) {
    const wasLob = b.state === "pass" && b.lob && b.target === best.i;
    const wasPass = b.state === "pass";
    give(g, best);
    g.events.push({ type: "catch", i: best.i });
    if (wasPass && best.team !== b.lastTeam) g.stats.steals[best.team]++;
    // Alley-oop: caught high near the rim, straight up and in.
    if (wasLob && best.team === g.ball.lastTeam && hyp(hoopX(best.team) - best.x, best.y) < 3.8) {
      g.stats.fga[best.team] += 0;
      startDunk(g, best, true);
    }
  }
}

function integrate(g: Game, b: Ball, dt: number) {
  // Two sub-steps: the rim is thin and a fast ball is not.
  const n = 3;
  const h = dt / n;
  for (let k = 0; k < n; k++) {
    b.vz -= G * h;
    b.x += b.vx * h;
    b.y += b.vy * h;
    b.z += b.vz * h;
    collide(g, b);
  }
}

function collide(g: Game, b: Ball) {
  const s = b.shot;
  // The floor.
  if (b.z < BALL_R) {
    b.z = BALL_R;
    if (b.vz < 0) {
      const p = -b.vz;
      b.vz = p > 0.6 ? p * 0.74 : 0;
      b.vx *= 0.9;
      b.vy *= 0.9;
      if (p > 1.2) g.events.push({ type: "bounce", power: p });
    }
    if (b.vz === 0) {
      b.vx *= 0.985;
      b.vy *= 0.985;
    }
  }
  for (const side of [-1, 1]) {
    const hx = side * HOOP_X;
    // A shot meant to drop does not rattle: its line is already through the middle.
    const clean = s && s.make && !s.touched && s.side === side;
    if (!clean) {
      // The rim: the nearest point on the ring of steel.
      const dx = b.x - hx;
      const dy = b.y;
      const dl = hyp(dx, dy) || 1e-6;
      const px = hx + (dx / dl) * RIM_R;
      const py = (dy / dl) * RIM_R;
      const ex = b.x - px;
      const ey = b.y - py;
      const ez = b.z - RIM_H;
      const ed = Math.sqrt(ex * ex + ey * ey + ez * ez);
      const min = BALL_R + RIM_TUBE;
      if (ed < min && ed > 1e-6) {
        const nx = ex / ed;
        const ny = ey / ed;
        const nz = ez / ed;
        b.x += nx * (min - ed);
        b.y += ny * (min - ed);
        b.z += nz * (min - ed);
        const vn = b.vx * nx + b.vy * ny + b.vz * nz;
        if (vn < 0) {
          const e = 0.52;
          b.vx -= (1 + e) * vn * nx;
          b.vy -= (1 + e) * vn * ny;
          b.vz -= (1 + e) * vn * nz;
          b.vx *= 0.86;
          b.vy *= 0.86;
          if (s && s.side === side) {
            s.touched = true;
            g.shotClock = SHOT_CLOCK;
          }
          g.events.push({ type: "rim", power: -vn });
        }
      }
    }
    // The glass.
    const fx = side * BOARD_X;
    if (Math.abs(b.y) < BOARD_HW + BALL_R && b.z > BOARD_BOT - BALL_R && b.z < BOARD_TOP + BALL_R) {
      const into = side > 0 ? b.x + BALL_R - fx : fx - (b.x - BALL_R);
      if (into > 0 && into < 0.25 && b.vx * side > 0) {
        b.x -= side * into;
        const p = Math.abs(b.vx);
        b.vx = -b.vx * 0.62;
        if (s && s.side === side) s.touched = true;
        g.events.push({ type: "board", power: p });
      }
    }
  }
}

function scored(g: Game, s: Shot) {
  const shooter = g.players[s.shooter];
  const team = s.team;
  g.score[team] += s.pts;
  shooter.pts += s.pts;
  g.stats.fg[team]++;
  if (s.pts === 3) g.stats.threes[team]++;
  if (s.kind === "dunk") g.stats.dunks[team]++;
  const buzzer = g.buzzerShot;
  const big = s.kind === "dunk" || s.pts === 3 || buzzer || s.perfect;
  const swish = !s.touched;
  g.lastScore = { team, i: s.shooter, pts: s.pts, kind: s.kind, big };
  g.events.push({ type: "score", team, i: s.shooter, pts: s.pts, kind: s.kind, swish, big, perfect: s.perfect, buzzer });
  const b = g.ball;
  b.shot = null;
  b.state = "loose";
  b.vx *= 0.2;
  b.vy *= 0.2;
  b.lastTeam = team;
  if (buzzer) g.buzzerShot = false;
  if (g.sudden || (buzzer && g.clock <= 0)) {
    if (g.score[0] !== g.score[1]) {
      g.phase = "over";
      g.phaseT = 0;
      const winner: TeamId = g.score[0] > g.score[1] ? 0 : 1;
      g.events.push({ type: "final", winner });
      return;
    }
  }
  if (g.clock <= 0 && !g.sudden) {
    endOfTime(g);
    if (g.phase === "over") return;
  }
  // The other lot take it out under their own basket.
  const other = (1 - team) as TeamId;
  g.phase = "score";
  g.phaseT = 0;
  g.phaseLen = big ? 4.4 : 2.3;
  g.next = { team: other, x: -attackDir(other) * (HALF_L - 0.6), y: 1.2 };
}

// ---------------------------------------------------------------- the computer

const LEVEL = {
  easy: { think: 0.5, sigma: 0.16, steal: 0.05, block: 0.3, shoot: 1.15 },
  normal: { think: 0.3, sigma: 0.09, steal: 0.11, block: 0.6, shoot: 1.0 },
  hard: { think: 0.18, sigma: 0.045, steal: 0.17, block: 0.85, shoot: 0.92 },
};
type Level = (typeof LEVEL)["normal"];

/** Gaussian-ish noise from the game's own dice. */
const noise = (g: Game) => (rnd(g) + rnd(g) + rnd(g) - 1.5) / 1.5;

/** Offensive spots, for a team attacking +x: top, wing, post, corner, other wing. */
const SPOTS = [
  { x: HOOP_X - 7.3, y: 0 },
  { x: HOOP_X - 4.4, y: -5.2 },
  { x: HOOP_X - 1.8, y: 2.4 },
  { x: HOOP_X - 0.7, y: 6.7 },
  { x: HOOP_X - 4.4, y: 5.2 },
];

const still = (): Intent => ({ mx: 0, my: 0, a: false, b: false, sprint: false });

function toward(p: Player, x: number, y: number, slow = 0.6): Intent {
  const dx = x - p.x;
  const dy = y - p.y;
  const d = hyp(dx, dy);
  if (d < 0.25) return still();
  const k = d < slow ? d / slow : 1;
  return { mx: (dx / d) * k, my: (dy / d) * k, a: false, b: false, sprint: d > 4 };
}

/**
 * The computer's thumb for one player. Called every step for every body that
 * no person is driving (and for a person's, when the computer is standing in
 * for them). It only ever does what a person could: run, pass, shoot and
 * let go when its meter looks right, jump, reach in.
 */
export function brain(g: Game, p: Player, dt: number): Intent {
  const withPeople = g.players.some((q) => q.team === p.team && q.ctrl >= 0);
  const lv = LEVEL[withPeople ? "normal" : g.difficulty];
  const br = p.brain;
  br.think -= dt;
  br.cut = Math.max(0, br.cut - dt);
  const b = g.ball;
  const dir = attackDir(p.team);
  const hx = hoopX(p.team);
  const own = -hx;
  const off = offence(g);

  // Dead balls and the tip: walk somewhere sensible.
  if (g.phase !== "play") {
    if (g.phase === "tip" || g.phase === "intro") {
      const s = TIP_SPOTS[p.slot];
      return toward(p, s.x * dir, s.y * dir);
    }
    if (g.next) {
      const n = g.next;
      if (p.team === n.team) {
        // Take it out, or get open in the backcourt for it.
        if (p.slot === 0) return toward(p, n.x, n.y, 1);
        return toward(p, own + dir * (4.5 + p.slot), (p.slot === 1 ? -3.5 : 3.5), 1);
      }
      // Get back on defence.
      return toward(p, own + dir * (3 + p.slot * 1.4), (p.slot - 1) * 3, 1);
    }
    return still();
  }

  if (b.owner === p.i) {
    if (p.act === "shoot") return still();
    return handler(g, p, lv);
  }

  // A pass on its way to me: go and meet it.
  if (b.state === "pass" && b.target === p.i) {
    const t = Math.max(0, (hyp(b.x - p.x, b.y - p.y) - 0.5) / 14);
    const inp = toward(p, b.x + b.vx * t, b.y + b.vy * t, 0.3);
    if (b.lob && b.z > 2.5 && hyp(b.x - p.x, b.y - p.y) < 2.0 && p.z === 0) inp.jump = true;
    return inp;
  }

  // A loose ball or a rebound: the closest two of each team go for it.
  if (b.owner < 0 && b.state !== "pass") {
    if (b.state === "shot" && b.shot && !b.shot.touched) {
      const sx = b.shot.side * HOOP_X;
      const mates = g.players.filter((q) => q.team === p.team).sort((a, c) => hyp(a.x - sx, a.y) - hyp(c.x - sx, c.y));
      const rank = mates.indexOf(p);
      const k = rank === 0 ? 1.7 : rank === 1 ? 2.8 : 6;
      const ang = (p.slot - 1) * 0.9 + (p.team ? 0.35 : -0.35);
      return toward(p, sx - b.shot.side * Math.cos(ang) * k, Math.sin(ang) * k, 0.5);
    }
    const t = 0.3;
    const lx = clamp(b.x + b.vx * t, -HALF_L, HALF_L);
    const ly = clamp(b.y + b.vy * t, -HALF_W, HALF_W);
    const mates = g.players.filter((q) => q.team === p.team).sort((a, c) => hyp(a.x - lx, a.y - ly) - hyp(c.x - lx, c.y - ly));
    const rank = mates.indexOf(p);
    if (rank <= 1) {
      const inp = toward(p, lx, ly, 0.15);
      inp.sprint = true;
      const d = hyp(b.x - p.x, b.y - p.y);
      if (d < 1.2 && b.z > STOOD_REACH && b.z < STOOD_REACH + 1.2 && p.z === 0 && p.cool <= 0) inp.jump = true;
      return inp;
    }
    return toward(p, own * 0.25, p.y * 0.5);
  }

  if (off === p.team) return offBall(g, p, lv);
  return defend(g, p, lv);
}

function handler(g: Game, p: Player, lv: Level): Intent {
  const br = p.brain;
  const hx = hoopX(p.team);
  const dir = attackDir(p.team);
  const d = distToHoop(g, p);
  const open = openness(g, p);
  const mates = g.players.filter((q) => q.team === p.team && q !== p);

  // Somebody (usually a person) is shouting for it.
  const caller = mates.find((q) => q.call > 0);
  if (caller && openness(g, caller) > 0.9 && p.act === "none" && g.ball.age > 0.25) return { ...still(), pass: caller.i };

  const backcourt = p.x * dir < 0;
  if (backcourt && g.shotClock > 3) {
    // Bring it up, and hit anybody running free ahead.
    const inp = toward(p, dir * 5, p.slot === 0 ? 0 : Math.sign(p.y || 1) * 3);
    inp.sprint = p.stamina > 0.4;
    if (br.think <= 0) {
      br.think = lv.think;
      const ahead = mates.find((q) => q.x * dir > p.x * dir + 5 && openness(g, q) > 3);
      if (ahead && rnd(g) < 0.45) inp.pass = ahead.i;
    }
    return inp;
  }

  if (br.think <= 0 && g.ball.age > 0.2) {
    br.think = lv.think * (0.7 + rnd(g) * 0.6);
    br.release = 0.85 + noise(g) * lv.sigma;
    const value = shotValue(g, p);
    // A cutter at the rim: throw it up there.
    const cutter = mates.find((q) => q.brain.cut > 0 && hyp(hoopX(q.team) - q.x, q.y) < 3.4 && openness(g, q) > 1.3);
    if (cutter && rnd(g) < 0.5) return { ...still(), pass: cutter.i, lob: true };
    // At the rim: go up.
    const reach = 2.0 + p.who.dunk * 0.35;
    if (d < reach && (open > 0.9 || p.who.dunk >= 4)) {
      const t = toward(p, hx, 0);
      return { ...t, shoot: true, sprint: true };
    }
    const urgent = g.shotClock < 2.4 || (g.clock < 2.6 && !g.sudden);
    const three = isThree(p.team, p.x, p.y);
    const good = value * lv.shoot > (three ? 1.12 : 0.88);
    if ((good && (open > 1.2 || rnd(g) < 0.3) && rnd(g) < 0.75 && d < 9.5) || urgent) return { ...still(), shoot: true };
    // A better look elsewhere.
    let best: Player | null = null;
    let bv = value + 0.35;
    for (const q of mates) {
      const v = shotValue(g, q) + (openness(g, q) > 2.2 ? 0.2 : 0);
      if (v > bv) {
        bv = v;
        best = q;
      }
    }
    if (best && rnd(g) < 0.45) return { ...still(), pass: best.i };
    // Pick a drive: at the rim, round whoever is in the way.
    const block = blockerAhead(g, p);
    br.tx = hx - dir * (block ? 2.6 : 0.8);
    br.ty = clamp(block ? (block.y > p.y ? p.y - 2.2 : p.y + 2.2) : 0, -HALF_W + 1, HALF_W - 1);
  }
  const t = toward(p, br.tx || hx - dir * 1.5, br.ty, 0.3);
  t.sprint = p.stamina > 0.3 && open > 1.2 && d < 9;
  return t;
}

function offBall(g: Game, p: Player, lv: Level): Intent {
  const br = p.brain;
  const dir = attackDir(p.team);
  const o = ownerOf(g);
  if (br.think <= 0) {
    br.think = lv.think * 2 * (0.6 + rnd(g) * 0.8);
    if (br.cut <= 0 && rnd(g) < 0.14 && o && o.x * dir > 0) br.cut = 1.4;
  }
  if (br.cut > 0) {
    const inp = toward(p, hoopX(p.team) - dir * 1.0, p.slot === 2 ? 0.8 : -0.8, 0.2);
    inp.sprint = true;
    return inp;
  }
  const flip = o && o.y > 0 ? -1 : 1;
  let s = SPOTS[p.slot === 1 ? 1 : p.slot === 2 ? 2 : 0];
  if (o && o.slot === 0 && p.slot === 1) s = SPOTS[4];
  if (o && o.slot !== 0 && p.slot === 0) s = SPOTS[0];
  let x = s.x;
  let y = s.y * flip;
  if (o && o.x * dir < 0) {
    // Transition: run the floor ahead of the ball.
    x = 6 + p.slot * 1.5;
    y = (p.slot === 1 ? -4 : 4) * flip;
  }
  const inp = toward(p, x * dir, y, 0.8);
  inp.sprint = hyp(x * dir - p.x, y - p.y) > 5;
  return inp;
}

function defend(g: Game, p: Player, lv: Level): Intent {
  const br = p.brain;
  const own = -hoopX(p.team);
  // My man: the attacker in the same slot.
  const man = g.players.find((q) => q.team !== p.team && q.slot === p.slot)!;
  const o = ownerOf(g);
  const onBall = o === man;
  const gap = onBall ? 1.05 : 2.1;
  const dx = own - man.x;
  const dy = -man.y;
  const dl = hyp(dx, dy) || 1;
  let x = man.x + (dx / dl) * Math.min(gap, dl * 0.5);
  let y = man.y + (dy / dl) * Math.min(gap, dl * 0.5);
  if (!onBall && o) {
    x += (o.x - x) * 0.18;
    y += (o.y - y) * 0.18;
  }
  const inp = toward(p, x, y, 0.4);
  inp.sprint = hyp(x - p.x, y - p.y) > 3;
  if (br.think <= 0) {
    br.think = lv.think * (0.6 + rnd(g) * 0.8);
    if (onBall && hyp(man.x - p.x, man.y - p.y) < 1.3 && p.cool <= 0 && rnd(g) < lv.steal * (1.5 + p.who.hands * 0.3)) inp.steal = true;
  }
  // Jump at a shooter in reach, a beat late on easy.
  const shooter = o && o.team !== p.team && (o.act === "shoot" || o.act === "layup" || o.act === "dunk") ? o : null;
  if (shooter && p.z === 0 && p.cool <= 0 && hyp(shooter.x - p.x, shooter.y - p.y) < 2.1) {
    if (br.jumpDelay <= 0) br.jumpDelay = 0.04 + (1 - lv.block) * 0.3 + rnd(g) * 0.1;
    br.jumpDelay -= 1 / 60;
    if (br.jumpDelay < 0.03 && rnd(g) < lv.block + 0.15) {
      inp.jump = true;
      br.jumpDelay = 0;
    }
  } else br.jumpDelay = 0;
  return inp;
}

// ---------------------------------------------------------------- page helpers

export function setInput(g: Game, ctrl: number, input: Partial<Input>) {
  const c = g.ctrls[ctrl];
  if (c) Object.assign(c.input, input);
}

/** Let the computer play a person's player (tests, the attract mode, a dropped guest). */
export function setAuto(g: Game, ctrl: number, on: boolean) {
  const c = g.ctrls[ctrl];
  if (c) c.auto = on;
}

/** Take every event since the last call. */
export function drain(g: Game): GameEvent[] {
  const e = g.events;
  g.events = [];
  return e;
}

export const clockLabel = (g: Game) => {
  if (g.sudden) return "NEXT BUCKET";
  const s = Math.max(0, g.clock);
  if (s < 10) return s.toFixed(1);
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

/** Who had the best night: most points, then the winning side. */
export function mvp(g: Game): Player {
  return [...g.players].sort((a, c) => c.pts - a.pts || (g.score[c.team] - g.score[a.team]))[0];
}
