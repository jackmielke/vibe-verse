/**
 * The rules of a bout, with no drawing in them.
 *
 * `Bout.step(dt, input)` advances the fight; the renderer reads `bout.opp`
 * and `bout.events` and never decides anything. Inputs are the same whether
 * they came from a camera, a thumb or a keyboard, which is why one set of
 * tests covers all three.
 *
 * The shape of every exchange: the opponent winds up from one side, with a
 * glow and a sound, for long enough to see. You either slip away from that
 * side, cover up, or eat it. A slip leaves them wide open for a moment and
 * your punches count double; that window is the game.
 */
import type { Hand, PunchKind } from "./pose";

export type Side = "L" | "R";

export interface Opponent {
  id: string;
  name: string;
  nick: string;
  /** One line the ring announcer reads out. */
  intro: string;
  hp: number;
  /** Seconds the glove glows before it lands. Shorter is harder. */
  windup: number;
  /** Average pause between attacks. */
  rest: number;
  damage: number;
  /** Chance per pause of putting the guard up instead of attacking. */
  guardiness: number;
  /** Chance a punch is followed straight away by another. */
  combo: number;
  /** Chance a punch is a feint that stops short. */
  feint: number;
  colors: { body: number; trim: number; glove: number; eye: number };
  shape: "can" | "bun" | "rock" | "cloud";
}

export const ROSTER: Opponent[] = [
  {
    id: "tommy", name: "Tin Tommy", nick: "The Rattling Can",
    intro: "Three hundred pounds of recycled soup can, and every one of them rattles.",
    hp: 90, windup: 1.05, rest: 1.9, damage: 9, guardiness: 0.15, combo: 0, feint: 0,
    colors: { body: 0xc9d3dc, trim: 0xe5484d, glove: 0xe5484d, eye: 0x7cf3ff }, shape: "can",
  },
  {
    id: "dumpling", name: "Mama Dumpling", nick: "The Soft Shell",
    intro: "Soft on the outside, steamed on the inside, and she covers up like nobody you have ever met.",
    hp: 120, windup: 0.85, rest: 1.6, damage: 11, guardiness: 0.35, combo: 0.2, feint: 0.1,
    colors: { body: 0xfbe3d4, trim: 0xff7aa8, glove: 0xff3d7f, eye: 0x3b2b2b }, shape: "bun",
  },
  {
    id: "boulder", name: "Big Boulder", nick: "The Landslide",
    intro: "He has been sitting on the same hillside for nine thousand years, and he would like his spot back.",
    hp: 150, windup: 0.68, rest: 1.3, damage: 14, guardiness: 0.25, combo: 0.4, feint: 0.15,
    colors: { body: 0x7b7f86, trim: 0x6fae4f, glove: 0x2f7d4a, eye: 0xffc94a }, shape: "rock",
  },
  {
    id: "nimbus", name: "Nimbus", nick: "The Thundercloud",
    intro: "Undefeated, unweighable, and technically a weather system. The champ.",
    hp: 170, windup: 0.55, rest: 1.1, damage: 16, guardiness: 0.3, combo: 0.55, feint: 0.25,
    colors: { body: 0xdfe8ff, trim: 0x6b7cff, glove: 0x3b4bff, eye: 0xfff36b }, shape: "cloud",
  },
];

export type OppPhase = "intro" | "idle" | "guard" | "windup" | "strike" | "recover" | "open" | "hurt" | "down" | "win";

export interface OppState {
  phase: OppPhase;
  /** Seconds into the current phase. */
  t: number;
  /** How long the current phase lasts. */
  len: number;
  side: Side;
  hp: number;
  /** A feint stops short at strike. */
  feinting: boolean;
  /** Which way the last hit knocked the head, for the renderer. */
  knock: { side: Side; kind: PunchKind; power: number; t: number };
}

export interface PlayerInput {
  guard: boolean;
  /** Negative is leaning to screen left. */
  lean: number;
  punches: { hand: Hand; kind: PunchKind; power: number }[];
}

export type BoutEvent =
  | { type: "hit"; hand: Hand; kind: PunchKind; damage: number; counter: boolean; combo: number }
  | { type: "blocked"; hand: Hand }
  | { type: "windup"; side: Side }
  | { type: "dodged"; side: Side }
  | { type: "covered"; side: Side }
  | { type: "hurt"; side: Side; damage: number }
  | { type: "feint" }
  | { type: "knockdown" }
  | { type: "ko"; winner: "player" | "opponent" }
  | { type: "bell"; round: number }
  | { type: "round-end"; round: number }
  | { type: "decision"; winner: "player" | "opponent" };

