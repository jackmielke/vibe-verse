/**
 * VIBE CUP — the tournament.
 *
 * All six clubs in one league: everybody plays everybody once over five
 * rounds, three matches a round, then the top two meet in the final. You
 * pick a club and play its matches as one person; the other matches of the
 * round are the computer against the computer and run live alongside yours.
 * Or pick nobody and just follow it.
 *
 * Plain data and pure functions, so the page can save it in localStorage
 * and `src/test/vibeCupTournament.test.ts` can play a whole Cup in node.
 */
import { CLUBS, clubById } from "./game";

export type Stage = "league" | "final";

export interface Fixture {
  id: string;
  round: number;
  stage: Stage;
  home: string;
  away: string;
  /** Final score, once played. */
  score: [number, number] | null;
  /** Decided by a golden goal. */
  golden?: boolean;
  /** Who scored, in order, for the results list. */
  scorers?: string[];
}

export type Position = "fw" | "mf" | "df";

export interface Cup {
  seed: number;
  /** Your club, or null to watch. */
  me: string | null;
  position: Position;
  clubs: string[];
  fixtures: Fixture[];
  /** The round being played: 1 to 5 for the league, 6 for the final. */
  round: number;
  champion: string | null;
}

export const LEAGUE_ROUNDS = 5;
export const FINAL_ROUND = LEAGUE_ROUNDS + 1;

/** Round-robin by the circle method: one club stays put, the rest rotate. */
export function schedule(clubs: string[], seed: number): Fixture[] {
  const order = [...clubs];
  // A seeded shuffle, so every Cup has a different running order.
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const n = order.length;
  const out: Fixture[] = [];
  const ring = order.slice(1);
  for (let r = 0; r < n - 1; r++) {
    const left = [order[0], ...ring.slice(0, n / 2 - 1)];
    const right = ring.slice(n / 2 - 1).reverse();
    for (let k = 0; k < n / 2; k++) {
      // Alternate who is "home" (left on the screen) so nobody always attacks the same way.
      const [home, away] = (r + k) % 2 === 0 ? [left[k], right[k]] : [right[k], left[k]];
      out.push({ id: `r${r + 1}-${k}`, round: r + 1, stage: "league", home, away, score: null });
    }
    ring.unshift(ring.pop()!);
  }
  return out;
}

export function newCup(me: string | null, position: Position = "fw", seed = (Date.now() & 0xffffff) + 1): Cup {
  const clubs = CLUBS.map((c) => c.id);
  return { seed, me, position, clubs, fixtures: schedule(clubs, seed), round: 1, champion: null };
}

export const roundFixtures = (cup: Cup, round = cup.round) => cup.fixtures.filter((f) => f.round === round);
export const myFixture = (cup: Cup, round = cup.round) => (cup.me ? roundFixtures(cup, round).find((f) => f.home === cup.me || f.away === cup.me) ?? null : null);
export const roundDone = (cup: Cup, round = cup.round) => roundFixtures(cup, round).every((f) => f.score);

export interface Row {
  club: string;
  p: number;
  w: number;
  d: number;
  l: number;
  gf: number;
  ga: number;
  pts: number;
  /** Last results, newest last: W, D or L. */
  form: string[];
}

/** The league table: points, then goal difference, then goals scored, then name. */
export function table(cup: Cup): Row[] {
  const rows = new Map<string, Row>(cup.clubs.map((c) => [c, { club: c, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, form: [] }]));
  for (const f of cup.fixtures) {
    if (f.stage !== "league" || !f.score) continue;
    const [a, b] = f.score;
    const h = rows.get(f.home)!;
    const w = rows.get(f.away)!;
    h.p++;
    w.p++;
    h.gf += a;
    h.ga += b;
    w.gf += b;
    w.ga += a;
    if (a > b) {
      h.w++;
      w.l++;
      h.pts += 3;
      h.form.push("W");
      w.form.push("L");
    } else if (b > a) {
      w.w++;
      h.l++;
      w.pts += 3;
      w.form.push("W");
      h.form.push("L");
    } else {
      h.d++;
      w.d++;
      h.pts++;
      w.pts++;
      h.form.push("D");
      w.form.push("D");
    }
  }
  return [...rows.values()].sort(
    (x, y) => y.pts - x.pts || y.gf - y.ga - (x.gf - x.ga) || y.gf - x.gf || clubById(x.club).name.localeCompare(clubById(y.club).name),
  );
}

/** Record a finished match. Returns a new Cup. */
export function record(cup: Cup, id: string, score: [number, number], golden = false, scorers: string[] = []): Cup {
  const fixtures = cup.fixtures.map((f) => (f.id === id ? { ...f, score, golden, scorers } : f));
  let next: Cup = { ...cup, fixtures };
  const fin = fixtures.find((f) => f.stage === "final");
  if (fin?.score) {
    next = { ...next, champion: fin.score[0] > fin.score[1] ? fin.home : fin.away };
  }
  return next;
}

/** Move on once every match of the round is in: the next round, or the final after the league. */
export function advance(cup: Cup): Cup {
  if (!roundDone(cup) || cup.champion) return cup;
  if (cup.round < LEAGUE_ROUNDS) return { ...cup, round: cup.round + 1 };
  if (cup.round === LEAGUE_ROUNDS) {
    const [first, second] = table(cup);
    const final: Fixture = { id: "final", round: FINAL_ROUND, stage: "final", home: first.club, away: second.club, score: null };
    return { ...cup, round: FINAL_ROUND, fixtures: [...cup.fixtures, final] };
  }
  return cup;
}

export const roundName = (round: number) => (round >= FINAL_ROUND ? "The Final" : `Round ${round} of ${LEAGUE_ROUNDS}`);

/** A saved Cup is only trusted if it still names clubs that exist. */
export function validCup(x: unknown): x is Cup {
  if (!x || typeof x !== "object") return false;
  const c = x as Cup;
  return (
    Array.isArray(c.fixtures) &&
    Array.isArray(c.clubs) &&
    c.clubs.length === CLUBS.length &&
    c.clubs.every((id) => CLUBS.some((k) => k.id === id)) &&
    typeof c.round === "number"
  );
}