export const ROUND_SECONDS = 60;
export const ROUNDS = 3;
export const REST_SECONDS = 6;
/** Leaning this far, in shoulder widths, is a slip. */
export const SLIP = 0.32;
export const PLAYER_HP = 100;

export type BoutStage = "intro" | "fighting" | "rest" | "over";

/** A seeded generator, so a test can replay the same fight. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export class Bout {
  readonly opponent: Opponent;
  opp: OppState;
  playerHp = PLAYER_HP;
  round = 1;
  clock = ROUND_SECONDS;
  stage: BoutStage = "intro";
  stageT = 0;
  combo = 0;
  comboT = 0;
  winner: "player" | "opponent" | null = null;
  /** Totals for the end card. */
  stats = { thrown: 0, landed: 0, counters: 0, dodged: 0, blocked: 0, taken: 0, best: 0, knockdowns: 0 };
  events: BoutEvent[] = [];
  /** A difficulty dial, 1 is normal. Raised when you win a bout and fight again. */
  private pace: number;
  private rand: () => number;
  private comboLeft = 0;
  private lastStrikeSide: Side = "R";
  private struck = false;

  constructor(opponent: Opponent, opts: { seed?: number; pace?: number } = {}) {
    this.opponent = opponent;
    this.rand = rng(opts.seed ?? (Date.now() & 0xffffff));
    this.pace = opts.pace ?? 1;
    this.opp = {
      phase: "intro", t: 0, len: 2.6, side: "R", hp: opponent.hp, feinting: false,
      knock: { side: "L", kind: "jab", power: 0, t: 99 },
    };
  }

  private setPhase(phase: OppPhase, len: number): void {
    this.opp.phase = phase;
    this.opp.t = 0;
    this.opp.len = len;
    this.struck = false;
  }

  private rest(): number {
    const r = this.opponent.rest / this.pace;
    return r * (0.55 + this.rand() * 0.9);
  }

  /** Skip the walk-out. */
  start(): void {
    if (this.stage !== "intro") return;
    this.stage = "fighting";
    this.stageT = 0;
    this.setPhase("idle", 1.2);
    this.events.push({ type: "bell", round: this.round });
  }

  step(dt: number, input: PlayerInput): BoutEvent[] {
    this.events = [];
    dt = Math.min(dt, 0.1);
    this.stageT += dt;
    this.opp.t += dt;
    this.opp.knock.t += dt;
    if (this.comboT > 0) { this.comboT -= dt; if (this.comboT <= 0) this.combo = 0; }

    if (this.stage === "intro") {
      if (this.stageT > 2.6) this.start();
      return this.events;
    }
    if (this.stage === "over") return this.events;
    if (this.stage === "rest") {
      if (this.stageT >= REST_SECONDS) {
        this.round++;
        this.clock = ROUND_SECONDS;
        this.stage = "fighting";
        this.stageT = 0;
        this.setPhase("idle", 1.2);
        this.events.push({ type: "bell", round: this.round });
      }
      return this.events;
    }

    // ---- fighting ----
    this.clock -= dt;
    this.punches(input);
    this.think(input);

    if (this.stage === "fighting" && this.clock <= 0) {
      this.clock = 0;
      if (this.round >= ROUNDS) {
        const winner = this.playerHp / PLAYER_HP >= this.opp.hp / this.opponent.hp ? "player" : "opponent";
        this.finish(winner);
        this.events.push({ type: "decision", winner });
      } else {
        this.stage = "rest";
        this.stageT = 0;
        // A corner and a towel: some of it comes back.
        this.playerHp = Math.min(PLAYER_HP, this.playerHp + 25);
        this.opp.hp = Math.min(this.opponent.hp, this.opp.hp + this.opponent.hp * 0.12);
        this.setPhase("idle", REST_SECONDS);
        this.events.push({ type: "round-end", round: this.round });
      }
    }
    return this.events;
  }

  private finish(winner: "player" | "opponent"): void {
    this.stage = "over";
    this.stageT = 0;
    this.winner = winner;
    this.setPhase(winner === "player" ? "down" : "win", 99);
  }

  private punches(input: PlayerInput): void {
    for (const p of input.punches) {
      this.stats.thrown++;
      const ph = this.opp.phase;
      if (ph === "down" || ph === "win" || ph === "intro") continue;
      // A covered head stops everything except an uppercut through the middle.
      if (ph === "guard" && p.kind !== "uppercut") {
        this.events.push({ type: "blocked", hand: p.hand });
        this.combo = 0;
        continue;
      }
      const counter = ph === "open";
      this.combo = this.comboT > 0 ? this.combo + 1 : 1;
      this.comboT = 1.1;
      this.stats.best = Math.max(this.stats.best, this.combo);
      const kindBonus = p.kind === "uppercut" ? 1.5 : p.kind === "hook" ? 1.25 : 1;
      const comboBonus = 1 + Math.min(6, this.combo - 1) * 0.08;
      const damage = Math.round((2.5 + p.power * 5.5) * kindBonus * comboBonus * (counter ? 2 : 1));
      this.opp.hp = Math.max(0, this.opp.hp - damage);
      this.stats.landed++;
      if (counter) this.stats.counters++;
      // Punch with your left and their head goes to screen right.
      this.opp.knock = { side: p.hand === "L" ? "R" : "L", kind: p.kind, power: p.power, t: 0 };
      this.events.push({ type: "hit", hand: p.hand, kind: p.kind, damage, counter, combo: this.combo });

      if (this.opp.hp <= 0) {
        this.stats.knockdowns++;
        this.events.push({ type: "knockdown" });
        this.events.push({ type: "ko", winner: "player" });
        this.finish("player");
        return;
      }
      // Hit them mid wind-up and a hard enough shot stuffs the punch.
      if (ph === "windup" && (p.power > 0.55 || p.kind === "uppercut")) {
        this.setPhase("hurt", 0.35);
      } else if (ph !== "open" && ph !== "windup" && ph !== "strike") {
        this.setPhase("hurt", 0.22 + p.power * 0.15);
      }
    }
  }

  private think(input: PlayerInput): void {
    const o = this.opp;
    if (o.phase === "down" || o.phase === "win") return;
    if (o.t < o.len) {
      if (o.phase === "strike" && o.t >= o.len * 0.5 && !o.feinting) this.resolveStrike(input);
      return;
    }
    switch (o.phase) {
      case "intro":
      case "recover":
      case "hurt":
      case "guard":
        this.setPhase("idle", this.rest());
        break;
      case "open":
        this.setPhase("recover", 0.35);
        break;
      case "idle": {
        if (this.rand() < this.opponent.guardiness) { this.setPhase("guard", 0.9 + this.rand() * 0.9); break; }
        this.windup();
        break;
      }
      case "windup":
        this.setPhase("strike", 0.22);
        if (o.feinting) this.events.push({ type: "feint" });
        break;
      case "strike":
        if (o.feinting) { o.feinting = false; this.setPhase("idle", 0.5); break; }
        if (this.comboLeft > 0) { this.comboLeft--; this.windup(0.55); break; }
        this.setPhase("recover", 0.45);
        break;
    }
  }

  private windup(scale = 1): void {
    const o = this.opp;
    // Mostly alternate hands, but not so reliably you can stop looking.
    o.side = this.rand() < 0.7 ? (this.lastStrikeSide === "L" ? "R" : "L") : this.lastStrikeSide;
    this.lastStrikeSide = o.side;
    o.feinting = this.rand() < this.opponent.feint;
    if (scale === 1 && this.rand() < this.opponent.combo) this.comboLeft = 1 + (this.rand() < 0.3 ? 1 : 0);
    const len = Math.max(0.42, (this.opponent.windup / Math.sqrt(this.pace)) * scale * (0.9 + this.rand() * 0.25));
    this.setPhase("windup", len);
    this.events.push({ type: "windup", side: o.side });
  }

  /** The instant the glove arrives. Happens once per strike. */
  private resolveStrike(input: PlayerInput): void {
    if (this.struck) return;
    this.struck = true;
    const side = this.opp.side;
    // A punch from screen right is slipped by leaning to screen left, and vice versa.
    const slipped = side === "R" ? input.lean < -SLIP : input.lean > SLIP;
    if (slipped) {
      this.stats.dodged++;
      this.comboLeft = 0;
      this.events.push({ type: "dodged", side });
      this.setPhase("open", 1.25);
      return;
    }
    if (input.guard) {
      this.stats.blocked++;
      const chip = Math.round(this.opponent.damage * 0.15);
      this.playerHp = Math.max(1, this.playerHp - chip);
      this.events.push({ type: "covered", side });
      return;
    }
    const damage = this.opponent.damage;
    this.playerHp = Math.max(0, this.playerHp - damage);
    this.stats.taken += damage;
    this.combo = 0;
    this.events.push({ type: "hurt", side, damage });
    if (this.playerHp <= 0) {
      this.events.push({ type: "ko", winner: "opponent" });
      this.finish("opponent");
    }
  }
}
